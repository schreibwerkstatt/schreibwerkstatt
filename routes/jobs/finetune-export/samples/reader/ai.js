'use strict';

// KI-Phasen des Leser-Modells, beide mit Belegpflicht und DB-Cache
// (finetune_ai_cache, Muster samples/ai-augment.js):
//   1) persona — Fragen an jede tragende Figur, Antwort in der Ich-Form;
//      Heuhaufen des Belegs ist das gelieferte Material (Notizen, Dialogzeilen).
//   2) deutung — «Warum …?»-Fragen pro Szene (ohne Szenen: pro Abschnitt mit
//      tragender Figur); Heuhaufen ist der Abschnittstext.
// Ein Paar, dessen `beleg` im Heuhaufen nicht vorkommt (lib/quote-verify.js),
// fällt weg: eine erfundene Motivation im Ton des Buchs klänge für Leser wie Kanon.

const { loadFinetuneAiCache, saveFinetuneAiCache } = require('../../../../../db/schema');
const { normalizeForQuoteMatch, quoteFoundIn } = require('../../../../../lib/quote-verify');
const appSettings = require('../../../../../lib/app-settings');
const { aiCall, _modelName, getPrompts } = require('../../../shared');
const { nameRegex } = require('../../lib/names');
const { clipAtSentence } = require('../../lib/text');
const { AUGMENT_CONCURRENCY, sha1, trimInstr, pmap } = require('../../lib/augment-util');
const { personaMaterial, hasPersonaMaterial, NOTE_LABELS } = require('./figures');
const { entryQuestion } = require('./persona');
const { PSYCHE_KERNE } = require('../../../../../lib/draft-mindmap-extract');

const PERSONA_PER_FIGURE_DEFAULT = 8;
const DEUTUNG_PER_SCENE_DEFAULT = 2;
// Kürzester prüfbarer Beleg: darunter träfe ein Allerweltswort zufällig.
const MIN_BELEG_CHARS = 12;
// Passage pro Deutungs-Call; längere Abschnitte werden am Satzende gekappt.
const DEUTUNG_PASSAGE_CHARS = 8000;

function belegOk(beleg, hayNorm) {
  const b = String(beleg || '').trim();
  return b.length >= MIN_BELEG_CHARS && quoteFoundIn(b, hayNorm);
}

async function cachedCall(ctx, scope, scopeKey, sig, buildPrompt, schema, expectedChars) {
  const { bookIdInt, userEmail, versionTag, jobId, tok, augmentSystem, logger } = ctx;
  let result = loadFinetuneAiCache(bookIdInt, userEmail, scope, scopeKey, sig, versionTag);
  if (result) return result;
  try {
    result = await aiCall(jobId, tok, buildPrompt(), augmentSystem, null, null, expectedChars, 0.4, 4000, undefined, schema);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    logger.warn(`${scope}: ${scopeKey} fehlgeschlagen: ${err.message}`);
    return null;
  }
  if (!result || !Array.isArray(result.paare)) return null;
  saveFinetuneAiCache(bookIdInt, userEmail, scope, scopeKey, sig, versionTag, result);
  return result;
}

// ── 1) Persona ───────────────────────────────────────────────────────────────
async function buildPersonaAiSamples(ctx, readerFigures, push) {
  const { langIsEn, bookName, prompts, logger } = ctx;
  const lang = langIsEn ? 'en' : 'de';
  const seed = ctx.opts.valSeed;
  const n = Math.max(2, Math.min(16, ctx.opts.ai.personaPerFigure || PERSONA_PER_FIGURE_DEFAULT));
  const figures = readerFigures.filter(hasPersonaMaterial);
  let kept = 0, dropped = 0;
  await pmap(figures, AUGMENT_CONCURRENCY, async (rf) => {
    const material = personaMaterial(rf, langIsEn);
    const sig = sha1(material + '|n=' + n + '|lang=' + lang);
    const result = await cachedCall(ctx, 'reader-persona', rf.key, sig,
      () => prompts.buildFinetunePersonaPrompt({ name: rf.name, bookName, material, count: n, langIsEn }),
      prompts.SCHEMA_FT_PERSONA, 600 * n);
    if (!result) return;
    const hayNorm = normalizeForQuoteMatch(material);
    const pairs = [];
    for (const p of result.paare) {
      const q = trimInstr(p.frage);
      const a = String(p.antwort || '').trim();
      if (q.length < 6 || a.length < 20) continue;
      if (!belegOk(p.beleg, hayNorm)) { dropped++; continue; }
      pairs.push([q, a]);
    }
    pairs.forEach(([q, a], i) => {
      if (push({
        id: `reader|persona|${rf.key}|${i}`,
        turns: [[entryQuestion(lang, rf.name, q, `${rf.key}|${i}`, seed), a]],
      })) kept++;
    });
    ctx.personaPairs.set(rf.key, { name: rf.name, pairs });
  });
  logger.info(`Leser persona: ${kept} Samples aus ${figures.length} Figuren, ${dropped} ohne Beleg verworfen.`);
}

