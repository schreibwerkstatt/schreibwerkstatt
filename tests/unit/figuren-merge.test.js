'use strict';
// Unit: regelbasierte Figuren-Dedup-/Merge-Helper der Komplettanalyse-Phase 2.
// Decken die subtilen Korrektheits-Invarianten ab (gleicher Nachname ≠ Merge,
// Indizien-Schwelle, Mode-Vote nur bei Stimmen-Split, Beschreibungs-Rescue),
// die sonst nur indirekt über die Integration-Pipeline berührt werden.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  preMergeChapterFiguren, mergeDuplicateFiguren,
  applySozialschichtModeVote, validateBeziehungenDescriptions,
  ensureUniqueFigIds,
} = require('../../routes/jobs/komplett/figuren-merge');

// ── preMergeChapterFiguren ────────────────────────────────────────────────────
test('preMerge: exakter Name über Kapitel hinweg wird zusammengeführt', () => {
  const chapterFiguren = [
    { kapitel: 'K1', figuren: [{ id: 'a', name: 'Anna', kapitel: [{ name: 'K1', haeufigkeit: 2 }], eigenschaften: ['mutig'] }] },
    { kapitel: 'K2', figuren: [{ id: 'b', name: 'Anna', kapitel: [{ name: 'K2', haeufigkeit: 3 }], eigenschaften: ['klug'] }] },
  ];
  const { chapterFiguren: out, dupesRemoved } = preMergeChapterFiguren(chapterFiguren);
  assert.equal(dupesRemoved, 1);
  // Nur ein Vorkommen bleibt (im ersten Kapitel), das zweite ist konsumiert.
  const flat = out.flatMap(c => c.figuren);
  assert.equal(flat.length, 1);
  const anna = flat[0];
  // Kapitel-Häufigkeiten aggregiert, Eigenschaften verschmolzen.
  assert.deepEqual(anna.kapitel.sort((x, y) => x.name.localeCompare(y.name)),
    [{ name: 'K1', haeufigkeit: 2 }, { name: 'K2', haeufigkeit: 3 }]);
  assert.deepEqual([...anna.eigenschaften].sort(), ['klug', 'mutig']);
});

test('preMerge: Titel-Präfix normalisiert (Dr. Anna == Anna)', () => {
  const { dupesRemoved } = preMergeChapterFiguren([
    { kapitel: 'K1', figuren: [{ id: 'a', name: 'Dr. Anna' }] },
    { kapitel: 'K2', figuren: [{ id: 'b', name: 'Anna' }] },
  ]);
  assert.equal(dupesRemoved, 1);
});

test('preMerge: Teilname + 2 Indizien → Merge', () => {
  // «Gerold» Teilmenge von «Gerold Brunner»; gleicher Beruf (+1) + gleiches Kapitel (+1) = 2.
  const { chapterFiguren: out, dupesRemoved } = preMergeChapterFiguren([
    { kapitel: 'K1', figuren: [{ id: 'a', name: 'Gerold Brunner', beruf: 'Schmied', kapitel: [{ name: 'K1', haeufigkeit: 1 }] }] },
    { kapitel: 'K2', figuren: [{ id: 'b', name: 'Gerold', beruf: 'Schmied', kapitel: [{ name: 'K1', haeufigkeit: 1 }] }] },
  ]);
  assert.equal(dupesRemoved, 1);
  assert.equal(out.flatMap(c => c.figuren).length, 1);
});

test('preMerge: gleicher Nachname, andere Vornamen → NICHT zusammengeführt', () => {
  const { chapterFiguren: out, dupesRemoved } = preMergeChapterFiguren([
    { kapitel: 'K1', figuren: [{ id: 'a', name: 'Paul Schmidt', beruf: 'Arzt', kapitel: [{ name: 'K1', haeufigkeit: 1 }] }] },
    { kapitel: 'K2', figuren: [{ id: 'b', name: 'Marta Schmidt', beruf: 'Arzt', kapitel: [{ name: 'K1', haeufigkeit: 1 }] }] },
  ]);
  assert.equal(dupesRemoved, 0);
  assert.equal(out.flatMap(c => c.figuren).length, 2);
});

// ── mergeDuplicateFiguren ─────────────────────────────────────────────────────
test('mergeDuplicate Stufe 1: exakter Name, längere Beschreibung gewinnt als Kanon', () => {
  const { figuren, mergedCount, stage1Saved, idRemap } = mergeDuplicateFiguren([
    { id: 'fig_1', name: 'Anna', beschreibung: 'kurz' },
    { id: 'fig_2', name: 'Anna', beschreibung: 'eine deutlich längere Beschreibung' },
  ]);
  assert.equal(mergedCount, 1);
  assert.equal(stage1Saved, 1);
  assert.equal(figuren.length, 1);
  // group.sort stellt die längere Beschreibung nach vorn → fig_2 ist Kanon.
  assert.equal(figuren[0].id, 'fig_2');
  assert.equal(idRemap['fig_1'], 'fig_2');
});

