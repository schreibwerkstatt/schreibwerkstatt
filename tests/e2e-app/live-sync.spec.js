// Live-Abgleich gegen die ECHTE App (Event-Stream + Tab-Kanal):
//   Tab → Tab     zwei Tabs desselben Browsers (eine Device-ID): ein Save in
//                 Tab A erscheint in der Leseansicht von Tab B (tab-bus.js)
//   Meta          Ideen und Bearbeitungsstand, geschrieben von «anderswo»
//                 (Request ohne Tab-Kennung, wie ein anderes Gerät/nativer
//                 Client): Plaketten ziehen ohne Reload nach (lib/live-writes.js)
//   Bucheditor    fremder Save auf einen unveränderten Block wird übernommen
//                 (book-editor/remote.js)
// Kein Test ruft selbst einen Lade-Pfad auf — sonst bewiese er nichts.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const VIEW_SEL = '#editor-card .page-content-view:not(.page-content-view--editing)';
const OTHER_DEVICE = '0f0e0d0c-0b0a-4909-8807-060504030201';

async function createPage(page, html) {
  return page.evaluate(async (h) => {
    const nav = window.Alpine.store('nav');
    const first = nav.pages[0];
    const r = await fetch('/content/pages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: nav.selectedBookId, chapter_id: first.chapter_id || undefined, name: 'E2E Live', html: h }),
    });
    if (!r.ok) throw new Error('createPage ' + r.status);
    const created = await r.json();
    nav.pages = [...nav.pages, { ...created, chapterName: first.chapterName }];
    return created.id;
  }, html);
}

async function openPage(page, pageId) {
  await page.evaluate(async (pid) => {
    let p = window.Alpine.store('nav').pages.find(x => x.id === pid);
    if (!p) p = await (await fetch('/content/pages/' + pid)).json();
    await window.__app.selectPage(p);
  }, pageId);
}

async function streamOpen(page) {
  await expect.poll(() => page.evaluate(async () => {
    const { bookStreamOpen } = await import('/js/event-stream.js');
    return bookStreamOpen(window.Alpine.store('nav').selectedBookId);
  }), { timeout: 10000 }).toBe(true);
}

async function deletePage(page, pageId) {
  await page.evaluate(async (pid) => { await fetch('/content/pages/' + pid, { method: 'DELETE' }); }, pageId);
}

test('Tab → Tab: Save in Tab A erscheint in der Leseansicht von Tab B', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const pageId = await createPage(page, '<p>Erste Fassung im Tab.</p>');
  const tabB = await page.context().newPage();
  try {
    await bootApp(tabB);
    await selectSeededBook(tabB);
    await openPage(tabB, pageId);
    await expect(tabB.locator(VIEW_SEL)).toContainText('Erste Fassung');

    await page.evaluate(async (pid) => {
      const { contentRepo } = await import('/js/repo/content.js');
      const cur = await contentRepo.loadPage(pid, { fresh: true });
      await contentRepo.savePage(pid, { html: '<p>Zweite Fassung aus Tab A.</p>', expected_updated_at: cur.updated_at });
    }, pageId);

    await expect(tabB.locator(VIEW_SEL)).toContainText('Zweite Fassung aus Tab A.', { timeout: 5000 });
  } finally {
    await tabB.close();
    await deletePage(page, pageId);
  }
});

test('Meta: Idee und Bearbeitungsstand von anderswo ziehen Plaketten live nach', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const pageId = await createPage(page, '<p>Abschnitt für Ideen.</p>');
  try {
    await openPage(page, pageId);
    await expect(page.locator(VIEW_SEL)).toContainText('Abschnitt für Ideen');
    await streamOpen(page);
    expect(await page.evaluate(() => window.__app.currentPageIdeenOpenCount || 0)).toBe(0);

    // page.request: gleiche Sitzung, aber ohne Tab-Kennung — wie ein anderes Gerät.
    const idee = await page.request.post('/ideen', { data: { book_id: bookId, page_id: pageId, content: 'Live-Idee' } });
    expect(idee.ok()).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__app.currentPageIdeenOpenCount || 0), { timeout: 5000 }).toBe(1);
    await expect.poll(() => page.evaluate((pid) => window.Alpine.store('badges').ideenCounts?.[pid] || 0, pageId)).toBe(1);

    const chain = await page.evaluate(() => window.Alpine.store('badges').editStatusChain || []);
    const target = chain[chain.length - 1];
    expect(target).toBeTruthy();
    const st = await page.request.put('/redaktion/page/' + pageId, { data: { status: target } });
    expect(st.ok()).toBe(true);
    await expect.poll(() => page.evaluate((pid) => window.Alpine.store('badges').editStatus?.[String(pid)]?.status || null, pageId), { timeout: 5000 }).toBe(target);
  } finally {
    await deletePage(page, pageId);
  }
});

test('Meta-Echo: eigener Tab löst keinen Nachlade-Lauf aus', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  await streamOpen(page);
  // Zähler auf dem Nachlade-Pfad: ein Anstoss an DIESEN Tab riefe ihn.
  await page.evaluate(() => {
    window.__metaRuns = 0;
    window.addEventListener('book-meta:changed', () => { window.__metaRuns++; });
  });
  const ideeId = await page.evaluate(async (bid) => {
    const r = await fetch('/ideen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ book_id: bid, content: 'Eigene Idee' }) });
    return (await r.json()).id;
  }, bookId);
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => window.__metaRuns)).toBe(0);
  await page.evaluate(async (id) => { await fetch('/ideen/' + id, { method: 'DELETE' }); }, ideeId);
});

test('Bucheditor: fremder Save auf einen unveränderten Block erscheint live', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const pageId = await createPage(page, '<p>Bucheditor alt.</p>');
  try {
    await page.evaluate(() => window.__app.toggleBookEditorCard());
    const editor = page.locator('.card--bookeditor');
    await expect(editor.locator('.book-editor-page-body', { hasText: 'Bucheditor alt.' })).toBeVisible({ timeout: 15000 });
    await streamOpen(page);

    const cur = await page.evaluate(async (pid) => (await (await fetch('/content/pages/' + pid, { cache: 'no-store' })).json()).updated_at, pageId);
    const res = await page.request.put('/content/pages/' + pageId, {
      data: { html: '<p>Bucheditor neu von anderswo.</p>', device_id: OTHER_DEVICE, expected_updated_at: cur },
    });
    expect(res.ok()).toBe(true);

    await expect(editor.locator('.book-editor-page-body', { hasText: 'Bucheditor neu von anderswo.' })).toBeVisible({ timeout: 8000 });
    const dirty = await page.evaluate(() => window.Alpine.$data(document.querySelector('.card--bookeditor')).dirtyCount);
    expect(dirty).toBe(0);
  } finally {
    await deletePage(page, pageId);
  }
});
