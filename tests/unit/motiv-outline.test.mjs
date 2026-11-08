// Motiv-Werkstatt: reine Helfer von Baum, Gliederung und Detail-Editor —
// Gruppierung Thema → Motiv samt Suche, Mini-Verlauf, Reihenfolge nach Drag,
// Trigger-Chips, Fundstellen nach Kapitel, Panel-Breite.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildMotifGroups, motifSparkCells, sparkBuckets, SPARK_MAX_CELLS, motifMatchesQuery } from '../../public/js/book/motiv/outline.js';
import { groupOccurrences, splitTriggerInput, mergeTriggerTerms } from '../../public/js/book/motiv/detail.js';
import { mergeMotifOrder } from '../../public/js/book/motiv/dnd.js';
import { clampPanelWidth, PANEL_W_MIN, PANEL_W_MAX } from '../../public/js/book/motiv/panel-resize.js';

const themes = [
  { id: 1, name: 'Schuld', position: 1 },
  { id: 2, name: 'Freiheit', position: 0 },
];
const motifs = [
  { id: 10, name: 'Wasser', theme_id: 1, position: 2, trigger_terms: ['Regen'] },
  { id: 11, name: 'Spiegel', theme_id: 1, position: 1, beschreibung: 'Selbstbild' },
  { id: 12, name: 'Käfig', theme_id: 2, position: 0 },
  { id: 13, name: 'Lied', theme_id: null, position: 3 },
  { id: 14, name: 'Waise', theme_id: 99, position: 4 }, // Thema gelöscht/fremd
];

describe('buildMotifGroups', () => {
  test('Themen nach Position, Motive nach Position, «Ohne Thema» zuletzt (inkl. toter theme_id)', () => {
    const g = buildMotifGroups(themes, motifs);
    assert.deepEqual(g.map(x => x.key), ['t2', 't1', 'none']);
    assert.deepEqual(g[1].motifs.map(m => m.id), [11, 10]);
    assert.deepEqual(g[2].motifs.map(m => m.id), [13, 14]);
  });

  test('ohne Suche bleiben leere Themen stehen (Drop-Ziel), leeres «Ohne Thema» nur mit Themen', () => {
    const g = buildMotifGroups(themes, motifs.filter(m => m.theme_id === 1));
    assert.deepEqual(g.map(x => x.key), ['t2', 't1', 'none']);
    assert.equal(g[0].motifs.length, 0);
    assert.deepEqual(buildMotifGroups([], []).map(x => x.key), []);
  });

  test('Suche: Treffer in Name/Beschreibung/Trigger; Themen-Name zeigt alle seine Motive', () => {
    assert.deepEqual(buildMotifGroups(themes, motifs, 'regen').flatMap(g => g.motifs.map(m => m.id)), [10]);
    assert.deepEqual(buildMotifGroups(themes, motifs, 'selbst').flatMap(g => g.motifs.map(m => m.id)), [11]);
    const byTheme = buildMotifGroups(themes, motifs, 'schuld');
    assert.deepEqual(byTheme.map(g => g.key), ['t1']);
    assert.equal(byTheme[0].motifs.length, 2);
    assert.equal(byTheme[0].total, 2);
  });

  test('motifMatchesQuery ist case-insensitiv, leere Anfrage trifft alles', () => {
    assert.equal(motifMatchesQuery(motifs[0], ''), true);
    assert.equal(motifMatchesQuery(motifs[0], 'wass'), true);
    assert.equal(motifMatchesQuery(motifs[0], 'xyz'), false);
  });
});

