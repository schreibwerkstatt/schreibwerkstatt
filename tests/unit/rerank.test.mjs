// Reranker-Client (lib/rerank.js): Antwort-Parsing (Jina/Cohere-Schema) +
// Retry-Klassifikation. Pure Helfer, kein Netz/DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';

// Temp-DB, damit das Require von app-settings (via rerank.js) die Dev-DB nicht anfasst.
useTmpDb('rerank');

const require = createRequire(import.meta.url);
const { _parseRerankResponse, _withRetry } = require('../../lib/rerank.js');

test('_parseRerankResponse: results mit relevance_score → absteigend sortiert', () => {
  const json = { results: [
    { index: 0, relevance_score: 0.2 },
    { index: 1, relevance_score: 0.9 },
    { index: 2, relevance_score: 0.5 },
  ] };
  const out = _parseRerankResponse(json, 3);
  assert.deepEqual(out.map(o => o.index), [1, 2, 0]);
  assert.equal(out[0].score, 0.9);
});

test('_parseRerankResponse: akzeptiert `score` und `data` als Aliase', () => {
  const json = { data: [{ index: 1, score: 0.7 }, { index: 0, score: 0.1 }] };
  const out = _parseRerankResponse(json, 2);
  assert.deepEqual(out.map(o => o.index), [1, 0]);
});

test('_parseRerankResponse: verwirft Out-of-Range-, fehlende- und Duplikat-Indizes', () => {
  const json = { results: [
    { index: 0, relevance_score: 0.8 },
    { index: 5, relevance_score: 0.9 },   // out of range (nDocs=2)
    { index: 0, relevance_score: 0.4 },   // Duplikat → verworfen
    { relevance_score: 0.7 },             // ohne index → verworfen
    { index: 1 },                          // ohne score → verworfen
  ] };
  const out = _parseRerankResponse(json, 2);
  assert.deepEqual(out.map(o => o.index), [0]);
  assert.equal(out.length, 1);
});

test('_parseRerankResponse: fehlendes results-Array → wirft', () => {
  assert.throws(() => _parseRerankResponse({ foo: 1 }, 3), /results/);
});

test('_withRetry: transient → Erfolg nach Retries; nicht-transient → sofort', async () => {
  let calls = 0;
  const out = await _withRetry(async () => {
    calls++;
    if (calls < 2) { const e = new Error('blip'); e.retriable = true; throw e; }
    return 'ok';
  }, { retries: 3, baseMs: 1 });
  assert.equal(out, 'ok');
  assert.equal(calls, 2);

  let c2 = 0;
  await assert.rejects(
    () => _withRetry(async () => { c2++; throw new Error('HTTP 400'); }, { retries: 3, baseMs: 1 }),
    /400/,
  );
  assert.equal(c2, 1);
});

test('_rerankBatched: Pakete ≤ batchSize, globale Indizes, absteigend gemischt', async () => {
  const { _rerankBatched } = require('../../lib/rerank.js');
  const docs = Array.from({ length: 70 }, (_, i) => `d${i}`);
  const sizes = [];
  // Score = globale Position, damit die Zusammenführung prüfbar ist.
  const out = await _rerankBatched(docs, 32, async (part) => {
    sizes.push(part.length);
    return part.map((d, i) => ({ index: i, score: Number(d.slice(1)) / 100 })).reverse();
  });
  assert.deepEqual(sizes, [32, 32, 6]);
  assert.equal(out.length, 70);
  assert.deepEqual(out.slice(0, 3).map(o => o.index), [69, 68, 67]);
  assert.ok(out.every(o => docs[o.index] === `d${Math.round(o.score * 100)}`));
});

test('_rerankBatched: Fehler in einem Paket wirft (Aufrufer fällt zurück)', async () => {
  const { _rerankBatched } = require('../../lib/rerank.js');
  let n = 0;
  await assert.rejects(_rerankBatched(['a', 'b', 'c'], 2, async (part) => {
    if (++n === 2) throw new Error('HTTP 422');
    return part.map((_, i) => ({ index: i, score: 0.5 }));
  }), /422/);
});

// Circuit-Breaker: nach einem transienten Ausfall (alle Retries verbraucht)
// scheitern Folgeaufrufe sofort, ohne den Endpunkt erneut zu treffen — ein
// Anker-Job mit vielen Anfragen lief sonst je Anfrage die volle Retry-Kette.
test('rerank: Breaker öffnet nach transientem Ausfall, Folgeaufruf trifft den Endpunkt nicht', async (t) => {
  const rerankMod = require('../../lib/rerank.js');
  const appSettings = require('../../lib/app-settings.js');
  const embed = require('../../lib/embed.js');
  const origGet = appSettings.get, origEmbed = embed.isEnabled, origFetch = globalThis.fetch;
  const origBase = rerankMod._testing.retryBaseMs;
  t.after(() => {
    appSettings.get = origGet; embed.isEnabled = origEmbed; globalThis.fetch = origFetch;
    rerankMod._testing.retryBaseMs = origBase; rerankMod._resetBreaker();
  });
  const cfg = { 'rerank.enabled': true, 'rerank.host': 'http://rerank.test' };
  appSettings.get = (k) => (k in cfg ? cfg[k] : origGet(k));
  embed.isEnabled = () => true;
  rerankMod._testing.retryBaseMs = 1;
  rerankMod._resetBreaker();

  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('down', { status: 500 }); };
  await assert.rejects(rerankMod.rerank('q', ['a', 'b']), (e) => e.rerankDown === true && !e.breakerOpen);
  assert.equal(calls, 4, 'ein Versuch + drei Retries');

  await assert.rejects(rerankMod.rerank('q', ['a', 'b']), (e) => e.breakerOpen === true);
  assert.equal(calls, 4, 'offener Breaker trifft den Endpunkt nicht');

  // Nach Reset (= Cooldown abgelaufen) wird wieder probiert; Erfolg schliesst.
  rerankMod._resetBreaker();
  globalThis.fetch = async () => { calls++; return Response.json({ results: [{ index: 1, relevance_score: 0.9 }] }); };
  const out = await rerankMod.rerank('q', ['a', 'b']);
  assert.deepEqual(out.map(o => o.index), [1]);
  assert.equal(calls, 5);
});

test('rerank: nicht-transienter Fehler (4xx) öffnet den Breaker nicht', async (t) => {
  const rerankMod = require('../../lib/rerank.js');
  const appSettings = require('../../lib/app-settings.js');
  const embed = require('../../lib/embed.js');
  const origGet = appSettings.get, origEmbed = embed.isEnabled, origFetch = globalThis.fetch;
  t.after(() => {
    appSettings.get = origGet; embed.isEnabled = origEmbed; globalThis.fetch = origFetch;
    rerankMod._resetBreaker();
  });
  const cfg = { 'rerank.enabled': true, 'rerank.host': 'http://rerank.test' };
  appSettings.get = (k) => (k in cfg ? cfg[k] : origGet(k));
  embed.isEnabled = () => true;
  rerankMod._resetBreaker();

  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('bad', { status: 422 }); };
  await assert.rejects(rerankMod.rerank('q', ['a']), (e) => !e.rerankDown);
  await assert.rejects(rerankMod.rerank('q', ['a']), (e) => !e.breakerOpen);
  assert.equal(calls, 2);
});
