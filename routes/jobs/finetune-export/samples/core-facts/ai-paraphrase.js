'use strict';

// KI-Varianten der Kernfakten (Profil `aiParaphrase`, Standard aus): die
// erste Antwort jeder Karte (und Fragerichtung) wird umformuliert. Eine
// Variante zählt nur, wenn sie jeden Namen, jede Jahreszahl und jedes
// Beziehungswort der Vorlage enthält — sonst fällt sie weg: eine Umformulierung,
// die aus «Mutter» «Tante» macht, wäre ein neuer, falscher Fakt. Gecacht wie
// die übrigen Augment-Calls (finetune_ai_cache).

const { loadFinetuneAiCache, saveFinetuneAiCache } = require('../../../../../db/schema');
const { aiCall, _modelName, getPrompts } = require('../../../shared');
const appSettings = require('../../../../../lib/app-settings');
const { AUGMENT_CONCURRENCY, sha1, pmap } = require('../../lib/augment-util');
const { ROLE_DE } = require('./words');

const ROLE_WORDS = [...new Set(Object.values(ROLE_DE).flatMap(g => Object.values(g).map(([n]) => n.toLowerCase())))];
const EN_ROLE_WORDS = ['father', 'mother', 'parent', 'son', 'daughter', 'child', 'brother', 'sister', 'sibling', 'husband', 'wife', 'spouse'];

// Was eine Variante unverändert tragen muss.
function requiredTokens(answer, names, langIsEn) {
  const low = answer.toLowerCase();
  const req = new Set();
  for (const n of names) if (n && answer.includes(n)) req.add(n);
  for (const y of answer.match(/\b\d{4}\b/g) || []) req.add(y);
  for (const w of langIsEn ? EN_ROLE_WORDS : ROLE_WORDS) {
    if (new RegExp(`(^|[^\\p{L}])${w}([^\\p{L}]|$)`, 'u').test(low)) req.add(w);
  }
  return [...req];
}

function keepsFacts(variant, required) {
  const low = variant.toLowerCase();
  return required.every(t => low.includes(t.toLowerCase()));
}

async function buildAiParaphraseSamples(ctx) {
  const { samples, opts, langIsEn, bookName, bookIdInt, userEmail, jobId, logger, figRows } = ctx;
  const prompts = await getPrompts(userEmail);
  const provider = appSettings.get('ai.provider') || 'claude';
  const versionTag = `${_modelName(provider)}:${prompts.PROMPTS_VERSION || ''}`;
  const system = prompts.buildFinetuneAugmentSystem(langIsEn);
  const tok = { in: 0, out: 0, ms: 0 };
  const names = figRows.flatMap(f => [f.name, f.kurzname]).filter(n => n && n.length >= 2);
  const maxV = Math.max(1, Number(opts.maxVariantsPerFact) || 5);

  // Gruppen je Karte + Richtung: Vorlage = erste Variante.
  const groups = new Map();
  for (const s of samples) {
    if (s.type !== 'core' || !s.factId) continue;
    const key = s.factId + '|' + (s.dir || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const want = Math.max(1, Number(opts.factParaphrases) || 3);
  let added = 0, rejected = 0;
  await pmap([...groups], AUGMENT_CONCURRENCY, async ([key, arr]) => {
    const room = maxV - arr.length;
    if (room <= 0) return;
    const base = arr[0];
    const question = base.messages[1].content;
    const answer = base.messages[2].content;
    const sig = sha1(question + '\u0000' + answer + '|n=' + want + '|lang=' + (langIsEn ? 'en' : 'de'));
    let result = loadFinetuneAiCache(bookIdInt, userEmail, 'paraphrase', key, sig, versionTag);
    if (!result) {
      try {
        result = await aiCall(jobId, tok,
          prompts.buildFinetuneParaphrasePrompt({ question, answer, count: want, langIsEn, bookName }),
          system, null, null, Math.max(400, answer.length * want), 1.0, 1500, undefined, prompts.SCHEMA_FT_PARAPHRASE);
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        logger.warn(`paraphrase: ${key} fehlgeschlagen: ${err.message}`);
        return;
      }
      if (!result || !Array.isArray(result.varianten)) return;
      saveFinetuneAiCache(bookIdInt, userEmail, 'paraphrase', key, sig, versionTag, result);
    }
    const required = requiredTokens(answer, names, langIsEn);
    const have = new Set(arr.map(s => s.messages[2].content.trim()));
    let n = 0;
    for (const v of result.varianten) {
      if (n >= room) break;
      const a = String(v || '').trim();
      if (a.length < 12 || have.has(a) || a.length > answer.length * 3 + 200) { rejected++; continue; }
      if (!keepsFacts(a, required)) { rejected++; continue; }
      have.add(a);
      const q = arr[(n + 1) % arr.length].messages[1].content;
      samples.push({
        ...base,
        id: `core|${key}|ai${n}`,
        aiParaphrase: true,
        messages: [base.messages[0], { role: 'user', content: q }, { role: 'assistant', content: a }],
      });
      n++;
      added++;
    }
  });
  ctx.counts.core += added;
  logger.info(`KI-Varianten Kernwissen: ${added} übernommen, ${rejected} verworfen (Fakt fehlte oder Dublette), ${groups.size} Karten.`);
}

module.exports = { buildAiParaphraseSamples, requiredTokens, keepsFacts };
