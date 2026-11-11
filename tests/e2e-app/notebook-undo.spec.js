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

// Caret ans Ende des ersten Absatzes. Geklickt wird der Absatz, nicht die
// Editor-Mitte: andere Specs derselben Shard-DB hängen Diagramm/Bild an diesen
// Abschnitt, und ein Klick darauf nähme den Fokus ins Diagramm-Quelltextfeld.
async function caretToEnd(page) {
  await page.locator(`${EDIT_SEL} > p`).first().click();
  await page.evaluate((sel) => {
    const el = document.querySelector(`${sel} > p`);
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }, EDIT_SEL);
}

// Caret-Position als Textoffset ab Editor-Anfang.
function caretOffset(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const s = getSelection();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.setEnd(s.anchorNode, s.anchorOffset);
    return r.toString().length;
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
  const endOffset = await caretOffset(page);
  await page.keyboard.type(' CARETPROBE');
  await page.keyboard.press('Control+z');
  await expect(page.locator(EDIT_SEL)).not.toContainText('CARETPROBE');
  expect(await caretOffset(page)).toBe(endOffset);
  // Nicht awaiten: nach Änderungen wartet cancelEdit auf den Verwerfen-Dialog.
  await page.evaluate(() => { window.__app.cancelEdit(); });
});

// Absatzgrenze: «Ende Absatz 1» und «Anfang Absatz 2» sind derselbe Text-Offset.
// Undo einer Eingabe am Absatzanfang muss den Caret in DEN Absatz setzen, in
// dem getippt wurde — nicht ans Ende des vorigen.
test('Undo am Absatzanfang lässt den Caret im eigenen Absatz', async ({ page }) => {
  await openPageInEdit(page, 1);
  await caretToEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('GRENZPROBE');
  await page.waitForTimeout(650);           // eigener Schritt
  await page.keyboard.press('Home');
  await page.keyboard.type('X');
  await page.keyboard.press('Control+z');
  await expect(page.locator(EDIT_SEL)).not.toContainText('XGRENZPROBE');
  const where = await page.evaluate(() => {
    const s = getSelection();
    const n = s.anchorNode;
    const block = (n.nodeType === 1 ? n : n.parentElement).closest('p');
    const r = document.createRange();
    r.selectNodeContents(block);
    r.setEnd(s.anchorNode, s.anchorOffset);
    return { text: block?.textContent, offsetInBlock: r.toString().length };
  });
  expect(where).toEqual({ text: 'GRENZPROBE', offsetInBlock: 0 });
  // Nicht awaiten: nach Änderungen wartet cancelEdit auf den Verwerfen-Dialog.
  await page.evaluate(() => { window.__app.cancelEdit(); });
});

// Reine Formatierung (Text unverändert): Undo lässt die Auswahl stehen, damit
// man direkt anders formatieren kann — sie fällt nicht zum Caret zusammen.
test('Undo von Fett lässt das markierte Wort markiert', async ({ page }) => {
  await openPageInEdit(page, 1);
  await caretToEnd(page);
  await page.keyboard.type(' FETTPROBE');
  await page.waitForTimeout(650);
  await page.evaluate((sel) => {
    const p = [...document.querySelectorAll(`${sel} > p`)].find(x => x.textContent.includes('FETTPROBE'));
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = walker.nextNode()) && !t.nodeValue.includes('FETTPROBE'));
    const i = t.nodeValue.indexOf('FETTPROBE');
    const r = document.createRange();
    r.setStart(t, i);
    r.setEnd(t, i + 'FETTPROBE'.length);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }, EDIT_SEL);
  await page.keyboard.press('Control+b');
  await expect(page.locator(`${EDIT_SEL} :is(b, strong)`, { hasText: 'FETTPROBE' })).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(page.locator(`${EDIT_SEL} :is(b, strong)`, { hasText: 'FETTPROBE' })).toHaveCount(0);
  expect(await page.evaluate(() => getSelection().toString())).toBe('FETTPROBE');
  // Nicht awaiten: nach Änderungen wartet cancelEdit auf den Verwerfen-Dialog.
  await page.evaluate(() => { window.__app.cancelEdit(); });
});
