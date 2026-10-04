// Notebook-Editor: ein stiller Block-Merge (Pre-Save-Check im Autosave) laesst
// den Caret in seinem Absatz stehen, statt ihn an den Seitenanfang zu werfen.
//
// Warum gegen die ECHTE App: Caret und Selection gibt es nur im Browser
// (linkedom kennt kein Range#setStart), und der Merge-Pfad haengt am echten
// OCC-Guard des Servers. Der Remote-Save setzt einen NEUEN Absatz vor alles —
// ein globaler Text-Offset (edit-history.js#captureCaretOffset) landete danach
// im falschen Block; nur der Block-Anker (shared/block-caret.js) haelt.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';
const OTHER_DEVICE = '0b5e8c1e-1111-4222-8333-444455556667';

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

// Caret in den letzten Absatz, 3 Zeichen nach dessen Anfang.
async function caretIntoLastBlock(page) {
  await page.locator(EDIT_SEL).click();
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const block = el.lastElementChild;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const t = walker.nextNode();
    const r = document.createRange();
    r.setStart(t, 3);
    r.collapse(true);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }, EDIT_SEL);
}

// Block-bid + Text-Offset im Block, wo der Caret gerade steht.
async function caretPos(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const s = getSelection();
    if (!s.rangeCount) return null;
    const r = s.getRangeAt(0);
    let b = r.startContainer;
    while (b && b.parentNode !== el) b = b.parentNode;
    if (!b) return null;
    const pre = r.cloneRange();
    pre.selectNodeContents(b);
    pre.setEnd(r.startContainer, r.startOffset);
    return { bid: b.getAttribute('data-bid'), offset: pre.toString().length, text: b.textContent };
  }, EDIT_SEL);
}

test('Stiller Auto-Merge im Autosave: Caret bleibt im eigenen Absatz an derselben Stelle', async ({ page }) => {
  await openPageInEdit(page, 2);
  await caretIntoLastBlock(page);
  await page.keyboard.type('XY');
  const before = await caretPos(page);
  expect(before?.bid).toBeTruthy();
  expect(before.offset).toBe(5);

  // Zweites Geraet setzt einen neuen Absatz an den Seitenanfang.
  const status = await page.evaluate(async (device) => {
    const p = window.__app.currentPage;
    const cur = await (await fetch(`/content/pages/${p.id}?__fresh=1`)).json();
    const r = await fetch(`/content/pages/${p.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html: `<p>REMOTE_CARETPROBE ganz neuer Absatz vorne</p>${cur.html}`,
        device_id: device, expected_updated_at: cur.updated_at,
      }),
    });
    return r.status;
  }, OTHER_DEVICE);
  expect(status).toBe(200);

  await page.evaluate(() => window.__app.quickSave());

  const editorText = await page.locator(EDIT_SEL).innerText();
  expect(editorText).toContain('REMOTE_CARETPROBE');
  const after = await caretPos(page);
  expect(after).toEqual(before);

  // Weitertippen landet an derselben Stelle, nicht am Seitenanfang.
  await page.keyboard.type('Z');
  const final = await caretPos(page);
  expect(final.bid).toBe(before.bid);
  expect(final.text.slice(0, 6)).toBe(before.text.slice(0, 5) + 'Z');
});
