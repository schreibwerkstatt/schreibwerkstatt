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
const { analyzeChapters, _deltaUnits, DELTA_MIN_TOKENS } = require('../../lib/lexicon/chapters');
const { analyzeIdiolect, IDIOLECT_MIN_TOKENS } = require('../../lib/lexicon/idiolect');
const { msgUtterances } = require('../../lib/html-text');
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
  assert.ok(rows.every(r => r.delta === null && r.delta_top === null && r.delta_block === null));
  assert.ok(rows.every(r => r.types === 3));
});

test('_deltaUnits: lange Kapitel einzeln, kurze Nachbarn gierig zu Blöcken, langes Kapitel unterbricht', () => {
  const M = DELTA_MIN_TOKENS;
  const units = (lens) => _deltaUnits(lens.map(tokens => ({ tokens })));
  // Nur lange Kapitel: wie ohne Bündelung.
  assert.deepEqual(units([M, M + 1, 2 * M]), [[0], [1], [2]]);
  // Kurze Kapitel: Block schliesst, sobald er die Schwelle erreicht.
  assert.deepEqual(units([700, 800, 600, 900, 500, 1000]), [[0, 1], [2, 3], [4, 5]]);
  // Zu kurzer Rest geht in den vorigen Block desselben Laufs.
  assert.deepEqual(units([700, 800, 600, 900, 300]), [[0, 1], [2, 3, 4]]);
  // Ein langes Kapitel unterbricht den Lauf; der Rest davor geht nicht ins lange Kapitel.
  assert.deepEqual(units([800, 800, 200, M, 900, 700]), [[0, 1, 2], [3], [4, 5]]);
  // Lauf ohne vollen Block bleibt ohne Einheit.
  assert.deepEqual(units([M, 400, 300, M]), [[0], [3]]);
  assert.deepEqual(units([400, 300]), []);
});

test('analyzeChapters: kurze Kapitel bekommen das Delta ihres Blocks, Masse bleiben je Kapitel', () => {
  const half = Math.ceil(DELTA_MIN_TOKENS / 2);
  // 8 kurze Kapitel → 4 Blöcke; der dritte Block (Kap. 5–6) ist der abweichende.
  const chTokens = new Map();
  for (let i = 1; i <= 8; i++) chTokens.set(i, chapterText(half, i === 5 || i === 6));
  const bookFreq = frequencies([...chTokens.values()].flat());
  const rows = analyzeChapters(chTokens, bookFreq, { isContentWord: () => true });
  assert.equal(rows.length, 8);
  assert.ok(rows.every(r => r.tokens === half && r.mattr != null), 'Diversitätsmasse je Kapitel');
  assert.ok(rows.every(r => r.delta != null && r.delta_block), 'jedes Kapitel trägt ein Block-Delta');
  assert.deepEqual(rows[4].delta_block, { first: 5, last: 6, chapters: 2, tokens: 2 * half });
  assert.equal(rows[4].delta, rows[5].delta);
  assert.deepEqual(rows[4].delta_top, rows[5].delta_top);
  const top = [...rows].sort((a, b) => b.delta - a.delta)[0];
  assert.equal(top.delta_block.first, 5);
});

