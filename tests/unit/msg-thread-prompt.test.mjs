// Nachrichtenverlauf im KI-Prompt: die Marken (lib/html-text.js) stehen in der
// Buchsprache, und die Regelblöcke von Lektorat (alle drei Pässe) und
// Abschnitts-Chat zitieren genau diese Wortlaute. Erscheinen nur, wenn der
// Abschnitt einen Verlauf enthält — sonst bleibt der Prompt (und sein Cache) gleich.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const { markMsgThreads, hasMsgThread, MSG_THREAD_MARKS } = require('../../lib/html-text.js');
const { htmlToTextForPrompt } = require('../../routes/jobs/shared/ai.js');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'prompt-config.json'), 'utf8'));
const prompts = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'prompts.js')).href);
const { _buildNachrichtenBlock } = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'prompts', 'blocks.js')).href);
const { pageChatNachrichtenHinweis } = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'prompts', 'page-chat.js')).href);

const THREAD = '<p>Davor.</p><div class="msg-thread"><p class="msg-name">Lena</p><p class="msg-in">bist du schon da??</p></div>';

test('hasMsgThread erkennt den Verlauf, wiederholt aufgerufen stabil', () => {
  assert.equal(hasMsgThread(THREAD), true);
  assert.equal(hasMsgThread(THREAD), true);
  assert.equal(hasMsgThread('<div class="poem"><p>x</p></div>'), false);
  assert.equal(hasMsgThread(''), false);
});

