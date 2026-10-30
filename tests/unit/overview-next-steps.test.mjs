// Übersicht «Nächste Schritte» (public/js/book-overview/next-steps.js#computeNextSteps):
// Auswahl aus den Buchdaten, Priorität, Deckel und Wegklicken je Buch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNextSteps, NEXT_STEPS_MAX } from '../../public/js/book-overview/next-steps.js';

const open = () => true;
const ideen = (n) => Array.from({ length: n }, (_, i) => ({ status: 'offen', chapter_id: 10 + i }));
const base = {
  bookId: 7, tree: [], ideen: [], figurenCount: 3, figurenForbidden: false,
  chars: 50000, buchtyp: 'roman', pageCount: 4, bookChatSessions: 2, isFinished: false,
};

test('nichts zu tun → leer', () => {
  assert.deepEqual(computeNextSteps(base, open), []);
});

test('leeres Kapitel: erstes ohne Abschnitte, nicht solo/ausgeschlossen/mit Unterkapiteln', () => {
  const tree = [
    { type: 'chapter', id: 'solo-1', solo: true, pages: [] },
    { type: 'chapter', id: 1, name: 'Eins', pages: [{ id: 5 }] },
    { type: 'chapter', id: 2, name: 'Teil', hasChildren: true, pages: [] },
    { type: 'chapter', id: 3, name: 'Raus', excluded: true, pages: [] },
    { type: 'chapter', id: 4, name: 'Charlotte', pages: [] },
  ];
  const out = computeNextSteps({ ...base, tree }, open);
  assert.deepEqual(out, [{ kind: 'emptyChapter', key: 'overview.emptyChapter.7', params: { id: 4, name: 'Charlotte' } }]);
  assert.deepEqual(computeNextSteps({ ...base, tree, isFinished: true }, open), [], 'abgeschlossenes Buch: kein Schreibfront-Schritt');
});

test('Ideen-Check ab fünf offenen Ideen mit Ort; ohne Ort und erledigte zählen nicht', () => {
  assert.equal(computeNextSteps({ ...base, ideen: ideen(4) }, open).length, 0);
  const mixed = [...ideen(4), { status: 'erledigt', page_id: 1 }, { status: 'offen' }];
  assert.equal(computeNextSteps({ ...base, ideen: mixed }, open).length, 0);
  assert.deepEqual(computeNextSteps({ ...base, ideen: ideen(5) }, open)[0].params, { n: 5 });
});

test('Figuren: nur ohne Figuren, mit genug Text, erzählendes Buch, Recht vorhanden', () => {
  const d = { ...base, figurenCount: 0 };
  assert.equal(computeNextSteps(d, open)[0].kind, 'figuren');
  assert.equal(computeNextSteps({ ...d, chars: 1000 }, open).length, 0);
  assert.equal(computeNextSteps({ ...d, buchtyp: 'sachbuch' }, open).length, 0);
  assert.equal(computeNextSteps({ ...d, figurenForbidden: true }, open).length, 0);
});

test('Buch-Chat: nie genutzt und genug Abschnitte; unbekannt (null) zählt nicht als nie', () => {
  const d = { ...base, bookChatSessions: 0, pageCount: 8 };
  assert.equal(computeNextSteps(d, open)[0].kind, 'bookChat');
  assert.equal(computeNextSteps({ ...d, bookChatSessions: null }, open).length, 0);
  assert.equal(computeNextSteps({ ...d, pageCount: 7 }, open).length, 0);
});

test('weggeklickt (Key je Buch) und Deckel', () => {
  const all = {
    ...base, tree: [{ type: 'chapter', id: 4, name: 'X', pages: [] }], ideen: ideen(6),
    figurenCount: 0, bookChatSessions: 0, pageCount: 20,
  };
  const out = computeNextSteps(all, open);
  assert.equal(out.length, NEXT_STEPS_MAX);
  assert.deepEqual(out.map(s => s.kind), ['emptyChapter', 'ideenCheck', 'figuren']);
  const rest = computeNextSteps(all, k => k !== 'overview.emptyChapter.7');
  assert.deepEqual(rest.map(s => s.kind), ['ideenCheck', 'figuren', 'bookChat']);
});
