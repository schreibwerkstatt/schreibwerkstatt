// Kaltstart ohne Netz: Tab zu, Netz weg, NEUER Tab, Adresse eintippen —
// echter Service Worker, echte App, KEIN von Hand angeheftetes Buch.
//
// WARUM HIER: sw-offline-book und sw-offline-editors heften das Buch per Knopf
// an und laden denselben Tab neu. Der Alltagsfall (Flugzeug, Zug) ist ein
// anderer Weg: frische Shell-Navigation aus dem Precache in einem neuen Tab,
// Startbuch aus der Offline-Ablage der Automatik (app/app-offline-books.js,
// `AUTO_OFFLINE_MAX`), ein dort nie geöffneter Abschnitt, Save → Entwurf in
// IndexedDB, nach dem Wiederverbinden beim Server.
// Mutationsgeprüft: ohne Automatik (`desiredOfflineBooks` ohne `auto`, früher
// `return` in `_noteBookOpenedForOffline`) wird der Test rot. `AUTO_OFFLINE_MAX
// = 0` allein reicht dafür nicht — das geöffnete Buch wird trotzdem gesynct.
//
// Nur Chromium: Playwrights `setOffline` greift in Firefox nicht verlässlich
// auf Service-Worker-Fetches durch.
const { test, expect } = require('@playwright/test');
const { bootApp, waitBooted, focusUntilItSticks } = require('./_helpers/app');
const { readDraftRecord } = require('./_helpers/drafts');

const NB = '#editor-card .page-content-view--editing';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test.afterEach(async ({ context }) => { await context.setOffline(false).catch(() => {}); });

test('neuer Tab ohne Netz: App startet, Automatik-Buch ist da, nie geöffneter Abschnitt lässt sich schreiben', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'SW-Offline nur in Chromium verlässlich steuerbar');
  test.setTimeout(180000);

  await bootApp(page);
  await page.evaluate(() => localStorage.setItem('sw', '1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitBooted(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitBooted(page);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 60000 });

  // Ohne Klick: die Automatik legt das geöffnete Buch komplett ab.
  const bookId = await page.evaluate(() => String(window.Alpine.store('nav').selectedBookId));
  await page.waitForFunction((k) => {
    const s = window.Alpine.store('session');
    return !s.offlineProgress[k] && !!s.offlineBooks[k]?.at;
  }, bookId, { timeout: 60000 });
  expect(await page.evaluate(() => window.Alpine.store('session').offlinePinned)).toEqual([]);
  const { target, pageCount } = await page.evaluate(() => {
    const ps = window.Alpine.store('nav').pages;
    const p = ps[ps.length - 1];
    return { target: { id: p.id, name: p.name }, pageCount: ps.length };
  });

  // Tab zu, Netz weg, neuer Tab, Adresse eintippen.
  await page.close();
  await context.setOffline(true);
  const tab = await context.newPage();
  await tab.goto('/', { waitUntil: 'domcontentloaded' });
  await waitBooted(tab);
  expect(await tab.evaluate(() => navigator.onLine)).toBe(false);
  expect(await tab.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  expect(await tab.evaluate(() => String(window.Alpine.store('nav').selectedBookId))).toBe(bookId);
  expect(await tab.evaluate(() => window.Alpine.store('nav').pages.length)).toBe(pageCount);

  // Abschnitt, der in keinem Tab geöffnet war: lesen, bearbeiten, speichern.
  await tab.evaluate(async (id) => {
    const p = window.Alpine.store('nav').pages.find((x) => String(x.id) === String(id));
    await window.__app.selectPage(p);
  }, target.id);
  await tab.waitForFunction(
    () => window.__app.showEditorCard === true && window.__app.pageContentLoading === false && window.__app.originalHtml != null,
    null, { timeout: 30000 },
  );
  expect(await tab.evaluate(() => window.__app.pageLoadError)).toBe(false);
  const seedHtml = await tab.evaluate(() => window.__app.originalHtml);
  expect(seedHtml.length).toBeGreaterThan(0);

  await tab.evaluate(() => window.__app.startEdit());
  await tab.waitForFunction(() => window.__app.editMode === true, null, { timeout: 15000 });
  await focusUntilItSticks(tab.locator(NB));
  await tab.keyboard.press(`${MOD}+End`);
  const marker = 'Im neuen Tab ohne Netz geschrieben';
  await tab.keyboard.type(` ${marker}.`, { delay: 10 });
  await tab.evaluate(() => window.__app.quickSave());
  await tab.waitForFunction(() => window.__app.saveOffline === true && window.__app.editSaving === false, null, { timeout: 15000 });
  await expect.poll(async () => (await readDraftRecord(tab, target.id))?.html ?? null).toContain(marker);

  // Netz zurück: der Entwurf geht von selbst raus.
  await context.setOffline(false);
  await expect.poll(async () => (await (await tab.request.get(`/content/pages/${target.id}`)).text()).includes(marker),
    { timeout: 60000 }).toBe(true);
  await expect.poll(async () => (await readDraftRecord(tab, target.id))?.html ?? null, { timeout: 20000 }).toBeNull();

  // Seed-Stand zurück für die folgenden Specs.
  const status = await tab.evaluate(async ({ id, html, name }) => {
    const cur = await (await fetch('/content/pages/' + id + '?__fresh=1')).json();
    const res = await fetch('/content/pages/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, name, source: 'main', expected_updated_at: cur.updated_at ?? null }),
    });
    return res.status;
  }, { ...target, html: seedHtml });
  expect(status, 'Testseite liess sich nicht zurücksetzen').toBeLessThan(300);
});