test('mergeDuplicate Stufe 2: Teilname + Indizien, Beziehungen werden auf Kanon-ID umgebogen', () => {
  const { figuren, stage2Saved, idRemap } = mergeDuplicateFiguren([
    { id: 'fig_1', name: 'Gerold Brunner', beruf: 'Schmied', geschlecht: 'm',
      kapitel: [{ name: 'K1' }], beschreibung: 'der Schmied' },
    { id: 'fig_2', name: 'Gerold', beruf: 'Schmied', geschlecht: 'm', kapitel: [{ name: 'K1' }] },
    { id: 'fig_3', name: 'Klara', beziehungen: [{ figur_id: 'fig_2', typ: 'freund' }] },
  ]);
  assert.equal(stage2Saved, 1);
  assert.equal(idRemap['fig_2'], 'fig_1');
  // Klaras Beziehung zeigte auf fig_2 (gemergt) → muss jetzt auf fig_1 zeigen.
  const klara = figuren.find(f => f.name === 'Klara');
  assert.equal(klara.beziehungen[0].figur_id, 'fig_1');
});

test('mergeDuplicate: Selbst-Referenz + Beziehung auf nicht existente ID werden entfernt', () => {
  const { figuren } = mergeDuplicateFiguren([
    { id: 'fig_1', name: 'Anna', beziehungen: [
      { figur_id: 'fig_1', typ: 'andere' },   // Selbst-Ref
      { figur_id: 'fig_99', typ: 'feind' },    // unbekannt
      { figur_id: 'fig_2', typ: 'freund' },    // gültig
    ] },
    { id: 'fig_2', name: 'Bert' },
  ]);
  const anna = figuren.find(f => f.name === 'Anna');
  assert.equal(anna.beziehungen.length, 1);
  assert.equal(anna.beziehungen[0].figur_id, 'fig_2');
});

// ── applySozialschichtModeVote ────────────────────────────────────────────────
test('modeVote: Mehrheit über Phase-1-Rohdaten korrigiert die konsolidierte Schicht', () => {
  const chapterFiguren = [
    { figuren: [{ name: 'Anna', sozialschicht: 'oben' }] },
    { figuren: [{ name: 'Anna', sozialschicht: 'oben' }] },
    { figuren: [{ name: 'Anna', sozialschicht: 'oben' }] },
    { figuren: [{ name: 'Anna', sozialschicht: 'mitte' }] },
  ];
  const figuren = [{ name: 'Anna', sozialschicht: 'mitte' }];
  const changes = applySozialschichtModeVote(chapterFiguren, figuren);
  assert.equal(changes, 1);
  assert.equal(figuren[0].sozialschicht, 'oben');
});

test('modeVote: Gleichstand → keine Korrektur', () => {
  const chapterFiguren = [
    { figuren: [{ name: 'Anna', sozialschicht: 'oben' }] },
    { figuren: [{ name: 'Anna', sozialschicht: 'mitte' }] },
  ];
  const figuren = [{ name: 'Anna', sozialschicht: 'mitte' }];
  assert.equal(applySozialschichtModeVote(chapterFiguren, figuren), 0);
  assert.equal(figuren[0].sozialschicht, 'mitte');
});

test('modeVote: einstimmige Schicht (keine Stimmen-Streuung) → kein Eingriff', () => {
  // entries.length < 2 → die einstimmig gevotete Schicht überschreibt NICHT.
  const chapterFiguren = [
    { figuren: [{ name: 'Anna', sozialschicht: 'oben' }] },
    { figuren: [{ name: 'Anna', sozialschicht: 'oben' }] },
  ];
  const figuren = [{ name: 'Anna', sozialschicht: 'mitte' }];
  assert.equal(applySozialschichtModeVote(chapterFiguren, figuren), 0);
  assert.equal(figuren[0].sozialschicht, 'mitte');
});

// ── validateBeziehungenDescriptions ───────────────────────────────────────────
test('beziehungsBeschreibung: passende Beschreibung bleibt unangetastet', () => {
  const figuren = [
    { id: 'fig_1', name: 'Anna', beziehungen: [{ figur_id: 'fig_2', typ: 'freund', beschreibung: 'Bert ist Annas Begleiter' }] },
    { id: 'fig_2', name: 'Bert' },
  ];
  const { suspicious, moved } = validateBeziehungenDescriptions(figuren);
  assert.equal(suspicious, 0);
  assert.equal(moved, 0);
  assert.equal(figuren[0].beziehungen[0].beschreibung, 'Bert ist Annas Begleiter');
});

