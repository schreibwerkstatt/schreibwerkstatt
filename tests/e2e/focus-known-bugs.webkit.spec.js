// Bekannter WebKit-Fehler des Focus-Editors — als `test.fail()` festgehalten.
// Der zweite WebKit-Befund (erster Tastendruck nach einem Sprung an den Rand)
// steht engine-unabhängig in focus-known-bugs.spec.js.
//
// Gefunden beim Durchspielen der Akzeptanzliste in WebKit (Safari, macOS-Client
// in WKWebView); Chromium zeigt ihn nicht. Sie sind bewusst NICHT behoben: der
// Focus-Editor ist stabilisiert, eine Änderung braucht einen ausdrücklichen
// Auftrag (public/js/editor/CLAUDE.md).
//
// `test.fail()` heisst: der Test beschreibt das RICHTIGE Verhalten und schlägt
// heute erwartungsgemäss fehl. Wer einen der Fehler behebt, bekommt ein
// „unexpectedly passed" — dann `test.fail()` entfernen, und der Test wird zum
// normalen Regressionsschutz.

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

test('Shift+Enter mitten im Text setzt ein <br>, statt den Absatz zu teilen', async ({ page }) => {
  // Heute: insertSoftBreak nimmt mitten im Text `execCommand('insertHTML', '<br>')`,
  // und WebKit macht daraus einen Absatzwechsel — zwei <p> statt eines <br>. Am
  // Blockende (manueller Zweig) funktioniert es.
  test.fail();
  // Wie startEdit der App (notebook/edit/lifecycle.js).
  await page.evaluate(() => document.execCommand('defaultParagraphSeparator', false, 'p'));
  // Text frisch in den Schreib-Slot am Ende tippen — wie in der App. Auf einem
  // vorab im DOM stehenden Absatz zeigt sich der Fehler nicht.
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
