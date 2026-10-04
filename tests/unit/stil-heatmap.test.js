'use strict';
// Verdichtung der Stil-Karte: lib/stil-heatmap.js. Getestet wird die
// Kapitel-Aggregation (gewichtet, nicht arithmetisch), der Drilldown-Zuschnitt
// und die Frage „muss nachgerechnet werden?" — das ist die Entscheidung, die
// frueher eine Metrik-Versions-KOPIE im Frontend traf.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildStilHeatmap, buildStilDetail, isSampleBucket, parseStyleRow, PERSPECTIVE_MIN_PRONOUNS } = require('../../lib/stil-heatmap');
const { percentileSorted } = require('../../lib/percentile');

function row(over = {}) {
  return {
    page_id: 1, chapter_id: 1, chapter_name: 'K1',
    words: 100, chars: 600, dialog_chars: 60,
    filler_count: 5, passive_count: 2, adverb_count: 9,
    avg_sentence_len: 12, sentence_len_p90: 20,
    lix: 40, flesch_de: 60, metrics_version: 7,
    cached_at: '2026-01-01T10:00:00.000Z',
    repetition_data: JSON.stringify({ score: 3, top: [{ word: 'und', count: 4 }] }),
    style_samples: JSON.stringify({ filler: [{ token: 'eigentlich', sentence: 'Ein Satz.' }], passive: [], adverb: [] }),
    sentence_lens: JSON.stringify([5, 12, 19]),
    opener_counts: JSON.stringify({ counts: { Er: 2, Sie: 1 }, repeats: 1 }),
    ...over,
  };
}

test('parseStyleRow: korrupte JSON-Spalte kippt die Zeile nicht', () => {
  const p = parseStyleRow(row({ repetition_data: '{kaputt', sentence_lens: 'nope', opener_counts: '[]' }));
  assert.equal(p.repetition_data, null);
  assert.equal(p.sentence_lens, null);
  // Ein Array ist kein Zaehl-Objekt — darf nicht als opener_counts durchgehen.
  assert.deepEqual(p.opener_counts, []);
});

test('buildStilHeatmap: Dichten pro 1000 Woerter, Dialog in Prozent', () => {
  const { chapters } = buildStilHeatmap({ rows: [row()], metricsVersion: 7 });
  assert.equal(chapters.length, 1);
  const c = chapters[0];
  assert.equal(c.filler_per1k, 50);   // 5 / 100 * 1000
  assert.equal(c.passive_per1k, 20);
  assert.equal(c.adverb_per1k, 90);
  assert.equal(c.dialog_ratio, 10);   // 60 / 600
  assert.equal(c.words, 100);
  assert.equal(c.pageCount, 1);
});

test('buildStilHeatmap: Mittelwerte sind wortgewichtet, nicht seitengewichtet', () => {
  // Eine lange Seite mit kurzen Saetzen und eine kurze Seite mit langen Saetzen:
  // arithmetisch waere der Schnitt 30, gewichtet ist er nahe an der langen Seite.
  const rows = [
    row({ page_id: 1, words: 900, avg_sentence_len: 10 }),
    row({ page_id: 2, words: 100, avg_sentence_len: 50 }),
  ];
  const { chapters } = buildStilHeatmap({ rows, metricsVersion: 7 });
  assert.equal(chapters[0].avg_sentence_len, 14); // (10*900 + 50*100) / 1000
});

test('buildStilHeatmap: Seiten ohne Kapitel bekommen den __uncat__-Schluessel und keinen Namen', () => {
  const { chapters } = buildStilHeatmap({
    rows: [row({ chapter_id: null, chapter_name: null })],
    metricsVersion: 7,
  });
  assert.equal(chapters[0].key, '__uncat__');
  // Das Label ist UI-Text und gehoert in die Locale-Datei, nicht in die Antwort.
  assert.equal(chapters[0].name, null);
});

test('buildStilHeatmap: needsSync bei alter Metrik-Version', () => {
  assert.equal(buildStilHeatmap({ rows: [row()], metricsVersion: 7 }).needsSync, false);
  assert.equal(buildStilHeatmap({ rows: [row({ metrics_version: 6 })], metricsVersion: 7 }).needsSync, true);
});

