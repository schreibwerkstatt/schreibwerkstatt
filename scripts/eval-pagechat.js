'use strict';
// Abschnitts-Chat-Eval — NICHT Teil von `npm test` (echte KI-Calls, kostet Geld).
// Spielt echte Fragen mit dem echten Job gegen eine Prod-Kopie ab und vergleicht
// Varianten (Settings oder Code-Stand) über Regeln und einen blinden Paarvergleich.
// Anleitung, Datenschutz, Kosten: eval/pagechat/README.md.
//
//   npm run eval:pagechat -- --prepare=/pfad/prod.db                 Eval-DB anlegen
//   npm run eval:pagechat -- --pick --db=/pfad/eval-pagechat.db       Fälle wählen
//   npm run eval:pagechat -- --db=… --label=ist                       Lauf
//   npm run eval:pagechat -- --db=… --label=kompakt --set=jobs.page_chat.figuren_modus=kompakt
//   npm run eval:pagechat -- --db=… --compare=ist,kompakt             Paarvergleich

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const CASES_FILE = path.join(ROOT, 'eval/pagechat/cases.json');
const args = process.argv.slice(2);
const arg = (name) => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const flag = (name) => args.includes(`--${name}`);
const argsAll = (name) => args.filter(x => x.startsWith(`--${name}=`)).map(x => x.slice(name.length + 3));
const usd = (n) => `${(n || 0).toFixed(2)} $`;

function die(msg) { console.error(`\n  ${msg}\n`); process.exit(2); }
function outDirFor(db) { const d = path.join(path.dirname(path.resolve(db)), 'eval-pagechat-out'); fs.mkdirSync(d, { recursive: true }); return d; }

async function main() {
  require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

  if (arg('prepare')) {
    const source = path.resolve(arg('prepare'));
    const target = path.resolve(arg('db') || path.join(path.dirname(source), 'eval-pagechat.db'));
    const { prepareEvalDb } = require('../eval/pagechat/prepare');
    const r = prepareEvalDb({ source, target, localDb: path.join(ROOT, 'schreibwerkstatt.db') });
    console.log(`\n  Eval-DB: ${target}\n  ${r.removed} Zugangsdaten entfernt, eingesetzt aus der lokalen DB: ${r.injected.join(', ') || '—'}\n`);
    return;
  }

  const dbArg = arg('db');
  if (!dbArg) die('--db=<Eval-DB> fehlt (anlegen mit --prepare=<Prod-Kopie>).');
  const evalDb = path.resolve(dbArg);
  if (!fs.existsSync(evalDb)) die(`Eval-DB fehlt: ${evalDb}`);
  const outDir = outDirFor(evalDb);

  if (flag('pick')) {
    const { pickCases } = require('../eval/pagechat/cases');
    const cases = pickCases(evalDb, { days: Number(arg('days') || 90) });
    fs.writeFileSync(CASES_FILE, JSON.stringify(cases, null, 2) + '\n');
    console.log(`\n  ${cases.length} Fälle → ${path.relative(ROOT, CASES_FILE)}\n`);
    return;
  }

  if (arg('compare')) return compare(evalDb, outDir, arg('compare').split(','));
  return run(evalDb, outDir);
}

async function run(evalDb, outDir) {
  const label = arg('label');
  if (!label || !/^[\w.-]+$/.test(label)) die('--label=<name> fehlt (Buchstaben, Ziffern, . _ -).');
  const maxUsd = Number(arg('max-usd') || 15);
  let cases = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'));
  const only = (arg('only') || '').split(',').filter(Boolean);
  if (only.length) cases = cases.filter(c => only.includes(c.id));
  if (arg('limit')) cases = cases.slice(0, Number(arg('limit')));

  // Wegwerf-Kopie: der Lauf schreibt Nachrichten, Revisionen und Ledger.
  const work = path.join(outDir, `work-${label}.db`);
  fs.copyFileSync(evalDb, work);
  const overrides = argsAll('set').map(s => {
    const i = s.indexOf('=');
    if (i < 1) die(`--set erwartet key=wert: ${s}`);
    const key = s.slice(0, i), raw = s.slice(i + 1);
    let value; try { value = JSON.parse(raw); } catch { value = raw; }
    return { key, value };
  });
  const { validateValue, isKnownKey } = require('../lib/app-settings/registry');
  const Database = require('better-sqlite3');
  const wdb = new Database(work);
  for (const { key, value } of overrides) {
    if (!isKnownKey(key)) die(`Unbekanntes Setting: ${key}`);
    validateValue(key, value);
    wdb.prepare('INSERT OR REPLACE INTO app_settings (key, value_json, encrypted, updated_at, updated_by) VALUES (?, ?, 0, ?, ?)')
      .run(key, JSON.stringify(value), new Date().toISOString(), 'eval-pagechat');
  }
  wdb.close();

  process.env.DB_PATH = work;
  process.env.LOG_DIR = outDir;
  const appSettings = require('../lib/app-settings');
  if (!appSettings.get('ai.claude.api_key')) die('Kein Claude-Key in der Eval-DB (--prepare setzt ihn aus der lokalen DB).');

  console.log(`\n  Abschnitts-Chat-Eval · Lauf «${label}» · ${cases.length} Fälle · Deckel ${usd(maxUsd)}`);
  for (const o of overrides) console.log(`  Setting ${o.key} = ${JSON.stringify(o.value)}`);
  console.log('');
  const { runCases } = require('../eval/pagechat/replay');
  // Kostendeckel: vor jedem Fall geprüft; ein laufender Fall wird nicht abgebrochen.
  // Limit-Antwort der API (Org-Monatslimit, Rate-Limit): sofort stoppen.
  let spent = 0;
  let stopReason = null;
  const all = await runCases(cases, {
    shouldStop: () => {
      if (stopReason) return true;
      if (spent >= maxUsd) { stopReason = `Kostendeckel erreicht (${usd(spent)})`; return true; }
      return false;
    },
    onResult: (r) => {
      spent += r.usd || 0;
      // Der Job meldet nur den i18n-Key (job.error.aiHttpError); ob dahinter das
      // Org-Ausgabenlimit steckt, steht erst im Log. Jeder HTTP-Fehler der API stoppt
      // darum den Lauf — sonst laufen alle Restfälle gegen eine gesperrte API.
      if (/aiHttpError|rate.?limit|usage limit|\b429\b/i.test(r.error || '')) stopReason = `API-Fehler (${r.error}) — Details im Log`;
    },
  });
  if (stopReason) console.log(`  ${stopReason} — Rest übersprungen.`);

  const file = path.join(outDir, `${label}.json`);
  fs.writeFileSync(file, JSON.stringify({ label, created: new Date().toISOString(), overrides, ...all }, null, 1));
  fs.rmSync(work, { force: true });
  summarize(label, all.results);
  console.log(`  Ergebnis: ${file}\n`);
}

