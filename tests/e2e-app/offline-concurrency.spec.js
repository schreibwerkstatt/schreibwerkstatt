// Nachsenden derselben Entwürfe von mehreren Stellen zugleich, gegen die echte
// App mit echtem IndexedDB (und, im zweiten Fall, echtem Service Worker):
//
//   - zwei Tabs flushen ihre Outbox gleichzeitig (Wiederverbinden weckt beide)
//   - Background Sync des Service Workers und die Outbox eines Tabs zugleich
//
// Invariante: derselbe Entwurf geht genau EINMAL an den Server. Ein zweiter PUT
// mit demselben Basis-Stempel landete im 409 → Merge (oder bei einer
// Block-Kollision als Konflikt beim User) — der Web Lock je Abschnitt
// (`draft-flush:<id>`) und das Räumen unter dem Lock müssen das verhindern.
//
// Gezählt wird am Kontext: er sieht Requests aller Tabs und (Chromium) die des
// Service Workers. Der SW reicht PUTs ungecached durch (sw.js: nur GET), ein
// PUT eines Tabs erscheint darum nur einmal.
const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp, waitBooted, selectSeededBook } = require('./_helpers/app');
const { draftRecords } = require('./_helpers/drafts');

test.describe.configure({ mode: 'serial' });

// Testabschnitt (nicht pages[0]/letzte Seite: die nutzen andere Specs) samt
// Ausgangsstand — afterEach schreibt ihn zurück.
let restore = null;

test.afterEach(async ({ context }) => {
  const r = restore;
  restore = null;
  if (!r) return;
  const page = context.pages().find((p) => !p.isClosed());
  if (!page) return;
  const status = await page.evaluate(async ({ id, html, name }) => {
    const res = await fetch('/content/pages/' + id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, name, source: 'main', expected_updated_at: null }),
    });
    return res.status;
  }, r);
  expect(status, 'Testabschnitt liess sich nicht zurücksetzen').toBeLessThan(300);
});

async function pickTestPage(page) {
  const info = await page.evaluate(async () => {
    const p = window.Alpine.store('nav').pages[1];
    const cur = await (await fetch(`/content/pages/${p.id}?__fresh=1`)).json();
    return { id: p.id, name: cur.name, html: cur.html };
  });
  restore = info;
  return info.id;
}

