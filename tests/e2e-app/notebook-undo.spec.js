// Notebook-Editor Undo/Redo gegen die ECHTE App.
//
// Warum E2E: die Undo-/Redo-Buttons binden `:disabled` an einen Stack, der in
// einer framework-freien Closure lebt (editor/shared/edit-history.js). Ob Alpine
// eine Änderung daran sieht, zeigt nur der gerenderte Button — ein Unit-Test
// auf `notebookCanUndo()` ist grün, während der Button grau bleibt.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';
const UNDO_BTN = '.page-editor-toolbar button:has(use[href="/icons.svg#undo"])';
const REDO_BTN = '.page-editor-toolbar button:has(use[href="/icons.svg#redo"])';

async function openPageInEdit(page, pageIdx) {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async (i) => {
    await window.__app.selectPage(window.Alpine.store('nav').pages[i]);
  }, pageIdx);
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
}

// Caret ans Ende des Editors.
async function caretToEnd(page) {
  await page.locator(EDIT_SEL).click();
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }, EDIT_SEL);
}

test('Undo-/Redo-Buttons werden nach dem Tippen aktiv und wirken per Klick', async ({ page }) => {
  await openPageInEdit(page, 0);
  const ed = page.locator(EDIT_SEL);
  await expect(page.locator(UNDO_BTN)).toBeDisabled();

  await caretToEnd(page);
  await page.keyboard.type(' KNOPFPROBE');
  // Sofort aktiv, nicht erst nach dem 500-ms-Debounce.
  await expect(page.locator(UNDO_BTN)).toBeEnabled({ timeout: 400 });

  await page.locator(UNDO_BTN).click();
  await expect(ed).not.toContainText('KNOPFPROBE');
  await expect(page.locator(REDO_BTN)).toBeEnabled();

  await page.locator(REDO_BTN).click();
  await expect(ed).toContainText('KNOPFPROBE');
  await expect(page.locator(REDO_BTN)).toBeDisabled();

  // Nicht awaiten: nach Änderungen wartet cancelEdit auf den Verwerfen-Dialog.
  await page.evaluate(() => { window.__app.cancelEdit(); });
});

test('Strg+Z nach dem Tippen setzt den Caret an die Einfügestelle, nicht an den Anfang', async ({ page }) => {
  await openPageInEdit(page, 1);
  await caretToEnd(page);
  const endOffset = await page.evaluate((sel) => document.querySelector(sel).textContent.length, EDIT_SEL);
  await page.keyboard.type(' CARETPROBE');
  await page.keyboard.press('Control+z');
  await expect(page.locator(EDIT_SEL)).not.toContainText('CARETPROBE');
  const caret = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const s = getSelection();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.setEnd(s.anchorNode, s.anchorOffset);
    return r.toString().length;
  }, EDIT_SEL);
  expect(caret).toBe(endOffset);
  // Nicht awaiten: nach Änderungen wartet cancelEdit auf den Verwerfen-Dialog.
  await page.evaluate(() => { window.__app.cancelEdit(); });
});
