// Herkunft einer Zugangsanfrage (lib/register-source.js): Kampagnen-Parameter
// vor weitergereichtem `src` vor fremdem Referer; eigener Host zaehlt nicht.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { deriveSource, cleanSource, MAX_LEN } = require('../../lib/register-source.js');

test('utm-/ref-Parameter schlagen Referer und src', () => {
  const s = deriveSource({
    query: { utm_source: 'newsletter', utm_campaign: 'herbst', src: 'x' },
    referer: 'https://www.google.com/search?q=geheim',
    ownHost: 'app.example.com',
  });
  assert.equal(s, 'utm_source=newsletter · utm_campaign=herbst');
  assert.equal(deriveSource({ query: { ref: 'mastodon' } }), 'ref=mastodon');
});

test('src (von der Landing weitergereicht) vor Referer', () => {
  const s = deriveSource({
    query: { src: 'https://www.google.com' },
    referer: 'https://app.example.com/landing',
    ownHost: 'app.example.com',
  });
  assert.equal(s, 'https://www.google.com');
});

test('fremder Referer: Origin + Pfad, ohne Query und Fragment', () => {
  const s = deriveSource({
    referer: 'https://blog.example.org/post/42?token=abc#x',
    ownHost: 'app.example.com',
  });
  assert.equal(s, 'https://blog.example.org/post/42');
  assert.equal(deriveSource({ referer: 'https://www.google.com/' }), 'https://www.google.com');
});

test('eigener Host, ungültige und Nicht-HTTP-Referer ergeben null', () => {
  assert.equal(deriveSource({ referer: 'https://APP.example.com/landing', ownHost: 'app.example.com' }), null);
  assert.equal(deriveSource({ referer: 'kein url' }), null);
  assert.equal(deriveSource({ referer: 'android-app://com.google.android.gm/' }), null);
  assert.equal(deriveSource({}), null);
});

test('Array-Parameter: erster Wert zählt', () => {
  assert.equal(deriveSource({ query: { utm_source: ['a', 'b'] } }), 'utm_source=a');
});

test('cleanSource entfernt Steuerzeichen, verdichtet Whitespace, deckelt', () => {
  assert.equal(cleanSource('  a\n\tb\u0000c  '), 'a b c');
  assert.equal(cleanSource(''), null);
  assert.equal(cleanSource(null), null);
  assert.equal(cleanSource('x'.repeat(MAX_LEN + 50)).length, MAX_LEN);
  assert.equal(cleanSource('abcdef', 3), 'abc');
});