test('buildStilHeatmap: needsSync bei nie gerechneter Seite mit Text', () => {
  // Nur der Umfangs-Pfad hat geschrieben: Woerter da, keine Metrik-Version.
  assert.equal(buildStilHeatmap({ rows: [row({ lix: null, metrics_version: null })], metricsVersion: 7 }).needsSync, true);
  // Eine leere Seite ist kein Grund nachzurechnen.
  assert.equal(buildStilHeatmap({ rows: [row({ lix: null, words: 0, metrics_version: null })], metricsVersion: 7 }).needsSync, false);
});

test('buildStilHeatmap: fehlender LIX auf aktuell gerechneter Seite loest KEIN Nachrechnen aus', () => {
  // Seite ohne zaehlbaren Satz (nur Zahlen): auch nach dem Sync bleibt lix null.
  // Als Ausloeser rechnete die Karte sonst bei jedem Oeffnen das ganze Buch neu.
  assert.equal(buildStilHeatmap({ rows: [row({ lix: null, flesch_de: null })], metricsVersion: 7 }).needsSync, false);
});

test('buildStilHeatmap: ohne Zeilen ist nichts berechnet, also needsSync', () => {
  const r = buildStilHeatmap({ rows: [], metricsVersion: 7 });
  assert.equal(r.needsSync, true);
  assert.deepEqual(r.chapters, []);
  assert.equal(r.lastUpdated, null);
});

test('buildStilHeatmap: lastUpdated ist der juengste Stand', () => {
  const rows = [
    row({ page_id: 1, cached_at: '2026-01-01T10:00:00.000Z' }),
    row({ page_id: 2, cached_at: '2026-03-05T08:00:00.000Z' }),
  ];
  assert.equal(buildStilHeatmap({ rows, metricsVersion: 7 }).lastUpdated, '2026-03-05T08:00:00.000Z');
});

test('buildStilHeatmap: Beispielsaetze reisen NICHT im Kapitel-Raster mit', () => {
  const { chapters } = buildStilHeatmap({ rows: [row()], metricsVersion: 7 });
  const blob = JSON.stringify(chapters);
  assert.ok(!blob.includes('eigentlich'), 'style_samples darf nicht in der Rasterantwort stehen');
  assert.ok(!blob.includes('sentence_lens'), 'die Satzlaengen-Sequenz gehoert ins Band, nicht in die Zeile');
});

test('buildStilHeatmap: Rhythmus und Satzanfaenge haengen mit an der Antwort', () => {
  const r = buildStilHeatmap({ rows: [row()], metricsVersion: 7 });
  assert.equal(r.rhythm.rows.length, 1);
  assert.equal(r.rhythm.rows[0].count, 3);
  assert.equal(r.openers.total, 3);
});

test('isSampleBucket: nur die vier bekannten Eimer', () => {
  for (const b of ['filler', 'passive', 'adverb', 'repetition']) assert.ok(isSampleBucket(b));
  for (const b of ['lix', '', null, 'DROP TABLE']) assert.ok(!isSampleBucket(b));
});

test('buildStilDetail: gruppiert Beispiele nach Token, sortiert Seiten nach Trefferzahl', () => {
  const rows = [
    row({ page_id: 1, page_name: 'S1', filler_count: 2, style_samples: JSON.stringify({ filler: [
      { token: 'eigentlich', sentence: 'A' }, { token: 'eigentlich', sentence: 'B' },
    ] }) }),
    row({ page_id: 2, page_name: 'S2', filler_count: 9, style_samples: JSON.stringify({ filler: [
      { token: 'halt', sentence: 'C' },
    ] }) }),
  ];
  const { entries } = buildStilDetail({ rows, bucket: 'filler' });
  assert.deepEqual(entries.map(e => e.page_name), ['S2', 'S1'], 'dichteste Seite zuerst');
  const s1 = entries.find(e => e.page_name === 'S1');
  assert.equal(s1.tokens.length, 1, 'zweimal dasselbe Wort ist eine Gruppe');
  assert.deepEqual(s1.tokens[0].sentences, ['A', 'B']);
});

