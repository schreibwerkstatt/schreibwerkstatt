// Alle drei Editoren nach einem Neuladen OHNE Netz: echter Service Worker,
// echte App.
//
// WARUM HIER: Die übrigen Offline-Specs (notebook-offline-retry,
// book-editor-offline, offline-structure) laufen ohne SW — er ist auf
// localhost per Default aus (boot/sw-register.js). Ohne SW lädt nach einem
// Offline-Reload aber gar nichts; ob die lazy nachgeladenen Editor-Partials
// aus dem Precache und die Daten aus dem Offline-Cache kommen, sieht nur diese
// Kette: Buch offline halten → Reload offline →
// Bucheditor (nie zuvor geöffnet: Blöcke aus dem Offline-Cache,
// cards/book-editor/blocks.js#fetchBookContents),
// Notebook-Editor (Edit-Modus, Tippen, Save scheitert → Entwurf in IndexedDB),
// Focus-Editor (aus dem Edit-Modus betreten).
// Mutationsgeprüft: fehlt `book-editor.html` oder `editor-focus.html` im
// Precache (sw-manifest.js), wird der Test rot.
//
// Nur Chromium: Playwrights `setOffline` greift in Firefox nicht verlässlich
// auf Service-Worker-Fetches durch.
const { test, expect } = require('@playwright/test');
const { bootApp, waitBooted, selectSeededBook, focusUntilItSticks } = require('./_helpers/app');
const { readDraftRecord } = require('./_helpers/drafts');

const NB = '#editor-card .page-content-view--editing';
const BE = '.card--bookeditor';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

let restore = null;

test.afterEach(async ({ page, context }) => {
  await context.setOffline(false).catch(() => {});
  if (!restore) return;
  const r = restore;
  restore = null;
  // Die Outbox sendet den Offline-Entwurf nach dem Wiederverbinden; erst
  // danach zurücksetzen, sonst überschriebe der Nachzügler den Seed-Stand.
  await expect.poll(async () => (await readDraftRecord(page, r.id))?.html ?? null, { timeout: 20000 }).toBeNull();
  const status = await page.evaluate(async ({ id, html, name }) => {
    const cur = await (await fetch('/content/pages/' + id + '?__fresh=1')).json();
    const res = await fetch('/content/pages/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, name, source: 'main', expected_updated_at: cur.updated_at ?? null }),
    });
    return res.status;
  }, r);
  expect(status, 'Testseite liess sich nicht zurücksetzen').toBeLessThan(300);
});

test('nach Reload ohne Netz öffnen Bucheditor, Notebook- und Focus-Editor', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'SW-Offline nur in Chromium verlässlich steuerbar');
  test.setTimeout(180000);

  await bootApp(page);
  const bookId = await selectSeededBook(page);

  // SW einschalten und warten, bis er die Seite kontrolliert (Erst-Install
  // übernimmt eine offene Seite nicht, kein clients.claim).
  await page.evaluate(() => localStorage.setItem('sw', '1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitBooted(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitBooted(page);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 60000 });
  await page.waitForFunction(() => window.Alpine.store('session').offlineCapable === true);

  // Buch anheften und den Sync abwarten.
  await page.evaluate((id) => { location.hash = '#book/' + id; }, bookId);
  const btn = page.locator('.card-actions button[aria-pressed]');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await btn.click();
  await page.waitForFunction((id) => {
    const s = window.Alpine.store('session');
    const k = String(id);
    return s.offlinePinned.includes(k) && !s.offlineProgress[k] && !!s.offlineBooks[k]?.at;
  }, bookId, { timeout: 60000 });

  const target = await page.evaluate(() => {
    const pages = window.Alpine.store('nav').pages;
    const p = pages[pages.length - 1];
    return { id: p.id, name: p.name };
  });

  await context.setOffline(true);
  await page.evaluate(() => history.replaceState(null, '', '/'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitBooted(page);
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await selectSeededBook(page);

  // Bucheditor: Partial aus dem Precache, Blöcke aus dem Offline-Cache.
  await page.evaluate(() => window.__app.toggleBookEditorCard());
  await expect(page.locator(`${BE} .book-editor-page-body`).first()).toBeVisible({ timeout: 15000 });

  // Notebook-Editor: Abschnitt aus dem Offline-Cache, Edit-Modus, Tippen.
  // `selectPage` löst den Bucheditor als exklusive Karte ab.
  await page.evaluate(async (id) => {
    const p = window.Alpine.store('nav').pages.find((x) => String(x.id) === String(id));
    await window.__app.selectPage(p);
  }, target.id);
  await page.waitForFunction(
    () => window.__app.showEditorCard === true && window.__app.pageContentLoading === false && window.__app.originalHtml != null,
    null, { timeout: 30000 },
  );
  expect(await page.evaluate(() => window.__app.pageLoadError)).toBe(false);
  restore = { ...target, html: await page.evaluate(() => window.__app.originalHtml) };
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForFunction(() => window.__app.editMode === true, null, { timeout: 15000 });
  await focusUntilItSticks(page.locator(NB));
  await page.keyboard.press(`${MOD}+End`);
  const marker = 'Offline nach dem Neuladen geschrieben';
  await page.keyboard.type(` ${marker}.`, { delay: 10 });
  await page.evaluate(() => window.__app.quickSave());
  await page.waitForFunction(() => window.__app.saveOffline === true && window.__app.editSaving === false, null, { timeout: 15000 });
  expect(await page.evaluate(() => window.__app.editMode), 'gescheiterter Save darf die Session nicht abbauen').toBe(true);
  await expect.poll(async () => (await readDraftRecord(page, target.id))?.html ?? null).toContain(marker);

  // Focus-Editor: aus dem Edit-Modus, Modul ebenfalls lazy.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('editor:focus:enter')));
  await page.waitForFunction(
    () => window.Alpine.$data(document.querySelector('.focus-editor'))?._focusState === 'active',
    null, { timeout: 15000 },
  );
  await expect(page.locator('.focus-editor__content')).toContainText(marker);
});
