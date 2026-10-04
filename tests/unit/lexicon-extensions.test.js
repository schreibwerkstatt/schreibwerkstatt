'use strict';
// Wortschatz-Analyse, Ausbau (docs/wortschatz.md): Tokenizer-Normalisierung,
// Namensfilter mit Genitiv, Funktionswortliste, Kapitel-Band (Burrows's Delta),
// Figuren-Idiolekt und Eingangs-Signatur. Pure — ohne DB; die DB-Seite
// (Referenz-Schranke, Verlauf) steht in lexicon-db.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

// lib/page-index und der Job laden db/connection — nie die Entwicklungs-DB.
const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('lexicon-extensions');

const { tokenize, tokenizeSegments } = require('../../lib/lexicon/tokenize');
const { buildNameStopwords } = require('../../lib/lexicon/names');
const { analyzeChapters, DELTA_MIN_TOKENS } = require('../../lib/lexicon/chapters');
const { analyzeIdiolect, IDIOLECT_MIN_TOKENS } = require('../../lib/lexicon/idiolect');
const { analyzeBook } = require('../../lib/lexicon/analyze');
const { keynessFor } = require('../../lib/lexicon/keyness');
const { frequencies } = require('../../lib/lexicon/tokenize');
const { findDialogRanges, buildFigureNamePatterns } = require('../../lib/page-index');
const { computeInputSig } = require('../../routes/jobs/lexicon-scan');

const page = (id, ch, html) => ({ page_id: id, chapter_id: ch, html });

// ── Tokenizer ─────────────────────────────────────────────────────────────────

test('tokenize: zerlegter Akzent wird zusammengezogen, nicht abgeschnitten', () => {
  assert.deepEqual(tokenize('Café und Café'), ['café', 'und', 'café']);
});

test('tokenize: weiches Trennzeichen und Zero-Width-Zeichen teilen kein Wort', () => {
  assert.deepEqual(tokenize('Silben­trennung Null​breite'), ['silbentrennung', 'nullbreite']);
});

test('tokenize: Apostroph-Varianten sind ein Type', () => {
  assert.deepEqual(tokenize("geht's geht’s gehtʼs"), ["geht's", "geht's", "geht's"]);
});

test('tokenizeSegments: dieselbe Normalisierung wie tokenize', () => {
  assert.deepEqual(tokenizeSegments('Silben­trennung. Neu'), [['silbentrennung'], ['neu']]);
});

// ── Namen ─────────────────────────────────────────────────────────────────────

test('buildNameStopwords: Genitiv-s und Apostroph-Namen', () => {
  const set = buildNameStopwords(["Anna Berger", "O'Brien", 'Hans'], ['anna', 'berger', 'brien', 'hans']);
  assert.ok(set.has('anna'));
  assert.ok(set.has('annas'), 'Genitiv „Annas" ist derselbe Name');
  assert.ok(set.has("o'brien"), 'Text-Token mit Apostroph');
  assert.ok(set.has('hans'));
  assert.equal(set.has('hanss'), false, 'Namen auf -s bilden den Genitiv mit Apostroph');
});

test('analyzeBook: Genitiv eines Namens ist kein Lieblingswort', async () => {
  const html = '<p>' + Array(5).fill('Annas Blick traf die Wand.').join(' ') + '</p>';
  const names = buildNameStopwords(['Anna'], ['anna']);
  const { terms } = await analyzeBook([page(1, 1, html)], { nameStopwords: names });
  assert.equal(terms.some(t => t.term === 'annas'), false);
  assert.ok(terms.some(t => t.term === 'blick'));
});

// ── Funktionswörter ──────────────────────────────────────────────────────────

test('analyzeBook: Funktionswörter führen die Lieblingswörter nicht an', async () => {
  const html = '<p>' + Array(6).fill('Diese Frau konnte sich wieder etwas erinnern.').join(' ') + '</p>';
  const { terms, stats } = await analyzeBook([page(1, 1, html)]);
  const words = terms.filter(t => t.kind === 'freq').map(t => t.term);
  for (const fw of ['diese', 'konnte', 'sich', 'wieder', 'etwas']) {
    assert.equal(words.includes(fw), false, `${fw} ist ein Funktionswort`);
  }
  assert.ok(words.includes('frau') && words.includes('erinnern'));
  // Inhaltswörter: frau, erinnern → 2 von 7 Token je Satz.
  assert.equal(stats.lex_density, Math.round((2 / 7) * 10000) / 10000);
});

// ── Keyness-Schranke pro Buch ────────────────────────────────────────────────

test('keynessFor: refUpper ersetzt die Referenzhäufigkeit durch die obere Schranke', () => {
  const target = new Map([['sonderling', 20]]);
  // Fehlt in der gekappten Referenz, kann aber in 10 Büchern je 2-mal stehen.
  const naive = keynessFor(['sonderling'], target, new Map(), 1000, 10000).get('sonderling');
  const careful = keynessFor(['sonderling'], target, new Map(), 1000, 10000,
    { refUpper: () => 20 }).get('sonderling');
  assert.ok(naive > careful, 'die vorsichtige Variante ist eine untere Schranke');
});