test('Marken in der Buchsprache, Fallback Deutsch', () => {
  assert.match(markMsgThreads(THREAD, { langCode: 'en' }), /\[Message thread .*\].*\[End of message thread\]/s);
  assert.match(markMsgThreads(THREAD), /\[Nachrichtenverlauf .*\].*\[Ende Nachrichtenverlauf\]/s);
  assert.match(markMsgThreads(THREAD, { langCode: 'fr' }), /\[Nachrichtenverlauf /);
  const en = htmlToTextForPrompt(THREAD, { langCode: 'en' });
  assert.match(en, /^Davor\.\n\n\[Message thread .*\]\n\nLena\n\nbist du schon da\?\?\n\n\[End of message thread\]$/);
});

test('Regelblöcke zitieren die Marken wortgleich', () => {
  for (const [lc, { label, end }] of Object.entries(MSG_THREAD_MARKS)) {
    const block = _buildNachrichtenBlock(lc);
    assert.ok(block.includes(`[${label}]`), `${lc}: label`);
    assert.ok(block.includes(`[${end}]`), `${lc}: end`);
  }
  for (const [lc, { label, end }] of Object.entries(MSG_THREAD_MARKS)) {
    assert.ok(pageChatNachrichtenHinweis(lc).includes(`[${label}]`), `Abschnitts-Chat ${lc}: label`);
    assert.ok(pageChatNachrichtenHinweis(lc).includes(`[${end}]`), `Abschnitts-Chat ${lc}: end`);
  }
  assert.equal(pageChatNachrichtenHinweis('fr'), pageChatNachrichtenHinweis('de'), 'unbekannte Sprache → Deutsch wie die Marken');
});

test('Lektorat: Block in allen Pässen nur mit Verlauf, in der Buchsprache', () => {
  for (const provider of ['claude', 'ollama']) {
    prompts.configurePrompts(cfg, provider);
    for (const lc of ['de', 'en']) {
      const marker = lc === 'en' ? 'Message threads (texts/chat' : 'Nachrichtenverläufe (SMS/Chat';
      const builds = {
        voll: (o) => prompts.buildLektoratPrompt('x', { langCode: lc, ...o }),
        stil: (o) => prompts.buildStilLektoratPrompt('x', { langCode: lc, ...o }),
        objektiv: (o) => prompts.buildObjektivLektoratPrompt('x', { langCode: lc, ...o }),
      };
      for (const [pass, build] of Object.entries(builds)) {
        assert.ok(build({ hatNachrichten: true }).includes(marker), `${provider}/${lc}/${pass}: mit Verlauf`);
        assert.ok(!build({}).includes(marker), `${provider}/${lc}/${pass}: ohne Verlauf`);
      }
    }
  }
  prompts.configurePrompts(cfg, 'claude');
});

test('Abschnitts-Chat: Hinweis nur mit Verlauf', () => {
  prompts.configurePrompts(cfg, 'claude');
  const build = (opts) => JSON.stringify(prompts.buildChatSystemPrompt('S', 'Text', [], null, null, null, null, null, opts));
  assert.ok(build({ hatNachrichten: true }).includes('Hinweis Nachrichtenverlauf'));
  assert.ok(!build({}).includes('Hinweis Nachrichtenverlauf'));
  // Englisches Buch: der Hinweis zitiert die Marken, die im Abschnittstext stehen.
  assert.ok(build({ hatNachrichten: true, langCode: 'en' }).includes(MSG_THREAD_MARKS.en.end));
});

test('Komplettanalyse (msgRows): jede Zeile trägt ihre Art, Startmarke erklärt die Zeichen', () => {
  const { htmlToText } = require('../../routes/jobs/shared/ai.js');
  const html = '<p>Davor.</p><div class="msg-thread"><p class="msg-meta">Di, 23:14</p><p class="msg-name">Lena</p>'
    + '<p class="msg-in">bist du wach?</p><p class="msg-out">jetzt schon</p><p>ohne Klasse</p><p class="msg-out"><br></p></div>';
  const de = htmlToText(html, { msgRows: true });
  assert.match(de, /^Davor\. \[Nachrichtenverlauf \(SMS\/Chat der Figuren, .*«→» = gesendet .*\] \[Di, 23:14\] Lena: bist du wach\? → jetzt schon ohne Klasse \[Ende Nachrichtenverlauf\]$/);
  assert.match(htmlToText(html, { msgRows: true, langCode: 'en' }), /\[Message thread \(the characters' text\/chat, .*\[End of message thread\]$/);
  // Ohne Option (Embeddings, Review, Finetune, …) bleibt der Text wie bisher.
  assert.equal(htmlToText(html), htmlToText(html, { msgRows: false }));
  assert.ok(!htmlToText(html).includes('→'));
});

// ── Verlauf-Erkennung: verschachtelte <div>, Attribut-Schreibweisen ──────────
const html = require('../../lib/html-text.js');
const NESTED = '<p>Davor.</p><div class="msg-thread"><p class="msg-name">Lena</p>'
  + '<div><p class="msg-in">bist du da?</p></div><p class="msg-out">gleich</p></div><p>Danach.</p>';

test('Verlauf endet am passenden </div>, nicht am ersten inneren', () => {
  assert.equal(html.stripMsgThreads(NESTED), '<p>Davor.</p> <p>Danach.</p>');
  const marked = html.markMsgThreads(NESTED);
  assert.match(marked, /gleich<\/p><p>\[Ende Nachrichtenverlauf\]<\/p><p>Danach\.<\/p>$/);
  assert.deepEqual(html.msgThreadLines(NESTED)[0].map(l => l.text), ['Lena', 'bist du da?', 'gleich']);
  const { text, msgRanges } = html.htmlToPlainTextWithMsgRanges(NESTED);
  assert.deepEqual(msgRanges.map(([a, b]) => text.slice(a, b)), ['bist du da?', 'gleich']);
  assert.ok(html.markMsgNameSides(NESTED).endsWith('<p>Danach.</p>'));
  // Ohne schliessendes </div> ist es kein Verlauf.
  assert.equal(html.hasMsgThread('<div class="msg-thread"><p>x</p>'), false);
});

test('Verlauf-Tag: Leerzeichen um =, einfache Quotes, weitere Klassen, Grossschreibung', () => {
  for (const open of ['<div class = "x msg-thread">', "<div class='msg-thread y'>", '<DIV CLASS="msg-thread">', '<div class=msg-thread>']) {
    const h = `${open}<p class='msg-out'>ok</p></DIV>`;
    assert.equal(html.hasMsgThread(h), true, open);
    assert.deepEqual(html.msgThreadLines(h), [[{ kind: 'out', text: 'ok' }]], open);
  }
  assert.equal(html.hasMsgThread('<div class="msg-thread-x"><p>a</p></div>'), false);
  assert.equal(html.hasMsgThread('<div class="no-msg-thread"><p>a</p></div>'), false);
});

test('msgThreadLines: Satzzeichen bleiben am Wort (Inline-Tags)', () => {
  const h = '<div class="msg-thread"><p class="msg-in">bist du <em>da</em>? <a href="#">Link</a>, ok&nbsp;!</p></div>';
  assert.equal(html.msgThreadLines(h)[0][0].text, 'bist du da? Link, ok !');
});

test('Absender-Seite über alle Zeilen, leere Zeilen erst danach weg', () => {
  // Die leere eingehende Zeile direkt unter «Lena» macht sie (wie am Bildschirm,
  // `.msg-name:has(+ p.msg-out)` greift nicht) zur eingehenden Absenderin.
  const h = '<div class="msg-thread"><p class="msg-name">Lena</p><p class="msg-in"><br></p>'
    + '<p class="msg-out">hallo</p><p class="msg-in">hi</p></div>';
  const lines = html.msgThreadLines(h)[0];
  assert.deepEqual(lines.map(l => l.kind), ['name', 'out', 'in']);
  assert.equal(lines[0].side, 'in');
  assert.deepEqual(html.msgUtterances([lines]), [{ sender: null, text: 'hallo' }, { sender: 'Lena', text: 'hi' }]);
  // Export: Seite wie am Bildschirm, leere Zeile entfernt, Bild-Zeile bleibt.
  const exp = html.markMsgNameSides(h.replace('</div>', '<p class="msg-in"><img src="a.png"></p></div>'));
  assert.ok(!exp.includes('<br>'), exp);
  assert.ok(!exp.includes('msg-name-out'), exp);
  assert.ok(exp.includes('<img src="a.png">'), exp);
  const out = html.markMsgNameSides('<div class="msg-thread"><p class="msg-name">Tom</p><p class="msg-meta"> </p><p class="msg-out">x</p></div>');
  assert.equal(out, '<div class="msg-thread"><p class="msg-name msg-name-out">Tom</p><p class="msg-out">x</p></div>');
});

test('Prompt-Text: Zeilenart auch absatzerhaltend, ohne Marken für den Embedding-Index', () => {
  const h = '<p>Davor.</p><div class="msg-thread"><p class="msg-name">Lena</p><p class="msg-out">jetzt</p></div>';
  const rows = htmlToTextForPrompt(h, { msgRows: true, langCode: 'en' });
  assert.match(rows, /^Davor\.\n\n\[Message thread \(the characters' text\/chat, .*\]\n\nLena:\n\n→ jetzt\n\n\[End of message thread\]$/);
  assert.equal(htmlToTextForPrompt(h, { msgMarks: false }), 'Davor.\n\nLena\n\njetzt');
});

test('Kontinuität nachprüfen liest Verläufe wie der Prüflauf (komplettTextOpts)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/jobs/komplett/job-recheck.js'), 'utf8');
  assert.match(src, /komplettTextOpts\(bookId, userEmail\)/);
  assert.match(src, /htmlToTextForPrompt\(pd\.html \|\| '', textOpts\)/);
});
