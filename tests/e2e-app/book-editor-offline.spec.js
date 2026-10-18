// Bucheditor ohne Netz: ein Block, dessen Save am Netz scheitert, liegt als
// lokaler Entwurf (cards/book-editor/drafts.js) und wird nachgesendet — beim
// Wiederverbinden im offenen Editor ebenso wie nach einem Neuladen. Der Text
// landet genau einmal auf dem Server, ohne Konflikt gegen sich selbst.

const { test, expect } = require('@playwright/test');
const { draftRecords, readDraftRecord } = require('./_helpers/drafts');

test.describe.configure({ mode: 'serial' });

const card = (page) => page.locator('.card--bookeditor');
const data = (page, fn, arg) => page.evaluate(([src, a]) => {
  // eslint-disable-next-line no-new-func
  const f = new Function('d', 'a', `return (${src})(d, a);`);
  return f(window.Alpine.$data(document.querySelector('.card--bookeditor')), a);
}, [fn.toString(), arg]);

async function openBookEditor(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__app && Array.isArray(window.Alpine.store('nav').books) && window.Alpine.store('nav').books.length > 0,
    null, { timeout: 30000 },
  );
  const bookId = await page.evaluate(() => window.Alpine.store('nav').books[0].id);
  await page.evaluate((id) => { location.hash = '#book/' + id; }, bookId);
  await page.waitForFunction(
    (id) => String(window.Alpine.store('nav').selectedBookId) === String(id)
            && Array.isArray(window.Alpine.store('nav').pages) && window.Alpine.store('nav').pages.length > 0,
    bookId, { timeout: 20000 },
  );
  await page.evaluate(() => window.__app.toggleBookEditorCard());
  await expect(card(page).locator('.book-editor-page-body').first()).toBeVisible({ timeout: 15000 });
}

async function typeInFirstBlock(page, text) {
  const body = card(page).locator('.book-editor-page-body').first();
  await body.click();
  await expect.poll(
    () => page.evaluate(() => document.activeElement?.classList?.contains('book-editor-page-body') === true),
    { timeout: 5000 },
  ).toBe(true);
  await page.keyboard.press('End');
  await page.keyboard.type(text);
}

const serverHtml = (page, pageId) => page.evaluate(
  async (id) => (await (await fetch(`/content/pages/${id}?__fresh=1`)).json()).html, pageId);

const drafts = (page, pageId) => draftRecords(page, pageId)
  .then(({ ls, idb }) => ({ ls: ls?.html ?? null, idb: idb?.html ?? null }));
const draftHtml = async (page, pageId) => (await readDraftRecord(page, pageId))?.html ?? null;

const firstBlock = (page) => data(page, (d) => {
  const b = d.blocks.find((x) => x.kind === 'page');
  return { pageId: b.pageId, dirty: b.dirty, offline: b.offline, conflict: !!b.conflict, status: d.blockStatus(b) };
});

test('Offline: Block wird lokal gesichert und beim Wiederverbinden gespeichert', async ({ page, context }) => {
  await openBookEditor(page);
  await typeInFirstBlock(page, ' Funkloch');
  await context.setOffline(true);
  await data(page, (d) => d.saveAllDirty());
  await expect.poll(async () => (await firstBlock(page)).status).toBe('offline');
  const { pageId } = await firstBlock(page);
  await expect.poll(() => draftHtml(page, pageId)).toContain('Funkloch');
  // Bestätigt liegt der Entwurf nur in IndexedDB — eine localStorage-Kopie
  // liesse ihn nach einem Background Sync wieder auferstehen.
  await expect.poll(() => drafts(page, pageId)).toEqual({ ls: null, idb: expect.stringContaining('Funkloch') });

  await context.setOffline(false);
  await expect.poll(async () => (await firstBlock(page)).dirty, { timeout: 15000 }).toBe(false);
  expect((await firstBlock(page)).conflict).toBe(false);
  const html = await serverHtml(page, pageId);
  expect(html.split('Funkloch').length - 1).toBe(1);
  await expect.poll(() => draftHtml(page, pageId)).toBeNull();
});

test('Offline geschrieben, Tab neu geladen: der Entwurf landet genau einmal auf dem Server', async ({ page, context }) => {
  await openBookEditor(page);
  await typeInFirstBlock(page, ' Tunnelfahrt');
  await context.setOffline(true);
  await data(page, (d) => d.saveAllDirty());
  await expect.poll(async () => (await firstBlock(page)).status).toBe('offline');
  const { pageId } = await firstBlock(page);
  await expect.poll(() => draftHtml(page, pageId)).toContain('Tunnelfahrt');

  await context.setOffline(false);
  await openBookEditor(page);
  // Nachgesendet von der Outbox beim Start oder vom Bucheditor beim Laden —
  // beide gehen über den Basis-Stempel, keiner überschreibt still.
  await expect.poll(() => serverHtml(page, pageId), { timeout: 20000 }).toContain('Tunnelfahrt');
  await expect.poll(async () => (await firstBlock(page)).dirty, { timeout: 15000 }).toBe(false);
  expect((await firstBlock(page)).conflict).toBe(false);
  expect((await serverHtml(page, pageId)).split('Tunnelfahrt').length - 1).toBe(1);
  await expect.poll(() => draftHtml(page, pageId)).toBeNull();
});
