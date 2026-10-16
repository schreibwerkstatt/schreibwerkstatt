// Freigabe-Bedenken im Browser (public/js/redaktion/bedenken.js): Wortlaut des
// Hinweises und Sortierung der Übersicht. Die Bedenken selbst rechnet der Server
// (lib/freigabe-bedenken.js, Integration in tests/integration/bearbeitungsstand.test.js).
//
// Lauf: `node --test tests/unit/freigabe-bedenken.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bedenkenSaetze, bedenkenHinweis, bedenkenRows } from '../../public/js/redaktion/bedenken.js';

const t = (k, p) => (p ? `${k}${JSON.stringify(p)}` : k);

test('bedenkenHinweis: Abschnitt nennt Form und jeden O-Ton, leer ohne Bedenken', () => {
  assert.equal(bedenkenHinweis(null, {}, t), '');
  assert.equal(bedenkenHinweis({ struktur: null, otone: [] }, {}, t), '');
  const b = { struktur: { urteil: 'verfehlt' }, otone: [{ source_id: 1, title: 'G', oton_auth: 'ausstehend' }] };
  assert.equal(bedenkenSaetze(b, t).length, 2);
  const h = bedenkenHinweis(b, {}, t);
  assert.ok(h.startsWith('freigabe.bedenken.pageIntro '));
  assert.ok(h.includes('struktur.urteil.verfehlt'));
  assert.ok(h.includes('sources.otonAuth.ausstehend'));
});

test('bedenkenHinweis: Kapitel zählt statt aufzuzählen', () => {
  const h = bedenkenHinweis({
    1: { struktur: { urteil: 'lueckenhaft' }, otone: [] },
    2: { struktur: null, otone: [{ source_id: 3 }] },
  }, { chapter: true }, t);
  assert.equal(h, 'freigabe.bedenken.chapter{"n":2,"struktur":1,"otone":1}');
  assert.equal(bedenkenHinweis({}, { chapter: true }, t), '');
});

test('bedenkenRows: freigegebene zuerst, sonst Buchreihenfolge; fremde IDs fallen weg', () => {
  const pages = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }];
  const rows = bedenkenRows(
    { 1: { struktur: { urteil: 'verfehlt' } }, 3: { otone: [{ source_id: 9 }] }, 99: { otone: [] } },
    pages, { 3: { status: 'freigegeben' }, 1: { status: 'roh' } }, 'freigegeben');
  assert.deepEqual(rows.map(r => [r.id, r.released]), [[3, true], [1, false]]);
  assert.deepEqual(rows[1].otone, []);
});
