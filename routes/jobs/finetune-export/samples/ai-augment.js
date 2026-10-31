'use strict';

// AI-Augmentation für den Finetune-Export.
//
// Drei opt-in-Phasen, alle mit DB-Cache (finetune_ai_cache):
//   1) reverse-prompts: pro Seite N natürliche User-Instructions, Assistant
//      bleibt der Originaltext der Seite (Stil-Schutz).
//   2) fact-qa: pro Figur/Ort/Ereignis N Q&A-Paare, gegroundet im strukturierten
//      JSON aus der DB.
//   3) voice-rewrite: die Figuren-/Orts-Antworten des Autor-Chats (Text der
//      Analyse) im Erzählton des Buchs neu fassen; ersetzt die Antwort in den
//      bestehenden Samples, statt neue hinzuzufügen.
//
// Cache-Key-Konzept:
//   sig = sha1(payload-inputs + modelName)
//   Der Sig ändert sich, sobald sich Quell-Daten oder Modell ändern → Cache-Miss.
//   PROMPTS_VERSION steckt zusätzlich im version-Feld, damit ein Schema-Bump
//   alte Einträge automatisch invalidiert.

const {
  loadFinetuneAiCache, saveFinetuneAiCache,
} = require('../../../../db/schema');
const { aiCall, _modelName, getPrompts } = require('../../shared');
const { extractName, nameRegex } = require('../lib/names');
const { clipAtSentence, splitParagraphs } = require('../lib/text');
const appSettings = require('../../../../lib/app-settings');
const { AUGMENT_CONCURRENCY, sha1, trimInstr, pmap } = require('../lib/augment-util');

const REVERSE_PROMPTS_PER_PAGE_DEFAULT = 4;
const FACT_QA_PER_ENTITY_DEFAULT = 4;

async function buildAiAugmentSamples(ctx) {
  const { opts } = ctx;
  const ai = opts.ai || {};
  if (!ai.reversePrompts && !ai.factQA && !ai.voiceRewrite) return;

  const prompts = await getPrompts(ctx.userEmail);
  const provider = appSettings.get('ai.provider') || 'claude';
  const subCtx = {
    ...ctx,
    prompts,
    augmentSystem: prompts.buildFinetuneAugmentSystem(ctx.langIsEn),
    versionTag: `${_modelName(provider)}:${prompts.PROMPTS_VERSION || ''}`,
    tok: { in: 0, out: 0, ms: 0 },
  };

  if (ai.reversePrompts)     await buildReversePromptSamples(subCtx);
  if (ai.factQA)             await buildFactQASamples(subCtx);
  if (ai.voiceRewrite)       await rewriteAnswersInBookVoice(subCtx);
}

// ── 1) Reverse-Prompts ───────────────────────────────────────────────────────
async function buildReversePromptSamples(ctx) {
  const {
    samples, counts, opts, langIsEn, unifiedSys, bookName,
    bookIdInt, userEmail, pageContents, prompts, augmentSystem, versionTag, jobId, logger, tok,
  } = ctx;
  const { minChars, maxChars } = opts;
  const n = Math.max(1, Math.min(8, opts.ai.reversePromptsPerPage || REVERSE_PROMPTS_PER_PAGE_DEFAULT));

  // Eligible Pages: nur in der Längen-Range, sonst sind weder Original-Page-
  // Sample noch Reverse-Prompt-Variation sinnvoll.
  const eligible = pageContents.filter(p => p.text && p.text.length >= minChars);
  if (!eligible.length) return;

  let processed = 0;
  await pmap(eligible, AUGMENT_CONCURRENCY, async (p) => {
    const passage = clipAtSentence(p.text, maxChars);
    const sig = sha1(passage + '|n=' + n + '|lang=' + (langIsEn ? 'en' : 'de'));
    const scopeKey = `page:${p.id}`;

    let result = loadFinetuneAiCache(bookIdInt, userEmail, 'reverse-prompts', scopeKey, sig, versionTag);
    if (!result) {
      const prompt = prompts.buildFinetuneReversePromptsPrompt({
        passage,
        count: n,
        langIsEn,
        bookName,
        chapter: p.chapter || '',
        pageTitle: p.title || '',
      });
      try {
        result = await aiCall(jobId, tok, prompt, augmentSystem, null, null, 800, 0.25, 1500, undefined, prompts.SCHEMA_FT_REVERSE_PROMPTS);
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        logger.warn(`reverse-prompts: page=${p.id} fehlgeschlagen: ${err.message}`);
        return;
      }
      if (!result || !Array.isArray(result.instructions)) return;
      saveFinetuneAiCache(bookIdInt, userEmail, 'reverse-prompts', scopeKey, sig, versionTag, result);
    }

    const instrs = (result.instructions || [])
      .map(trimInstr)
      .filter(s => s.length >= 6 && s.length <= 240);
    const seen = new Set();
    let variantIdx = 0;
    for (const instr of instrs) {
      const key = instr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      samples.push({
        id: `aiRev|${p.id}|${variantIdx++}`,
        type: 'aiAugment',
        sourceKey: 'ch:' + (p.chapter_id ?? 0),
        messages: [
          { role: 'system', content: unifiedSys },
          { role: 'user', content: instr },
          { role: 'assistant', content: passage },
        ],
      });
      counts.aiAugment = (counts.aiAugment || 0) + 1;
    }
    processed++;
  });

  logger.info(`AI-Augment reverse-prompts: ${processed}/${eligible.length} Seiten verarbeitet, ${counts.aiAugment || 0} Samples bisher.`);
}

