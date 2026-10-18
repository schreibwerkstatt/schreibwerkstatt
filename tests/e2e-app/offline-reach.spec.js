// Offline-Reichweite in der echten App (neben den Entwürfen, die
// book-editor-offline.spec.js prüft):
//   - Server-pflichtige Aktionen scheitern ohne Netz sofort, mit einem Hinweis
//     statt eines Timeouts (app/boot/net-required.js), und sind gedimmt.
//   - Die Suche findet ohne Netz in den abgelegten Abschnitten des Buchs
//     (shared/offline-search.js).
//   - Das geöffnete Buch wird als „zuletzt geöffnet" gemerkt (Automatik in
//     app/app-offline-books.js).
//
// Der Service Worker ist auf localhost aus. Die Offline-Ablage, die er im
// Betrieb füllt, legt dieser Test darum selbst in die Cache Storage — dieselben
// Pfade, die public/sw-offline.js ablegt.

const { test, expect } = require('@playwright/test');
const { bootApp } = require('./_helpers/app');

test.describe.configure({ mode: 'serial' });

test.afterEach(async ({ context }) => { await context.setOffline(false).catch(() => {}); });

test('Offline: KI-Job scheitert sofort mit Hinweis, Chat-Senden ist gedimmt', async ({ page, context }) => {
  await bootApp(page);
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('is-offline'))).toBe(true);

  const t0 = Date.now();
  const res = await page.evaluate(async () => {
    try { await fetch('/jobs/review', { method: 'POST', body: '{}' }); return 'resolved'; }
    catch (e) { return e.offline ? 'offline' : 'other:' + e.message; }
  });
  expect(res).toBe('offline');
  expect(Date.now() - t0).toBeLessThan(2000);

  const msg = await page.evaluate(() => window.__app.t('offline.needsNetwork'));
  await expect(page.locator('.job-toast')).toContainText(msg, { timeout: 3000 });

  // LanguageTool beim Tippen: abgewiesen, aber ohne zweiten Toast.
  await page.evaluate(() => window.__app._dismissJobToast());
  const lt = await page.evaluate(async () => {
    try { await fetch('/languagetool/check', { method: 'POST', body: '{}' }); return 'resolved'; }
    catch (e) { return e.offline ? 'offline' : 'other'; }
  });
  expect(lt).toBe('offline');
  await expect(page.locator('.job-toast')).toHaveCount(0);

  await context.setOffline(false);
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('is-offline'))).toBe(false);
});

test('Offline: Suche findet in den abgelegten Abschnitten des Buchs', async ({ page, context }) => {
  await bootApp(page);
  const bookId = await page.evaluate(() => window.Alpine.store('nav').selectedBookId);
  // Ablage wie sw-offline.js: Baum + Abschnitte, ein Wort aus dem ersten Abschnitt als Suchwort.
  const probe = await page.evaluate(async (id) => {
    const tree = await (await fetch(`/content/books/${id}/tree?__fresh=1`)).json();
    const pages = [...(tree.topPages || [])];
    const walk = (cs) => { for (const c of cs || []) { pages.push(...(c.pages || [])); walk(c.subchapters); } };
    walk(tree.chapters);
    const cache = await caches.open('schreibwerkstatt-offline-v1');
    const json = (o) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
    await cache.put(location.origin + `/content/books/${id}/tree`, json(tree));
    let word = null;
    let pageId = null;
    for (const p of pages) {
      const full = await (await fetch(`/content/pages/${p.id}?__fresh=1`)).json();
      await cache.put(location.origin + `/content/pages/${p.id}`, json(full));
      if (!word) {
        const text = String(full.html || '').replace(/<[^>]*>/g, ' ');
        const w = text.split(/\s+/).find((x) => /^[A-Za-zÄÖÜäöü]{5,}$/.test(x));
        if (w) { word = w; pageId = p.id; }
      }
    }
    return { word, pageId, total: pages.length };
  }, bookId);
  expect(probe.word, 'Seed-Buch braucht einen Abschnitt mit Text').toBeTruthy();

  // Karte VOR dem Netzschnitt öffnen: ihr Partial wird nachgeladen, und ohne
  // SW (localhost) gibt es offline niemanden, der es aus dem Cache liefert.
  await page.evaluate(() => window.__app.toggleSearchCard());
  const input = page.locator('.search-q');
  await expect(input).toBeVisible();
  await context.setOffline(true);
  await input.fill(probe.word);

  const hits = page.locator('.search-hit');
  await expect(hits.first()).toBeVisible({ timeout: 5000 });
  const ids = await page.evaluate(() => window.Alpine.$data(document.querySelector('.search-q').closest('[x-data]')).hits.map((h) => h.entity_id));
  expect(ids).toContain(probe.pageId);
  await expect(page.locator('.search-hit mark').first()).toBeVisible();
  const hint = await page.evaluate(() => window.__app.t('search.offline.full'));
  await expect(page.locator('.search-status', { hasText: hint })).toBeVisible();

  await page.evaluate(() => caches.delete('schreibwerkstatt-offline-v1'));
});

test('Automatik: das geöffnete Buch wird als zuletzt geöffnet gemerkt', async ({ page }) => {
  await bootApp(page);
  const { email, bookId } = await page.evaluate(() => ({
    email: window.Alpine.store('session').currentUser?.email,
    bookId: window.Alpine.store('nav').selectedBookId,
  }));
  await expect.poll(() => page.evaluate((e) => JSON.parse(localStorage.getItem('offline_auto_u:' + e) || 'null')?.bookId, email))
    .toBe(String(bookId));
  await expect.poll(() => page.evaluate(() => window.Alpine.store('session').offlineAuto)).toEqual({ enabled: true, bookId: String(bookId) });
});

test('Benutzer-Einstellungen: Automatik lässt sich pro Gerät abschalten', async ({ page }) => {
  await bootApp(page);
  // Der Schalter steht nur mit kontrollierendem SW da — lokal gibt es keinen.
  await page.evaluate(() => { window.Alpine.store('session').offlineCapable = true; });
  await page.evaluate(() => window.__app.toggleUserSettingsCard());
  const label = await page.evaluate(() => window.__app.t('profile.offlineAuto'));
  const sw = page.locator('.card--settings [role="switch"]', { hasText: label });
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  const email = await page.evaluate(() => window.Alpine.store('session').currentUser?.email);
  await expect.poll(() => page.evaluate((e) => JSON.parse(localStorage.getItem('offline_auto_u:' + e) || 'null')?.enabled, email))
    .toBe(false);
  // Zurück auf an, damit nachfolgende Specs den Default sehen.
  await sw.click();
  await expect.poll(() => page.evaluate((e) => JSON.parse(localStorage.getItem('offline_auto_u:' + e) || 'null')?.enabled, email))
    .toBe(true);
});
