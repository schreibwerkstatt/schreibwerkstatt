'use strict';
// Client-Vertrag (contract/README.md): jede Operation, die macOS oder Android
// aufruft, läuft hier durch die echte Device-Token-Kette und wird gegen
// contract/openapi.json geprüft — Status, Request-Body, Antwort.
//
// Die Antworten landen, aufs Schema projiziert und normalisiert (Zeitstempel,
// zufällige Block-Ids, Job-Ids), als Fixtures in contract/fixtures/. Die
// Client-Repos dekodieren genau diese Dateien in ihren Unit-Tests — eine
// Server-Änderung, die ein Client-DTO brechen würde, zeigt sich so schon hier
// als Fixture-Diff und dort als roter Decoding-Test.
//
//   CONTRACT_UPDATE=1 node --test tests/integration/client-contract.test.js
//
// schreibt die Fixtures neu (nach einer gewollten Vertragsänderung; dann
// contract/CHANGELOG.md und ggf. contract/version.json mitziehen).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');

const { bootstrap } = require('./_helpers/setup');
const { validate, project, deref } = require('../../contract/tools/schema');
const { buildSpec } = require('../../contract/spec');

const FIXTURES = path.join(__dirname, '..', '..', 'contract', 'fixtures');
const UPDATE = process.env.CONTRACT_UPDATE === '1';
const spec = buildSpec();

let ctx;
let C;
let CASES;
let server;
let baseUrl;
let tokens;
const st = {};

// ── Normalisierung ─────────────────────────────────────────────────────────
// Zeitstempel: der geseedete Stand (T0) bleibt stehen, jeder vom Server
// erzeugte wird zu einem festen Platzhalter im SELBEN Format (ISO mit/ohne ms,
// SQLite-Form mit Leerzeichen) — der Client muss das Format dekodieren können,
// nicht die Uhrzeit. Eine Nummerierung nach Auftreten wäre nicht stabil: zwei
// Writes in derselben Millisekunde teilen sich einen Stempel.
const TS_RE = /^(\d{4}-\d\d-\d\d)([T ])(\d\d:\d\d:\d\d)(\.\d{3})?(Z?)$/;
const TS_IN_TEXT_RE = /\d{4}-\d\d-\d\dT\d\d(?::|%3A)\d\d(?::|%3A)\d\d\.\d{3}Z/g;
const T0 = '2026-01-01T00:00:00.000Z';
const bidMap = new Map();
const volatileStrings = new Map();

function synthTs(orig) {
  if (orig === T0) return orig;
  const m = TS_RE.exec(orig);
  return `2026-01-02${m[2]}00:00:00${m[4] ? '.000' : ''}${m[5]}`;
}

function normString(s) {
  if (TS_RE.test(s)) return synthTs(s);
  let out = s.replace(TS_IN_TEXT_RE, (hit) => {
    const enc = hit.includes('%3A');
    const ts = synthTs(enc ? decodeURIComponent(hit) : hit);
    return enc ? encodeURIComponent(ts) : ts;
  });
  for (const [v, ph] of volatileStrings) out = out.split(v).join(ph);
  // Vom Server neu vergebene Block-Ids (lib/html-clean.js#ensureBlockIds) sind
  // zufällig; die geseedeten (`c000…`) bleiben stehen.
  out = out.replace(/data-bid="([0-9a-f]{16})"/g, (all, bid) => {
    if (bid.startsWith('c00000000000')) return all;
    if (!bidMap.has(bid)) bidMap.set(bid, `f${String(bidMap.size + 1).padStart(15, '0')}`);
    return `data-bid="${bidMap.get(bid)}"`;
  });
  return out;
}

function normalize(v) {
  if (typeof v === 'string') return normString(v);
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)]));
  return v;
}

// ── Spec-Zugriff ───────────────────────────────────────────────────────────
function operation(op) {
  const [method, p] = op.split(' ');
  const o = spec.paths[p]?.[method.toLowerCase()];
  assert.ok(o, `Operation ${op} fehlt in contract/spec/paths.js`);
  return o;
}

function responseSchema(op, status) {
  const r = operation(op).responses[status];
  assert.ok(r, `${op}: Status ${status} ist im Vertrag nicht dokumentiert`);
  return r;
}

const val = (value, schema, label) => {
  const errs = validate(value, schema, spec);
  assert.deepEqual(errs, [], `${label} verletzt den Vertrag:\n  ${errs.join('\n  ')}`);
};

