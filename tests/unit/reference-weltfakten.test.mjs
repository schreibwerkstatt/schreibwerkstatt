// Weltfakten-Reiter im Referenz-Panel: Kontext-Regel.
// Ein Fakt haengt am KAPITEL (chapter_ids); „in diesem Abschnitt" kommt aus dem
// Herkunfts-Abschnitt (`seite`) oder dem Subjekt im Abschnittstext.
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectWeltfaktenForPage } from '../../public/js/cards/reference-weltfakten.js';

const fakten = [
  { id: 1, subjekt: 'Burg Eschen', fakt: 'hat drei Tore', seite: null, chapter_ids: [] },
  { id: 2, subjekt: 'Magie', fakt: 'kostet Erinnerung', seite: 'Der Aufbruch', chapter_ids: [5] },
  { id: 3, subjekt: 'Zunft', fakt: 'wählt jährlich', seite: 'Anderswo', chapter_ids: ['5'] },
  { id: 4, subjekt: 'Hafen', fakt: 'friert im Winter zu', seite: 'Der Aufbruch', chapter_ids: [9] },
  { id: 5, subjekt: null, fakt: 'Es gibt keine Pferde', seite: null, chapter_ids: [] },
];
const inText = (txt) => (name) => txt.includes(name.toLowerCase());

test('Herkunfts-Abschnitt und Subjekt im Text → page, Kapitel-Bruecke → chapter', () => {
  const out = selectWeltfaktenForPage(fakten, {
    pageName: 'der aufbruch ', chapterId: 5, inText: inText('vor der burg eschen stand er'),
  });
  assert.deepEqual(out.map(f => [f.id, f.refCtx]), [[1, 'page'], [2, 'page'], [3, 'chapter']]);
});

test('gleichnamiger Abschnitt eines anderen Kapitels zaehlt nicht', () => {
  const out = selectWeltfaktenForPage(fakten, { pageName: 'Der Aufbruch', chapterId: 5 });
  assert.ok(!out.some(f => f.id === 4));
});

test('ohne Kapitel nur Treffer aus Text/Herkunft; Eingabe bleibt unveraendert', () => {
  const out = selectWeltfaktenForPage(fakten, { pageName: '', chapterId: null, inText: inText('magie') });
  assert.deepEqual(out.map(f => f.id), [2]);
  assert.equal(fakten[1].refCtx, undefined);
});
