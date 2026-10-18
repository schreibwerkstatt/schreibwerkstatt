// Bucheditor: ein Save, dessen Antwort unterwegs verloren geht (Zug, Funkloch),
// ist ein EIGENER Stand — der nächste Save darf dafür keinen Konflikt melden.
// Erkannt über die Save-Kennung (repo/save-ids.js, pages.last_save_id): der
// Pre-Check sieht den eigenen Stand, der Server nimmt den Save trotz altem
// Stempel an. Gegenprobe: ein fremder Write dazwischen bleibt ein Konflikt.

const { test, expect } = require('@playwright/test');

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

// Nächsten Seiten-PUT zum Server durchlassen, die Antwort verwerfen.
async function loseNextSaveResponse(page) {
  let landed = null;
  const done = new Promise((resolve) => {
    page.route(/\/content\/pages\/\d+$/, async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      const res = await route.fetch();
      landed = res.status();
      await route.abort('timedout');
      await page.unroute(/\/content\/pages\/\d+$/);
      resolve();
    });
  });
  return { done, status: () => landed };
}

const serverHtml = (page, pageId) => page.evaluate(
  async (id) => (await (await fetch(`/content/pages/${id}?__fresh=1`)).json()).html, pageId);

const saveAll = (page) => data(page, (d) => d.saveAllDirty());
const firstBlock = (page) => data(page, (d) => {
  const b = d.blocks.find((x) => x.kind === 'page');
  return { pageId: b.pageId, dirty: b.dirty, conflict: !!b.conflict, saveError: b.saveError };
});

test('Verlorene Save-Antwort: der nächste Save meldet keinen Konflikt gegen sich selbst', async ({ page }) => {
  await openBookEditor(page);
  await typeInFirstBlock(page, ' Verlorenbuch');
  const lost = await loseNextSaveResponse(page);
  await saveAll(page);
  await lost.done;
  expect(lost.status()).toBe(200);
  await expect.poll(async () => (await firstBlock(page)).saveError).not.toBe('');

  await typeInFirstBlock(page, ' und weiter');
  await saveAll(page);
  await expect.poll(async () => (await firstBlock(page)).dirty, { timeout: 15000 }).toBe(false);
  const b = await firstBlock(page);
  expect(b.conflict).toBe(false);
  const html = await serverHtml(page, b.pageId);
  expect(html).toContain('und weiter');
  expect(html.split('Verlorenbuch').length - 1).toBe(1);
});

test('Gegenprobe: fremder Write nach dem verlorenen Save bleibt ein Konflikt', async ({ page }) => {
  await openBookEditor(page);
  await typeInFirstBlock(page, ' Zweitprobe');
  const lost = await loseNextSaveResponse(page);
  await saveAll(page);
  await lost.done;
  await expect.poll(async () => (await firstBlock(page)).saveError).not.toBe('');

  // Anderer Schreiber ohne Save-Kennung (Job, alter Client) — beendet die
  // Eigen-Erkennung.
  const { pageId } = await firstBlock(page);
  const status = await page.evaluate(async (id) => {
    const cur = await (await fetch(`/content/pages/${id}?__fresh=1`)).json();
    const r = await fetch(`/content/pages/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: cur.html + '<p>Fremd dazu</p>', expected_updated_at: cur.updated_at }),
    });
    return r.status;
  }, pageId);
  expect(status).toBe(200);

  await typeInFirstBlock(page, ' noch mehr');
  await saveAll(page);
  await expect.poll(async () => (await firstBlock(page)).conflict, { timeout: 15000 }).toBe(true);
  expect(await serverHtml(page, pageId)).toContain('Fremd dazu');
});