// ── 2) Fakten-Q&A ─────────────────────────────────────────────────────────────
async function buildFactQASamples(ctx) {
  const {
    samples, counts, opts, langIsEn, unifiedSys, bookName,
    bookIdInt, userEmail, prompts, augmentSystem, versionTag, jobId, logger, tok,
    figRows, locRows, eventsByFigPk, appearancesByFigPk, chaptersByLocPk, figsByLocPk, figById,
  } = ctx;
  const n = Math.max(2, Math.min(8, opts.ai.factQAPerEntity || FACT_QA_PER_ENTITY_DEFAULT));

  const entities = [];

  // Figuren — strukturiertes Profil mit Lebensereignissen + Kapitel-Auftritten.
  for (const f of figRows) {
    if (!f.name || !f.name.trim()) continue;
    const events = (eventsByFigPk.get(f.pk) || []).slice(0, 12);
    const chapters = (appearancesByFigPk.get(f.pk) || []).slice(0, 12);
    const json = {
      typ: 'figur',
      name: f.name,
      kurzname: f.kurzname || null,
      figurentyp: f.typ || null,
      beschreibung: f.beschreibung || null,
      beruf: f.beruf || null,
      geschlecht: f.geschlecht || null,
      sozialschicht: f.sozialschicht || null,
      tags: f.tags_csv ? f.tags_csv.split(',').filter(Boolean) : [],
      lebensereignisse: events,
      kapitel: chapters,
    };
    entities.push({
      scope: 'fact-qa',
      scopeKey: `figur:${f.fig_id || f.pk}`,
      kindLabel: langIsEn ? 'character' : 'Figur',
      json,
    });
  }

  // Orte
  for (const l of locRows) {
    if (!l.name || !l.name.trim()) continue;
    const figIds = figsByLocPk.get(l.pk) || [];
    const figNames = figIds.map(id => extractName(id, figById)).filter(Boolean).slice(0, 12);
    const chapters = (chaptersByLocPk.get(l.pk) || []).slice(0, 12);
    const json = {
      typ: 'ort',
      name: l.name,
      ortstyp: l.typ || null,
      beschreibung: l.beschreibung || null,
      stimmung: l.stimmung || null,
      erste_erwaehnung: l.erste_erwaehnung || null,
      figuren: figNames,
      kapitel: chapters,
    };
    entities.push({
      scope: 'fact-qa',
      scopeKey: `ort:${l.loc_id || l.pk}`,
      kindLabel: langIsEn ? 'location' : 'Ort',
      json,
    });
  }

  if (!entities.length) return;

  let processed = 0;
  await pmap(entities, AUGMENT_CONCURRENCY, async (ent) => {
    const sig = sha1(JSON.stringify(ent.json) + '|n=' + n + '|lang=' + (langIsEn ? 'en' : 'de'));

    let result = loadFinetuneAiCache(bookIdInt, userEmail, ent.scope, ent.scopeKey, sig, versionTag);
    if (!result) {
      const prompt = prompts.buildFinetuneFactQAPrompt({
        entityType: ent.kindLabel,
        entityJson: ent.json,
        count: n,
        langIsEn,
        bookName,
      });
      try {
        result = await aiCall(jobId, tok, prompt, augmentSystem, null, null, 1200, 0.3, 2000, undefined, prompts.SCHEMA_FT_FACT_QA);
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        logger.warn(`fact-qa: ${ent.scopeKey} fehlgeschlagen: ${err.message}`);
        return;
      }
      if (!result || !Array.isArray(result.qa)) return;
      saveFinetuneAiCache(bookIdInt, userEmail, ent.scope, ent.scopeKey, sig, versionTag, result);
    }

    const seen = new Set();
    let variantIdx = 0;
    for (const pair of result.qa || []) {
      const q = trimInstr(pair.frage);
      const a = (pair.antwort || '').trim();
      if (q.length < 6 || a.length < 20) continue;
      const key = q.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      samples.push({
        id: `aiQA|${ent.scopeKey}|${variantIdx++}`,
        type: 'aiAugment',
        messages: [
          { role: 'system', content: unifiedSys },
          { role: 'user', content: q },
          { role: 'assistant', content: a },
        ],
      });
      counts.aiAugment = (counts.aiAugment || 0) + 1;
    }
    processed++;
  });

  logger.info(`AI-Augment fact-qa: ${processed}/${entities.length} Entitäten verarbeitet, ${counts.aiAugment || 0} Samples bisher.`);
}

