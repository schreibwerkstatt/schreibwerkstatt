// Chat-Markdown über markdown-it (public/js/utils/markdown.js): der Zustand
// vor dem Nachladen (escapter Klartext) und die Fälle, an denen der frühere
// Regex-Renderer scheiterte. Reihenfolge der Tests ist Absicht: der erste läuft
// vor loadChatMarkdown().
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderChatMarkdown, loadChatMarkdown, chatMarkdownReady } from '../../public/js/utils/markdown.js';

test('vor dem Laden: escapter Klartext mit <br>, kein Roh-HTML', () => {
  assert.equal(chatMarkdownReady(), false);
  assert.equal(renderChatMarkdown('a <img src=x onerror=alert(1)>\n**b**'),
    'a &lt;img src=x onerror=alert(1)&gt;<br>**b**');
});

test('nach dem Laden: Markdown wird gerendert', async () => {
  await loadChatMarkdown();
  assert.equal(chatMarkdownReady(), true);
  assert.match(renderChatMarkdown('**b**'), /<strong>b<\/strong>/);
});

const CASES = [
  ['Inline-Code schützt Sternchen', 'Nutze `a*b*c` hier', /<code class="chat-code">a\*b\*c<\/code>/],
  ['Multiplikation bleibt Text', 'Rechnung: 2 * 3 * 4', /2 \* 3 \* 4/],
  ['Unterstrich-Kursiv', 'das ist _wichtig_', /<em>wichtig<\/em>/],
  ['mehrzeiliger Listenpunkt bleibt in der Liste', '- eins\n  weiter\n- zwei', /<li>eins<br>\nweiter<\/li>/],
  ['Überschrift jenseits ###', '#### Vier', /<h5 class="chat-heading chat-heading--3">Vier<\/h5>/],
  ['nummerierte Liste behält Startwert', '3. drei\n4. vier', /<ol start="3"/],
  ['Link mit Klammern in der URL', '[Bern](https://de.wikipedia.org/wiki/Bern_(Stadt))', /href="https:\/\/de\.wikipedia\.org\/wiki\/Bern_\(Stadt\)"/],
  ['nackte URL wird verlinkt', 'siehe https://example.com/a', /<a href="https:\/\/example\.com\/a"[^>]*class="chat-link"/],
  ['Tabelle im Scroll-Wrapper', '| A |\n|---|\n| 1 |', /<div class="table-scroll"><table class="chat-table">/],
  ['Absatz bekommt Chat-Klasse', 'eins\n\nzwei', /<p class="chat-p">zwei<\/p>/],
];
for (const [name, md, re] of CASES) {
  test(`markdown-it: ${name}`, () => { assert.match(renderChatMarkdown(md), re); });
}

test('markdown-it: Bilder werden nie geladen', () => {
  assert.ok(!renderChatMarkdown('![a](https://evil.example/t.png)').includes('<img'));
});

test('markdown-it: data:- und javascript:-Links bleiben Klartext', () => {
  for (const md of ['[x](javascript:alert(1))', '[x](data:text/html,<script>alert(1)</script>)']) {
    const out = renderChatMarkdown(md);
    assert.ok(!out.includes('<a '), md);
    assert.ok(!out.includes('<script>'), md);
  }
});

test('markdown-it: Cite-Platzhalter der Recherche überleben das Rendern', () => {
  const OPEN = String.fromCharCode(0xE010), CLOSE = String.fromCharCode(0xE011);
  assert.ok(renderChatMarkdown(`Text ${OPEN}1${CLOSE} weiter`).includes(`${OPEN}1${CLOSE}`));
});
