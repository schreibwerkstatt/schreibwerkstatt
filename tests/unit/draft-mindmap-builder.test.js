'use strict';
// Unit-Tests für lib/draft-mindmap-builder.js. Pure Function: figures-Row +
// Tags + Relations → jsMind-Mindmap. Verifiziert dass leere Felder den
// i18n-Marker des Default-Trees behalten und gefüllte Felder als Sub-Knoten
// im richtigen Container landen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMindmapFromFigure, mapArchetype } = require('../../lib/draft-mindmap-builder');

function findNode(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children || []) {
    const f = findNode(c, id);
    if (f) return f;
  }
  return null;
}

test('Default-Struktur bleibt bei leerer Figur erhalten', () => {
  const m = buildMindmapFromFigure({ name: 'Niemand' });
  assert.equal(m.data.id, 'root');
  assert.equal(m.data.topic, 'Niemand');
  // Default-Container existieren weiter
  assert.ok(findNode(m.data, 'steckbrief'));
  assert.ok(findNode(m.data, 'stimme'));
  assert.ok(findNode(m.data, 'subtext'));
  // Keine Felder gesetzt → keine Children unter aussehen, hintergrund, etc.
  assert.deepEqual(findNode(m.data, 'aussehen').children || [], []);
  assert.deepEqual(findNode(m.data, 'hintergrund').children || [], []);
  assert.deepEqual(findNode(m.data, 'beziehungen').children || [], []);
});

test('Stammdaten landen unter Steckbrief > Hintergrund', () => {
  const m = buildMindmapFromFigure({
    name: 'Anna', kurzname: 'Annie', geschlecht: 'w', beruf: 'Ärztin',
    wohnadresse: 'Bern', sozialschicht: 'mittel', rolle: 'Protagonistin',
  });
  const h = findNode(m.data, 'hintergrund');
  const labels = h.children.map(c => c.topic);
  assert.ok(labels.some(l => l.startsWith('Kurzname:') && l.includes('Annie')));
  assert.ok(labels.some(l => l.startsWith('Beruf:') && l.includes('Ärztin')));
  assert.ok(labels.some(l => l.startsWith('Wohnort:') && l.includes('Bern')));
  assert.ok(labels.some(l => l.startsWith('Sozialschicht:')));
  assert.ok(labels.some(l => l.startsWith('Rolle:')));
});

test('Beschreibung landet unter Aussehen', () => {
  const m = buildMindmapFromFigure({
    name: 'Boris',
    beschreibung: 'Hochgewachsener Mann mit Narbe über dem rechten Auge.',
  });
  const a = findNode(m.data, 'aussehen');
  assert.equal(a.children.length, 1);
  assert.ok(a.children[0].topic.includes('Narbe'));
});

test('Beziehungen aus relationsOut + relationsIn, mit Dedup', () => {
  const m = buildMindmapFromFigure({
    name: 'Carl',
    relationsOut: [
      { typ: 'mentor', partner_name: 'Eva', beschreibung: 'lehrt Magie' },
      { typ: 'mentor', partner_name: 'Eva', beschreibung: 'lehrt Magie' }, // Dupe
    ],
    relationsIn: [
      { typ: 'kind', partner_name: 'Heinz' },
    ],
  });
  const b = findNode(m.data, 'beziehungen');
  assert.equal(b.children.length, 2);
  assert.ok(b.children[0].topic.includes('Eva'));
  assert.ok(b.children[1].topic.includes('Heinz'));
});

test('Tags landen unter Persönlichkeit', () => {
  const m = buildMindmapFromFigure({
    name: 'Dora',
    tags: ['mutig', 'sarkastisch', ''], // leeren Tag ignorieren
  });
  const p = findNode(m.data, 'persoenlichkeit');
  assert.equal(p.children.length, 2);
  assert.deepEqual(p.children.map(c => c.topic), ['mutig', 'sarkastisch']);
});

test('Konflikt + entwicklung + motivation landen passend', () => {
  const m = buildMindmapFromFigure({
    name: 'Erik',
    konflikt: 'Loyalität vs. Wahrheit',
    entwicklung: 'Vom Soldaten zum Pazifisten',
    motivation: 'Vater rächen',
  });
  assert.ok(findNode(m.data, 'konflikt').children[0].topic.includes('Loyalität'));
  assert.ok(findNode(m.data, 'bogen').children[0].topic.includes('Pazifist'));
  assert.ok(findNode(m.data, 'want').children[0].topic.includes('rächen'));
});

test('mapArchetype matcht Whitelist-Synonyme', () => {
  assert.equal(mapArchetype('Protagonist'), 'protagonist');
  assert.equal(mapArchetype('Antagonistin'), 'antagonist');
  assert.equal(mapArchetype('Mentor'), 'mentor');
  assert.equal(mapArchetype('Nemesis'), 'nemesis');
  assert.equal(mapArchetype('Nebenfigur'), 'nebenfigur');
  // Katalog-Keys (public/js/book/figur-typen.js) — der Normalfall heute.
  assert.equal(mapArchetype('hauptfigur'), 'protagonist');
  assert.equal(mapArchetype('randfigur'), 'nebenfigur');
  assert.equal(mapArchetype('andere'), null);
  assert.equal(mapArchetype('Erzähler'), null);
  assert.equal(mapArchetype(''), null);
  assert.equal(mapArchetype(null), null);
});

test('Stammdaten-Labels folgen der Import-Sprache', () => {
  const en = buildMindmapFromFigure({ name: 'Annie', kurzname: 'Annie', beruf: 'Pilotin', stimme: 'rau' }, 'en');
  const de = buildMindmapFromFigure({ name: 'Annie', kurzname: 'Annie', beruf: 'Pilotin', stimme: 'rau' });
  const topics = (m) => JSON.stringify(m.data);
  assert.ok(topics(en).includes('Short name: Annie'));
  assert.ok(topics(en).includes('Occupation: Pilotin'));
  assert.ok(topics(en).includes('Voice: rau'));
  assert.ok(topics(de).includes('Kurzname: Annie'));
  assert.ok(!topics(en).includes('werkstatt.import.label'), 'kein unaufgeloester Key');
});