function summarize(label, results) {
  const ok = results.filter(r => !r.error);
  const sum = (f) => ok.reduce((n, r) => n + (f(r) || 0), 0);
  const tin = sum(r => r.usage.tokensIn), read = sum(r => r.usage.cacheRead);
  const c = (k) => sum(r => r.checks[k]);
  console.log(`\n  ── «${label}»: ${ok.length}/${results.length} ok · ${usd(sum(r => r.usd))} · Ø ${(sum(r => r.ms) / Math.max(1, ok.length) / 1000).toFixed(0)} s`);
  console.log(`     Input ${tin} Tokens (${tin ? Math.round(100 * read / tin) : 0} % aus Cache) · Output ${sum(r => r.usage.tokensOut)} Tokens`);
  console.log(`     Vorschläge ${c('vorschlaege')} (nicht gefunden ${c('nichtGefunden')}, mehrdeutig ${c('mehrdeutig')}, ohne Änderung ${c('ohneAenderung')}, gekappt ${c('gekappt')})`);
  console.log(`     Ideen ${c('ideen')} · Ideen-Änderungen ${c('ideenAenderungen')} · JSON-Fallback ${c('parseFallback')} · leere Antwort ${c('antwortLeer')}`);
  for (const r of results.filter(x => x.error)) console.log(`     ✖ ${r.id}: ${r.error}`);
}

async function compare(evalDb, outDir, labels) {
  if (labels.length !== 2) die('--compare=<a>,<b> erwartet genau zwei Läufe.');
  const [la, lb] = labels;
  const load = (l) => JSON.parse(fs.readFileSync(path.join(outDir, `${l}.json`), 'utf8'));
  const A = load(la), B = load(lb);
  const byId = new Map(B.results.map(r => [r.id, r]));
  const pairs = A.results.filter(r => !r.error && byId.get(r.id) && !byId.get(r.id).error).map(r => [r, byId.get(r.id)]);

  process.env.DB_PATH = evalDb;
  process.env.LOG_DIR = outDir;
  const { callAI, parseJSON } = require('../lib/ai');
  const { JSON_ONLY } = await import(pathToFileURL(path.join(ROOT, 'public/js/prompts/state.js')).href);
  const { judgePair } = require('../eval/pagechat/judge');

  console.log(`\n  Paarvergleich «${la}» ↔ «${lb}» · ${pairs.length} Fälle\n`);
  const verdicts = [];
  for (const [a, b] of pairs) {
    try {
      const v = await judgePair(a, b, A.refs[a.ref] ?? B.refs[b.ref] ?? '', { callAI, parseJSON, jsonOnly: JSON_ONLY });
      verdicts.push({ id: a.id, ...v });
      console.log(`  ${a.id}: ${v.winner === 'gleich' ? 'gleich' : v.winner === 'a' ? la : lb}`);
    } catch (e) {
      verdicts.push({ id: a.id, error: e.message });
      console.log(`  ${a.id}: ✖ ${e.message}`);
    }
  }
  const n = (w) => verdicts.filter(v => v.winner === w).length;
  console.log(`\n  ══ «${lb}» besser: ${n('b')} · gleich: ${n('gleich')} · «${la}» besser: ${n('a')} (von ${verdicts.length})`);
  const cost = (R) => R.results.reduce((s, r) => s + (r.usd || 0), 0);
  console.log(`  Kosten der Läufe: «${la}» ${usd(cost(A))} · «${lb}» ${usd(cost(B))}`);
  summarize(la, A.results.filter(r => byId.has(r.id)));
  summarize(lb, B.results);
  const losses = verdicts.filter(v => v.winner === 'a');
  if (losses.length) {
    console.log(`\n  Fälle, in denen «${lb}» verliert:`);
    for (const v of losses) console.log(`   • ${v.id}: ${v.begruendung}\n     Mängel «${lb}»: ${(v.maengel_b || []).join(' / ') || '—'}`);
  }
  const file = path.join(outDir, `compare-${la}-vs-${lb}.json`);
  fs.writeFileSync(file, JSON.stringify({ a: la, b: lb, created: new Date().toISOString(), verdicts }, null, 1));
  console.log(`\n  Ergebnis: ${file}\n`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