// ── Lauf ───────────────────────────────────────────────────────────────────
async function send(c) {
  const p = typeof c.path === 'function' ? c.path(st) : c.path;
  const headers = { ...(typeof c.headers === 'function' ? c.headers(st) : c.headers || {}) };
  const token = c.token === 'capture' ? tokens.captureToken
    : c.token === 'invalid' ? `swd_${'0'.repeat(64)}` : tokens.deviceToken;
  const sent = { method: c.method || 'GET', path: p };
  const contractHeaders = Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'If-None-Match'));
  if (Object.keys(contractHeaders).length) sent.headers = contractHeaders;
  const all = { ...headers, Authorization: `Bearer ${token}`, 'X-Client-Version': 'contract/1', 'X-Client-Platform': 'macos' };
  let bodyText;
  if (c.body) {
    sent.body = c.body(st);
    bodyText = JSON.stringify(sent.body);
    all['Content-Type'] = 'application/json';
  }
  for (let i = 0; ; i++) {
    const res = await fetch(`${baseUrl}${p}`, { method: sent.method, headers: all, body: bodyText });
    if (!c.waitDone) return { res, sent };
    const j = await res.clone().json();
    if (['done', 'error', 'cancelled'].includes(j.status) || i > 200) return { res, sent };
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function readBody(c, res, op) {
  if (c.raw === 'empty') return null;
  if (c.raw === 'text') return res.text();
  if (c.raw === 'zip') {
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const manifest = JSON.parse(await zip.file('bundle-manifest.json').async('string'));
    for (const f of [...manifest.jsFiles, ...manifest.cssFiles]) assert.ok(zip.file(f), `Bundle: ${f} im Manifest, aber nicht im ZIP`);
    val(manifest, responseSchema(op, 200)['x-manifest'], 'bundle-manifest.json');
    return project(manifest, responseSchema(op, 200)['x-manifest'], spec);
  }
  return res.json();
}

test.before(async () => {
  ctx = bootstrap();
  C = require('./_helpers/contract-app');
  ({ CASES } = require('./_helpers/contract-cases'));
  ctx.mockAi.on({ schemaHas: 'fehler' }, {
    fehler: [{ typ: 'stil', original: 'Erster Absatz', korrektur: 'Erster Abschnitt', erklaerung: 'Vertragsbeispiel.' }],
    szenen: [], stilanalyse: '', fazit: '',
  });
  ctx.mockAi.on({ schemaHas: 'synonyme' }, { synonyme: [{ wort: 'Abschnitt', hinweis: 'neutral' }] });
  tokens = C.seed(require('../../db/schema').db);
  server = C.buildApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  if (UPDATE) fs.mkdirSync(FIXTURES, { recursive: true });
});
test.after(() => {
  if (server) server.close();
  ctx.cleanup();
});

test('Fälle: jede Operation auf einem Vertragsfall', () => {
  const covered = new Set(CASES.map((c) => c.op));
  const missing = [];
  for (const [p, methods] of Object.entries(spec.paths)) {
    for (const [m, o] of Object.entries(methods)) {
      const op = `${m.toUpperCase()} ${p}`;
      if (!o['x-contract-untested'] && !covered.has(op)) missing.push(op);
    }
  }
  assert.deepEqual(missing, [], 'Operation ohne Vertragsfall (oder `x-contract-untested` mit Begründung setzen)');
  const names = CASES.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, 'Fallnamen doppelt');
});

test('Fälle laufen in Reihenfolge gegen den Vertrag', async (t) => {
  for (const c of CASES) {
    await t.test(c.name, async () => {
      const { res, sent } = await send(c);
      const op = c.op;
      const r = responseSchema(op, res.status);
      const text = c.raw ? null : await res.clone().text();
      assert.equal(res.status, c.status, `${c.name}: Status ${res.status} statt ${c.status}${text ? ` — ${text.slice(0, 300)}` : ''}`);

      const reqSchema = operation(op).requestBody?.content?.['application/json']?.schema;
      if (reqSchema && sent.body && c.status < 400) val(sent.body, reqSchema, `${c.name}: Request-Body`);

      let body = await readBody(c, res, op);
      if (c.after) c.after(body, st, res);
      for (const v of (c.volatile ? c.volatile(st) : [])) if (v) volatileStrings.set(v, '<job-id>');

      const schema = r.content?.['application/json']?.schema;
      if (schema) {
        val(body, schema, `${c.name}: Antwort`);
        body = project(body, schema, spec);
      }
      const fixture = { operation: op, request: normalize(sent), status: res.status, response: normalize(body) };
      const file = path.join(FIXTURES, `${c.name}.json`);
      if (UPDATE) {
        fs.writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
      } else {
        assert.ok(fs.existsSync(file), `Fixture ${c.name}.json fehlt — CONTRACT_UPDATE=1 node --test ${path.relative(process.cwd(), __filename)}`);
        assert.deepEqual(fixture, JSON.parse(fs.readFileSync(file, 'utf8')),
          `Fixture ${c.name}.json weicht ab — gewollte Vertragsänderung? Dann CONTRACT_UPDATE=1, CHANGELOG + version.json (contract/README.md)`);
      }
    });
  }
});

test('keine verwaisten Fixtures', () => {
  const names = new Set(CASES.map((c) => `${c.name}.json`));
  const orphans = fs.existsSync(FIXTURES) ? fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json') && !names.has(f)) : [];
  assert.deepEqual(orphans, [], 'Fixture ohne Fall — löschen oder Fall ergänzen');
});

test('jedes $ref im Vertrag löst auf', () => {
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      if (v.$ref) deref(v, spec);
      Object.values(v).forEach(walk);
    }
  };
  walk(spec);
});
