// Shift+Enter im Focus-Editor unter WebKit (Safari, macOS-Client in WKWebView):
// mitten im Text ein weicher Umbruch (<br>) im SELBEN Absatz, kein Absatzwechsel.
//
// Eigenes WebKit-Projekt, weil die Fehlerklasse an WebKits `execCommand`
// hängt: `insertHTML('<br>')` teilte dort den Absatz (`<p>Eins</p><br> zwei…`),
// Chromium nicht. insertSoftBreak (shared/soft-break.js) setzt den Umbruch
// darum von Hand. Die Chromium-Fälle (mitten im Text, Blockende, Dedup,
// Auswahl-Ersatz) stehen in focus-editor.spec.js.

const { test, expect } = require('./_helpers/fixtures');

const HARNESS = '/tests/fixtures/focus-harness.html';
const EDITOR = '#editor-card .focus-editor__content';

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.harnessReady === true);
  await page.evaluate(() => { window.harness.editMode = true; window.harness.enterFocusMode(); });
  await page.waitForFunction(() => window.harness._focusListeners !== null);
  await page.waitForTimeout(150);
});

test('Shift+Enter mitten im Text setzt ein <br> im selben Absatz, statt ihn zu teilen', async ({ page }) => {
  // Wie startEdit der App (notebook/edit/lifecycle.js).
  await page.evaluate(() => document.execCommand('defaultParagraphSeparator', false, 'p'));
  // Text frisch in den Schreib-Slot am Ende tippen — wie in der App.
  await page.keyboard.type('Eins zwei drei vier', { delay: 5 });
  const before = await page.evaluate((sel) => document.querySelectorAll(sel + ' p').length, EDITOR);
  await page.evaluate((sel) => {
    const p = [...document.querySelectorAll(sel + ' p')].find(x => x.textContent.startsWith('Eins'));
    const r = document.createRange();
    r.setStart(p.firstChild, 4);
    r.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }, EDITOR);
  await page.keyboard.press('Shift+Enter');
  await page.waitForTimeout(150);
  const r = await page.evaluate((sel) => {
    const p = [...document.querySelectorAll(sel + ' p')].find(x => x.textContent.startsWith('Eins'));
    return { count: document.querySelectorAll(sel + ' p').length, br: p.querySelectorAll('br').length, text: p.textContent };
  }, EDITOR);
  expect(r.count, 'Absatz wurde geteilt').toBe(before);
  expect(r.br).toBe(1);
  expect(r.text).toBe('Eins zwei drei vier');
});
