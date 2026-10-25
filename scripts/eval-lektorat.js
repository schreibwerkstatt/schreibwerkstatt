'use strict';
// Manuelle Output-Qualitäts-Eval für das Lektorat – NICHT Teil von `npm test`
// (macht echte KI-Calls, kostet Tokens, braucht einen konfigurierten Provider).
//
//   npm run eval:lektorat                      Kombi- und Split-Prompt
//   npm run eval:lektorat -- --mode=split      nur Split (Objektiv- + Stil-Pass)
//   EVAL_PROVIDER=claude npm run eval:lektorat Provider erzwingen
//   EVAL_ONLY=id1,id2 npm run eval:lektorat    nur diese Gold-Fälle
//
// Wie im Job: Locale und Buchtyp je Fall (System-Prompt der Locale, Profil des
// Buchtyps), und die regelbasierten Dialogformat-Befunde (lib/dialogformat-rules.js)
// kommen zu den KI-Befunden dazu — im Report mit [regel] markiert.
//
// Baut für jeden Gold-Fall (eval/lektorat/gold.mjs) den echten Lektorat-Prompt,
// ruft callAI mit dem konfigurierten Provider (Claude/Ollama/OpenAI-compat) und
// bewertet die Findings gegen die kuratierten Erwartungen:
//   • RECALL   – Anteil der gepflanzten objektiven Fehler, die gefunden wurden.
//   • FALSE-POS – Findings, die einen als KORREKT markierten Satz anstreichen.
//
// So wird eine Prompt-Änderung messbar: vorher/nachher laufen lassen und die
// Recall-/FP-Zahlen vergleichen. Eine Handvoll Fälle ist keine Statistik, aber
// ein verlässlicher Regress-Wecker.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const ROOT = path.resolve(__dirname, '..');
  // SESSION_SECRET entschlüsselt den API-Key in app_settings.
  require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
  const appSettings = require('../lib/app-settings');
  const { callAI, parseJSON, resolveProvider } = require('../lib/ai');
  const { checkDialogformat, mergeRegelBefunde } = require('../lib/dialogformat-rules');

  const provider = process.env.EVAL_PROVIDER || resolveProvider();
  const modeArg = (process.argv.find(a => a.startsWith('--mode=')) || '').slice(7);
  const modes = modeArg ? [modeArg] : ['kombi', 'split'];
  if (provider === 'claude' && !appSettings.get('ai.claude.api_key')) {
    console.error('\n  Kein Claude-API-Key konfiguriert (ai.claude.api_key). Eval abgebrochen.');
    console.error('  Setze den Key im Admin oder wechsle den Provider (ai.provider).\n');
    process.exit(2);
  }

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'prompt-config.json'), 'utf8'));
  const prompts = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'prompts.js')).href);
  prompts.configurePrompts(cfg, provider);
  const { GOLD_CASES: ALL_CASES } = await import(pathToFileURL(path.join(ROOT, 'eval', 'lektorat', 'gold.mjs')).href);
  const only = (process.env.EVAL_ONLY || '').split(',').filter(Boolean);
  const GOLD_CASES = only.length ? ALL_CASES.filter(c => only.includes(c.id)) : ALL_CASES;

  // Ein Lauf eines Falls wie im Job: Kombi = ein Call, Split = Objektiv- + Stil-Pass.
  async function analyze(c, mode) {
    const locale = c.locale || 'de-CH';
    const langCode = locale.split('-')[0];
    const buchtyp = c.buchtyp || 'roman';
    const system = prompts.getLocalePromptsForBook(locale, buchtyp, null, false).SYSTEM_LEKTORAT;
    const opts = { langCode, locale, buchtyp };
    const call = async (prompt, schema) => {
      const res = await callAI(prompt, system, null, null, null, provider, schema);
      const parsed = typeof res.text === 'string' ? parseJSON(res.text) : res.text;
      return Array.isArray(parsed?.fehler) ? parsed.fehler : [];
    };
    let ki;
    if (mode === 'split') {
      const [obj, stil] = await Promise.all([
        call(prompts.buildObjektivLektoratPrompt(c.text, opts), prompts.buildObjektivLektoratSchema({ buchtyp, hasFiguren: false })),
        call(prompts.buildStilLektoratPrompt(c.text, opts), prompts.buildLektoratSchema({ buchtyp, stilOnly: true })),
      ]);
      ki = [...obj, ...stil];
    } else {
      ki = await call(prompts.buildLektoratPrompt(c.text, opts), prompts.buildLektoratSchema({ buchtyp }));
    }
    const profil = prompts.lektoratProfil(buchtyp);
    const regel = prompts.lektoratTypen(buchtyp).includes('dialogformat')
      ? checkDialogformat(c.text, langCode, { locale, sachtext: profil !== 'narrativ' })
      : [];
    return mergeRegelBefunde(ki, regel, c.text);
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

  for (const mode of modes) await runMode(mode);

  async function runMode(mode) {
  console.log(`\n  Lektorat-Eval · Provider: ${provider} · Modus: ${mode} · ${GOLD_CASES.length} Fälle\n`);

  let totCatch = 0, totFound = 0, totFP = 0, totFindings = 0;
  const rows = [];

  const results = await Promise.all(GOLD_CASES.map(c =>
    analyze(c, mode).then(findings => ({ findings, err: null }), e => ({ findings: [], err: e.message }))));
  for (const [i, c] of GOLD_CASES.entries()) {
    const { findings, err } = results[i];

    const foundFlags = c.mustCatch.map(m => findings.some(f => overlaps(f.original, m.needle, c.text)));
    const found = foundFlags.filter(Boolean).length;
    const fps = findings.filter(f => (c.cleanSpans || []).some(span => overlaps(f.original, span, c.text)));

    totCatch += c.mustCatch.length;
    totFound += found;
    totFP += fps.length;
    totFindings += findings.length;

    rows.push({ c, found, foundFlags, fps, findings, err });
  }

  // Detail-Report
  for (const { c, found, foundFlags, fps, findings, err } of rows) {
    if (err) { console.log(`  ✖ ${c.id}: KI-Fehler – ${err}\n`); continue; }
    const recall = c.mustCatch.length ? `${found}/${c.mustCatch.length}` : '– (keine)';
    console.log(`  ${c.id}`);
    console.log(`     Recall: ${recall}   Findings gesamt: ${findings.length}   False-Positives: ${fps.length}`);
    c.mustCatch.forEach((m, i) => {
      const hit = findings.find(f => overlaps(f.original, m.needle, c.text));
      console.log(`       ${foundFlags[i] ? '✔' : '✗ VERPASST'}  [${m.typ}] «${m.needle}»${hit?.regel ? '  [regel]' : ''}`);
    });
    // Weder gepflanzt noch auf einem sauberen Satz: zur Sichtung, nicht gewertet.
    findings
      .filter(f => !c.mustCatch.some(m => overlaps(f.original, m.needle, c.text)) && !fps.includes(f))
      .forEach(f => console.log(`       · sonstig   [${f.typ}${f.regel ? ', regel' : ''}] «${oneLine(f.original)}» → «${oneLine(f.korrektur)}» (${f.erklaerung})`));
    fps.forEach(f => console.log(`       ⚠ FALSE-POS  [${f.typ}${f.regel ? ', regel' : ''}] «${f.original}» → «${f.korrektur}» (${f.erklaerung})`));
    console.log('');
  }

  // Aggregat
  const recallPct = totCatch ? Math.round((totFound / totCatch) * 100) : 100;
  console.log('  ────────────────────────────────────────');
  console.log(`  GESAMT   Recall: ${totFound}/${totCatch} (${recallPct}%)   False-Positives: ${totFP}   Findings: ${totFindings}`);
  const ok = recallPct >= 80 && totFP === 0;
  console.log(`  Verdikt: ${ok ? '✔ gut' : '⚠ Aufmerksamkeit nötig'} (Ziel: Recall ≥ 80 %, 0 False-Positives)\n`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
