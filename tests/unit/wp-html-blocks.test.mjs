// lib/wp-html.js — was ein WordPress-Round-Trip (Push → Pull) tragen muss und
// was die Push-Sperre erkennen muss. Gegenstueck zu tests/unit/wp-html.test.mjs:
// dort Grund-Mapping und Quellenverzeichnis, hier die App-Bloecke, die frueher
// beim Push verloren gingen (Bildnachweis, Gedicht, h5/h6, Todo, verschachtelte
// Liste, Bild-Link) und die Allowlist der Sperre.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const { wpToAppHtml, wpLossyBlocks, appToWpHtml } = await import('../../lib/wp-html.js');
const { carryBlockIds } = await import('../../lib/html-clean.js');

const squash = (s) => s.replace(/>\s+</g, '><').trim();
const roundTrip = async (html) => squash(await wpToAppHtml(appToWpHtml(html)));

test('Sperre: Bloecke ausserhalb der Allowlist (Galerie, Spalten, Weiterlesen)', () => {
  const gallery = '<!-- wp:gallery --><figure class="wp-block-gallery"><!-- wp:image {"id":1} --><figure class="wp-block-image"><img src="https://b/a.jpg"/></figure><!-- /wp:image --><!-- wp:image {"id":2} --><figure class="wp-block-image"><img src="https://b/b.jpg"/></figure><!-- /wp:image --></figure><!-- /wp:gallery -->';
  assert.deepEqual(wpLossyBlocks(gallery), ['gallery', 'wp:gallery']);
  assert.ok(wpLossyBlocks('<!-- wp:columns --><div class="wp-block-columns"><!-- wp:column --><div><p>x</p></div><!-- /wp:column --></div><!-- /wp:columns -->').includes('wp:columns'));
  assert.deepEqual(wpLossyBlocks('<!-- wp:more --><!--more--><!-- /wp:more -->'), ['wp:more']);
  assert.deepEqual(wpLossyBlocks('<!-- wp:acme/widget {"x":1} /-->'), ['wp:acme/widget']);
});

test('Sperre: Classic-Galerie ohne Block-Kommentare (Figur mit mehreren Bildern)', () => {
  assert.deepEqual(wpLossyBlocks('<figure><img src="https://b/a.jpg"><img src="https://b/b.jpg"></figure>'), ['gallery']);
});

test('Sperre: der eigene Push sperrt sich nie selbst', () => {
  const app = '<h2>T</h2><h5>Klein</h5><p class="x">A</p><figure><a href="https://l"><img src="https://b/c.jpg" alt="a"></a><figcaption>L</figcaption><p class="figure-credit">Foto: X</p></figure>'
    + '<div class="poem"><p>Z1</p><p>Z2</p></div><div class="msg-thread"><p class="msg-in">Hi</p></div>'
    + '<ul class="todo"><li class="todo-item"><input type="checkbox"><span class="todo-text">T</span></li></ul>'
    + '<ol><li>A<ul><li>A1</li></ul></li></ol><blockquote><p>Q</p></blockquote><pre>code</pre><hr>'
    + '<table><caption>C</caption><thead><tr><th scope="col">H</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>';
  assert.deepEqual(wpLossyBlocks(appToWpHtml(app)), []);
});

test('Round-Trip: Bildnachweis bleibt in der Abbildung, Bild-Link bleibt', async () => {
  const app = '<figure><a href="https://link.test/"><img src="https://b/c.jpg" alt="Alt"></a><figcaption>Legende</figcaption><p class="figure-credit">Foto: Jane Doe</p></figure>';
  const pushed = appToWpHtml(app);
  // Im Bildblock selbst kein <p> (sonst ungueltig im Block-Editor) — der
  // Nachweis steht als eigener Absatz dahinter.
  assert.doesNotMatch(/<!-- wp:image[\s\S]*?<!-- \/wp:image -->/.exec(pushed)[0], /figure-credit/);
  assert.match(pushed, /<!-- wp:paragraph \{"className":"figure-credit"\} -->/);
  assert.equal(await roundTrip(app), squash(app));
});

test('Round-Trip: Gedicht, h5/h6, Todo-Liste, verschachtelte Liste', async () => {
  for (const app of [
    '<div class="poem"><p>Zeile 1</p><p>Zeile 2</p></div>',
    '<h5>Fuenf</h5><h6>Sechs</h6>',
    '<ul class="todo"><li class="todo-item"><input type="checkbox" checked><span class="todo-text">Aufgabe</span></li></ul>',
    '<ul><li>A<ul><li>A1</li></ul></li><li>B</li></ul>',
  ]) {
    assert.equal(await roundTrip(app), squash(app), app);
  }
});

test('Push: verschachtelte Liste als inneren wp:list-Block, nicht als rohes <ul>', () => {
  const out = appToWpHtml('<ul><li>A<ul><li>A1</li></ul></li></ul>');
  assert.match(out, /<li>A<!-- wp:list -->/);
});

test('Push: loser Wrapper mit Bloecken → Bloecke, kein <p><p>', () => {
  const out = appToWpHtml('<div><p>eins</p><p>zwei</p></div>');
  assert.doesNotMatch(out, /<p>\s*<p>/);
  assert.equal((out.match(/<!-- wp:paragraph -->/g) || []).length, 2);
});

test('Pull: Theme-Klassen (size-*, align*, is-*, columns-*) fallen weg, App-Klassen bleiben', async () => {
  const out = await wpToAppHtml('<figure class="wp-block-image size-full aligncenter is-resized"><img src="https://b/x.jpg" class="wp-image-7"></figure><p class="has-large-font-size lead-x">T</p>');
  assert.doesNotMatch(out, /size-full|aligncenter|is-resized|has-large/);
  assert.match(out, /wp-image-7/);
  assert.match(out, /class="lead-x"/);
});

test('carryBlockIds: gleiche Bloecke behalten ihre ID, geaenderte nicht', () => {
  const old = '<p data-bid="aaaaaaaaaaaaaaaa">Gleich</p><p data-bid="bbbbbbbbbbbbbbbb">Alt</p><figure data-bid="cccccccccccccccc"><img src="data:x" alt="Bild"><figcaption>L</figcaption></figure>';
  const neu = '<p>Gleich</p><p>Neu</p><figure><img src="https://wp/x.png" alt="Bild"><figcaption>L</figcaption></figure>';
  const out = carryBlockIds(old, neu);
  assert.match(out, /<p data-bid="aaaaaaaaaaaaaaaa">Gleich<\/p>/);
  assert.match(out, /<p>Neu<\/p>/);
  // Abbildung ueber Alt-Text + Legende erkannt, nicht ueber die (gewechselte) URL.
  assert.match(out, /<figure data-bid="cccccccccccccccc">/);
});

test('carryBlockIds: zwei gleiche Absaetze behalten ihre Reihenfolge', () => {
  const old = '<p data-bid="1111111111111111">x</p><p data-bid="2222222222222222">y</p><p data-bid="3333333333333333">x</p>';
  const out = carryBlockIds(old, '<p>x</p><p>x</p>');
  assert.deepEqual(out.match(/data-bid="(\d)/g), ['data-bid="1', 'data-bid="3']);
});
