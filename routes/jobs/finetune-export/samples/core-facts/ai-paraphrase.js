'use strict';

// KI-Fragevarianten der Kernfakten (Profil `aiParaphrase`, Standard aus): die
// erste FRAGE jeder Karte (und Fragerichtung) wird umformuliert, die Antworten
// bleiben die der Vorlage — eine umformulierte Antwort könnte aus «Mutter»
// «Tante» machen, also einen neuen, falschen Fakt. Eine Fragevariante zählt
// nur, wenn sie jeden Namen der Vorlage enthält und keinen anderen Figurennamen
// (sie fragt sonst nach etwas anderem). Danach laufen die neuen Fragen durch
// dieselben Schutznetze wie alle (finalize.js: Prompt-Dedup, Val-Überlappung,
// Eval-Prompts nicht im Train). Gecacht wie die übrigen Augment-Calls
// (finetune_ai_cache). Gezählt als `aiAugmentCount`.

const { loadFinetuneAiCache, saveFinetuneAiCache } = require('../../../../../db/schema');
const { aiCall, _modelName, getPrompts } = require('../../../shared');
const appSettings = require('../../../../../lib/app-settings');
const { augmentConcurrency, augmentMaxTokens, sha1, pmap } = require('../../lib/augment-util');
const { escapeRe } = require('../../lib/names');

// Namen, die eine Frage trägt (aus der Figurenliste), auch im Genitiv («Stefans»).
const namesIn = (text, names) => names.filter(n => new RegExp(`(?<![\\p{L}])${escapeRe(n)}(s|')?(?![\\p{L}])`, 'u').test(text));

// Eine Fragevariante passt, wenn sie eine Frage oder Bitte ist, alle Namen der
// Vorlage trägt und keine weiteren.
function keepsQuestion(variant, original, names) {
  const v = String(variant || '').trim();
  if (v.length < 8 || v.length > original.length * 3 + 80 || !/[?.!]$/.test(v)) return false;
  const want = new Set(namesIn(original, names));
  const have = new Set(namesIn(v, names));
  for (const n of want) if (!have.has(n)) return false;
  for (const n of have) if (!want.has(n) && ![...want].some(w => w.includes(n) || n.includes(w))) return false;
  return true;
}

