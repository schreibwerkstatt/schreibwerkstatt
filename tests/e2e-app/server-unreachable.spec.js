// Server unerreichbar, obwohl der Browser „online" meldet (Hotspot ohne DNS,
// Captive Portal, Zug im Tunnel) — app/boot/reachability.js in der echten App:
//   - zwei gescheiterte Requests schalten in den Offline-Zustand: Banner,
//     `is-offline`-Dimmung, KI-Job wird nach kurzem Test abgewiesen;
//   - antwortet /ping wieder, schaltet der nächste Anlass (hier: Fokus) zurück;
//   - ein Fehlalarm blockiert nichts: antwortet der Server beim Test, läuft
//     die ausdrückliche Aktion normal.
//
// `navigator.onLine` bleibt die ganze Zeit `true` — der Ausfall wird per
// page.route simuliert. Auf localhost ist der Service Worker aus; fetch-guard
// zählt dann auch GET-Antworten als Erfolg.

const { test, expect } = require('@playwright/test');
const { bootApp } = require('./_helpers/app');

test.describe.configure({ mode: 'serial' });

const isOffline = (page) => page.evaluate(() => document.documentElement.classList.contains('is-offline'));
const failingFetch = (page, url) => page.evaluate(async (u) => {
  try { await fetch(u); return 'resolved'; } catch { return 'failed'; }
}, url);

test('Server weg bei Browser-online: Banner, Dimmung, Job abgewiesen, Rückkehr per Test', async ({ page }) => {
  await bootApp(page);
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  expect(await isOffline(page)).toBe(false);

  await page.route('**/*', (route) => route.abort('failed'));
  // Ein einzelner Fehler schaltet nicht (Unit-Test reachability.test.mjs); hier
  // scheitern Hintergrund-Requests der App mit, darum keine Zwischenprüfung.
  expect(await failingFetch(page, '/content/books')).toBe('failed');
  expect(await failingFetch(page, '/content/books')).toBe('failed');
  await expect.poll(() => isOffline(page)).toBe(true);
  await expect(page.locator('.session-banner--offline')).toBeVisible();

  // Ausdrückliche Aktion: Test an /ping scheitert → sofort abgewiesen mit Toast.
  const t0 = Date.now();
  const res = await page.evaluate(async () => {
    try { await fetch('/jobs/review', { method: 'POST', body: '{}' }); return 'resolved'; }
    catch (e) { return e.offline ? 'offline' : 'other:' + e.message; }
  });
  expect(res).toBe('offline');
  expect(Date.now() - t0).toBeLessThan(5000);
  const msg = await page.evaluate(() => window.__app.t('offline.needsNetwork'));
  await expect(page.locator('.job-toast')).toContainText(msg, { timeout: 3000 });

  // Server zurück: der nächste Anlass testet und schaltet zurück.
  await page.unroute('**/*');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => isOffline(page)).toBe(false);
  await expect(page.locator('.session-banner--offline')).toBeHidden();
});

test('Fehlalarm: antwortet der Server beim Test, läuft der KI-Job normal', async ({ page }) => {
  await bootApp(page);
  // Alles weg ausser /ping — eine gelungene Antwort dazwischen (Job-Queue-Poll)
  // setzte den Zähler zurück, so will es die Logik.
  await page.route('**/*', (route) => (new URL(route.request().url()).pathname === '/ping' ? route.continue() : route.abort('failed')));
  await failingFetch(page, '/content/books');
  await failingFetch(page, '/content/books');
  await expect.poll(() => isOffline(page)).toBe(true);
  await page.unroute('**/*');

  const res = await page.evaluate(async () => {
    try { await fetch('/jobs/review', { method: 'POST', body: '{}' }); return 'resolved'; }
    catch (e) { return e.offline ? 'offline' : 'other:' + e.message; }
  });
  expect(res).toBe('resolved');
  expect(await isOffline(page)).toBe(false);
});

test('/ping antwortet ohne Login mit der App-Kennung', async ({ request }) => {
  const r = await request.get('/ping');
  expect(r.ok()).toBe(true);
  expect(await r.json()).toEqual({ app: 'schreibwerkstatt' });
});
