// Unit-Tests für die deterministische Buch-Befund-Engine (lib/narrative-report.js).
// Pure Funktion über Katalog-Zeilen — kein DB, kein KI. Deckt die 8 Befunde ab:
// Präsenzbogen/Absenz, statisch, Begegnungslücken, Pacing-Sag/-Flags, fallengelassene
// Motive, Schauplatz-Nutzung, POV-Konfidenz-Läufe, Ereignis-Wüsten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { computeNarrativeReport, NARRATIVE_REPORT_THRESHOLDS } = require('../../lib/narrative-report.js');

// Helfer: baut eine Kapitel-Achse mit chapter_id = 1..n.
function chapters(n) {
  return Array.from({ length: n }, (_, i) => ({ chapter_id: i + 1, kapitel: `Kap ${i + 1}`, sort_order: i }));
}

test('leere Eingabe → leerer Befund', () => {
  const r = computeNarrativeReport({});
  assert.equal(r.chapterCount, 0);
  assert.deepEqual(r.arcs, []);
  assert.deepEqual(r.encounters, []);
  assert.deepEqual(r.presenceBand, { chapters: [], figures: [] });
});

test('Präsenz-Band: Vektor + Flags pro Hauptfigur, nach Präsenz sortiert', () => {
  const n = 24;
  const appearances = [];
  // Figur 1 (Held): fast durchgehend präsent, keine Ereignisse → static.
  for (let ch = 1; ch <= 20; ch++) appearances.push({ figure_id: 1, chapter_id: ch });
  // Figur 2: Kap 1–3, dann erst wieder 22–24 → disappears.
  for (const ch of [1, 2, 3, 22, 23, 24]) appearances.push({ figure_id: 2, chapter_id: ch });
  const r = computeNarrativeReport({
    chapters: chapters(n),
    figures: [{ id: 1, name: 'Held' }, { id: 2, name: 'Nebel' }],
    appearances,
    events: [],
  });
  assert.equal(r.presenceBand.chapters.length, n);
  assert.equal(r.presenceBand.figures.length, 2);
  const held = r.presenceBand.figures[0]; // präsenter → zuerst
  assert.equal(held.name, 'Held');
  assert.equal(held.present.length, n);
  assert.equal(held.present[0], 1);
  assert.equal(held.present[23], 0);
  assert.ok(held.flags.includes('static'));
  const nebel = r.presenceBand.figures[1];
  assert.ok(nebel.flags.includes('disappears'));
  assert.equal(nebel.present[10], 0);
});

test('Präsenzbogen: Absenz-Lücke wird als disappears geflaggt', () => {
  const n = 24;
  // Figur 1 in Kap 1–3, dann erst wieder Kap 22–24 (18 Kapitel Lücke).
  const present = [1, 2, 3, 22, 23, 24];
  const appearances = present.map(ch => ({ figure_id: 1, chapter_id: ch }));
  const r = computeNarrativeReport({
    chapters: chapters(n),
    figures: [{ id: 1, name: 'Anna' }],
    appearances,
  });
  const arc = r.arcs.find(a => a.id === 1);
  assert.ok(arc, 'Arc für Hauptfigur vorhanden');
  assert.equal(arc.longestGap.len, 18);
  assert.ok(arc.flags.includes('disappears'));
  assert.equal(arc.eventCount, 0);
});

test('Präsenzbogen: hohe Präsenz + 0 Ereignisse → static', () => {
  const n = 10;
  const appearances = Array.from({ length: 6 }, (_, i) => ({ figure_id: 1, chapter_id: i + 1 }));
  const r = computeNarrativeReport({
    chapters: chapters(n),
    figures: [{ id: 1, name: 'Bert' }],
    appearances,
    events: [],
  });
  const arc = r.arcs.find(a => a.id === 1);
  assert.ok(arc.flags.includes('static'));
  // Mit Ereignissen kein static-Flag.
  const r2 = computeNarrativeReport({
    chapters: chapters(n),
    figures: [{ id: 1, name: 'Bert' }],
    appearances,
    events: [{ figure_id: 1, chapter_id: 2 }],
  });
  assert.ok(!r2.arcs.find(a => a.id === 1).flags.includes('static'));
});