async function buildAiParaphraseSamples(ctx) {
  const { samples, opts, langIsEn, bookName, bookIdInt, userEmail, jobId, logger, figRows } = ctx;
  const prompts = await getPrompts(userEmail);
  const provider = appSettings.get('ai.provider') || 'claude';
  const versionTag = `${ctx.aiModel || _modelName(provider)}:${prompts.PROMPTS_VERSION || ''}`;
  const system = prompts.buildFinetuneAugmentSystem(langIsEn);
  const tok = { in: 0, out: 0, ms: 0 };
  const names = [...new Set(figRows.flatMap(f => [f.name, f.kurzname]).filter(n => n && n.length >= 2))];

  // Gruppen je Karte + Richtung: Vorlage = erste Variante.
  const groups = new Map();
  for (const s of samples) {
    if (s.type !== 'core' || !s.factId || s.messages.length !== 3) continue;
    const key = s.factId + '|' + (s.dir || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const want = Math.max(1, Number(opts.factParaphrases) || 3);
  const prompts0 = new Set(samples.flatMap(s => s.messages.filter(m => m.role === 'user').map(m => m.content.trim())));
  let added = 0, rejected = 0;
  await pmap([...groups], augmentConcurrency(ctx.aiModel), async ([key, arr]) => {
    const base = arr[0];
    const question = base.messages[1].content;
    const answer = base.messages[2].content;
    const sig = sha1('q|' + question + '\u0000' + answer + '|n=' + want + '|lang=' + (langIsEn ? 'en' : 'de'));
    let result = loadFinetuneAiCache(bookIdInt, userEmail, 'paraphrase', key, sig, versionTag);
    if (!result) {
      try {
        result = await aiCall(jobId, tok,
          prompts.buildFinetuneParaphrasePrompt({ question, answer, count: want, langIsEn, bookName }),
          system, null, null, Math.max(300, question.length * want * 2), 1.0, augmentMaxTokens(question.length * want * 2), undefined, prompts.SCHEMA_FT_PARAPHRASE);
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        logger.warn(`paraphrase: ${key} fehlgeschlagen: ${err.message}`);
        return;
      }
      if (!result || !Array.isArray(result.varianten)) return;
      saveFinetuneAiCache(bookIdInt, userEmail, 'paraphrase', key, sig, versionTag, result);
    }
    // Antworten der Vorlage reihum: der Fakt bleibt wörtlich derselbe.
    const answers = [...new Set(arr.map(s => s.messages[2].content))];
    let n = 0;
    for (const v of result.varianten) {
      const q = String(v || '').trim();
      if (prompts0.has(q) || !keepsQuestion(q, question, names)) { rejected++; continue; }
      prompts0.add(q);
      samples.push({
        ...base,
        id: `core|${key}|ai${n}`,
        aiParaphrase: true,
        messages: [base.messages[0], { role: 'user', content: q }, { role: 'assistant', content: answers[n % answers.length] }],
      });
      n++;
      added++;
    }
  });
  ctx.counts.core += added;
  logger.info(`KI-Fragevarianten Kernwissen: ${added} übernommen, ${rejected} verworfen (Name fehlte, fremder Name oder Dublette), ${groups.size} Karten.`);
}

// Warum-Leserfragen (Profil `aiWhyQuestions`, Standard an): je Warum-Karte
// (why.js, Typ `eventWhy`) bis zu `WHY_AI_COUNT` Fragen, wie Leser sie stellen
// — «Warum hat Stefan Renate vergewaltigt?» statt nur der Vorlagen mit dem
// Ereignistitel in «…». Das deckt auch Ereignisse ab, deren Titel kein Satz mit
// Handelndem ist («Standesamtliche Hochzeit von …»): dort fehlte die Verbfrage.
// Antworten bleiben die geprüften der Karte; eine Frage zählt nur, wenn sie
// jeden Namen des Ereignisses (und der Figur) trägt und keinen anderen.
const WHY_AI_COUNT = 6;

async function buildAiWhyQuestions(ctx) {
  const { samples, langIsEn, bookName, bookIdInt, userEmail, jobId, logger, figRows } = ctx;
  const prompts = await getPrompts(userEmail);
  const provider = appSettings.get('ai.provider') || 'claude';
  const versionTag = `${ctx.aiModel || _modelName(provider)}:${prompts.PROMPTS_VERSION || ''}`;
  const system = prompts.buildFinetuneAugmentSystem(langIsEn);
  const tok = { in: 0, out: 0, ms: 0 };
  const names = [...new Set(figRows.flatMap(f => [f.name, f.kurzname]).filter(n => n && n.length >= 2))];

  const groups = new Map();
  for (const s of samples) {
    if (s.task !== 'eventWhy' || !s.factId || s.messages.length !== 3) continue;
    if (!groups.has(s.factId)) groups.set(s.factId, []);
    groups.get(s.factId).push(s);
  }
  const cards = new Map((ctx.factCards || []).map(c => [c.id, c]));
  const prompts0 = new Set(samples.flatMap(s => s.messages.filter(m => m.role === 'user').map(m => m.content.trim())));
  let added = 0, rejected = 0;
  await pmap([...groups], augmentConcurrency(ctx.aiModel), async ([factId, arr]) => {
    const card = cards.get(factId);
    const base = arr[0];
    const event = String(card?.subject || '');
    const figure = String(card?.fields?.figur || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    if (!event || !figure) return;
    const own = !/:motive:/.test(factId);
    const answer = base.messages[2].content;
    // Namensprobe: Ereignis + Figur — jede Frage muss sie alle tragen.
    const probe = `${event} ${figure}`;
    const sig = sha1('why|' + probe + '\u0000' + answer + '|own=' + own + '|n=' + WHY_AI_COUNT + '|lang=' + (langIsEn ? 'en' : 'de'));
    let result = loadFinetuneAiCache(bookIdInt, userEmail, 'why-questions', factId, sig, versionTag);
    if (!result) {
      try {
        result = await aiCall(jobId, tok,
          prompts.buildFinetuneWhyQuestionsPrompt({ event, figure, own, answer, count: WHY_AI_COUNT, langIsEn, bookName }),
          system, null, null, 600, 1.0, augmentMaxTokens(600 * 2), undefined, prompts.SCHEMA_FT_PARAPHRASE);
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        logger.warn(`why-questions: ${factId} fehlgeschlagen: ${err.message}`);
        return;
      }
      if (!result || !Array.isArray(result.varianten)) return;
      saveFinetuneAiCache(bookIdInt, userEmail, 'why-questions', factId, sig, versionTag, result);
    }
    // Nur Fassungen, die keine Vorlagen-Frage schon trägt (why.js#whyAnswers):
    // je Frage eine eigene Antwort, sonst würde die Fassung zum Block.
    const taken = new Set(arr.map(s => s.messages[2].content));
    const answers = (ctx.whyAnswers?.get(factId) || []).filter(a => !taken.has(a));
    let n = 0;
    for (const v of result.varianten) {
      if (n >= answers.length) break;
      const q = String(v || '').trim();
      if (/[«»"“”]/.test(q) || prompts0.has(q) || !keepsQuestion(q, probe, names)) { rejected++; continue; }
      prompts0.add(q);
      samples.push({
        ...base,
        id: `core|${factId}|why${n}`,
        aiParaphrase: true,
        messages: [base.messages[0], { role: 'user', content: q }, { role: 'assistant', content: answers[n] }],
      });
      n++;
      added++;
    }
  });
  ctx.counts.core += added;
  logger.info(`KI-Warum-Fragen: ${added} übernommen, ${rejected} verworfen (Name fehlte, fremder Name, Zitat oder Dublette), ${groups.size} Karten.`);
  return added;
}

module.exports = { buildAiParaphraseSamples, buildAiWhyQuestions, keepsQuestion };
