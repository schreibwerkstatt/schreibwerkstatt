// Diagnosezeile des Konflikt-Modals (public/js/editor/notebook/conflict-report.js):
// trägt Block-IDs, Zeitstempel und Entscheidungsgrundlagen — nie Manuskripttext.

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatConflictReport } from '../../public/js/editor/notebook/conflict-report.js';

const BASE = '<p data-bid="aaaaaaaaaaaaaaaa">Geheimer Satz eins.</p><p data-bid="bbbbbbbbbbbbbbbb">Zwei.</p>';
const LOCAL = '<p data-bid="aaaaaaaaaaaaaaaa">Geheimer Satz eins, weiter.</p><p data-bid="bbbbbbbbbbbbbbbb">Zwei.</p>';
const REMOTE = '<p data-bid="bbbbbbbbbbbbbbbb">Zwei.</p><p data-bid="cccccccccccccccc">Neu.</p>';

test('Diagnosezeile: Block-Herkunft je Konflikt, Zählung, keine Inhalte', () => {
  const line = formatConflictReport({
    pageId: 42, via: 'precheck', baseAt: 't0', remoteAt: 't1',
    author: { remoteIsSelf: true, remoteDeviceId: null }, ownFp: false,
    baseHtml: BASE, localHtml: LOCAL, remoteHtml: REMOTE,
    conflicts: [{ bid: 'aaaaaaaaaaaaaaaa' }],
  });
  assert.match(line, /Abschnitt 42 via precheck/);
  assert.match(line, /Basis t0 · Server t1/);
  assert.match(line, /eigenes Konto, Gerät unbekannt, Fingerabdruck kein Treffer/);
  assert.match(line, /Blöcke B\/L\/R 2\/2\/2/);
  assert.match(line, /Konflikte 1: aaaaaa:BL/);
  assert.doesNotMatch(line, /Geheimer|Zwei|Neu/);
});

test('Diagnosezeile: Block ohne ID erscheint als Platzhalter, nicht als Text', () => {
  const line = formatConflictReport({
    pageId: 1, via: 'draft', author: null, ownFp: true,
    baseHtml: '<p>ohne id</p>', localHtml: '<p>ohne id, lokal</p>', remoteHtml: '',
    conflicts: [{ bid: '__nobid_0' }],
  });
  assert.match(line, /fremdes Konto/);
  assert.match(line, /Fingerabdruck Treffer/);
  assert.match(line, /__nobid_0:BL/);
  assert.doesNotMatch(line, /ohne id/);
});