// ── Kapitel-Band ──────────────────────────────────────────────────────────────

function chapterText(n, odd = false) {
  // Gleicher Wortbestand in allen Kapiteln, ausser im „odd"-Kapitel: dort steht
  // „hatte", wo die anderen „und" haben.
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(i % 3 === 0 ? (odd ? 'hatte' : 'und') : `wort${i % 400}`);
  }
  return out;
}

test('analyzeChapters: das abweichende Kapitel hat das höchste Delta, mit Begründung', () => {
  const n = DELTA_MIN_TOKENS + 300;
  const chTokens = new Map([
    [1, chapterText(n)], [2, chapterText(n)], [3, chapterText(n)], [4, chapterText(n, true)],
  ]);
  const bookFreq = frequencies([...chTokens.values()].flat());
  const rows = analyzeChapters(chTokens, bookFreq, { isContentWord: () => true });
  assert.equal(rows.length, 4);
  const top = [...rows].sort((a, b) => b.delta - a.delta)[0];
  assert.equal(top.chapter_id, 4);
  assert.ok(top.delta_top.some(d => d.term === 'hatte' && d.z > 0), 'Begründung: auffällig oft „hatte"');
  assert.ok(rows.every(r => r.mattr != null && r.tokens === n));
});

test('analyzeChapters: zu kurze oder zu wenige Kapitel → Delta null, Masse trotzdem da', () => {
  const short = new Map([[1, ['aa', 'bb', 'cc']], [2, ['aa', 'bb', 'dd']], [3, ['ee', 'ff', 'gg']]]);
  const rows = analyzeChapters(short, frequencies([...short.values()].flat()));
  assert.ok(rows.every(r => r.delta === null && r.delta_top === null));
  assert.ok(rows.every(r => r.types === 3));
});

test('analyzeBook: Kapitel-Band nur für Seiten mit Kapitel, in Buchreihenfolge', async () => {
  const { chapters } = await analyzeBook([
    page(1, 20, '<p>Eins zwei drei.</p>'),
    page(2, null, '<p>Ohne Kapitel.</p>'),
    page(3, 10, '<p>Vier fünf.</p>'),
  ]);
  assert.deepEqual(chapters.map(c => c.chapter_id), [20, 10]);
});

// ── Figuren-Idiolekt ──────────────────────────────────────────────────────────

const deps = { findDialogRanges, buildFigureNamePatterns };
const figures = [{ id: 1, name: 'Anna' }, { id: 2, name: 'Bruno' }, { id: 3, name: 'Anna' }];

// Viele kurze Äusserungen — die Dialog-Erkennung nimmt (zu Recht) keine
// seitenlangen Zitate an.
function utterances(k, word, who) {
  return Array.from({ length: k }, (_, i) =>
    `»${word} ding${i} ${word} sache${i} ${word}«, sagte ${who}.`);
}

test('analyzeIdiolect: Zuordnung nur bei genau einer Figur im Erzähltext', () => {
  const blocks = [
    ...utterances(40, 'gewiss', 'Anna'),
    ...utterances(40, 'jawohl', 'Bruno'),
    '»egal egal egal egal«, sagte Anna zu Bruno.',  // zwei Figuren → unzugeordnet
    '»Anna, komm komm komm komm!«, rief jemand.',   // Name nur IN der Rede → unzugeordnet
  ];
  const { rows, coverage } = analyzeIdiolect(blocks, figures, deps);
  const anna = rows.filter(r => r.figure_id === 1 || r.figure_id === 3);
  assert.equal(anna.length, 2, 'gleichnamige Kopien teilen sich eine Zeile');
  assert.ok(anna[0].tokens >= IDIOLECT_MIN_TOKENS);
  assert.ok(anna[0].terms.some(t => t.term === 'gewiss'), 'typisches Wort gegen die Rede der anderen');
  assert.equal(anna[0].terms.some(t => t.term === 'egal'), false);
  const bruno = rows.find(r => r.figure_id === 2);
  assert.ok(bruno.terms.some(t => t.term === 'jawohl'));
  assert.ok(coverage > 0 && coverage < 1, 'Abdeckung offengelegt');
});

test('analyzeIdiolect: zu wenig Rede → keine Zeile', () => {
  const { rows } = analyzeIdiolect(['»Ja.«, sagte Anna.'], figures, deps);
  assert.deepEqual(rows, []);
});

// ── Eingangs-Signatur ─────────────────────────────────────────────────────────

test('computeInputSig: Namen und Referenz ändern die Signatur, Reihenfolge nicht', () => {
  const base = computeInputSig('abc', new Set(['anna', 'bruno']), ['1:Anna:'], '7:x');
  assert.equal(base, computeInputSig('abc', new Set(['bruno', 'anna']), ['1:Anna:'], '7:x'));
  assert.notEqual(base, computeInputSig('abc', new Set(['anna']), ['1:Anna:'], '7:x'));
  assert.notEqual(base, computeInputSig('abc', new Set(['anna', 'bruno']), ['1:Anna:'], '7:y'));
  assert.notEqual(base, computeInputSig('abc', new Set(['anna', 'bruno']), ['1:Anna:', '2:Bruno:'], '7:x'));
});
