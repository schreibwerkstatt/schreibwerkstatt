// lib/dev-seed-showcase.js — der Formatierungs-Schaukasten im Devmode-Testbuch
// muss jede Formatierung des Notebook-Editors enthalten. Neuer Slash-Menue-Key
// ohne Eintrag im Schaukasten ⇒ rot.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = window.matchMedia;
globalThis.Alpine = { store: () => ({ uiLocale: 'de' }) };

const { SLASH_ITEMS } = await import('../../public/js/editor/notebook/toolbar/_shared.js');
const require_ = createRequire(import.meta.url);
const {
  buildShowcaseHtml, SHOWCASE_SELECTORS, SHOWCASE_EXEMPT, SHOWCASE_INLINE_SELECTORS,
} = require_('../../lib/dev-seed-showcase.js');

const html = buildShowcaseHtml({ srcId: 7, imgId: 3, xrefChapterId: 11, xrefPageId: 12 });
const root = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body></html>`).document.getElementById('r');

test('Schaukasten: jeder Slash-Menue-Key ist abgedeckt oder bewusst ausgenommen', () => {
  for (const { key } of SLASH_ITEMS) {
    const covered = Object.hasOwn(SHOWCASE_SELECTORS, key);
    const exempt = SHOWCASE_EXEMPT.includes(key);
    assert.ok(covered !== exempt,
      `Slash-Key "${key}": in lib/dev-seed-showcase.js ins Markup + SHOWCASE_SELECTORS eintragen (oder begruendet in SHOWCASE_EXEMPT)`);
  }
  const keys = new Set(SLASH_ITEMS.map(i => i.key));
  for (const key of [...Object.keys(SHOWCASE_SELECTORS), ...SHOWCASE_EXEMPT]) {
    assert.ok(keys.has(key), `"${key}" steht im Schaukasten, aber nicht mehr in SLASH_ITEMS`);
  }
});

test('Schaukasten: jeder Selektor trifft im erzeugten Markup', () => {
  for (const [key, sel] of Object.entries({ ...SHOWCASE_SELECTORS, ...SHOWCASE_INLINE_SELECTORS })) {
    assert.ok(root.querySelector(sel), `"${key}" (${sel}) fehlt im Schaukasten-Markup`);
  }
});

test('Schaukasten: Block-IDs sind deterministisch und eindeutig', () => {
  const again = buildShowcaseHtml({ srcId: 7, imgId: 3, xrefChapterId: 11, xrefPageId: 12 });
  assert.equal(again, html);
  const bids = [...root.querySelectorAll('[data-bid]')].map(el => el.getAttribute('data-bid'));
  assert.equal(new Set(bids).size, bids.length);
});
