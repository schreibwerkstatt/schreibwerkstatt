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
const { PAGE_CHAT_NACHRICHTEN_HINWEIS } = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'prompts', 'page-chat.js')).href);

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
  assert.ok(PAGE_CHAT_NACHRICHTEN_HINWEIS.includes(`[${MSG_THREAD_MARKS.de.label}]`));
  assert.ok(PAGE_CHAT_NACHRICHTEN_HINWEIS.includes(`[${MSG_THREAD_MARKS.de.end}]`));
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
