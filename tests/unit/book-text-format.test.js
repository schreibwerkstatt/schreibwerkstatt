'use strict';
// Buchtext im KI-Prompt: routes/jobs/shared/book-text-format.js.
// Vertrag: Absätze bleiben erhalten, Kapitel/Abschnitte als XML-Tags, Namen
// wortgleich im Attribut, Text kann die Struktur nicht schliessen.
// Doku: docs/komplett.md (Buchtext-Format).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  xmlAttr, neutralizeOwnTags, formatAbschnitt, formatAbschnitte, formatKapitel, formatBook, pageTextForAi,
} = require('../../routes/jobs/shared/book-text-format');
const { groupByChapter, buildSinglePassBookText } = require('../../routes/jobs/shared/loader');
const { splitPageIntoParts } = require('../../routes/jobs/shared/chunking');

test('pageTextForAi: Absätze als Leerzeile, <br> als Zeilenumbruch', () => {
  const t = pageTextForAi('<p>»Komm her«, sagte sie.</p><p>Er kam.<br>Langsam.</p>');
  assert.equal(t, '»Komm her«, sagte sie.\n\nEr kam.\nLangsam.');
});

test('pageTextForAi: Umbruch im HTML-Quelltext ist kein Umbruch im Prompt', () => {
  assert.equal(pageTextForAi('<p>Ein\n   langer\nSatz.</p>\n\n<p>Zwei.</p>'), 'Ein langer Satz.\n\nZwei.');
});

test('pageTextForAi: geschütztes Leerzeichen im Quelltext bleibt (Doppel-Leerzeichen sichtbar)', () => {
  assert.equal(pageTextForAi('<p>Geil.\u00A0 Ich</p>'), 'Geil.\u00A0 Ich');
});

test('pageTextForAi: Szenentrenner bleibt eigene Zeile', () => {
  assert.equal(pageTextForAi('<p>Ende.</p><p>* * *</p><p>Anfang.</p>'), 'Ende.\n\n* * *\n\nAnfang.');
});

test('pageTextForAi: Diagramm fällt, Tabelle wird Kurzform', () => {
  const t = pageTextForAi('<p>Vor.</p><pre class="mermaid">flowchart TD\nA-->B</pre><table><tr><th>Jahr</th></tr><tr><td>1</td></tr></table><p>Nach.</p>');
  assert.ok(!t.includes('flowchart'), t);
  assert.ok(t.includes('[Tabelle 2×1: Kopf: Jahr]'), t);
  assert.ok(t.startsWith('Vor.') && t.endsWith('Nach.'), t);
});

test('xmlAttr: Wert wortgleich, & bleibt roh', () => {
  assert.equal(xmlAttr('titel', 'Tom & Jerry'), 'titel="Tom & Jerry"');
});

test('xmlAttr: Titel mit " steht in einfachen Anführungszeichen', () => {
  assert.equal(xmlAttr('titel', 'Der "Fall"'), `titel='Der "Fall"'`);
});

test('xmlAttr: beide Anführungszeichen → &quot;, Zeilenumbruch → Space', () => {
  assert.equal(xmlAttr('titel', `It's "x"`), 'titel="It\'s &quot;x&quot;"');
  assert.equal(xmlAttr('pfad', 'A\nB'), 'pfad="A B"');
});

test('neutralizeOwnTags: eigener Schluss-Tag im Text schliesst nichts', () => {
  const out = formatAbschnitt({ title: 'XML', text: 'Schreib </abschnitt> und <kapitel pfad="x"> hin. a<b' });
  assert.equal((out.match(/<\/abschnitt>/g) || []).length, 1);
  assert.ok(out.includes('‹/abschnitt>') && out.includes('‹kapitel pfad'), out);
  assert.ok(out.includes('a<b'), 'fremde < bleiben');
  assert.equal(neutralizeOwnTags('<abschnittX>'), '<abschnittX>', 'nur ganze Tag-Namen');
});

test('formatAbschnitte/formatKapitel: Form', () => {
  const pages = [{ title: 'Eins', text: 'A\n\nB' }, { title: 'Zwei', text: '---' }];
  assert.equal(formatAbschnitte(pages),
    '<abschnitt titel="Eins">\nA\n\nB\n</abschnitt>\n\n<abschnitt titel="Zwei">\n---\n</abschnitt>');
  assert.equal(formatKapitel('Teil 1 › K', [pages[0]]),
    '<kapitel pfad="Teil 1 › K">\n<abschnitt titel="Eins">\nA\n\nB\n</abschnitt>\n</kapitel>');
});

test('buildSinglePassBookText = formatBook, Kapitel in Lesereihenfolge', () => {
  const contents = [
    { id: 1, chapter_id: 7, chapter: 'Erstes', title: 'a', text: 'eins' },
    { id: 2, chapter_id: 8, chapter: 'Zweites', title: 'b', text: 'zwei\n\ndrei' },
    { id: 3, chapter_id: 7, chapter: 'Erstes', title: 'c', text: 'vier' },
  ];
  const { groups, groupOrder } = groupByChapter(contents);
  const txt = buildSinglePassBookText(groups, groupOrder);
  assert.equal(txt, formatBook(groups, groupOrder));
  assert.ok(txt.indexOf('pfad="Erstes"') < txt.indexOf('pfad="Zweites"'));
  assert.equal((txt.match(/<kapitel /g) || []).length, 2);
  assert.equal((txt.match(/<abschnitt /g) || []).length, 3);
  assert.ok(txt.includes('zwei\n\ndrei'));
});

test('Chunking: Teil-Schnitt landet an der Absatzgrenze des Prompt-Texts', () => {
  // Drei gleich lange Absätze aus vielen Sätzen; zwei Teile → Ziel mitten im
  // zweiten Absatz. Mit Absätzen schneidet chunking.js an der Absatzgrenze, ohne
  // (einzeiliger Text) an der Satzgrenze mitten im Absatz.
  const para = (c) => `<p>${Array.from({ length: 40 }, (_, i) => `${c}${i} sagt etwas.`).join(' ')}</p>`;
  const text = pageTextForAi(para('a') + para('b') + para('c'));
  const parts = splitPageIntoParts({ id: 1, title: 'T', text }, Math.ceil(text.length / 2) + 10);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.match(p.text, /^[abc]0 /, p.text.slice(0, 30));
});
