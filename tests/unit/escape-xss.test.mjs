// Tests für escHtml + renderChatMarkdown:
// XSS-Regression. KI- und User-Inhalte fliessen über `x-html`-Sinks ins DOM
// (Review-Renderer, Chat-Markdown, Status-Strings). CLAUDE.md fordert ein
// Escape-First-Modell ohne Runtime-Sanitizer; jede neue Sink muss durch
// escHtml. Dieser Test prüft die Escape-Invariante.
import test from 'node:test';
import assert from 'node:assert/strict';
import { escHtml, renderChatMarkdown } from '../../public/js/utils.js';

const PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '"><svg onload=alert(1)>',
  "'\"><body onload=alert(1)>",
  '<a href="javascript:alert(1)">x</a>',
];

test('escHtml: neutralisiert <script>', () => {
  const out = escHtml('<script>alert(1)</script>');
  assert.equal(out, '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.ok(!out.includes('<script'));
  assert.ok(!out.includes('</script>'));
});

test('escHtml: alle XSS-Payloads enthalten kein < oder " ungeschützt', () => {
  for (const p of PAYLOADS) {
    const out = escHtml(p);
    assert.ok(!/[<>]/.test(out), `payload "${p}" → output "${out}" enthält < oder >`);
    // Quotes müssen escaped sein
    assert.ok(!out.includes('"'), `payload "${p}" → output enthält literal "`);
  }
});

test('escHtml: ampersand wird zuerst escaped (verhindert double-encode)', () => {
  // & vor < ersetzen, sonst würde &lt; zu &amp;lt; werden.
  assert.equal(escHtml('a & b'), 'a &amp; b');
  assert.equal(escHtml('<'), '&lt;');
  // Kombination: bereits escaped Inhalt darf nicht doppelt encoded werden
  // (passiert hier nicht, weil escHtml input als raw behandelt – aber
  // das & muss sicher nur einmal pro Pass laufen).
  assert.equal(escHtml('<&>'), '&lt;&amp;&gt;');
});

test('escHtml: null/undefined → leerer String, kein Crash; 0 bleibt sichtbar', () => {
  assert.equal(escHtml(null), '');
  assert.equal(escHtml(undefined), '');
  assert.equal(escHtml(''), '');
  assert.equal(escHtml(0), '0'); // 0 ist ein Wert (Zähler, Seitenzahl) — nur null/undefined werden leer
});

test('renderChatMarkdown: escapt Input zuerst – <script> wird unausführbar', () => {
  const out = renderChatMarkdown('Hier: <script>alert(1)</script>');
  assert.ok(!out.includes('<script>'),
    'renderChatMarkdown muss vor Markdown-Processing escapen');
  assert.match(out, /&lt;script&gt;/);
});

test('renderChatMarkdown: img-onerror-Payload bleibt unausführbar', () => {
  const out = renderChatMarkdown('<img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<img'),
    '<img>-Tag muss escaped sein, sonst feuert onerror');
  // onerror= als Text-Inhalt ist OK (kein < davor → kein Attribut-Kontext);
  // entscheidend ist: das öffnende `<` ist neutralisiert.
  assert.match(out, /&lt;img/);
});

test('renderChatMarkdown: Markdown-Features funktionieren weiter (regression)', () => {
  // **bold** → <strong>, *italic* → <em>, `code` → <code>
  const out = renderChatMarkdown('**fett** *kursiv* `code`');
  assert.match(out, /<strong>fett<\/strong>/);
  assert.match(out, /<em>kursiv<\/em>/);
  assert.match(out, /<code class="chat-code">code<\/code>/);
});

test('renderChatMarkdown: payload IM Markdown-Kontext bleibt escaped', () => {
  // Ein Angreifer könnte versuchen, das Tag durch Bold/Italic-Marker zu schmuggeln.
  const out = renderChatMarkdown('**<script>alert(1)</script>**');
  assert.match(out, /<strong>/);
  assert.ok(!out.includes('<script>'));
  assert.match(out, /&lt;script&gt;/);
});

test('renderChatMarkdown: leerer Input → leerer Output', () => {
  assert.equal(renderChatMarkdown(''), '');
  assert.equal(renderChatMarkdown(null), '');
});

test('renderChatMarkdown: Tabelle escapt Zelleninhalt', () => {
  // Dreifaches Zeilenende: Tabellen-Regex captured \|[^\n]+\n, also muss
  // jede Zeile auf \n enden (auch die letzte) damit der Markdown-Parser
  // sie als Block erkennt.
  const md = '| Name | Wert |\n|---|---|\n| <script>x</script> | y |\n';
  const out = renderChatMarkdown(md);
  assert.match(out, /<table/);
  assert.ok(!out.includes('<script>'),
    'Tabellenzellen müssen escaped sein – sonst XSS via Markdown-Tabelle');
});

test('renderChatMarkdown: [Text](url) → Link bei http(s)/mailto', () => {
  const out = renderChatMarkdown('Siehe [Anthropic](https://anthropic.com).');
  assert.match(out, /<a href="https:\/\/anthropic\.com" target="_blank" rel="noopener noreferrer" class="chat-link">Anthropic<\/a>/);
});

test('renderChatMarkdown: gefährliches Link-Protokoll bleibt Klartext', () => {
  // javascript:/data: dürfen NICHT zu href werden – Markdown-Link-XSS.
  const out = renderChatMarkdown('Klick [hier](javascript:alert(1)).');
  assert.ok(!out.includes('<a '), 'javascript:-URL darf kein <a>-Tag erzeugen');
  assert.ok(!out.includes('href='));
});

test('renderChatMarkdown: verschachtelte Liste → genestete <ul>/<ol>', () => {
  const out = renderChatMarkdown('- A\n  - A1\n- B');
  assert.match(out, /<ul class="chat-list"><li>A<ul class="chat-list"><li>A1<\/li><\/ul><\/li><li>B<\/li><\/ul>/);
});

test('renderChatMarkdown: Fenced Code-Block bleibt unzerstückelt + escaped', () => {
  const out = renderChatMarkdown('x\n```json\n{ "a": 1 }\n```\ny');
  assert.match(out, /<pre class="chat-pre"><code>/);
  assert.match(out, /&quot;a&quot;/, 'Code-Inhalt muss escaped sein');
  assert.ok(!out.includes('<br>{'), 'Code-Block darf nicht in <br>-Fragmente zerfallen');
});