test('beziehungsBeschreibung: an die richtige (leere) Beziehung verschoben', () => {
  const figuren = [
    { id: 'fig_1', name: 'Anna', beziehungen: [
      { figur_id: 'fig_2', typ: 'freund', beschreibung: 'Cara ist die Schwester' }, // erwähnt Cara, nicht Bert
      { figur_id: 'fig_3', typ: 'geschwister' },                                     // leer → Ziel
    ] },
    { id: 'fig_2', name: 'Bert' },
    { id: 'fig_3', name: 'Cara' },
  ];
  const { suspicious, moved } = validateBeziehungenDescriptions(figuren);
  assert.equal(moved, 1);
  assert.equal(suspicious, 0);
  assert.equal(figuren[0].beziehungen[0].beschreibung, null);
  assert.equal(figuren[0].beziehungen[1].beschreibung, 'Cara ist die Schwester');
});

test('beziehungsBeschreibung: ohne erkennbare Figur → bleibt stehen (kein Urteil ohne Gegenbeleg)', () => {
  const figuren = [
    { id: 'fig_1', name: 'Anna', beziehungen: [{ figur_id: 'fig_2', typ: 'freund', beschreibung: 'irgendeine Notiz ohne Namen' }] },
    { id: 'fig_2', name: 'Bert' },
  ];
  const { suspicious, moved } = validateBeziehungenDescriptions(figuren);
  assert.equal(suspicious, 0);
  assert.equal(moved, 0);
  assert.equal(figuren[0].beziehungen[0].beschreibung, 'irgendeine Notiz ohne Namen');
});

// ── ensureUniqueFigIds ────────────────────────────────────────────────────────
// Schutz vor UNIQUE(book_id, fig_id, user_email): mergeDuplicateFiguren dedupt
// nur nach Namen, nicht nach id. Verschieden benannte Figuren mit gleicher id
// (KI-Konsolidierung oder fig_N-Index-Kollision) würden sonst den INSERT brechen.
test('ensureUniqueFigIds: doppelte id wird neu vergeben, erste behält sie', () => {
  const figuren = [
    { id: 'fig_3', name: 'Anna' },
    { id: 'fig_3', name: 'Bert' }, // Kollision
  ];
  const reassigned = ensureUniqueFigIds(figuren);
  assert.equal(reassigned, 1);
  assert.equal(figuren[0].id, 'fig_3');           // erste behält
  assert.notEqual(figuren[1].id, 'fig_3');         // zweite neu
  assert.equal(new Set(figuren.map(f => f.id)).size, 2);
});

test('ensureUniqueFigIds: neue id liegt über dem bisherigen Maximum', () => {
  const figuren = [
    { id: 'fig_3', name: 'Anna' },
    { id: 'fig_3', name: 'Bert' },
    { id: 'fig_7', name: 'Cara' },
  ];
  ensureUniqueFigIds(figuren);
  assert.equal(figuren[1].id, 'fig_8');
});

test('ensureUniqueFigIds: leere/fehlende id wird vergeben', () => {
  const figuren = [
    { id: 'fig_1', name: 'Anna' },
    { id: '', name: 'Bert' },
    { name: 'Cara' },
  ];
  const reassigned = ensureUniqueFigIds(figuren);
  assert.equal(reassigned, 2);
  assert.equal(new Set(figuren.map(f => f.id)).size, 3);
  assert.ok(figuren.every(f => /^fig_\d+$/.test(f.id)));
});

test('ensureUniqueFigIds: bereits eindeutig → no-op', () => {
  const figuren = [{ id: 'fig_1', name: 'Anna' }, { id: 'fig_2', name: 'Bert' }];
  assert.equal(ensureUniqueFigIds(figuren), 0);
  assert.deepEqual(figuren.map(f => f.id), ['fig_1', 'fig_2']);
});

// Regression: dieselbe Objekt-Referenz zweimal im Array. Ohne Vorab-Dedup würde
// die ID-Neuvergabe beide Slots (= dasselbe Objekt) gleich mutieren → erneut
// kollidierende fig_id → UNIQUE-Crash in saveFigurenToDb. Erwartung: Referenz
// einmal behalten, eindeutige IDs.
test('ensureUniqueFigIds: doppelte Objekt-Referenz wird kollabiert (nicht dupliziert)', () => {
  const shared = { id: 'fig_5', name: 'Anna' };
  const figuren = [shared, { id: 'fig_2', name: 'Bert' }, shared];
  ensureUniqueFigIds(figuren);
  assert.equal(figuren.length, 2, 'doppelte Referenz entfernt');
  assert.equal(new Set(figuren.map(f => f.id)).size, 2, 'IDs eindeutig');
  assert.ok(figuren.includes(shared));
});

