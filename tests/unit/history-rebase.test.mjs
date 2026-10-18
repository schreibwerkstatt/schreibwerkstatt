// Unit-Tests für public/js/editor/shared/history-rebase.js — hebt Undo-Stände
// über einen kollisionsfreien Remote-Merge (Notebook- und Bucheditor).
// Fixtures sind statische HTML-Literale aus dem Test-Source.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.DOMParser = window.DOMParser;

const { createSnapshotRebaser } = await import('../../public/js/editor/shared/history-rebase.js');

const BASE = '<p data-bid="b1">eins</p><p data-bid="b2">zwei</p>';
// Remote hat «zwei» geändert und einen Absatz angehängt.
const REMOTE = '<p data-bid="b1">eins</p><p data-bid="b2">ZWEI</p><p data-bid="b3">drei</p>';

test('älterer Stand bekommt die Remote-Blöcke, behält die eigenen', () => {
  const map = createSnapshotRebaser(BASE, REMOTE);
  const out = map('<p data-bid="b1">eins!</p><p data-bid="b2">zwei</p>');
  assert.match(out, /eins!/, 'eigene Änderung bleibt');
  assert.match(out, /ZWEI/, 'Remote-Änderung steht drin');
  assert.match(out, /drei/, 'Remote-Absatz steht drin');
});

test('derselbe Block lokal und remote anders → nicht übertragbar', () => {
  const map = createSnapshotRebaser(BASE, REMOTE);
  assert.equal(map('<p data-bid="b1">eins</p><p data-bid="b2">zwo</p>'), null);
});

test('Stand ohne IDs (vor dem ersten Save getippt) wird über den Text zugeordnet', () => {
  const map = createSnapshotRebaser(BASE, REMOTE);
  const out = map('<p>eins</p><p>zwei</p><p>neu</p>');
  assert.match(out, /ZWEI/);
  assert.match(out, /neu/);
  assert.doesNotMatch(out, />zwei</, 'unveränderter Block übernimmt die Remote-Fassung');
});

test('loser Text direkt unter der Wurzel → nicht übertragbar statt still verloren', () => {
  const map = createSnapshotRebaser(BASE, REMOTE);
  assert.equal(map('<p data-bid="b1">eins</p>loser Text'), null);
});

test('Basis ohne IDs → nichts übertragbar', () => {
  const map = createSnapshotRebaser('<p>eins</p>', REMOTE);
  assert.equal(map('<p>eins</p>'), null);
});