test('analyzeChapters: gemischtes Buch — lange Kapitel einzeln, kurzer Lauf als Block', () => {
  // Längen als Vielfache der Textperiode (3 × 400), damit Block und lange Kapitel
  // dieselbe Verteilung haben und nur das „odd"-Kapitel abweicht.
  const half = 1200, n = 2 * half;
  assert.ok(half < DELTA_MIN_TOKENS && n >= DELTA_MIN_TOKENS);
  const chTokens = new Map([
    [1, chapterText(n)], [2, chapterText(half)], [3, chapterText(half)], [4, chapterText(n)], [5, chapterText(n, true)],
  ]);
  const rows = analyzeChapters(chTokens, frequencies([...chTokens.values()].flat()), { isContentWord: () => true });
  assert.equal(rows[0].delta_block, null);
  assert.deepEqual(rows[1].delta_block, { first: 2, last: 3, chapters: 2, tokens: 2 * half });
  assert.equal(rows[1].delta, rows[2].delta);
  assert.equal(rows[3].delta_block, null);
  assert.ok(rows.every(r => r.delta != null));
  assert.equal([...rows].sort((a, b) => b.delta - a.delta)[0].chapter_id, 5);
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

test('msgUtterances: Absenderzeile gilt bis zur nächsten, ausgehend ohne Sprecher', () => {
  const u = msgUtterances([[
    { kind: 'in', text: 'vor dem Namen' },
    { kind: 'name', text: 'Anna' },
    { kind: 'in', text: 'eins' },
    { kind: 'meta', text: '14:32' },
    { kind: 'out', text: 'zwei' },
    { kind: 'in', text: 'drei' },
    { kind: 'name', text: 'Bruno' },
    { kind: 'in', text: 'vier' },
  ], [{ kind: 'in', text: 'neuer Verlauf' }]]);
  assert.deepEqual(u, [
    { sender: null, text: 'vor dem Namen' },
    { sender: 'Anna', text: 'eins' },
    { sender: null, text: 'zwei' },
    { sender: 'Anna', text: 'drei' },
    { sender: 'Bruno', text: 'vier' },
    { sender: null, text: 'neuer Verlauf' },
  ]);
});

test('msgUtterances: Absender über ausgehenden gilt für die ausgehende Seite', () => {
  const u = msgUtterances([[
    { kind: 'name', text: 'Anna' },
    { kind: 'in', text: 'eins' },
    { kind: 'name', text: 'Bruno' },
    { kind: 'meta', text: '14:32' },
    { kind: 'out', text: 'zwei' },
    { kind: 'in', text: 'drei' },
    { kind: 'out', text: 'vier' },
  ]]);
  assert.deepEqual(u, [
    { sender: 'Anna', text: 'eins' },
    { sender: 'Bruno', text: 'zwei' },
    { sender: 'Anna', text: 'drei' },
    { sender: 'Bruno', text: 'vier' },
  ]);
});

test('analyzeIdiolect: Nachrichten gehören der Figur aus der Absenderzeile', () => {
  const msgs = (k, word, sender) => Array.from({ length: k }, (_, i) => ({ sender, text: `${word} ding${i} ${word} sache${i} ${word}` }));
  const { rows, coverage, dialogTokens } = analyzeIdiolect([], figures, deps, {
    utterances: [
      ...msgs(40, 'gewiss', 'Anna'),
      ...msgs(40, 'jawohl', 'Bruno'),
      ...msgs(5, 'egal', null),          // ausgehend → unzugeordnet
      ...msgs(5, 'egal', 'Anna, Bruno'), // zwei Figuren → unzugeordnet
    ],
  });
  const anna = rows.find(r => r.figure_id === 1);
  assert.ok(anna.terms.some(t => t.term === 'gewiss'));
  assert.equal(anna.utterances, 40);
  assert.ok(rows.find(r => r.figure_id === 2).terms.some(t => t.term === 'jawohl'));
  assert.equal(dialogTokens, 90 * 5, 'alle Nachrichten zählen als Rede');
  assert.ok(coverage > 0 && coverage < 1);
});

test('analyzeBook: Nachrichten im Idiolekt, aber nicht doppelt als Erzähl-Absatz', async () => {
  const lines = Array.from({ length: 40 }, (_, i) => `<p class="msg-in">gewiss ding${i} gewiss sache${i} gewiss</p>`).join('');
  const html = `<p>Anna schrieb.</p><div class="msg-thread"><p class="msg-name">Anna</p>${lines}<p class="msg-out">«nein», sagte Bruno</p></div>`;
  const { idiolect, stats } = await analyzeBook([page(1, null, html)], { idiolect: { figures, deps } });
  const anna = idiolect.find(r => r.figure_id === 1);
  assert.equal(anna.utterances, 40);
  assert.equal(idiolect.some(r => r.figure_id === 2), false, 'Inquit in einer ausgehenden Nachricht ordnet nicht zu');
  assert.ok(stats.tokens >= 200, 'Nachrichten bleiben im Wortschatz');
});

test('analyzeIdiolect: zu wenig Rede → keine Zeile', () => {
  const { rows } = analyzeIdiolect(['»Ja.«, sagte Anna.'], figures, deps);
  assert.deepEqual(rows, []);
});

test('analyzeIdiolect: britische einfache Anführungszeichen, Apostroph in der Rede', () => {
  const blocks = [
    ...Array.from({ length: 40 }, (_, i) => `‘Indeed it’s thing${i}, indeed James’ stuff${i}, indeed,’ said Anna.`),
    ...Array.from({ length: 40 }, (_, i) => `‘Righto, item${i}, righto piece${i} righto,’ Bruno replied.`),
  ];
  const { rows, coverage } = analyzeIdiolect(blocks, figures, deps);
  const anna = rows.find(r => r.figure_id === 1 || r.figure_id === 3);
  const bruno = rows.find(r => r.figure_id === 2);
  assert.ok(anna && bruno, 'beide Figuren bekommen eine Zeile');
  assert.ok(anna.terms.some(t => t.term === 'indeed'));
  assert.ok(bruno.terms.some(t => t.term === 'righto'));
  assert.equal(coverage, 1, 'die ganze Rede bis zum Schluss-Apostroph wird erkannt');
});

// ── Eingangs-Signatur ─────────────────────────────────────────────────────────

test('computeInputSig: Namen und Referenz ändern die Signatur, Reihenfolge nicht', () => {
  const base = computeInputSig('abc', new Set(['anna', 'bruno']), ['1:Anna:'], '7:x');
  assert.equal(base, computeInputSig('abc', new Set(['bruno', 'anna']), ['1:Anna:'], '7:x'));
  assert.notEqual(base, computeInputSig('abc', new Set(['anna']), ['1:Anna:'], '7:x'));
  assert.notEqual(base, computeInputSig('abc', new Set(['anna', 'bruno']), ['1:Anna:'], '7:y'));
  assert.notEqual(base, computeInputSig('abc', new Set(['anna', 'bruno']), ['1:Anna:', '2:Bruno:'], '7:x'));
});

test('buildNameStopwords: englischer Genitiv mit Apostroph', () => {
  const set = buildNameStopwords(['Margaret'], ['margaret']);
  assert.ok(set.has("margaret's"));
  assert.ok(set.has('margarets'));
});