test('Nebenfigur (<3 Kapitel) erscheint nicht in arcs', () => {
  const r = computeNarrativeReport({
    chapters: chapters(10),
    figures: [{ id: 1, name: 'Statist' }],
    appearances: [{ figure_id: 1, chapter_id: 1 }, { figure_id: 1, chapter_id: 2 }],
  });
  assert.equal(r.arcs.length, 0);
});

test('Begegnungslücke: Hauptfiguren ohne gemeinsame Szene, Beziehung zuerst', () => {
  const n = 10;
  const appearances = [];
  for (const fid of [1, 2, 3]) for (let ch = 1; ch <= 5; ch++) appearances.push({ figure_id: fid, chapter_id: ch });
  const r = computeNarrativeReport({
    chapters: chapters(n),
    figures: [{ id: 1, name: 'Held' }, { id: 2, name: 'Antagonist' }, { id: 3, name: 'Freund' }],
    appearances,
    // Held(1) & Freund(3) teilen Szene 100; Held(1) & Antagonist(2) NIE.
    scenes: [{ id: 100, chapter_id: 1 }],
    sceneFigures: [{ scene_id: 100, figure_id: 1 }, { scene_id: 100, figure_id: 3 }],
    // Deklarierte Beziehung Held↔Antagonist (behauptet, nie gezeigt).
    relations: [{ from_fig_id: 1, to_fig_id: 2, typ: 'feind' }],
  });
  assert.ok(r.encounters.length >= 1);
  const first = r.encounters[0];
  assert.ok(first.hasRelation, 'Beziehungs-Paar zuerst');
  assert.equal(first.relTyp, 'feind');
  const names = [first.aName, first.bName].sort();
  assert.deepEqual(names, ['Antagonist', 'Held']);
  // Held & Freund teilen eine Szene → keine Lücke zwischen ihnen.
  assert.ok(!r.encounters.some(e => [e.aName, e.bName].sort().join() === ['Freund', 'Held'].sort().join()));
});

test('Pacing: Sag-Lauf + no_peak + flat Flags', () => {
  const n = 6;
  // Alle Kapitel Intensität 2 → Sag über alle, kein Peak, flach.
  const narrative = chapters(n).map(c => ({ chapter_id: c.chapter_id, intensitaet: 2, pov_konfidenz: 0.9 }));
  const r = computeNarrativeReport({ chapters: chapters(n), narrative });
  assert.equal(r.pacing.sags.length, 1);
  assert.equal(r.pacing.sags[0].len, 6);
  assert.ok(r.pacing.flags.includes('no_peak'));
  assert.ok(r.pacing.flags.includes('flat'));
  assert.equal(r.pacing.peakIntensitaet, 2);
});

test('Pacing: Peak in zweiter Hälfte → monotone_first_half', () => {
  const n = 8;
  const vals = [2, 2, 3, 3, 4, 5, 4, 3];
  const narrative = vals.map((v, i) => ({ chapter_id: i + 1, intensitaet: v, pov_konfidenz: 0.9 }));
  const r = computeNarrativeReport({ chapters: chapters(n), narrative });
  assert.ok(r.pacing.flags.includes('monotone_first_half'));
  assert.equal(r.pacing.peakIntensitaet, 5);
  assert.ok(!r.pacing.flags.includes('no_peak'));
});

test('Fallengelassenes Motiv: früh eingeführt, nie in 2. Hälfte', () => {
  const n = 12;
  const themes = [
    { chapter_id: 1, thema: 'die Uhr', typ: 'symbol' },
    { chapter_id: 2, thema: 'die Uhr', typ: 'symbol' },
    // durchgehendes Motiv (nicht fallengelassen):
    { chapter_id: 1, thema: 'Schuld', typ: 'thema' },
    { chapter_id: 10, thema: 'Schuld', typ: 'thema' },
  ];
  const r = computeNarrativeReport({ chapters: chapters(n), themes });
  const dropped = r.droppedMotifs.map(d => d.thema);
  assert.ok(dropped.includes('die Uhr'));
  assert.ok(!dropped.includes('Schuld'));
});

