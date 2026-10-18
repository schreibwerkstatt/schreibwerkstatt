// Background Sync der Entwürfe (public/sw-drafts.js) mit echtem Service Worker
// und echtem IndexedDB: ein Entwurf, den kein Tab hält, landet ohne Zutun der
// App auf dem Server und wird danach geräumt. Einen Abschnitt, den ein offener
// Tab hält, fasst er nicht an.
//
// Den `sync`-Event selbst kann Playwright nicht auslösen — der Test ruft den
// Lauf, den der Listener startet (`self.__swDrafts.flush()`), im Worker auf.
// Nur Chromium: Background Sync gibt es nur dort.
const { test, expect } = require('@playwright/test');
const { bootApp, waitBooted, selectSeededBook } = require('./_helpers/app');
const { draftRecords } = require('./_helpers/drafts');

test.describe.configure({ mode: 'serial' });

async function enableSw(page) {
  await page.evaluate(() => localStorage.setItem('sw', '1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitBooted(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitBooted(page);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 60000 });
}

// Entwurf so ablegen, wie draft-storage.js ihn nach der Bestätigung hält.
const seedDraft = (page, pageId, marker) => page.evaluate(async ([id, mark]) => {
  const email = window.Alpine.store('session').currentUser.email;
  const cur = await (await fetch(`/content/pages/${id}?__fresh=1`)).json();
  const rec = {
    html: cur.html + `<p>${mark}</p>`, originalHtml: cur.html, originalUpdatedAt: cur.updated_at,
    savedAt: Date.now(), owner: email, writer: 'notebook', ownSaveIds: [],
  };
  const db = await new Promise((res, rej) => { const r = indexedDB.open('schreibwerkstatt-drafts', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  await new Promise((res, rej) => {
    const tx = db.transaction('drafts', 'readwrite');
    tx.objectStore('drafts').put(rec, `editor_draft_u:${email}:${id}`);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  db.close();
}, [pageId, marker]);

const serverHtml = (page, id) => page.evaluate(async (pid) => (await (await fetch(`/content/pages/${pid}?__fresh=1`)).json()).html, id);

async function swFlush(context) {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(() => self.__swDrafts.flush());
}

test('Entwurf ohne haltenden Tab wird gesendet und geräumt', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Background Sync nur in Chromium');
  test.setTimeout(120000);
  await bootApp(page);
  await selectSeededBook(page);
  await enableSw(page);
  const pageId = await page.evaluate(() => { const p = window.Alpine.store('nav').pages; return p[p.length - 1].id; });

  await seedDraft(page, pageId, 'Hintergrundsync');
  await swFlush(context);

  const html = await serverHtml(page, pageId);
  expect(html.split('Hintergrundsync').length - 1).toBe(1);
  expect((await draftRecords(page, pageId)).idb).toBeNull();
});

test('Abschnitt, den ein offener Tab bearbeitet, bleibt unangetastet', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Background Sync nur in Chromium');
  test.setTimeout(120000);
  await bootApp(page);
  await selectSeededBook(page);
  await enableSw(page);
  const pageId = await page.evaluate(async () => {
    const p = window.Alpine.store('nav').pages[0];
    await window.__app.selectPage(p);
    window.__app.startEdit();
    return p.id;
  });
  await page.waitForFunction(() => window.__app.editMode === true, null, { timeout: 10000 });

  await seedDraft(page, pageId, 'Gehaltenerentwurf');
  await swFlush(context);

  expect(await serverHtml(page, pageId)).not.toContain('Gehaltenerentwurf');
  expect((await draftRecords(page, pageId)).idb?.html).toContain('Gehaltenerentwurf');
});