// Entwurf so ablegen, wie draft-storage.js ihn nach der Bestätigung hält, und
// den offenen Tabs per Broadcast melden (wie ein Tab, der ihn geschrieben hat).
// Ein frischer BroadcastChannel erreicht auch den Kanal der App im selben Tab.
const seedDraft = (page, pageId, marker) => page.evaluate(async ([id, mark]) => {
  const email = window.Alpine.store('session').currentUser.email;
  const cur = await (await fetch(`/content/pages/${id}?__fresh=1`)).json();
  const key = `editor_draft_u:${email}:${id}`;
  const rec = {
    html: cur.html + `<p>${mark}</p>`, originalHtml: cur.html, originalUpdatedAt: cur.updated_at,
    savedAt: Date.now(), owner: email, writer: 'notebook', ownSaveIds: [],
  };
  const db = await new Promise((res, rej) => { const r = indexedDB.open('schreibwerkstatt-drafts', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  await new Promise((res, rej) => {
    const tx = db.transaction('drafts', 'readwrite');
    tx.objectStore('drafts').put(rec, key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  db.close();
  const ch = new BroadcastChannel('schreibwerkstatt-drafts');
  ch.postMessage({ type: 'put', key, rec });
  ch.close();
}, [pageId, marker]);

// Hat der Tab den Entwurf im Spiegel? Der Broadcast löst `draft:changed` aus,
// der Pending-Zähler zählt ihn dann als wartend.
const waitDraftKnown = (page) => page.waitForFunction(
  () => window.Alpine.store('session').pendingSyncCount >= 1, null, { timeout: 10000 },
);

const serverHtml = (page, id) => page.evaluate(async (pid) => (await (await fetch(`/content/pages/${pid}?__fresh=1`)).json()).html, id);

function countPuts(context, pageId) {
  const seen = [];
  context.on('request', (req) => {
    if (req.method() === 'PUT' && new URL(req.url()).pathname === `/content/pages/${pageId}`) {
      seen.push(req.serviceWorker() ? 'sw' : 'tab');
    }
  });
  return seen;
}

test('zwei Tabs flushen gleichzeitig: der Entwurf geht genau einmal raus', async ({ page, context }) => {
  test.setTimeout(90000);
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  const pageId = await pickTestPage(page);

  const tab2 = await context.newPage();
  const guard2 = attachConsoleGuard(tab2);
  await bootApp(tab2);
  await selectSeededBook(tab2);

  const puts = countPuts(context, pageId);
  await seedDraft(page, pageId, 'Zweitabsatz');
  await waitDraftKnown(page);
  await waitDraftKnown(tab2);

  await Promise.all([
    page.evaluate(() => window.__app._flushOutbox()),
    tab2.evaluate(() => window.__app._flushOutbox()),
  ]);
  // Auch ein Fokus-Trigger danach darf nichts mehr senden.
  await Promise.all([
    page.evaluate(() => window.__app._flushOutbox()),
    tab2.evaluate(() => window.__app._flushOutbox()),
  ]);

  expect(puts, `PUTs: ${puts.join(',')}`).toHaveLength(1);
  const html = await serverHtml(page, pageId);
  expect(html.split('Zweitabsatz').length - 1).toBe(1);
  expect((await draftRecords(page, pageId)).idb).toBeNull();
  for (const t of [page, tab2]) {
    await expect.poll(() => t.evaluate(() => window.Alpine.store('session').pendingSyncCount)).toBe(0);
  }
  guard.assertClean('Tab 1');
  guard2.assertClean('Tab 2');
  await tab2.close();
});

async function enableSw(page) {
  await page.evaluate(() => localStorage.setItem('sw', '1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitBooted(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitBooted(page);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 60000 });
}

test('Background Sync und Outbox zugleich: der Entwurf geht genau einmal raus', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Background Sync nur in Chromium');
  test.setTimeout(120000);
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  await enableSw(page);
  const pageId = await pickTestPage(page);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');

  const puts = countPuts(context, pageId);
  await seedDraft(page, pageId, 'Hintergrundundtab');
  await waitDraftKnown(page);

  // Erst beide wirklich gleichzeitig …
  await Promise.all([
    worker.evaluate(() => self.__swDrafts.flush()),
    page.evaluate(() => window.__app._flushOutbox()),
  ]);
  await page.evaluate(() => window.__app._flushOutbox());
  expect(puts, `PUTs: ${puts.join(',')}`).toHaveLength(1);

  // … dann die enge Reihenfolge fest: der SW sendet und räumt, die Lösch-
  // Meldung erreicht den Tab aber (noch) nicht — sein Spiegel hält den Entwurf.
  // Gleiches Modul wie die App (gleiche URL), darum trifft der Handler-Tausch
  // ihren Kanal.
  puts.length = 0;
  await seedDraft(page, pageId, 'Spaeterbroadcast');
  await waitDraftKnown(page);
  await page.evaluate(async () => {
    const m = await import('/js/editor/draft-idb.js');
    m.draftIdb.onMessage(() => {});
  });
  await worker.evaluate(() => self.__swDrafts.flush());
  expect(puts).toEqual(['sw']);
  await page.evaluate(() => window.__app._flushOutbox());
  expect(puts, 'Tab hat den schon gesendeten Stand ein zweites Mal geschickt').toEqual(['sw']);
  expect((await serverHtml(page, pageId)).split('Spaeterbroadcast').length - 1).toBe(1);

  expect(puts, `PUTs: ${puts.join(',')}`).toHaveLength(1);
  const html = await serverHtml(page, pageId);
  expect(html.split('Hintergrundundtab').length - 1).toBe(1);
  expect((await draftRecords(page, pageId)).idb).toBeNull();
  await expect.poll(() => page.evaluate(() => window.Alpine.store('session').pendingSyncCount)).toBe(0);
  guard.assertClean('SW + Outbox');
  await page.evaluate(() => localStorage.removeItem('sw'));
});