// ── 2) Deutungen ─────────────────────────────────────────────────────────────
// Innenleben je Figur für den Deutungs-Prompt: Analyse (Motivation, Konflikt)
// und Werkstatt-Kerne.
function psycheNotes(rf, lang) {
  const lines = [];
  const de = lang === 'de';
  if (rf.fig?.motivation) lines.push(`${rf.name} – Motivation: ${rf.fig.motivation}`);
  if (rf.fig?.konflikt) lines.push(`${rf.name} – ${de ? 'Konflikt' : 'Conflict'}: ${rf.fig.konflikt}`);
  for (const kern of PSYCHE_KERNE) {
    if (rf.notes[kern]?.length) lines.push(`${rf.name} – ${NOTE_LABELS[kern][lang]}: ${rf.notes[kern].join('; ')}`);
  }
  return lines;
}

// Einheiten: Szenen mit Figuren, sonst Abschnitte, in denen eine tragende Figur
// vorkommt. Jede Einheit trägt ihren Abschnittstext als Heuhaufen.
function deutungUnits(ctx, readerFigures) {
  const { sceneRows, figsByScene, figById, pageContents, pageTextById, opts } = ctx;
  const notesByFigId = new Map(readerFigures.filter(r => r.fig).map(r => [r.fig.fig_id, r]));
  const units = [];
  for (const s of sceneRows) {
    const text = s.page_id ? pageTextById.get(s.page_id) : null;
    const figIds = figsByScene.get(s.id) || [];
    if (!text || text.length < opts.minChars || !figIds.length) continue;
    const page = pageContents.find(p => p.id === s.page_id);
    units.push({
      scopeKey: `scene:${s.id}`, text, sceneTitle: s.titel || '', chapter: s.kapitel || '',
      chapterId: page?.chapter_id ?? 0,
      figs: figIds.map(id => notesByFigId.get(id) || { name: figById.get(id)?.name, fig: figById.get(id), notes: {} }).filter(r => r.name),
    });
  }
  if (units.length) return units;
  for (const p of pageContents) {
    if (!p.text || p.text.length < opts.minChars) continue;
    const figs = readerFigures.filter(r => nameRegex(r.name).test(p.text));
    if (!figs.length) continue;
    units.push({ scopeKey: `page:${p.id}`, text: p.text, sceneTitle: '', chapter: p.chapter || '', chapterId: p.chapter_id ?? 0, figs });
  }
  return units;
}

async function buildDeutungAiSamples(ctx, readerFigures, push) {
  const { langIsEn, bookName, prompts, logger } = ctx;
  const lang = langIsEn ? 'en' : 'de';
  const n = Math.max(1, Math.min(6, ctx.opts.ai.deutungPerScene || DEUTUNG_PER_SCENE_DEFAULT));
  const units = deutungUnits(ctx, readerFigures);
  let kept = 0, dropped = 0;
  await pmap(units, AUGMENT_CONCURRENCY, async (u) => {
    const passage = clipAtSentence(u.text, DEUTUNG_PASSAGE_CHARS);
    const figures = u.figs.flatMap(r => psycheNotes(r, lang)).join('\n');
    const sig = sha1({ passage, figures, n, lang, sceneTitle: u.sceneTitle, chapter: u.chapter });
    const result = await cachedCall(ctx, 'reader-deutung', u.scopeKey, sig,
      () => prompts.buildFinetuneDeutungPrompt({ passage, figures, sceneTitle: u.sceneTitle, chapter: u.chapter, bookName, count: n, langIsEn }),
      prompts.SCHEMA_FT_DEUTUNG, 700 * n);
    if (!result) return;
    const hayNorm = normalizeForQuoteMatch(passage);
    result.paare.forEach((p, i) => {
      const q = trimInstr(p.frage);
      const a = String(p.antwort || '').trim();
      if (q.length < 6 || a.length < 30) return;
      if (!belegOk(p.beleg, hayNorm)) { dropped++; return; }
      const about = u.figs.filter(r => r.key && nameRegex(r.name).test(q));
      if (push({
        id: `reader|deutung|${u.scopeKey}|${i}`,
        turns: [[q, a]],
        // Die Antwort zitiert Buchtext → Split mit dem Kapitel.
        sourceKey: 'ch:' + u.chapterId,
        convKey: about.length === 1 ? about[0].key : undefined,
      })) kept++;
    });
  });
  logger.info(`Leser deutung: ${kept} Samples aus ${units.length} Einheiten, ${dropped} ohne Beleg verworfen.`);
}

async function buildReaderAiSamples(ctx, readerFigures, push) {
  const ai = ctx.opts.ai || {};
  if (!ai.persona && !ai.deutung) return;
  const prompts = await getPrompts(ctx.userEmail);
  const provider = appSettings.get('ai.provider') || 'claude';
  const subCtx = {
    ...ctx,
    prompts,
    augmentSystem: prompts.buildFinetuneAugmentSystem(ctx.langIsEn),
    versionTag: `${ctx.aiModel || _modelName(provider)}:${prompts.PROMPTS_VERSION || ''}`,
    tok: { in: 0, out: 0, ms: 0 },
  };
  if (ai.persona) await buildPersonaAiSamples(subCtx, readerFigures, push);
  if (ai.deutung) await buildDeutungAiSamples(subCtx, readerFigures, push);
}

module.exports = { buildReaderAiSamples, deutungUnits, belegOk };