test('buildStilDetail: Seiten ohne Treffer erscheinen nicht', () => {
  const rows = [row({ page_id: 3, style_samples: JSON.stringify({ filler: [], passive: [], adverb: [] }) })];
  assert.deepEqual(buildStilDetail({ rows, bucket: 'filler' }).entries, []);
});

test('buildStilDetail: Wiederholungen liefern Woerter statt Saetze', () => {
  const { entries } = buildStilDetail({ rows: [row({ page_name: 'S1' })], bucket: 'repetition' });
  assert.deepEqual(entries[0].words, [{ token: 'und', count: 4 }]);
  assert.equal(entries[0].count, 4);
  assert.equal(entries[0].tokens, undefined);
});

test('buildStilDetail: unbekannter Eimer liefert nichts statt zu raten', () => {
  assert.deepEqual(buildStilDetail({ rows: [row()], bucket: 'lix' }).entries, []);
});

// --- Kapitel-P90 exakt aus den gepoolten Satzlaengen ------------------------

test('Kapitel-P90: gepoolte Sequenz, nicht das Mittel der Seiten-P90', () => {
  // Seite 1: 9 kurze Saetze, Seite 2: 1 langer. Pro Seite waere P90 = 5 bzw. 40,
  // das wortgewichtete Mittel ~22. Ueber alle 10 Saetze ist P90 = Index 8 = 5.
  const rows = [
    row({ page_id: 1, words: 45, sentence_len_p90: 5,  sentence_lens: JSON.stringify(Array(9).fill(5)) }),
    row({ page_id: 2, words: 40, sentence_len_p90: 40, sentence_lens: JSON.stringify([40]) }),
  ];
  const { chapters, book } = buildStilHeatmap({ rows, metricsVersion: 7 });
  assert.equal(chapters[0].sentence_len_p90, 5);
  assert.equal(chapters[0].sentence_len_p90_exact, true);
  assert.equal(book.sentence_len_p90, 5);
  assert.equal(book.sentence_len_p90_exact, true);
});

test('Kapitel-P90: eine einzige Seite ergibt genau den Seiten-P90 (gleiche Definition)', () => {
  const lens = [3, 8, 12, 15, 17, 20, 22, 25, 31, 44, 60];
  const sorted = [...lens].sort((a, b) => a - b);
  const { chapters } = buildStilHeatmap({
    rows: [row({ sentence_lens: JSON.stringify(lens), sentence_len_p90: percentileSorted(sorted, 0.9) })],
    metricsVersion: 7,
  });
  assert.equal(chapters[0].sentence_len_p90, percentileSorted(sorted, 0.9));
  assert.equal(chapters[0].sentence_len_p90, 44);
});

test('Kapitel-P90: Fallback auf das Seiten-P90-Mittel nur fuer Seiten ohne Sequenz', () => {
  // Nur Altseiten (metrics_version < 7): wortgewichtetes Mittel, als geschaetzt markiert.
  const legacyOnly = buildStilHeatmap({
    rows: [
      row({ page_id: 1, words: 300, sentence_len_p90: 20, sentence_lens: null, metrics_version: 6 }),
      row({ page_id: 2, words: 100, sentence_len_p90: 40, sentence_lens: null, metrics_version: 6 }),
    ],
    metricsVersion: 7,
  });
  assert.equal(legacyOnly.chapters[0].sentence_len_p90, 25); // (20*300 + 40*100) / 400
  assert.equal(legacyOnly.chapters[0].sentence_len_p90_exact, false);

  // Gemischt: exakter Teil (P90 = 10, 100 Woerter) + Altseite (P90 30, 100 Woerter).
  const mixed = buildStilHeatmap({
    rows: [
      row({ page_id: 1, words: 100, sentence_lens: JSON.stringify(Array(10).fill(10)) }),
      row({ page_id: 2, words: 100, sentence_len_p90: 30, sentence_lens: null, metrics_version: 6 }),
    ],
    metricsVersion: 7,
  });
  assert.equal(mixed.chapters[0].sentence_len_p90, 20);
  assert.equal(mixed.chapters[0].sentence_len_p90_exact, false);
  assert.equal(mixed.book.sentence_len_p90_exact, false);
});

