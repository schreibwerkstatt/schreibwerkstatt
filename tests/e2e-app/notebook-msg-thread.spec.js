// Nachrichtenverlauf (div.msg-thread) im NOTEBOOK-Editor, gegen die ECHTE App:
// Slash-Einfügen, Enter/Tab/Backspace/Delete in Verlaufszeilen, die schwebende
// Zeilenleiste und die Bildschirm-Anordnung (ausgehend rechts).
//
// WARUM DIESE SCHICHT: wie bei den Blockgrenzen (notebook-block-boundaries.spec.js)
// ersetzt der Editor hier natives contenteditable-Verhalten — nur ein echter
// Browser zeigt, ob Chromium beim Merge zweier verschieden gestylter Zeilen
// Inline-`style` einbäckt. Die Anordnung hängt am echten Stylesheet
// (manuscript-content.css), das ein Fixture-Harness nicht lädt.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';
const THREAD = '<p>Vorher</p><div class="msg-thread"><p class="msg-in">Hallo</p><p class="msg-out">Hi</p></div><p>Nachher</p>';

async function enterNotebookEdit(page) {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
  await page.waitForTimeout(300);
}

async function seed(page, html, target, pos) {
  await page.evaluate(({ html, target, pos }) => {
    const editEl = document.querySelector('#editor-card .page-content-view--editing');
    editEl.innerHTML = html;
    const el = editEl.querySelector(target);
    editEl.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(pos === 'start');
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }, { html, target, pos });
}

function readHtml(page) {
  return page.evaluate(() => document.querySelector('#editor-card .page-content-view--editing')
    .innerHTML.replace(/ data-bid="[^"]*"/g, ''));
}

async function expectNoInlineStyle(page, label) {
  const n = await page.evaluate(() => document
    .querySelectorAll('#editor-card .page-content-view--editing [style]').length);
  expect(n, `${label}: kein Inline-style`).toBe(0);
}

test.describe('Notebook — Nachrichtenverlauf', () => {
  test('Slash-Menü legt den Verlauf an, Enter/Tab/Doppel-Enter bedienen ihn', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<p>Vorher</p><p><br></p>', 'p:last-child', 'start');
    await page.keyboard.press('/');
    await page.waitForSelector('.edit-slash-menu', { state: 'visible', timeout: 5000 });
    await page.locator('.edit-slash-item--msgthread').click();
    await page.waitForTimeout(100);
    expect(await readHtml(page)).toBe('<p>Vorher</p><div class="msg-thread"><p class="msg-in"><br></p></div>');

    await page.keyboard.type('bist du da?');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.type('gleich');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Danach');
    expect(await readHtml(page)).toBe('<p>Vorher</p><div class="msg-thread"><p class="msg-in">bist du da?</p>'
      + '<p class="msg-out">gleich</p></div><p>Danach</p>');
    await expectNoInlineStyle(page, 'nach dem Tippen');
  });

  test('Enter mitten in der Zeile teilt sie, die Art bleibt', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, THREAD, '.msg-out', 'end');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    expect(await readHtml(page)).toBe('<p>Vorher</p><div class="msg-thread"><p class="msg-in">Hallo</p>'
      + '<p class="msg-out">H</p><p class="msg-out">i</p></div><p>Nachher</p>');
  });

  test('Backspace/Delete verschmelzen Zeilen ohne Inline-style', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, THREAD, '.msg-out', 'start');
    await page.keyboard.press('Backspace');
    expect(await readHtml(page)).toBe('<p>Vorher</p><div class="msg-thread"><p class="msg-in">HalloHi</p></div><p>Nachher</p>');
    await expectNoInlineStyle(page, 'Backspace');

    await seed(page, THREAD, '.msg-in', 'end');
    await page.keyboard.press('Delete');
    expect(await readHtml(page)).toBe('<p>Vorher</p><div class="msg-thread"><p class="msg-in">HalloHi</p></div><p>Nachher</p>');
    await expectNoInlineStyle(page, 'Delete');

    // Grenze: Backspace am Anfang der ersten Zeile verlässt den Verlauf.
    await seed(page, THREAD, '.msg-in', 'start');
    await page.keyboard.press('Backspace');
    expect(await readHtml(page)).toBe('<p>Vorher</p><p>Hallo</p><div class="msg-thread"><p class="msg-out">Hi</p></div><p>Nachher</p>');
    await expectNoInlineStyle(page, 'Grenze');
  });

  test('Zeilenleiste: erscheint im Verlauf, setzt die Art, verschwindet ausserhalb', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, THREAD, '.msg-in', 'end');
    const bar = page.locator('.edit-msg-bar');
    await expect(bar).toBeVisible();
    await expect(bar.locator('.edit-msg-btn--active')).toHaveText(/Eingang|Incoming/);
    await bar.locator('.edit-msg-btn').nth(2).click();
    expect(await readHtml(page)).toContain('<p class="msg-name">Hallo</p>');
    // Caret blieb im Editor: weitertippen landet in derselben Zeile.
    await page.keyboard.type('!');
    expect(await readHtml(page)).toContain('<p class="msg-name">Hallo!</p>');

    await seed(page, THREAD, ':scope > p:last-of-type', 'end');
    await expect(bar).toBeHidden();
  });

  test('Bildschirm: ausgehend rechts, eingehend links', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, THREAD, '.msg-in', 'end');
    const geo = await page.evaluate(() => {
      const t = document.querySelector('#editor-card .page-content-view--editing .msg-thread').getBoundingClientRect();
      const i = document.querySelector('#editor-card .page-content-view--editing .msg-in').getBoundingClientRect();
      const o = document.querySelector('#editor-card .page-content-view--editing .msg-out').getBoundingClientRect();
      return { tl: t.left, tr: t.right, il: i.left, ir: i.right, ol: o.left, or: o.right };
    });
    expect(Math.abs(geo.il - geo.tl)).toBeLessThan(2);
    expect(Math.abs(geo.or - geo.tr)).toBeLessThan(2);
    expect(geo.ol).toBeGreaterThan(geo.tl + (geo.tr - geo.tl) / 2);
  });
});
