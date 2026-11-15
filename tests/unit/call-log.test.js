'use strict';
// Logzeile je KI-Call (routes/jobs/shared/call-log.js): Name aus Label bzw.
// umgebendem retryOnTransientAi-Label, Laufnummer je Job, Cache-Anteile, Fehlerzeile.
// Logging darf nie werfen.
const test = require('node:test');
const assert = require('node:assert/strict');

const logger = require('../../logger');
const { jobs } = require('../../routes/jobs/shared/state');
const { beginCallLog, markCallStarted, endCallLog, failCallLog, withCallLabel } = require('../../routes/jobs/shared/call-log');
const { retryOnTransientAi } = require('../../routes/jobs/shared/ai');

function capture(fn) {
  const lines = [];
  const { info, warn } = logger;
  logger.info = (m) => lines.push(['info', m]);
  logger.warn = (m) => lines.push(['warn', m]);
  return Promise.resolve(fn()).then(() => lines).finally(() => { logger.info = info; logger.warn = warn; });
}

test('Zeile je Call: Name, Laufnummer, Phase, Cache-Anteile, Modell', async () => {
  jobs.set('j1', { id: 'j1', statusText: 'job.phase.extractingChunks', statusParams: { kapitel: 'K4', n: 3 } });
  const lines = await capture(() => {
    const a = beginCallLog('j1', { label: 'objektiv 1/7', prompt: [{ type: 'text', text: 'x'.repeat(2000), cache_control: {} }, { type: 'text', text: 'y' }], system: [{ text: 'S', ttl: '1h' }, { text: 'C' }] });
    markCallStarted(a);
    endCallLog(a, { tokensIn: 30000, tokensOut: 2000, cacheReadIn: 20000, cacheCreationIn: 5000, cacheCreation1hIn: 1000, stopReason: 'end_turn', servedModel: 'm' }, 'claude');
    const b = beginCallLog('j1', { prompt: 'p', system: 'S' });
    endCallLog(b, { tokensIn: 10, tokensOut: 1 }, 'claude');
  });
  assert.equal(lines.length, 2);
  const [, l1] = lines[0];
  assert.match(l1, /^KI-Call #1 objektiv 1\/7 \[extractingChunks kapitel=K4 n=3\]/);
  assert.match(l1, /20\.0K gelesen/);
  assert.match(l1, /4\.0K\+1\.0K\(1h\) geschrieben/);
  assert.match(l1, /5\.0K ungecacht/);
  assert.match(l1, /claude\/m/);
  assert.match(l1, /Prompt 2 Blöcke 2\.0K\+1 Z\., 1 mit Cache · System 2 Blöcke 1\+1 Z\., 2 mit Cache/);
  assert.match(lines[1][1], /^KI-Call #2 \[extractingChunks/);
  assert.match(lines[1][1], /kein Cache/);
  jobs.delete('j1');
});

test('Label aus retryOnTransientAi, Wiederholung als Versuch 2', async () => {
  jobs.set('j2', { id: 'j2', statusText: 'job.phase.extracting' });
  const transient = Object.assign(new Error('overloaded'), { code: 'AI_TIMEOUT' });
  let attempt = 0;
  const lines = await capture(() => retryOnTransientAi(async () => {
    attempt++;
    const c = beginCallLog('j2', { tierLabel: 'extract', prompt: 'p', system: 'S' });
    if (attempt === 1) { failCallLog(c, transient, 'claude'); throw transient; }
    endCallLog(c, { tokensIn: 1, tokensOut: 1 }, 'claude');
    return 1;
  }, { label: 'Single-Pass Fakten (C)' }).catch(() => {}));
  const calls = lines.filter(([, m]) => m.startsWith('KI-Call'));
  assert.equal(calls.length, 2, JSON.stringify(lines));
  assert.match(calls[0][1], /^KI-Call #1 Single-Pass Fakten \(C\) \(extract\) \[extracting\] fehlgeschlagen nach .*keine Antwort.*overloaded/);
  assert.equal(calls[0][0], 'warn');
  assert.match(calls[1][1], /^KI-Call #2 Single-Pass Fakten \(C\) \(Versuch 2\) \(extract\)/);
  jobs.delete('j2');
});

test('ohne Job und mit kaputten Eingaben: kein Wurf', async () => {
  const lines = await capture(() => withCallLabel(null, () => {
    const c = beginCallLog('unbekannt', { prompt: null, system: undefined });
    endCallLog(c, null, 'x');
    failCallLog(c, undefined, 'x');
    endCallLog(null, null, 'x');
  }));
  assert.match(lines[0][1], /^KI-Call: 0↑/);
});
