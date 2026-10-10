// Unit-Tests für die Vorschau im Konflikt-Auflösungs-Modal
// (public/js/editor/shared/conflict-diff.js). Lauf: `node --test tests/unit/conflict-diff.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import { blockText, conflictDiffView } from '../../public/js/editor/shared/conflict-diff.js';

const join = parts => parts.map(p => p.v).join('');

test('blockText: Markup und data-bid raus, Entities dekodiert, Listenpunkte auf eigenen Zeilen', () => {
  assert.equal(blockText('<p data-bid="ab12">Er sagte: «nein» &amp; <b>ging</b>.</p>'), 'Er sagte: «nein» & ging.');
  assert.equal(blockText('<ul data-bid="x"><li>Eins</li><li>Zwei</li></ul>'), 'Eins\nZwei');
  assert.equal(blockText('<p>A<br>B&nbsp;C &#8212; D</p>'), 'A\nB C — D');
});

test('conflictDiffView: lokale Spalte zeigt eq+del, andere eq+add', () => {
  const v = conflictDiffView({
    local_html: '<p data-bid="a">Der Hund lief schnell.</p>',
    remote_html: '<p data-bid="a">Der Hund rannte schnell.</p>',
  });
  assert.equal(join(v.local), 'Der Hund lief schnell.');
  assert.equal(join(v.remote), 'Der Hund rannte schnell.');
  assert.deepEqual(v.local.filter(p => p.t === 'del').map(p => p.v), ['lief']);
  assert.deepEqual(v.remote.filter(p => p.t === 'add').map(p => p.v), ['rannte']);
  assert.equal(v.formatOnly, false);
});

test('conflictDiffView: gelöschte Seite → null', () => {
  const v = conflictDiffView({ local_html: null, remote_html: '<p>Neu</p>' });
  assert.equal(v.local, null);
  assert.equal(join(v.remote), 'Neu');
});

test('conflictDiffView: nur Formatierung geändert → formatOnly', () => {
  const v = conflictDiffView({ local_html: '<p>Ein <b>Wort</b></p>', remote_html: '<p>Ein <i>Wort</i></p>' });
  assert.equal(v.formatOnly, true);
});

test('conflictDiffView: unverändertes Wort bleibt Gleichtext, auch wenn Leerzeichen anders ausrichten könnten', () => {
  const v = conflictDiffView({
    local_html: '<p>Alpha gemeinsamer LOKAL Absatz.</p>',
    remote_html: '<p>Alpha FERN gemeinsamer Absatz.</p>',
  });
  assert.deepEqual(v.local.filter(p => p.t === 'del').map(p => p.v.trim()), ['LOKAL']);
  assert.deepEqual(v.remote.filter(p => p.t === 'add').map(p => p.v.trim()), ['FERN']);
});
