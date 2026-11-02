#!/usr/bin/env node
'use strict';

// LLM-Richter für das Eval-Set des Fine-Tune-Exports (docs/finetuning.md#5-qualitäts-check).
//
//   node scripts/eval-judge.js eval.jsonl antworten.jsonl [--model M] [--endpoint URL] [--key K] [--out bewertung.jsonl]
//
// `antworten.jsonl`: eine Zeile je Antwort, `{ "i": <Zeilennummer im eval.jsonl, ab 0>, "answer": "…" }`.
// Ablauf je Frage: zuerst die Regeln (routes/jobs/finetune-export/lib/eval/score.js —
// dieselben wie compare_models.py), dann der Richter mit `judge`-Text, Referenz und
// Antwort über einen OpenAI-kompatiblen Endpunkt (`/v1/chat/completions`). Die
// Punkte des Richters werden auf das Regel-Maximum gedeckelt: verletzt eine
// Antwort ein `mustNotContain`, bekommt sie höchstens 1 (bei Ablehnungen 0),
// was immer der Richter sagt. Ausgabe: 0/1/2 + Begründung je Frage und eine
// Tabelle je Kategorie und `holdout`.
//
// Endpunkt und Modell: Flags, sonst EVAL_JUDGE_ENDPOINT/EVAL_JUDGE_MODEL/
// EVAL_JUDGE_KEY, sonst die App-Einstellungen `ai.openai-compat.host`/`.model`/
// `.api_key` (LiteLLM), wenn das Script im App-Verzeichnis mit DB läuft.

const fs = require('fs');
const path = require('path');
const { scoreRules } = require('../routes/jobs/finetune-export/lib/eval/score');

function parseArgs(argv) {
  const out = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out.files.push(a);
  }
  return out;
}

const readJsonl = (p) => fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

// Endpunkt aus Flags, Umgebung oder App-Einstellungen.
function resolveEndpoint(args) {
  let endpoint = args.endpoint || process.env.EVAL_JUDGE_ENDPOINT || '';
  let model = args.model || process.env.EVAL_JUDGE_MODEL || '';
  let key = args.key || process.env.EVAL_JUDGE_KEY || '';
  if (!endpoint || !model) {
    try {
      const settings = require('../lib/app-settings');
      endpoint = endpoint || settings.get('ai.openai-compat.host');
      model = model || settings.get('ai.openai-compat.model');
      key = key || settings.get('ai.openai-compat.api_key') || '';
    } catch { /* ohne App-DB: nur Flags/Umgebung */ }
  }
  return { endpoint: String(endpoint || '').replace(/\/+$/, ''), model, key };
}

const JUDGE_SYSTEM = [
  'Du bewertest die Antwort eines Sprachmodells, das als Buch mit Leserinnen und Lesern spricht.',
  'Skala: 2 = richtig (erfüllt die Bewertungsanweisung, nichts Erfundenes), 1 = teilweise, 0 = falsch.',
  'Antworte ausschliesslich mit JSON: {"score": 0|1|2, "reason": "<ein Satz>"}.',
].join(' ');

function judgePrompt(row, answer, rules) {
  return [
    `Frage: ${row.messages?.[row.messages.length - 1]?.content || ''}`,
    row.expected ? `Referenz (eine mögliche richtige Antwort, kein Pflichtwortlaut): ${row.expected}` : '',
    `Bewertungsanweisung: ${row.judge || '—'}`,
    rules.violations.length ? `Bereits festgestellte Regelverstösse: ${rules.violations.map(v => v.rule).join(', ')}` : '',
    `Antwort des Modells:\n${answer}`,
  ].filter(Boolean).join('\n\n');
}

async function askJudge({ endpoint, model, key }, row, answer, rules, timeoutMs = 120000) {
  const res = await fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      model, temperature: 0,
      messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: judgePrompt(row, answer, rules) }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = String(data?.choices?.[0]?.message?.content || '');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('keine JSON-Antwort: ' + text.slice(0, 120));
  const j = JSON.parse(m[0]);
  const score = Number(j.score);
  if (![0, 1, 2].includes(score)) throw new Error('ungültiger score: ' + j.score);
  return { score, reason: String(j.reason || '') };
}

// Punkte je Kategorie und holdout → Zeilen der Tabelle.
function summarize(results) {
  const groups = new Map();
  const add = (k, r) => {
    if (!groups.has(k)) groups.set(k, { n: 0, points: 0 });
    const g = groups.get(k);
    g.n++;
    g.points += r.score;
  };
  for (const r of results) {
    add(`${r.category}`, r);
    add(`holdout:${r.holdout || '–'}`, r);
    add('Total', r);
  }
  return [...groups.entries()].map(([k, g]) => ({ group: k, n: g.n, points: g.points, pct: Math.round((g.points / (2 * g.n)) * 100) }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [evalPath, answersPath] = args.files;
  if (!evalPath || !answersPath) {
    process.stderr.write('Aufruf: node scripts/eval-judge.js eval.jsonl antworten.jsonl [--model M] [--endpoint URL] [--key K] [--out datei]\n');
    process.exit(2);
  }
  const rows = readJsonl(evalPath);
  const answers = readJsonl(answersPath);
  const ep = resolveEndpoint(args);
  if (!ep.endpoint || !ep.model) {
    process.stderr.write('Kein Richter-Endpunkt: --endpoint/--model oder EVAL_JUDGE_ENDPOINT/EVAL_JUDGE_MODEL setzen.\n');
    process.exit(2);
  }
  const results = [];
  for (const { i, answer } of answers) {
    const row = rows[i];
    if (!row) { process.stderr.write(`Zeile ${i} fehlt im Eval-Set.\n`); continue; }
    const rules = scoreRules(answer, row);
    let judged;
    try {
      judged = await askJudge(ep, row, answer, rules);
    } catch (e) {
      judged = { score: rules.ok === false ? Math.min(1, rules.cap) : 0, reason: `Richter-Fehler: ${e.message}`, error: true };
    }
    const score = Math.min(judged.score, rules.cap);
    results.push({ i, category: row.category, holdout: row.holdout || null, score, judge: judged.score, cap: rules.cap,
      violations: rules.violations, reason: judged.reason, ...(judged.error ? { error: true } : {}) });
    process.stdout.write(`[${i}] ${row.category}${row.holdout ? ' · ' + row.holdout : ''}: ${score}/2 (Richter ${judged.score}, Regel-Max ${rules.cap}) — ${judged.reason}\n`);
  }
  const table = summarize(results);
  process.stdout.write('\n| Gruppe | Fragen | Punkte | Anteil |\n|---|---|---|---|\n');
  for (const r of table) process.stdout.write(`| ${r.group} | ${r.n} | ${r.points} / ${2 * r.n} | ${r.pct} % |\n`);
  if (args.out) fs.writeFileSync(path.resolve(args.out), results.map(r => JSON.stringify(r)).join('\n') + '\n');
}

if (require.main === module) main().catch(e => { process.stderr.write(e.stack + '\n'); process.exit(1); });

module.exports = { askJudge, summarize, resolveEndpoint, judgePrompt, main };
