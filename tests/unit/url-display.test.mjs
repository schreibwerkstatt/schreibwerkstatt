// Unit-Tests für public/js/utils/url-display.js — Anzeige-Kurzform von URLs
// (DESIGN.md „URL als Link-Text").
import test from 'node:test';
import assert from 'node:assert/strict';
import { shortUrl, linkText, urlHost } from '../../public/js/utils/url-display.js';

test('shortUrl: Schema, www, Query und Fragment fallen weg', () => {
  assert.equal(shortUrl('https://www.example.org/'), 'example.org');
  assert.equal(shortUrl('https://example.org/a?x=1#y'), 'example.org/a');
});

test('shortUrl: kurzer Pfad bleibt ganz, langer zeigt nur das letzte Stück', () => {
  assert.equal(shortUrl('https://example.org/wiki/Bern'), 'example.org/wiki/Bern');
  assert.equal(shortUrl('https://example.org/a/b/c/artikel'), 'example.org/…/artikel');
  assert.equal(shortUrl('https://example.org/sehr-langer-ordnername/x'), 'example.org/…/x');
});

test('shortUrl: Endstück dekodiert und mittig gekürzt', () => {
  assert.equal(shortUrl('https://de.wikipedia.org/wiki/Z%C3%BCrich'), 'de.wikipedia.org/wiki/Zürich');
  const s = shortUrl('https://example.org/' + 'a'.repeat(20) + 'b'.repeat(40));
  assert.ok(s.includes('…'));
  assert.ok(s.length < 50);
});

test('shortUrl: Nicht-http und Unsinn bleiben unverändert', () => {
  assert.equal(shortUrl('mailto:x@y.ch'), 'mailto:x@y.ch');
  assert.equal(shortUrl('kein link'), 'kein link');
  assert.equal(shortUrl(null), '');
});

test('linkText: Label vor Kurzform', () => {
  assert.equal(linkText('Wikipedia', 'https://de.wikipedia.org/wiki/Bern'), 'Wikipedia');
  assert.equal(linkText('  ', 'https://example.org/a'), 'example.org/a');
});

test('urlHost', () => {
  assert.equal(urlHost('https://www.nzz.ch/x'), 'nzz.ch');
  assert.equal(urlHost('quatsch'), '');
});
