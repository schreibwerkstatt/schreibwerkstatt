'use strict';
// `_cacheFeatureLayout` (lib/pdf-render/fonts.js) — Shaping-Cache für Text mit
// OpenType-Features. Ohne ihn shapt fontkit jede Blocksatz-Zeile als Ganzes
// neu, und der synchrone PDF-Satz eines grossen Buchs blockiert den Server.
//
// Stub statt echter Schrift: geprüft wird die Zerlegung + der Cache, nicht
// fontkit selbst (ein Test mit Google-Fonts wäre in CI vom Netz abhängig).

const test = require('node:test');
const assert = require('node:assert/strict');
const { _cacheFeatureLayout } = require('../../lib/pdf-render/fonts');

// Je Zeichen ein Glyph mit Breite 10; zählt die Shaping-Aufrufe.
function stubFont() {
  const calls = [];
  const font = {
    calls,
    layoutRun(text, features) {
      calls.push({ text, features });
      const glyphs = [...text].map(ch => ({ id: ch.charCodeAt(0) }));
      const positions = glyphs.map(() => ({ xAdvance: 10, advanceWidth: 10 }));
      return { glyphs, positions, advanceWidth: 10 * glyphs.length };
    },
    layout(text) { return { plain: text }; },
  };
  return font;
}

test('Text mit Features wird an Leerzeichen zerlegt, Wörter einmal geshapt', () => {
  const f = stubFont();
  _cacheFeatureLayout(f);
  const feats = ['liga', 'kern'];
  const a = f.layout('der Hund der', feats);
  assert.deepEqual(f.calls.map(c => c.text), ['der ', 'Hund ', 'der']);
  assert.equal(a.glyphs.length, 12);
  assert.equal(a.positions.length, 12);
  assert.equal(a.advanceWidth, 120);
  f.layout('Hund der ', feats);
  // «Hund » und «der » kommen aus dem Cache, «der» (ohne Space) ebenso schon.
  assert.deepEqual(f.calls.map(c => c.text), ['der ', 'Hund ', 'der']);
});

test('onlyWidth liefert nur die Breite', () => {
  const f = stubFont();
  _cacheFeatureLayout(f);
  const r = f.layout('ab cd', ['kern'], true);
  assert.equal(r.glyphs, null);
  assert.equal(r.positions, null);
  assert.equal(r.advanceWidth, 50);
});

test('andere Features ⇒ eigener Cache-Eintrag', () => {
  const f = stubFont();
  _cacheFeatureLayout(f);
  f.layout('fi', ['liga']);
  f.layout('fi', ['liga', 'onum']);
  assert.equal(f.calls.length, 2);
});

test('ohne Features bleibt pdfkits eigener Pfad', () => {
  const f = stubFont();
  _cacheFeatureLayout(f);
  assert.deepEqual(f.layout('ab cd'), { plain: 'ab cd' });
  assert.deepEqual(f.layout('ab cd', []), { plain: 'ab cd' });
  assert.equal(f.calls.length, 0);
});

test('doppelter Aufruf patcht nicht zweimal', () => {
  const f = stubFont();
  _cacheFeatureLayout(f);
  const patched = f.layout;
  _cacheFeatureLayout(f);
  assert.equal(f.layout, patched);
});