test('Kapitel-P90: ohne Saetze und ohne Altwert bleibt er null', () => {
  const { chapters } = buildStilHeatmap({
    rows: [row({ sentence_lens: JSON.stringify([]), sentence_len_p90: null })],
    metricsVersion: 7,
  });
  assert.equal(chapters[0].sentence_len_p90, null);
});

// --- Satzanfaenge pro Kapitel ----------------------------------------------

test('buildStilHeatmap: Satzanfaenge pro Kapitel reisen mit', () => {
  const r = buildStilHeatmap({
    rows: [
      row({ page_id: 1, chapter_id: 1, opener_counts: JSON.stringify({ counts: { Er: 4 }, repeats: 2 }) }),
      row({ page_id: 2, chapter_id: 2, chapter_name: 'K2', opener_counts: JSON.stringify({ counts: { Ich: 3, Dann: 1 }, repeats: 1 }) }),
    ],
    metricsVersion: 7,
  });
  assert.deepEqual(r.chapterOpeners.map(c => c.key), ['1', '2']);
  assert.equal(r.chapterOpeners[1].top[0].word, 'Ich');
  assert.equal(r.chapterOpeners[1].repeats, 1);
  assert.equal(r.openers.total, 8, 'die buchweite Rangliste bleibt daneben bestehen');
});

// --- Ich-Anteil im Erzaehltext -------------------------------------------------

function pron({ ich = 0, wir = 0, er = 0, sie = 0, ichDlg = 0, du = 0 } = {}) {
  return JSON.stringify({
    ich: { narr: ich, dlg: ichDlg }, du: { narr: du, dlg: 0 }, er: { narr: er, dlg: 0 },
    sie_sg: { narr: sie, dlg: 0 }, wir: { narr: wir, dlg: 0 }, ihr_pl: { narr: 0, dlg: 0 }, man: { narr: 0, dlg: 0 },
  });
}

test('Ich-Anteil: 1. Person (ich + wir) unter 1. + 3. Person, nur Erzaehltext', () => {
  const { chapters } = buildStilHeatmap({
    rows: [
      row({ page_id: 1, chapter_id: 1, pronoun_counts: pron({ ich: 25, wir: 5, er: 8, sie: 2, ichDlg: 500, du: 50 }) }),
      row({ page_id: 2, chapter_id: 2, chapter_name: 'K2', pronoun_counts: pron({ ich: 1, er: 30, sie: 9, ichDlg: 80 }) }),
    ],
    metricsVersion: 7,
  });
  // (25 + 5) / (25 + 5 + 8 + 2) = 75 % — Dialog-„ich" und „du" zaehlen nicht.
  assert.equal(chapters[0].first_person_share, 75);
  assert.equal(chapters[1].first_person_share, 2.5);
});

test('Ich-Anteil: null unter der Mindestzahl erzaehlender Pronomen', () => {
  const below = PERSPECTIVE_MIN_PRONOUNS - 1;
  const r1 = buildStilHeatmap({ rows: [row({ pronoun_counts: pron({ ich: below }) })], metricsVersion: 7 });
  assert.equal(r1.chapters[0].first_person_share, null);
  const r2 = buildStilHeatmap({ rows: [row({ pronoun_counts: pron({ ich: below, er: 1 }) })], metricsVersion: 7 });
  assert.equal(r2.chapters[0].first_person_share, Math.round((below / PERSPECTIVE_MIN_PRONOUNS) * 1000) / 10);
  // Ohne Pronomen-Spalte (oder korrupt) ebenfalls null, nicht 0.
  const r3 = buildStilHeatmap({ rows: [row({ pronoun_counts: '{kaputt' })], metricsVersion: 7 });
  assert.equal(r3.chapters[0].first_person_share, null);
  assert.equal(r3.perspectiveMinPronouns, PERSPECTIVE_MIN_PRONOUNS);
});
