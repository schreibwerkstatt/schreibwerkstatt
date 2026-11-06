// Revisionsliste gegen die ECHTE App: ein Save eines ZWEITGERÄTS (Mac-Client)
// muss die Revisionsliste der offenen Seite von selbst nachziehen.
//
// WARUM DIESE SCHICHT: die Kette laeuft vom fremden PUT ueber den Collab-Feed
// (/changes) bis zum Nachladen der Liste. Der lokale Repo-Pfad (eigener Save)
// dispatcht `page-revisions:changed` selbst — der fremde Save kommt ueber den
// Collab-Weg, und ob dort die Liste mitkommt, sieht nur die gebootete App.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const OTHER_DEVICE = '7c1d9e44-2f3b-4a6c-9d5e-1b8a0c2f4e60';

async function openFreshPage(page) {
  await bootApp(page);
  await selectSeededBook(page);
  const pid = await page.evaluate(async () => {
    const nav = window.Alpine.store('nav');
    const first = nav.pages[0];
    const r = await fetch('/content/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: nav.selectedBookId, chapter_id: first.chapter_id || undefined, name: 'E2E Revisions remote', html: '<p>Ausgangstext.</p>' }),
    });
    if (!r.ok) throw new Error('createPage ' + r.status);
    const created = await r.json();
    nav.pages = [...nav.pages, { ...created, chapterName: first.chapterName }];
    await window.__app.selectPage(nav.pages[nav.pages.length - 1]);
    return created.id;
  });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.waitForSelector('.page-revisions-bar', { state: 'attached', timeout: 15000 });
  return pid;
}

const revisionCount = (page) => page.evaluate(() => {
  const el = document.querySelector('.page-revisions-bar');
  if (!el) return -1;
  return window.Alpine.$data(el).revisions.length;
});

// Quellen der gelisteten Revisionen (neueste zuerst) — der Mac-Client liefert
// `macapp`.
const revisionSources = (page) => page.evaluate(() => {
  const el = document.querySelector('.page-revisions-bar');
  if (!el) return [];
  return window.Alpine.$data(el).revisions.map(r => r.source);
});

test('Revisionsliste: fremder Save (Mac-Client) zieht die Liste nach', async ({ page }) => {
  const pageId = await openFreshPage(page);
  try {
    const bookId = await page.evaluate(() => Number(window.Alpine.store('nav').selectedBookId));

    // Buch-Kanal bestaetigt (`hello`) — dieselbe Modul-Instanz wie die App.
    await page.waitForFunction(async (id) => {
      const m = await import('/js/event-stream.js');
      return m.bookStreamOpen(id);
    }, bookId, { timeout: 15000 });

    // Zweitgeraet meldet sich am Buch → Geraete-Zaehler > 1 → Voll-Poll
    // startet und holt seine Baseline.
    const ping = await page.request.post(`/content/books/${bookId}/device-ping`, {
      data: { device_id: OTHER_DEVICE, page_id: pageId },
    });
    expect(ping.ok()).toBeTruthy();
    await page.waitForFunction(() => {
      const c = window.Alpine.store('collab');
      return !!c._collabPollTimer && !!c._collabSince;
    }, null, { timeout: 15000 });

    // Timer anhalten: ab hier kann nur der Stream liefern.
    await page.evaluate(() => {
      const c = window.Alpine.store('collab');
      clearInterval(c._collabPollTimer);
      clearInterval(c._bookDevicePingTimer);
    });

    const before = await revisionCount(page);

    // Der fremde Save (Mac-Client, Quelle `macapp`).
    const save = await page.request.put(`/content/pages/${pageId}`, {
      data: { html: '<p>Vom Mac-Client geschrieben.</p>', source: 'macapp', device_id: OTHER_DEVICE },
    });
    expect(save.ok()).toBeTruthy();

    // Die Liste haengt am fremden Save nach.
    await expect.poll(() => revisionCount(page), { timeout: 15000 }).toBeGreaterThan(before);
    // Und sie zeigt die Fassung des Mac-Clients (Quelle `macapp`).
    expect(await revisionSources(page)).toContain('macapp');
  } finally {
    await page.evaluate(async (id) => { await fetch('/content/pages/' + id, { method: 'DELETE' }); }, pageId);
  }
});