// ── 3) Antworten im Buchton ───────────────────────────────────────────────────
const VOICE_SAMPLE_CHARS = 600;
const VOICE_SAMPLES = 3;

// Stilproben: Absätze, in denen die Figur bzw. der Ort vorkommt (Stimme und
// Blick des Buchs auf genau diese Entität), sonst die ersten Absätze des Buchs.
function voiceStyleSamples(name, paragraphs) {
  const re = nameRegex(name);
  const hits = paragraphs.filter(p => p.length >= 200 && re.test(p));
  const pool = hits.length ? hits : paragraphs.filter(p => p.length >= 200);
  return pool.slice(0, VOICE_SAMPLES).map(p => clipAtSentence(p, VOICE_SAMPLE_CHARS));
}

async function rewriteAnswersInBookVoice(ctx) {
  const {
    samples, langIsEn, bookName, voiceTargets, pageContents,
    bookIdInt, userEmail, prompts, augmentSystem, versionTag, jobId, logger, tok,
  } = ctx;
  if (!voiceTargets?.size) return;
  const paragraphs = pageContents.flatMap(p => splitParagraphs(p.text || ''));
  const rewritten = new Map();

  await pmap([...voiceTargets], AUGMENT_CONCURRENCY, async ([key, t]) => {
    const styleSamples = voiceStyleSamples(t.name, paragraphs);
    const sig = sha1(JSON.stringify({ text: t.text, styleSamples }) + '|lang=' + (langIsEn ? 'en' : 'de'));
    let result = loadFinetuneAiCache(bookIdInt, userEmail, 'voice-rewrite', key, sig, versionTag);
    if (!result) {
      const prompt = prompts.buildFinetuneVoiceRewritePrompt({
        entityType: t.kind === 'figure'
          ? (langIsEn ? 'the character' : 'der Figur')
          : (langIsEn ? 'the location' : 'dem Ort'),
        name: t.name, text: t.text, styleSamples, langIsEn, bookName,
      });
      try {
        result = await aiCall(jobId, tok, prompt, augmentSystem, null, null, Math.max(400, t.text.length), 0.3, 1500, undefined, prompts.SCHEMA_FT_VOICE_REWRITE);
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        logger.warn(`voice-rewrite: ${key} fehlgeschlagen: ${err.message}`);
        return;
      }
      if (!result || typeof result.antwort !== 'string') return;
      saveFinetuneAiCache(bookIdInt, userEmail, 'voice-rewrite', key, sig, versionTag, result);
    }
    const a = result.antwort.trim();
    // Ausreisser (leer, abgeschweift) behalten die Analyse-Antwort: lieber der
    // falsche Ton als eine Antwort, deren Fakten niemand geprüft hat.
    if (a.length < 20 || a.length > t.text.length * 3 + 400) return;
    rewritten.set(key, a);
  });

  let replaced = 0;
  for (const s of samples) {
    const a = s.voiceKey && rewritten.get(s.voiceKey);
    if (!a) continue;
    s.messages[s.messages.length - 1].content = a;
    replaced++;
  }
  ctx.counts.voiceRewritten = replaced;
  logger.info(`AI-Augment voice-rewrite: ${rewritten.size}/${voiceTargets.size} Antworten neu gefasst, ${replaced} Samples ersetzt.`);
}

module.exports = { buildAiAugmentSamples, rewriteAnswersInBookVoice };