test('Fallengelassenes Motiv: einmal gesetztes Symbol ist kein fallengelassenes Motiv', () => {
  const r = computeNarrativeReport({
    chapters: chapters(12),
    themes: [{ chapter_id: 1, thema: 'der Beton-Kubus', typ: 'symbol' }],
  });
  assert.deepEqual(r.droppedMotifs, []);
});

test('computed: «nicht berechnet» ist von «leer» unterscheidbar', () => {
  // Eine einzige Hauptfigur → Begegnungslücken nicht berechenbar.
  const one = computeNarrativeReport({
    chapters: chapters(12),
    figures: [{ id: 1, name: 'Ilona' }],
    appearances: [1, 3, 5].map(ch => ({ figure_id: 1, chapter_id: ch })),
  });
  assert.equal(one.computed.encounters, false);
  assert.equal(one.computed.eventDeserts, false, 'ohne datierte Ereignisse');
  assert.equal(one.computed.spans, true);
  // Zwei Hauptfiguren, die sich in einer Szene treffen → berechnet, aber leer.
  const two = computeNarrativeReport({
    chapters: chapters(12),
    figures: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }],
    appearances: [1, 2, 3].flatMap(ch => [{ figure_id: 1, chapter_id: ch }, { figure_id: 2, chapter_id: ch }]),
    sceneFigures: [{ scene_id: 9, figure_id: 1 }, { scene_id: 9, figure_id: 2 }],
  });
  assert.equal(two.computed.encounters, true);
  assert.deepEqual(two.encounters, []);
  assert.equal(computeNarrativeReport({ chapters: chapters(5) }).computed.spans, false);
});

test('Schauplatz: Einmal-Ort landet in oneOff', () => {
  const n = 8;
  const r = computeNarrativeReport({
    chapters: chapters(n),
    locations: [{ id: 1, name: 'Bahnhof' }, { id: 2, name: 'Haus' }],
    locationChapters: [
      { location_id: 1, chapter_id: 4 },              // einmal
      { location_id: 2, chapter_id: 1 }, { location_id: 2, chapter_id: 7 }, // mehrfach
    ],
  });
  assert.deepEqual(r.locations.oneOff.map(l => l.name), ['Bahnhof']);
});

test('POV: Konfidenz-Lauf unter Schwelle', () => {
  const n = 5;
  const conf = [0.9, 0.4, 0.3, 0.5, 0.9];
  const narrative = conf.map((c, i) => ({ chapter_id: i + 1, pov_konfidenz: c }));
  const r = computeNarrativeReport({ chapters: chapters(n), narrative });
  assert.equal(r.pov.lowConfidenceRuns.length, 1);
  assert.equal(r.pov.lowConfidenceRuns[0].len, 3);
});

test('Ereignis-Wüste: ≥5 Kapitel ohne Ereignis (aber Buch hat Ereignisse)', () => {
  const n = 10;
  const events = [{ figure_id: 1, chapter_id: 1 }, { figure_id: 1, chapter_id: 10 }];
  const r = computeNarrativeReport({ chapters: chapters(n), figures: [{ id: 1, name: 'X' }], events });
  assert.equal(r.eventDeserts.length, 1);
  assert.equal(r.eventDeserts[0].len, 8); // Kap 2–9
});

test('Ereignis-Wüste: ohne jegliche Ereignisse keine Meldung', () => {
  const r = computeNarrativeReport({ chapters: chapters(10), events: [] });
  assert.deepEqual(r.eventDeserts, []);
});

test('Schwellen sind exportiert und plausibel', () => {
  assert.equal(NARRATIVE_REPORT_THRESHOLDS.MAIN_FIGURE_MIN_CHAPTERS, 3);
  assert.ok(NARRATIVE_REPORT_THRESHOLDS.PACING_SAG_MIN_RUN >= 2);
});
