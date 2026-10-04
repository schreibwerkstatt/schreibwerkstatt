// Reine Rechenkerne zweier Mess-Kacheln ohne eigenen Endpunkt:
//   * Kapitel-Dashboard „Stil & Lesbarkeit" (cards/kapitel-stil.js) — liest
//     /history/style-stats, Scope gegen Buchschnitt, Abweichungs-Regel.
//   * Buch-Übersicht „Wortschatz" (book-overview/wortschatz.js) — liest
//     /lexicon/:book_id, MTLD/MATTR + Peer-Median.
// Gemeinsame Invariante: ein nicht messbarer Wert ist `null` (Anzeige „–"),
// nie 0 — und eine fehlende Quelle blendet die Kachel aus.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeKapitelStil, aggregateStil, stilDeviation, STIL_MIN_WORDS,
} from '../../public/js/cards/kapitel-stil.js';
import { computeOverviewLexicon } from '../../public/js/book-overview/wortschatz.js';

const CH = (key, words, over = {}) => ({
  key: String(key), words,
  avg_sentence_len: 12, lix: 40, flesch_de: 60, dialog_ratio: 20,
  filler_per1k: 5, passive_per1k: 3, adverb_per1k: 10, ...over,
});

test('aggregateStil: wortgewichtet, Kapitel ohne Woerter zaehlen nicht', () => {
  const agg = aggregateStil([
    CH(1, 1000, { avg_sentence_len: 10 }),
    CH(2, 3000, { avg_sentence_len: 20 }),
    CH(3, 0,    { avg_sentence_len: 99 }),
  ], null);
  assert.equal(agg.words, 4000);
  assert.equal(agg.values.avg_sentence_len, 17.5);
});

test('aggregateStil: null-Felder fallen aus der Rechnung, nicht als 0', () => {
  const agg = aggregateStil([CH(1, 1000, { lix: null }), CH(2, 1000, { lix: 50 })], null);
  assert.equal(agg.values.lix, 50);
  const none = aggregateStil([CH(1, 1000, { lix: null })], null);
  assert.equal(none.values.lix, null);
});

test('stilDeviation: relative UND absolute Schwelle, Wortsockel', () => {
  // 25 % von 40 = 10 > minAbs 4 → 49 knapp darunter, 50 darueber.
  assert.equal(stilDeviation(49, 40, 4, 1000), null);
  assert.equal(stilDeviation(50, 40, 4, 1000), 'up');
  assert.equal(stilDeviation(30, 40, 4, 1000), 'down');
  // Kleiner Buchwert: minAbs traegt (0,8 → 1,2 sind +50 %, aber < 1 absolut).
  assert.equal(stilDeviation(1.2, 0.8, 1, 1000), null);
  // Zu wenig Text im Scope: keine Markierung.
  assert.equal(stilDeviation(80, 40, 4, STIL_MIN_WORDS - 1), null);
  assert.equal(stilDeviation(null, 40, 4, 1000), null);
});

test('computeKapitelStil: Scope inkl. Sub-Kapitel gegen Buchschnitt', () => {
  const data = {
    chapters: [
      CH(1, 2000, { dialog_ratio: 60 }),
      CH(2, 2000, { dialog_ratio: 10 }),
      CH(3, 2000, { dialog_ratio: 10 }),
    ],
    needsSync: false,
  };
  const r = computeKapitelStil(data, new Set(['1']));
  const dialog = r.rows.find(x => x.key === 'dialog_ratio');
  assert.equal(dialog.value, 60);
  assert.equal(dialog.book, 26.7);
  assert.equal(dialog.dev, 'up');
  assert.equal(r.rows.find(x => x.key === 'lix').dev, null);
  assert.equal(r.deviating, 1);
  assert.equal(r.needsSync, false);
  // Sub-Kapitel im Scope mitgerechnet.
  const scoped = computeKapitelStil(data, new Set(['1', '2']));
  assert.equal(scoped.words, 4000);
  assert.equal(scoped.rows.find(x => x.key === 'dialog_ratio').value, 35);
});

test('computeKapitelStil: ohne Antwort / ohne Text im Scope → null (Kachel aus)', () => {
  assert.equal(computeKapitelStil(null, new Set(['1'])), null);
  assert.equal(computeKapitelStil({ chapters: [CH(1, 0)] }, new Set(['1'])), null);
  assert.equal(computeKapitelStil({ chapters: [CH(1, 100)] }, new Set(['9'])), null);
});

test('computeOverviewLexicon: fehlende Antwort blendet aus, fehlender Scan zeigt Hinweis', () => {
  assert.equal(computeOverviewLexicon(null), null);
  assert.equal(computeOverviewLexicon([]), null);
  assert.deepEqual(computeOverviewLexicon({ stats: null, peers: null }), { scanned: false });
});

test('computeOverviewLexicon: MTLD bevorzugt, Peer-Median daneben', () => {
  const r = computeOverviewLexicon({
    stats: { mtld: 78.4, mattr: 0.71, mattr_window: 1000 },
    peers: { books: 3, mtld: 71, mattr: 0.7 },
    thresholds: { mattrWindow: 1000 },
  });
  assert.equal(r.metric, 'mtld');
  assert.equal(r.value, 78.4);
  assert.equal(r.peer, 71);
  assert.equal(r.peerBooks, 3);
});

test('computeOverviewLexicon: MATTR-Fallback, ohne volles Fenster keine Peer-Zeile', () => {
  const short = computeOverviewLexicon({
    stats: { mtld: null, mattr: 0.8, mattr_window: 400 },
    peers: { books: 2, mattr: 0.7 },
    thresholds: { mattrWindow: 1000 },
  });
  assert.equal(short.metric, 'mattr');
  assert.equal(short.peer, null);
  const full = computeOverviewLexicon({
    stats: { mtld: null, mattr: 0.8, mattr_window: 1000 },
    peers: null,
    thresholds: { mattrWindow: 1000 },
  });
  assert.equal(full.peer, null, 'peers: null → kein Vergleich, keine 0');
});

test('computeOverviewLexicon: weder MTLD noch MATTR → value null, nicht 0', () => {
  const r = computeOverviewLexicon({ stats: { mtld: null, mattr: null }, peers: { books: 1, mtld: 70 } });
  assert.equal(r.metric, null);
  assert.equal(r.value, null);
  assert.equal(r.peer, null);
});

test('computeOverviewLexicon: Nicht-Besitzer bekommt keine Vergleichszeile', () => {
  const r = computeOverviewLexicon({ stats: { mtld: 80 }, peers: null, isOwner: false });
  assert.equal(r.peerLine, false);
  assert.equal(computeOverviewLexicon({ stats: { mtld: 80 }, peers: null }).peerLine, true);
});
