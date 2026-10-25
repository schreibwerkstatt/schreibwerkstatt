'use strict';
// Strukturerhaltendes Kürzen der Werkzeug-Ergebnisse (routes/jobs/chat-tools/truncate.js).
// Regression: die frühere Fassung rekursierte endlos, wenn `results` 6–10 Einträge
// hatte und trotzdem zu gross war; Ergebnisse ohne `results` wurden hart als String
// geschnitten und verloren dabei Summen/hint am Ende.

const test = require('node:test');
const assert = require('node:assert/strict');
const { truncateToolResult } = require('../../routes/jobs/chat-tools/truncate');

const big = (n) => 'x'.repeat(n);

test('passt → unverändert (gleiche Referenz)', () => {
  const o = { a: 1, results: [1, 2] };
  assert.equal(truncateToolResult(o, 1000), o);
});

test('results mit 6–10 grossen Einträgen terminiert und passt', () => {
  for (let n = 6; n <= 10; n++) {
    const o = { query: 'q', results: Array.from({ length: n }, () => ({ snippet: big(3000) })) };
    const out = truncateToolResult(o, 4000);
    assert.ok(JSON.stringify(out).length <= 4000, `n=${n} zu gross`);
    assert.equal(out.truncated, true);
    assert.equal(out.total_results, n);
    assert.equal(out.query, 'q');
  }
});

test('ein einzelnes riesiges Element: Strings werden gekürzt, Skalare bleiben', () => {
  const o = { total: 7, hint: 'h', results: [{ text: big(50000) }] };
  const out = truncateToolResult(o, 3000);
  assert.ok(JSON.stringify(out).length <= 3000);
  assert.equal(out.total, 7);
  assert.equal(out.hint, 'h');
  assert.equal(out.results.length, 1);
});

test('Ergebnis ohne results: grösstes Array (pages/items/chapters) wird halbiert, truncated_fields', () => {
  const o = {
    total_pages: 40, total_words: 9999, hint: 'Hinweis',
    pages: Array.from({ length: 40 }, (_, i) => ({ page_id: i, text: big(500) })),
    items: [{ a: 1 }],
  };
  const out = truncateToolResult(o, 6000);
  assert.ok(JSON.stringify(out).length <= 6000);
  assert.equal(out.total_pages, 40);
  assert.equal(out.total_words, 9999);
  assert.equal(out.hint, 'Hinweis');
  assert.ok(out.pages.length < 40 && out.pages.length >= 1);
  assert.deepEqual(out.truncated_fields.pages, { shown: out.pages.length, total: 40 });
  assert.deepEqual(out.items, [{ a: 1 }]);
});

test('vorhandenes total_results des Tools wird nicht überschrieben', () => {
  const o = { total_results: 500, results: Array.from({ length: 30 }, () => ({ s: big(400) })) };
  const out = truncateToolResult(o, 3000);
  assert.equal(out.total_results, 500);
});

test('letzter Ausweg harter Schnitt bleibt unter dem Deckel', () => {
  const o = {};
  for (let i = 0; i < 400; i++) o['k' + i] = i;
  const out = truncateToolResult(o, 500);
  assert.ok(JSON.stringify(out).length <= 600);
  assert.ok(out._truncated.startsWith('{"k0":0'));
});

test('Nicht-Objekte gehen unverändert durch', () => {
  assert.equal(truncateToolResult(null, 10), null);
  assert.equal(truncateToolResult('abc', 1), 'abc');
});
