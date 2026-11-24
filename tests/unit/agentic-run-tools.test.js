'use strict';
// Werkzeug-Runde des agentischen Loops (routes/jobs/agentic-chat/run-tools.js)
// direkt: Rundenbudget, abgewiesene Aufrufe, Kürzung, Abbruch vs. Timeout.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeToolRunner } = require('../../routes/jobs/agentic-chat/run-tools');

const logger = { info() {}, warn() {} };

function runner({ results = {}, throws = {}, offered = ['big', 'small', 'propose_x'], caps = {}, jobSignal } = {}) {
  const toolLog = [];
  const counters = { skipped: 0, notOffered: 0, failed: 0 };
  const run = makeToolRunner({
    executeTool: async (name) => {
      if (throws[name]) throw throws[name]();
      return typeof results[name] === 'function' ? results[name]() : (results[name] ?? { ok: true });
    },
    ctx: {},
    offered: new Set(offered),
    caps: {
      maxToolsPerRound: 8, roundResultCap: 6000, toolResultCaps: {}, capFor: () => 5000,
      collectTools: new Set(['propose_x']), ...caps,
    },
    toolLog, toolView: () => null, logger, jobSignal, publishLive() {}, counters,
  });
  return { run, toolLog, counters };
}
const tu = (name, id, extra = {}) => ({ id, name, input: {}, ...extra });

test('Rundenbudget erschöpft: abgewiesene Aufrufe behalten ihre ganze Meldung (kein «…»)', async () => {
  const { run } = runner({ results: { big: { text: 'x'.repeat(5900) } } });
  const out = await run([tu('big', 'a'), tu('big', 'b'), tu('big', 'c'), tu('big', 'd')], 1);
  assert.equal(out.length, 4);
  for (const r of out.slice(2)) {
    assert.notEqual(r.content, '…');
    const parsed = JSON.parse(r.content);
    assert.match(parsed.error, /nächsten Runde/);
  }
});

test('Ergebnis grösser als Rest des Rundenbudgets: strukturiert gekürzt, gültiges JSON, Summen bleiben', async () => {
  const { run } = runner({
    caps: { roundResultCap: 9000 },
    results: { big: () => ({ total_results: 99, hint: 'vorn', results: Array.from({ length: 80 }, (_, i) => ({ i, s: 'y'.repeat(90) })) }) },
  });
  const out = await run([tu('big', 'a'), tu('big', 'b')], 1);
  const second = JSON.parse(out[1].content);
  assert.equal(second.total_results, 99);
  assert.equal(second.hint, 'vorn');
  assert.equal(second.truncated, true);
});

test('Sammel-Werkzeug (propose_*) läuft auch bei ausgeschöpftem Rundenbudget', async () => {
  const { run, toolLog } = runner({ caps: { roundResultCap: 5000 }, results: { big: { text: 'x'.repeat(4900) }, propose_x: { ok: true } } });
  await run([tu('big', 'a'), tu('propose_x', 'p')], 1);
  const p = toolLog.find(e => e.name === 'propose_x');
  assert.equal(p.skipped, undefined, 'Vorschlag nicht abgewiesen');
  assert.equal(p.ok, true);
});

test('nicht angebotenes Werkzeug mit kaputtem JSON: «nicht angeboten», nicht «wiederhole»', async () => {
  const { run, toolLog, counters } = runner();
  await run([tu('get_secret', 'a', { parseError: 'Unexpected token' })], 1);
  assert.equal(toolLog[0].errorKey, 'chat.toolError.notOffered');
  assert.equal(counters.notOffered, 1);
});

test('AbortError ohne Job-Abbruch (Timeout im Werkzeug) = Werkzeug-Fehler, Lauf geht weiter', async () => {
  // Wie lib/http-util.js#fetchWithTimeout: AbortError mit eigenem Code.
  const timeout = () => Object.assign(new Error('timeout'), { name: 'AbortError', code: 'FETCH_TIMEOUT' });
  const { run, toolLog } = runner({ throws: { small: timeout } });
  const out = await run([tu('small', 'a')], 1);
  assert.equal(out[0].is_error, true);
  assert.equal(toolLog[0].ok, false);
});

test('AbortError bei abgebrochenem Job wird weitergeworfen', async () => {
  const ac = new AbortController();
  const { run } = runner({ jobSignal: ac.signal, throws: { small: () => { ac.abort(); return new DOMException('x', 'AbortError'); } } });
  await assert.rejects(run([tu('small', 'a')], 1), { name: 'AbortError' });
});

test('harter Schnitt halbiert kein Emoji (gültiges UTF-16 an den Provider)', async () => {
  // Kein Array, ein String knapp über dem Deckel, Emoji genau an der Schnittkante.
  const { run } = runner({ caps: { roundResultCap: 100000, capFor: () => 50 }, results: { big: '😀'.repeat(60) } });
  const out = await run([tu('big', 'a')], 1);
  assert.equal(out[0].content.isWellFormed(), true);
});
