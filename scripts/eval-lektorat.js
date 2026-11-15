'use strict';
// Manuelle Output-Qualitäts-Eval für das Lektorat – NICHT Teil von `npm test`
// (macht echte KI-Calls, kostet Tokens, braucht einen konfigurierten Provider).
//
//   npm run eval:lektorat                          Kombi + Split, alle Fälle
//   npm run eval:lektorat -- --mode=split          nur den Split
//   npm run eval:lektorat -- --set=stil            nur das Stil-Gold-Set
//   npm run eval:lektorat -- --set=objektiv        nur das Objektiv-Gold-Set
//   EVAL_PROVIDER=claude npm run eval:lektorat     Provider erzwingen
//   EVAL_ONLY=id1,id2 npm run eval:lektorat        nur diese Gold-Fälle
//
// Modi (wie im Job, routes/jobs/lektorat-split.js):
//   kombi   – ein Call, alle Typen
//   split   – Objektiv-Pass + ein Stil-Pass (Produktion bei Claude)
// Die Prüfung in Stücken (lib/lektorat-chunks.js) greift erst über der Schwelle
// (Default 10'000 Zeichen) — die Gold-Fälle sind kürzer und messen sie nicht.
// Nachbearbeitung wie im Job: Cross-Pass-Merge (mergePasses), Typ-Validierung,
// Dedup, Stil-Obergrenze (finalizeFehler). Modell und Effort wie im Job
// (applyLektoratAiOverrides).
// Dazu die regelbasierten Dialogformat-Befunde (lib/dialogformat-rules.js), im
// Report mit [regel] markiert.
//
// Gold-Sets: eval/lektorat/gold.mjs (objektive Fehler) und gold-stil.mjs (Stil,
// Handwerk, Konsistenz — lange Fälle mit Verdrängung). Bewertet wird je Fall:
//   • RECALL    – Anteil der gepflanzten Mängel, deren Stelle ein Befund trifft
//                 (Typ egal; «Typ ✔» zählt zusätzlich, ob der Typ stimmt).
//   • FALSE-POS – Befunde auf einem als gut markierten Satz.
// Dazu je Modus Tokens, Calls und Laufzeit — die Kosten-Seite der Entscheidung.
// Eine Handvoll Fälle ist keine Statistik, aber ein verlässlicher Regress-Wecker;
// streut ein Ergebnis, Fälle mit EVAL_ONLY mehrfach laufen lassen.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const ROOT = path.resolve(__dirname, '..');
  // SESSION_SECRET entschlüsselt den API-Key in app_settings.
  require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
  const appSettings = require('../lib/app-settings');
  const { callAI, parseJSON, resolveProvider } = require('../lib/ai');
  const { runWithContext } = require('../lib/log-context');
  const { checkDialogformat, mergeRegelBefunde } = require('../lib/dialogformat-rules');
  const { mergePasses } = require('../lib/lektorat-consolidate');
  const { finalizeFehler, effectiveStylisticCap } = require('../routes/jobs/lektorat-filter');
  const { lektoratMaxTokens, applyLektoratAiOverrides } = require('../routes/jobs/lektorat-split');

  const arg = (name) => (process.argv.find(a => a.startsWith(`--${name}=`)) || '').slice(name.length + 3);
  const provider = process.env.EVAL_PROVIDER || resolveProvider();
  const modes = (arg('mode') || 'kombi,split').split(',').filter(Boolean);
  const set = arg('set') || 'alle';
  if (provider === 'claude' && !appSettings.get('ai.claude.api_key')) {
    console.error('\n  Kein Claude-API-Key konfiguriert (ai.claude.api_key). Eval abgebrochen.');
    console.error('  Setze den Key im Admin oder wechsle den Provider (ai.provider).\n');
    process.exit(2);
  }
  if (provider !== 'claude' && modes.some(m => m !== 'kombi')) {
    console.error(`\n  Modus ${modes.join(',')} gibt es nur für Claude — lokale Provider fahren immer den Kombi-Call.\n`);
    process.exit(2);
  }

  const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'prompt-config.json'), 'utf8'));
  const prompts = await imp('public/js/prompts.js');
  prompts.configurePrompts(cfg, provider);
  const { OBJEKTIV_TYPEN } = await imp('public/js/prompts/lektorat-typen.js');
  const { GOLD_CASES } = await imp('eval/lektorat/gold.mjs');
  const { STIL_CASES } = await imp('eval/lektorat/gold-stil.mjs');

  const pool = set === 'objektiv' ? GOLD_CASES : set === 'stil' ? STIL_CASES : [...GOLD_CASES, ...STIL_CASES];
  const only = (process.env.EVAL_ONLY || '').split(',').filter(Boolean);
  const CASES = only.length ? pool.filter(c => only.includes(c.id)) : pool;

  // Gold-Strings müssen verbatim im Text stehen — sonst misst der Scorer Unsinn.
  for (const c of CASES) {
    const needles = [...c.mustCatch.flatMap(m => [m.needle, ...(m.alt || [])]), ...(c.cleanSpans || [])];
    const missing = needles.filter(n => !c.text.includes(n));
    if (missing.length) throw new Error(`Gold-Fall ${c.id}: nicht im Text: ${missing.map(m => `«${m}»`).join(', ')}`);
  }

  // Modell + Effort wie im Job. applyLektoratAiOverrides setzt den ALS-Bag; ausserhalb
  // eines Kontexts liefe der Call mit dem globalen Modell und dem Modell-Default-Effort.
  const logger = { info: () => {} };
  const ctx = {};
  let modelLabel = provider;
  await runWithContext(ctx, async () => {
    const { model } = applyLektoratAiOverrides(provider, logger);
    modelLabel = `${model}${ctx.aiJob?.effort ? ` · effort ${ctx.aiJob.effort}` : ''}`;
  });
  const withJobBag = (fn) => runWithContext({ aiJob: ctx.aiJob }, fn);

  // Ein Lauf eines Falls wie im Job. Rückgabe: Befunde nach Nachbearbeitung + Verbrauch.
  async function analyze(c, mode) {
    const locale = c.locale || 'de-CH';
    const langCode = locale.split('-')[0];
    const buchtyp = c.buchtyp || 'roman';
    const textsorte = c.textsorte || null;
    const kontext = c.kontext || {};
    const system = prompts.getLocalePromptsForBook(locale, buchtyp, null, false).SYSTEM_LEKTORAT;
    const cap = effectiveStylisticCap(c.text.length);
    const opts = { langCode, locale, buchtyp, textsorte, stylisticCap: cap, ...kontext };
    const maxTokens = lektoratMaxTokens(c.text.length);
    // Gültige Typen wie checkOnePage: ohne Fakten kein weltfakt/soziolekt.
    const validTypen = new Set(prompts.lektoratTypen(buchtyp, { textsorte }).filter(t =>
      (t !== 'weltfakt' || (kontext.weltfakten || []).length) && (t !== 'soziolekt' || (kontext.soziolekte || []).length)));
    const usage = { calls: 0, tokIn: 0, tokOut: 0, cacheRead: 0, cacheWrite: 0 };

    const call = async (prompt, schema) => {
      const res = await withJobBag(() => callAI(prompt, system, null, maxTokens, null, provider, schema));
      usage.calls++;
      usage.tokIn += res.tokensIn || 0;
      usage.tokOut += res.tokensOut || 0;
      usage.cacheRead += res.cacheReadIn || 0;
      usage.cacheWrite += res.cacheCreationIn || 0;
      if (res.truncated) throw new Error('truncated (Ausgabe-Deckel erreicht)');
      const parsed = typeof res.text === 'string' ? parseJSON(res.text) : res.text;
      if (!Array.isArray(parsed?.fehler)) throw new Error('fehler-Array fehlt');
      return parsed.fehler;
    };
    const objektivPass = () => call(
      prompts.buildObjektivLektoratPrompt(c.text, opts),
      prompts.buildObjektivLektoratSchema({ buchtyp, textsorte, hasFiguren: (kontext.figuren || []).length > 0 }),
    );
    const neighbour = { text: c.text, excerpts: [] };

    const t0 = Date.now();
    let fehler;
    if (mode === 'kombi') {
      const ki = await call(prompts.buildLektoratPrompt(c.text, opts), prompts.buildLektoratSchema({ buchtyp, textsorte }));
      fehler = finalizeFehler(ki, locale, validTypen, neighbour);
    } else if (mode === 'split') {
      const [obj, stil] = await Promise.all([
        objektivPass(),
        call(prompts.buildStilLektoratPrompt(c.text, opts), prompts.buildLektoratSchema({ buchtyp, textsorte, stilOnly: true })),
      ]);
      fehler = finalizeFehler(mergePasses([obj, stil], c.text), locale, validTypen, neighbour);
    } else {
      throw new Error(`Unbekannter Modus: ${mode}`);
    }
    const ms = Date.now() - t0;

    const profil = prompts.lektoratProfil(buchtyp);
    const regel = prompts.lektoratTypen(buchtyp).includes('dialogformat')
      ? checkDialogformat(c.text, langCode, { locale, sachtext: profil !== 'narrativ' })
      : [];
    return { findings: mergeRegelBefunde(fehler, regel, c.text), usage, ms };
  }

  // Überlappung: f.original und Ziel-String treffen dieselbe Textstelle. Positional
  // im Falltext, weil das Modell den Span oft etwas anders schneidet als die Nadel
  // («?“ fragte sie» statt «morgen?“ fragte»); ohne Fundstelle per Enthaltensein.
  const oneLine = (s) => String(s || '').replace(/\n/g, '⏎');
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const overlaps = (original, target, text) => {
    const a = norm(original), b = norm(target);
    if (!a || !b) return false;
    const t = norm(text);
    const i = t.indexOf(a), j = t.indexOf(b);
    if (i >= 0 && j >= 0) return i < j + b.length && j < i + a.length;
    return a.includes(b) || b.includes(a);
  };
  const hitsCatch = (f, m, text) => [m.needle, ...(m.alt || [])].some(n => overlaps(f.original, n, text));
  const objektivSet = new Set(OBJEKTIV_TYPEN);
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)} %` : '–');

  const summary = [];
  for (const mode of modes) summary.push(await runMode(mode));

  if (summary.length > 1) {
    console.log('  ════ Vergleich ════════════════════════════════════════════════════════');
    console.log('  Modus     Recall obj.   Recall stil   Typ ✔    FP   Befunde  Calls  Out-Tok  In-Tok(+Cache)  Ø s/Fall');
    for (const s of summary) {
      const inTot = s.usage.tokIn + s.usage.cacheRead + s.usage.cacheWrite;
      console.log(`  ${s.mode.padEnd(8)}  ${`${s.obj.found}/${s.obj.total}`.padEnd(12)}  ${`${s.stil.found}/${s.stil.total}`.padEnd(12)}  ${pct(s.typOk, s.obj.found + s.stil.found).padEnd(7)}  ${String(s.fp).padEnd(3)}  ${String(s.findings).padEnd(7)}  ${String(s.usage.calls).padEnd(5)}  ${String(s.usage.tokOut).padEnd(7)}  ${String(inTot).padEnd(14)}  ${(s.ms / 1000 / s.n).toFixed(1)}`);
    }
    console.log('');
  }

  async function runMode(mode) {
    console.log(`\n  Lektorat-Eval · ${modelLabel} · Modus: ${mode} · Set: ${set} · ${CASES.length} Fälle\n`);

    const results = await Promise.all(CASES.map(c =>
      analyze(c, mode).then(r => ({ ...r, err: null }), e => ({ findings: [], usage: null, ms: 0, err: e.message }))));

    const agg = {
      mode, n: CASES.length, obj: { found: 0, total: 0 }, stil: { found: 0, total: 0 },
      typOk: 0, fp: 0, findings: 0, ms: 0, usage: { calls: 0, tokIn: 0, tokOut: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const perTyp = new Map();   // typ → { found, total } über alle Fälle

    for (const [i, c] of CASES.entries()) {
      const { findings, usage, ms, err } = results[i];
      if (usage) for (const k of Object.keys(agg.usage)) agg.usage[k] += usage[k];
      agg.ms += ms;
      if (err) { console.log(`  ✖ ${c.id}: KI-Fehler – ${err}\n`); continue; }

      const hits = c.mustCatch.map(m => findings.find(f => hitsCatch(f, m, c.text)) || null);
      const fps = findings.filter(f => (c.cleanSpans || []).some(span => overlaps(f.original, span, c.text)));
      const found = hits.filter(Boolean).length;
      c.mustCatch.forEach((m, k) => {
        const bucket = objektivSet.has(m.typ) ? agg.obj : agg.stil;
        bucket.total++;
        const t = perTyp.get(m.typ) || { found: 0, total: 0 };
        t.total++;
        if (hits[k]) { bucket.found++; t.found++; if (hits[k].typ === m.typ) agg.typOk++; }
        perTyp.set(m.typ, t);
      });
      agg.fp += fps.length;
      agg.findings += findings.length;

      const recall = c.mustCatch.length ? `${found}/${c.mustCatch.length}` : '– (keine)';
      const u = usage ? `   ${usage.calls} Calls, ${usage.tokOut} Out-Tok, ${(ms / 1000).toFixed(1)} s` : '';
      console.log(`  ${c.id}`);
      console.log(`     Recall: ${recall}   Findings gesamt: ${findings.length}   False-Positives: ${fps.length}${u}`);
      c.mustCatch.forEach((m, k) => {
        const hit = hits[k];
        const typNote = hit && hit.typ !== m.typ ? `  (als ${hit.typ})` : '';
        console.log(`       ${hit ? '✔' : '✗ VERPASST'}  [${m.typ}] «${oneLine(m.needle)}»${typNote}${hit?.regel ? '  [regel]' : ''}`);
      });
      // Weder gepflanzt noch auf einem sauberen Satz: zur Sichtung, nicht gewertet.
      findings
        .filter(f => !c.mustCatch.some(m => hitsCatch(f, m, c.text)) && !fps.includes(f))
        .forEach(f => console.log(`       · sonstig   [${f.typ}${f.regel ? ', regel' : ''}] «${oneLine(f.original)}» → «${oneLine(f.korrektur)}» (${f.erklaerung})`));
      fps.forEach(f => console.log(`       ⚠ FALSE-POS  [${f.typ}${f.regel ? ', regel' : ''}] «${oneLine(f.original)}» → «${oneLine(f.korrektur)}» (${f.erklaerung})`));
      console.log('');
    }

    const totFound = agg.obj.found + agg.stil.found;
    const totCatch = agg.obj.total + agg.stil.total;
    const recallPct = totCatch ? Math.round((totFound / totCatch) * 100) : 100;
    console.log('  ────────────────────────────────────────');
    console.log(`  GESAMT   Recall: ${totFound}/${totCatch} (${recallPct}%)   objektiv ${agg.obj.found}/${agg.obj.total} · stil ${agg.stil.found}/${agg.stil.total}   Typ ✔ ${pct(agg.typOk, totFound)}   False-Positives: ${agg.fp}   Findings: ${agg.findings}`);
    console.log(`  Verbrauch: ${agg.usage.calls} Calls · Out ${agg.usage.tokOut} · In ${agg.usage.tokIn} + Cache-Read ${agg.usage.cacheRead} + Cache-Write ${agg.usage.cacheWrite}`);
    const missed = [...perTyp].filter(([, t]) => t.found < t.total).map(([typ, t]) => `${typ} ${t.found}/${t.total}`);
    if (missed.length) console.log(`  Verpasst je Typ: ${missed.join(' · ')}`);
    const ok = recallPct >= 80 && agg.fp === 0;
    console.log(`  Verdikt: ${ok ? '✔ gut' : '⚠ Aufmerksamkeit nötig'} (Ziel: Recall ≥ 80 %, 0 False-Positives)\n`);
    return agg;
  }
}

main().catch(e => { console.error(e); process.exit(1); });
