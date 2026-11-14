// Shift+Enter (weicher Umbruch) im NOTEBOOK-Editor, gegen die ECHTE App — läuft
// in Chromium und Firefox (playwright.app.config.js, `notebook-*.spec.js`).
//
// Geprüft (toolbar/keydown.js#_kbSoftBreak, shared/soft-break.js):
//   1. Am Blockende: zwei <br>, die Zeile wird sichtbar höher; Getipptes
//      ersetzt den Platzhalter — in beiden Engines gleich.
//   2. Zweites Shift+Enter direkt dahinter ist im Absatz ein No-Op (die
//      Leerzeile kollabierte beim Save ohnehin).
//   3. Im Code-Block setzt das zweite Shift+Enter die Leerzeile — dort ist
//      `a<br><br>b` Inhalt (softBreakNoop).
//   4. In einer Überschrift kein Umbruch — Überschriften sind einzeilig.
//   5. Shift+Enter umgeht die Enter-Sonderregeln: in der Checkbox-Zeile bleibt
//      es eine Zeile.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';

async function enterNotebookEdit(page) {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
  await page.waitForTimeout(300);
}

// Inhalt setzen, Caret an `pos` ('start'|'end'|Textoffset im ersten Textknoten).
async function seed(page, html, target, pos) {
  await page.evaluate(({ html, target, pos, EDIT_SEL }) => {
    const editEl = document.querySelector(EDIT_SEL);
    editEl.innerHTML = html;
    editEl.focus({ preventScroll: true });
    const el = editEl.querySelector(target);
    const r = document.createRange();
    if (typeof pos === 'number') { r.setStart(el.firstChild, pos); r.collapse(true); } else { r.selectNodeContents(el); r.collapse(pos === 'start'); }
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }, { html, target, pos, EDIT_SEL });
}

const readHtml = (page) => page.evaluate((s) => document.querySelector(s).innerHTML
  .replace(/ data-bid="[^"]*"/g, '')
  .replace(/ contenteditable="false"/g, ''), EDIT_SEL);
const height = (page, sel) => page.evaluate(({ s, sel }) =>
  document.querySelector(s).querySelector(sel).getBoundingClientRect().height, { s: EDIT_SEL, sel });

test.describe('Notebook: Shift+Enter', () => {
  test('am Blockende sichtbare neue Zeile, Getipptes ersetzt den Platzhalter', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<p>Text</p><p>Next</p>', 'p', 'end');
    const h0 = await height(page, 'p');
    await page.keyboard.press('Shift+Enter');
    expect(await readHtml(page)).toBe('<p>Text<br><br></p><p>Next</p>');
    expect(await height(page, 'p')).toBeGreaterThan(h0 * 1.5);
    await page.keyboard.type('X');
    expect(await readHtml(page)).toBe('<p>Text<br>X</p><p>Next</p>');
  });

  test('zweites Shift+Enter im Absatz stapelt kein <br>', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<p>Ab</p>', 'p', 1);
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.press('Shift+Enter');
    expect(await readHtml(page)).toBe('<p>A<br>b</p>');
  });

  test('zweites Shift+Enter im Code-Block setzt die Leerzeile', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<pre><code>ab</code></pre>', 'code', 1);
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.press('Shift+Enter');
    expect(await readHtml(page)).toBe('<pre><code>a<br><br>b</code></pre>');
  });

  test('in einer Überschrift kein Umbruch', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<h2>Titel</h2>', 'h2', 2);
    await page.keyboard.press('Shift+Enter');
    expect(await readHtml(page)).toBe('<h2>Titel</h2>');
  });

  test('in der Checkbox-Zeile bleibt es eine Zeile', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<ul class="todo"><li class="todo-item"><input type="checkbox"><span class="todo-text">Ab</span></li></ul>', '.todo-text', 1);
    await page.keyboard.press('Shift+Enter');
    const r = await page.evaluate((s) => {
      const ed = document.querySelector(s);
      return { li: ed.querySelectorAll('li').length, br: ed.querySelector('li').querySelectorAll('br').length };
    }, EDIT_SEL);
    expect(r).toEqual({ li: 1, br: 1 });
  });
});
