// Drift-Berechnung „lohnt sich eine neue Fassung?" (lib/snapshot-drift.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeDrift } = require('../../lib/snapshot-drift.js');
const { diffSnapshots } = await import('../../public/js/book-snapshot-diff.js');

// buildBookJson-Format: { book:{settings}, tree:[{type:'page',srcId,html}…] }
function content(pages, settings = null) {
  return {
    book: { name: 'X', settings },
    tree: pages.map((p) => ({ type: 'page', srcId: p.id, name: p.name || '', html: p.html })),
  };
}

test('identischer Stand → 0% Drift, nicht empfehlenswert', () => {
  const c = content([{ id: 1, html: '<p>Es war einmal ein Wald.</p>' }]);
  const d = computeDrift({ baselineContent: c, currentContent: c });
  assert.equal(d.text.changePct, 0);
  assert.equal(d.text.unchangedPages, 1);
  assert.equal(d.worthwhile, false);
});

test('Voll-Umschrieb einer Seite → ~100% Drift', () => {
  const base = content([{ id: 1, html: '<p>alpha beta gamma delta</p>' }]);
  const cur = content([{ id: 1, html: '<p>eins zwei drei vier</p>' }]);
  const d = computeDrift({ baselineContent: base, currentContent: cur });
  assert.equal(d.text.changedPages, 1);
  assert.ok(d.text.changePct >= 90, `changePct=${d.text.changePct}`);
  assert.equal(d.worthwhile, true);
});

test('kleine Aenderung in grossem Text → unter Schwelle, nicht empfehlenswert', () => {
  const words = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
  const base = content([{ id: 1, html: `<p>${words}</p>` }]);
  const cur = content([{ id: 1, html: `<p>${words} extra</p>` }]);
  const d = computeDrift({ baselineContent: base, currentContent: cur });
  assert.equal(d.text.changedPages, 1);
  assert.ok(d.text.changePct < 10, `changePct=${d.text.changePct}`);
  assert.equal(d.worthwhile, false);
});

test('neue + entfernte Seiten werden gezaehlt und fliessen in die Drift', () => {
  const base = content([{ id: 1, html: '<p>bleibt gleich</p>' }, { id: 2, html: '<p>faellt weg bald jetzt</p>' }]);
  const cur = content([{ id: 1, html: '<p>bleibt gleich</p>' }, { id: 3, html: '<p>ganz neue seite hier</p>' }]);
  const d = computeDrift({ baselineContent: base, currentContent: cur });
  assert.equal(d.text.addedPages, 1);
  assert.equal(d.text.removedPages, 1);
  assert.equal(d.text.unchangedPages, 1);
  assert.ok(d.text.changePct > 0);
});

test('Publikations-Aenderung macht empfehlenswert (auch ohne Textdrift)', () => {
  const c = content([{ id: 1, html: '<p>unveraendert</p>' }]);
  // Keys kommen vom Aufrufer (book-snapshot-diff.js#diffPublication).
  const d = computeDrift({ baselineContent: c, currentContent: c, publicationFields: ['isbn'] });
  assert.equal(d.text.changePct, 0);
  assert.equal(d.publicationChanged, true);
  assert.deepEqual(d.publicationFields, ['isbn']);
  assert.equal(d.worthwhile, true);
});

test('Einstellungs-Aenderung macht empfehlenswert', () => {
  const c = content([{ id: 1, html: '<p>gleich</p>' }]);
  const d = computeDrift({
    baselineContent: c, currentContent: c,
    baselineSettings: { buchtyp: 'roman', citation_style: 'apa7' },
    currentSettings: { buchtyp: 'roman', citation_style: 'chicago' },
  });
  assert.equal(d.settingsChanged, true);
  assert.deepEqual(d.settingsFields, ['citation_style']);
  assert.equal(d.worthwhile, true);
});

test('Arbeits-/Status-Felder (fertig, Tagesziel, Stilprofil) sind keine Drift', () => {
  const c = content([{ id: 1, html: '<p>gleich</p>' }]);
  const d = computeDrift({
    baselineContent: c, currentContent: c,
    baselineSettings: { is_finished: 0, daily_goal_chars: 1000, stilprofil: 'a', goal_deadline: null },
    currentSettings: { is_finished: 1, daily_goal_chars: 3000, stilprofil: 'b', goal_deadline: '2027-01-01' },
  });
  assert.equal(d.settingsChanged, false);
  assert.equal(d.worthwhile, false);
});

test('Buchtitel-Aenderung macht empfehlenswert', () => {
  const pages = [{ id: 1, html: '<p>gleich</p>' }];
  const base = { ...content(pages), book: { name: 'Alt', description: '' } };
  const cur = { ...content(pages), book: { name: 'Neu', description: '' } };
  const d = computeDrift({ baselineContent: base, currentContent: cur });
  assert.equal(d.bookChanged, true);
  assert.deepEqual(d.bookFields, ['name']);
  assert.equal(d.worthwhile, true);
});

test('0/null/"" in Einstellungen zaehlen nicht als Aenderung', () => {
  const c = content([{ id: 1, html: '<p>x</p>' }]);
  const d = computeDrift({
    baselineContent: c, currentContent: c,
    baselineSettings: { daily_goal_chars: 0, schauplatz_land: null },
    currentSettings: { daily_goal_chars: '0', schauplatz_land: '' },
  });
  assert.equal(d.settingsChanged, false);
});

test('Gliederungs-Aenderung ohne Textdrift macht empfehlenswert', () => {
  const base = { book: {}, tree: [
    { type: 'chapter', srcId: 10, name: 'A', children: [
      { type: 'page', srcId: 1, name: 'a', html: '<p>eins</p>' },
      { type: 'page', srcId: 2, name: 'b', html: '<p>zwei</p>' },
    ] },
  ] };
  const cur = { book: {}, tree: [
    { type: 'chapter', srcId: 10, name: 'A', children: [
      { type: 'page', srcId: 2, name: 'b', html: '<p>zwei</p>' },
      { type: 'page', srcId: 1, name: 'a', html: '<p>eins</p>' },
    ] },
  ] };
  const d = computeDrift({
    baselineContent: base, currentContent: cur,
    structureSummary: diffSnapshots(base, cur).summary,
  });
  assert.equal(d.text.changePct, 0);
  assert.equal(d.structure.reorderedPages, 1);
  assert.equal(d.structure.changed, true);
  assert.equal(d.worthwhile, true);
});

test('Grosser Abschnitt: satzweiser Diff statt Wort-Diff, gleiche Groessenordnung', () => {
  const sentences = Array.from({ length: 50 }, (_, i) => `Satz nummer ${i} hat fuenf Woerter.`);
  const base = content([{ id: 1, html: `<p>${sentences.join(' ')}</p>` }]);
  const changed = sentences.slice(); changed[10] = 'Ein ganz anderer Satz steht hier.';
  const cur = content([{ id: 1, html: `<p>${changed.join(' ')}</p>` }]);
  const exact = computeDrift({ baselineContent: base, currentContent: cur });
  const coarse = computeDrift({ baselineContent: base, currentContent: cur, maxWordDiff: 10 });
  assert.ok(coarse.text.changedWords >= exact.text.changedWords, 'satzweise zaehlt mindestens so viel');
  assert.ok(coarse.text.changedWords <= 14, `nur der geaenderte Satz: ${coarse.text.changedWords}`);
});