describe('motifSparkCells', () => {
  test('eine Zelle je Kapitel, auf das Zeilen-Maximum normiert, Boden 14 %', () => {
    const chapters = [{ id: 1, name: 'K1' }, { id: 2, name: 'K2' }, { id: 3, name: 'K3' }];
    const cells = motifSparkCells([{ chapterId: 1, n: 100 }, { chapterId: 3, n: 1 }], sparkBuckets(chapters));
    assert.deepEqual(cells.map(c => c.n), [100, 0, 1]);
    assert.equal(cells[0].t, 100);
    assert.equal(cells[1].t, 0);
    assert.equal(cells[2].t, 14);
  });
  test('Kapitel-IDs typtolerant (Zahl vs. String)', () => {
    const cells = motifSparkCells([{ chapterId: '7', n: 2 }], sparkBuckets([{ id: 7, name: 'K7' }]));
    assert.equal(cells[0].n, 2);
  });
  test('Unterkapitel zählen zum Oberkapitel', () => {
    const chapters = [{ id: 1, name: 'A' }, { id: 2, name: 'A.1' }, { id: 3, name: 'A.1.a' }, { id: 4, name: 'B' }];
    const parentOf = new Map([['2', '1'], ['3', '2']]);
    const buckets = sparkBuckets(chapters, parentOf);
    assert.deepEqual(buckets.map(b => b.label), ['A', 'B']);
    const cells = motifSparkCells([{ chapterId: 2, n: 3 }, { chapterId: 3, n: 1 }, { chapterId: 4, n: 2 }], buckets);
    assert.deepEqual(cells.map(c => c.n), [4, 2]);
  });
  test('mehr Kapitel als Zellen: gleich grosse Folgen, nichts geht verloren', () => {
    const chapters = Array.from({ length: 54 }, (_, i) => ({ id: i + 1, name: 'K' + (i + 1) }));
    const buckets = sparkBuckets(chapters);
    assert.equal(buckets.length, SPARK_MAX_CELLS);
    assert.equal(buckets.flatMap(b => b.ids).length, 54);
    const sizes = buckets.map(b => b.ids.length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
    assert.equal(buckets[0].label, 'K1 – K2');
    assert.equal(new Set(buckets.map(b => b.key)).size, SPARK_MAX_CELLS);
    const cells = motifSparkCells(chapters.map(c => ({ chapterId: c.id, n: 1 })), buckets);
    assert.equal(cells.reduce((s, c) => s + c.n, 0), 54);
  });
  test('bis zur Obergrenze bleibt es eine Zelle je Kapitel', () => {
    const chapters = Array.from({ length: SPARK_MAX_CELLS }, (_, i) => ({ id: i + 1, name: 'K' + (i + 1) }));
    assert.deepEqual(sparkBuckets(chapters).map(b => b.label), chapters.map(c => c.name));
  });
});

describe('mergeMotifOrder', () => {
  test('geänderte Gruppen in neuer Reihenfolge, Rest unverändert, ohne Dubletten', () => {
    const groups = buildMotifGroups(themes, motifs);
    // Wasser (10) aus Schuld in Freiheit vor Käfig gezogen
    const changed = new Map([['t2', [10, 12]], ['t1', [11]]]);
    assert.deepEqual(mergeMotifOrder(groups, changed), [10, 12, 11, 13, 14]);
  });
});

describe('Trigger-Chips', () => {
  test('Komma trennt, Leerraum fällt weg', () => {
    assert.deepEqual(splitTriggerInput(' Regen, Fluss ,,ertrinken '), ['Regen', 'Fluss', 'ertrinken']);
    assert.deepEqual(splitTriggerInput(''), []);
  });
  test('Dubletten ohne Rücksicht auf Gross-/Kleinschreibung übergangen', () => {
    assert.deepEqual(mergeTriggerTerms(['Regen'], ['regen', 'Fluss', 'Fluss']), ['Regen', 'Fluss']);
  });
});

describe('groupOccurrences', () => {
  const occ = [
    { id: 1, chapter_id: 2, chapter_name: 'Zwei', source: 'semantic' },
    { id: 2, chapter_id: 1, chapter_name: 'Eins', source: 'trigger' },
    { id: 3, chapter_id: null, source: 'semantic' },
    { id: 4, chapter_id: 2, chapter_name: 'Zwei', source: 'trigger' },
  ];
  test('Gruppen in Lesereihenfolge, kapitellose zuletzt', () => {
    const g = groupOccurrences(occ, [1, 2]);
    assert.deepEqual(g.map(x => x.key), ['1', '2', '']);
    assert.deepEqual(g[1].items.map(o => o.id), [1, 4]);
  });
  test('Quellen-Filter', () => {
    const g = groupOccurrences(occ, [1, 2], 'trigger');
    assert.deepEqual(g.flatMap(x => x.items.map(o => o.id)), [2, 4]);
  });
});

test('clampPanelWidth deckelt auf die Grenzen', () => {
  assert.equal(clampPanelWidth(10), PANEL_W_MIN);
  assert.equal(clampPanelWidth(10000), PANEL_W_MAX);
  assert.equal(clampPanelWidth(400.4), 400);
});
