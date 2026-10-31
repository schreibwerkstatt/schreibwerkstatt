// Chat-Ersatz mit Auszeichnung und Absatzteilung (public/js/utils/html-replace-rich.js):
//   - *kursiv* / **fett** werden echtes <em>/<strong>, nie Sternchen im Buch
//   - Leerzeile im Ersatz teilt den Absatz, nur in einem schlichten <p>
//   - ohne beides identisch zu replaceInHtml
import test from 'node:test';
import assert from 'node:assert/strict';

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
globalThis.document ??= {
  createElement: () => {
    let v = '';
    return { set innerHTML(x) { v = ENT[x] ?? x; }, get value() { return v; } };
  },
};
const { replaceInHtml } = await import('../../public/js/utils/html-find.js');
const {
  replaceInHtmlRich, richSkipReason, richReplacementText, replacementSplitsParagraph, parseRichReplacement,
} = await import('../../public/js/utils/html-replace-rich.js');

test('ohne Auszeichnung und Absatz: identisch zu replaceInHtml', () => {
  const html = '<p data-bid="a1">Er ging nach Hause.</p>';
  assert.equal(replaceInHtmlRich(html, 'ging', 'lief'), replaceInHtml(html, 'ging', 'lief'));
});

test('*kursiv* und **fett** werden Markup', () => {
  const html = '<p>Sie dachte: Bleib ruhig. Dann ging sie.</p>';
  const out = replaceInHtmlRich(html, 'Bleib ruhig.', '*Go slow, Ada.*');
  assert.equal(out, '<p>Sie dachte: <em>Go slow, Ada.</em> Dann ging sie.</p>');
  const out2 = replaceInHtmlRich(html, 'Bleib ruhig.', '**Bleib** ruhig.');
  assert.equal(out2, '<p>Sie dachte: <strong>Bleib</strong> ruhig. Dann ging sie.</p>');
});

test('einzelne Sternchen ohne Paar bleiben Text, Rechnung bleibt Rechnung', () => {
  const html = '<p>Das ergibt drei.</p>';
  assert.equal(replaceInHtmlRich(html, 'drei', '5 * 3'), '<p>Das ergibt 5 * 3.</p>');
  assert.equal(parseRichReplacement('snake_case_name').hasMarkup, false);
});

test('Leerzeile teilt den Absatz, neuer Absatz ohne data-bid', () => {
  const html = '<p data-bid="a1" class="x">Er kam herein. Sie sah auf.</p>';
  const out = replaceInHtmlRich(html, 'Er kam herein. Sie sah auf.', 'Er kam herein.\n\nSie sah auf.');
  assert.equal(out, '<p data-bid="a1" class="x">Er kam herein.</p><p class="x">Sie sah auf.</p>');
});

test('Absatzteilung innerhalb einer Hervorhebung schliesst und öffnet sie neu', () => {
  const html = '<p><em>Eins zwei drei vier.</em></p>';
  const out = replaceInHtmlRich(html, 'zwei drei', 'zwei.\n\nDrei');
  assert.equal(out, '<p><em>Eins zwei.</em></p><p><em>Drei vier.</em></p>');
});

test('Absatzteilung im Blockzitat erlaubt, in Liste/Gedicht/Nachricht nicht', () => {
  const bq = '<blockquote><p>A b. C d.</p></blockquote>';
  assert.equal(replaceInHtmlRich(bq, 'A b. C d.', 'A b.\n\nC d.'), '<blockquote><p>A b.</p><p>C d.</p></blockquote>');
  for (const html of [
    '<ul><li><p>A b. C d.</p></li></ul>',
    '<div class="msg-thread"><p class="msg-in">A b. C d.</p></div>',
  ]) {
    assert.equal(replaceInHtmlRich(html, 'A b. C d.', 'A b.\n\nC d.'), html, html);
    assert.equal(richSkipReason(html, 'A b. C d.', 'A b.\n\nC d.'), 'paragraphSplit');
  }
});

test('Absatzteilung nie innerhalb eines Links', () => {
  const html = '<p><a href="https://x.ch">A b. C d.</a></p>';
  assert.equal(replaceInHtmlRich(html, 'A b. C d.', 'A b.\n\nC d.'), html);
});

test('quer liegende Auszeichnung fällt auf Klartext zurück, nie kaputtes Markup', () => {
  const html = '<p>Ein <strong>sehr langer</strong> Satz.</p>';
  const out = replaceInHtmlRich(html, 'Ein sehr langer Satz.', 'Ein *sehr langer Satz.*');
  assert.ok(!out.includes('*'), out);
  assert.notEqual(out, html);
  const tags = out.match(/<\/?[a-z]+>/g).join('');
  assert.ok(!/<strong><em>[^]*<\/strong>[^]*<\/em>/.test(tags), out);
});

test('richReplacementText: ohne Zeichen, Absätze durch Leerzeile', () => {
  assert.equal(richReplacementText('*A* b.\r\n\r\n**C**'), 'A b.\n\nC');
  assert.equal(replacementSplitsParagraph('A\n\nB'), true);
  assert.equal(replacementSplitsParagraph('A\nB'), false);
});

test('richSkipReason: nicht gefunden bleibt notFound', () => {
  assert.equal(richSkipReason('<p>A</p>', 'Z', 'Y\n\nX'), 'notFound');
});
