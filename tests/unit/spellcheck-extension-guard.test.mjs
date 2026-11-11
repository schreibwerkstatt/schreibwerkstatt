// Erkennung der LanguageTool-Browser-Erweiterung: der MutationObserver auf
// document.body feuert bei jedem Tastendruck. `mutationsTouchMarker` entscheidet,
// ob eine Mutationsserie überhaupt einen Erweiterungs-Marker betrifft — nur dann
// läuft der Scan über das ganze Dokument. Ein Tastendruck im Editor (Text,
// Zähler, Badge) darf ihn nicht auslösen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document } = parseHTML('<!doctype html><html><body><div id="ed"><p>Text</p></div></body></html>');
globalThis.document = document;

const { mutationsTouchMarker } = await import('../../public/js/cards/editor-spellcheck/extension-guard.js');

const added = (...nodes) => ({ type: 'childList', target: document.body, addedNodes: nodes, removedNodes: [] });
const el = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; };

test('Tippen im Editor: Text- und Zählerknoten lösen keinen Scan aus', () => {
  const p = el('<p>Neuer Absatz</p>');
  const counter = el('<span class="focus-counter">1234</span>');
  assert.equal(mutationsTouchMarker([added(document.createTextNode('a')), added(p, counter)]), false);
  assert.equal(mutationsTouchMarker([{ type: 'attributes', target: el('<div class="page-editor-marks-layer"></div>'), addedNodes: [], removedNodes: [] }]), false);
});

test('Erweiterung fügt ihr Element ein: erkannt', () => {
  assert.equal(mutationsTouchMarker([added(el('<lt-highlighter></lt-highlighter>'))]), true);
  assert.equal(mutationsTouchMarker([added(el('<div class="lt-toolbar__wrapper"></div>'))]), true);
});

test('Marker tief in einem eingefügten Teilbaum: erkannt', () => {
  assert.equal(mutationsTouchMarker([added(el('<section><div><lt-div></lt-div></div></section>'))]), true);
});

test('Klassenwechsel auf ein Erweiterungs-Element: erkannt', () => {
  const t = el('<div class="x-languagetool-active"></div>');
  assert.equal(mutationsTouchMarker([{ type: 'attributes', target: t, addedNodes: [], removedNodes: [] }]), true);
});