test('ensureUniqueFigIds: doppelte Referenz UND ID-Kollision gemischt', () => {
  const shared = { id: 'fig_1', name: 'Anna' };
  const figuren = [shared, shared, { id: 'fig_1', name: 'Bert' }];
  ensureUniqueFigIds(figuren);
  assert.equal(figuren.length, 2);
  assert.equal(new Set(figuren.map(f => f.id)).size, 2);
});

// ── Anrede-/Indizien-Widerspruch: gleicher Schlüssel allein verschmilzt nicht ──
// normName schneidet Herr/Frau ab — «Herr Brunner» und «Frau Brunner» haben den
// Schlüssel `brunner`. Ebenso gleicher Name mit verschiedenen Geburtsjahren.
test('preMerge: Herr Brunner und Frau Brunner bleiben zwei Figuren, Dr. Brunner fällt auf den passenden', () => {
  const chapterFiguren = [
    { kapitel: 'K1', figuren: [{ id: 'a', name: 'Herr Brunner', kapitel: [{ name: 'K1' }] }] },
    { kapitel: 'K2', figuren: [
      { id: 'b', name: 'Frau Brunner', kapitel: [{ name: 'K2' }] },
      { id: 'c', name: 'Frau Brunner', kapitel: [{ name: 'K2' }], beruf: 'Ärztin' },
    ] },
  ];
  const { chapterFiguren: out, dupesRemoved } = preMergeChapterFiguren(chapterFiguren);
  const names = out.flatMap(c => c.figuren.map(f => f.name));
  assert.deepEqual(names, ['Herr Brunner', 'Frau Brunner']);
  assert.equal(dupesRemoved, 1, 'nur die zweite «Frau Brunner» geht auf');
  assert.equal(out[1].figuren[0].beruf, 'Ärztin');
});

test('preMerge: gleicher Name, verschiedene Geburtsjahre → NICHT zusammengeführt', () => {
  const chapterFiguren = [
    { kapitel: 'K1', figuren: [{ id: 'a', name: 'Anna Meier', geburtstag: '1943' }] },
    { kapitel: 'K2', figuren: [{ id: 'b', name: 'Anna Meier', geburtstag: '1978' }] },
  ];
  const { chapterFiguren: out, dupesRemoved } = preMergeChapterFiguren(chapterFiguren);
  assert.equal(dupesRemoved, 0);
  assert.equal(out.flatMap(c => c.figuren).length, 2);
});

test('mergeDuplicate Stufe 1: Herr/Frau Brunner getrennt, Dr. Brunner ohne Widerspruch gemergt', () => {
  const { figuren, idRemap } = mergeDuplicateFiguren([
    { id: 'fig_1', name: 'Herr Brunner', beschreibung: 'Der Vater' },
    { id: 'fig_2', name: 'Frau Brunner', beschreibung: 'Die Mutter' },
    { id: 'fig_3', name: 'Dr. Brunner', geschlecht: 'männlich' },
  ]);
  assert.deepEqual(figuren.map(f => f.id).sort(), ['fig_1', 'fig_2']);
  assert.equal(idRemap.fig_3, 'fig_1');
  assert.equal(idRemap.fig_2, undefined);
});

test('mergeDuplicate Stufe 1: gleicher Name, Geburtsjahr-Widerspruch → zwei Figuren', () => {
  const { figuren } = mergeDuplicateFiguren([
    { id: 'fig_1', name: 'Anna Meier', geburtstag: '1943' },
    { id: 'fig_2', name: 'Anna Meier', geburtstag: '1978' },
  ]);
  assert.equal(figuren.length, 2);
});

test('mergeDuplicate Stufe 1: Name ohne Anrede neben Herr UND Frau → mehrdeutig, bleibt eigenständig', () => {
  const { figuren } = mergeDuplicateFiguren([
    { id: 'fig_1', name: 'Herr Brunner', beschreibung: 'Der Vater, lang beschrieben' },
    { id: 'fig_2', name: 'Frau Brunner', beschreibung: 'Die Mutter' },
    { id: 'fig_3', name: 'Brunner' },
  ]);
  assert.equal(figuren.length, 3);
});

test('preMerge: Name ohne Anrede neben Herr UND Frau → nicht zugeordnet', () => {
  const { dupesRemoved } = preMergeChapterFiguren([
    { kapitel: 'K1', figuren: [{ id: 'a', name: 'Herr Brunner' }, { id: 'b', name: 'Frau Brunner' }] },
    { kapitel: 'K2', figuren: [{ id: 'c', name: 'Brunner' }] },
  ]);
  assert.equal(dupesRemoved, 0);
});
