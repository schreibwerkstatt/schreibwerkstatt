// „Buch offline halten" end-to-end: echter Service Worker, echte App, Netz weg.
//
// WARUM HIER: Der SW ist auf localhost per Default aus (boot/sw-register.js) —
// keine andere Schicht sieht, ob ein angeheftetes Buch nach einem Reload ohne
// Netz wirklich lesbar ist. Die Unit-Tests (sw-offline-books.test.mjs) prüfen
// die Bausteine einzeln; hier zählt die Kette: Sidebar-Knopf → SW-Sync →
// Reload offline → Shell aus dem Precache → Baum + ein NIE geöffneter
// Abschnitt aus dem Offline-Cache.
//
// Nur Chromium: Playwrights `setOffline` greift in Firefox nicht verlässlich
// auf Service-Worker-Fetches durch.
const { test, expect } = require('@playwright/test');
const { bootApp, waitBooted, selectSeededBook } = require('./_helpers/app');

test('angeheftetes Buch ist nach Reload ohne Netz lesbar, auch ein nie geöffneter Abschnitt', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'SW-Offline nur in Chromium verlässlich steuerbar');
  test.setTimeout(180000);

  await bootApp(page);
  const bookId = await selectSeededBook(page);

  // SW einschalten (lokal sonst aus) und warten, bis er die Seite kontrolliert:
  // Erst-Install übernimmt eine offene Seite bewusst nicht (kein clients.claim).
  await page.evaluate(() => localStorage.setItem('sw', '1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitBooted(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitBooted(page);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 60000 });
  await page.waitForFunction(() => window.Alpine.store('session').offlineCapable === true);

  // Buch per Sidebar-Knopf anheften und auf den fertigen Sync warten.
  await page.evaluate((id) => { location.hash = '#book/' + id; }, bookId);
  const btn = page.locator('.card-actions button:has(use[href="/icons.svg#cloud-download"])');
  await btn.click();
  await page.waitForFunction(
    (id) => !!window.Alpine.store('session').offlineBooks[String(id)]?.at,
    bookId, { timeout: 60000 },
  );
  await expect(page.locator('.card-actions button:has(use[href="/icons.svg#cloud-check"])')).toHaveAttribute('aria-pressed', 'true');

  // Einen Abschnitt wählen, der in dieser Sitzung nie geöffnet wurde: der
  // kann nur aus dem Offline-Cache kommen, nicht aus dem CONTENT_CACHE.
  const target = await page.evaluate(() => {
    const pages = window.Alpine.store('nav').pages;
    return pages[pages.length - 1].id;
  });

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitBooted(page);
  await page.evaluate(([b, p]) => { location.hash = `#book/${b}/page/${p}`; }, [bookId, target]);
  await page.waitForFunction(
    (p) => String(window.__app.currentPage?.id) === String(p) && window.__app.pageContentLoading === false,
    target, { timeout: 30000 },
  );
  expect(await page.evaluate(() => window.__app.pageLoadError)).toBe(false);
  await context.setOffline(false);
});
