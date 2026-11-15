// NOTEBOOK-Editor: startEdit setzt den Caret ans Ende des letzten Blocks und
// scrollt ihn ins Bild (edit/caret-end.js#placeCaretAtEditorEnd). Kein neuer
// leerer Absatz (das ist der Auto-Slot des Fokusmodus, nicht dieses Editors).

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';
let freshPageId = null;

async function openFresh(page, html) {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  freshPageId = await page.evaluate(async ({ bid, html }) => {
    const { contentRepo } = await import('/js/repo/content.js');
    const created = await contentRepo.createPage({ book_id: parseInt(bid, 10), name: 'Caret-Ende', html });
    await window.__app.loadPages();
    await window.__app.selectPage(window.Alpine.store('nav').pages.find((x) => x.id === created.id));
    return created.id;
  }, { bid: bookId, html });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
  await page.waitForTimeout(300);
}

test.afterEach(async ({ page }) => {
  if (freshPageId == null) return;
  const id = freshPageId;
  freshPageId = null;
  await page.evaluate(async (pid) => {
    window.__app.editDirty = false;
    if (window.__app.editMode) await window.__app.cancelEdit();
    await window.__app.deletePageById(pid, { confirm: false });
  }, id).catch(() => {});
});

test('Caret steht nach startEdit am Ende des letzten Absatzes, Block im Bild', async ({ page }) => {
  const paras = Array.from({ length: 60 }, (_, i) => `<p>Absatz ${i + 1} mit etwas Text.</p>`).join('');
  await openFresh(page, paras + '<p>Letzter Satz.</p>');
  await page.keyboard.type('X');
  const state = await page.evaluate((sel) => {
    const ed = document.querySelector(sel);
    const last = ed.lastElementChild;
    const r = last.getBoundingClientRect();
    return {
      lastText: last.textContent,
      count: ed.children.length,
      inView: r.top >= 0 && r.bottom <= window.innerHeight,
    };
  }, EDIT_SEL);
  expect(state.lastText).toBe('Letzter Satz.X');
  expect(state.count).toBe(61);
  expect(state.inView).toBe(true);
});

test('Liste als letzter Block: Caret in der letzten Zeile', async ({ page }) => {
  await openFresh(page, '<p>Vorher.</p><ul><li>eins</li><li>zwei</li></ul>');
  await page.keyboard.type('X');
  const lastLi = await page.evaluate((sel) => document.querySelector(sel).querySelector('ul li:last-child').textContent, EDIT_SEL);
  expect(lastLi).toBe('zweiX');
});
