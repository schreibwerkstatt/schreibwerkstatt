// Prod-Bündel der Shell (scripts/build-bundle.js, lib/bundle.js): läuft nur,
// wenn der Server mit BUNDLE_DIR auf ein frisch gebautes Bündel zeigt (CI-Schritt
// «Bündel-Smoke»). Prüft ausdrücklich, dass das Bündel GELADEN wurde — ein
// veraltetes Bündel ignoriert der Server still, und der Smoke liefe dann grün
// gegen die Einzeldateien.
const { test, expect } = require('@playwright/test');
const JSZip = require('jszip');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp, waitBooted, selectSeededBook } = require('./_helpers/app');

test.skip(!process.env.BUNDLE_DIR, 'nur im Bündel-Smoke (BUNDLE_DIR gesetzt)');

test('Shell bootet aus dem Bündel, ohne eine Einzeldatei aus /js/ als Modul', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  const moduleRequests = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (req.resourceType() === 'script' && url.pathname.startsWith('/js/')) moduleRequests.push(url.pathname);
  });
  const res = await page.request.get('/');
  const html = await res.text();
  expect(html).toContain('/bundle/app-');
  expect(html).not.toContain('rel="modulepreload"');

  await bootApp(page);
  await selectSeededBook(page);
  guard.assertClean('Boot aus dem Bündel');
  // Erlaubt bleiben nur die klassischen Scripts aus index.html.
  const classic = ['/js/theme-init.js', '/js/ios-viewport.js', '/js/client-error.js', '/js/failsafe-reveal.js', '/js/plausible-init.js'];
  expect(moduleRequests.filter((p) => !classic.includes(p))).toEqual([]);
});

// Service Worker im Bündel-Modus: /sw-manifest.js kommt aus dem Bündel
// (lib/bundle.js#bundleSwManifest), der Precache hält die Bündel-Dateien statt
// der eingebauten Einzeldateien, und die Shell bootet daraus offline.
test('Service Worker precacht das Bündel und bootet daraus offline', async ({ page, context }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const swManifest = await (await page.request.get('/sw-manifest.js')).text();
  expect(swManifest).toContain('"/bundle/app-');
  expect(swManifest).not.toContain('"/js/app.js"');

  await page.evaluate(() => localStorage.setItem('sw', '1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitBooted(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitBooted(page);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 60000 });

  const cached = await page.evaluate(async () => {
    const urls = [];
    for (const name of await caches.keys()) {
      if (!name.startsWith('schreibwerkstatt-shell-')) continue;
      for (const req of await (await caches.open(name)).keys()) urls.push(new URL(req.url).pathname);
    }
    return urls;
  });
  expect(cached.some((u) => u.startsWith('/bundle/app-'))).toBe(true);
  expect(cached).not.toContain('/js/app.js');
  // Offline scheitern die API-Abrufe der Karten (erwartet) — die Konsole wird
  // darum nur bis hier geprüft, offline zählt allein der Boot aus dem Precache.
  guard.assertClean('SW-Install aus dem Bündel');

  await context.setOffline(true);
  try {
    await page.evaluate(() => history.replaceState(null, '', '/'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitBooted(page);
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    expect(await page.evaluate(() => [...document.scripts].some((s) => s.src.includes('/bundle/app-')))).toBe(true);
  } finally {
    await context.setOffline(false);
  }
});

// Die nativen Clients (macOS, Android) ziehen den Editor-Kern als OTA-ZIP aus
// den Einzeldateien unter public/js (lib/editor-bundle.js) — das Bündel der
// Shell darf daran nichts ändern (Vertrag: contract/editor-api.d.ts).
test('OTA-Editor-ZIP der Clients bleibt aus den Einzeldateien gebaut', async ({ page }) => {
  await bootApp(page);
  const res = await page.request.get('/content/editor-bundle.zip');
  expect(res.status()).toBe(200);
  const zip = await JSZip.loadAsync(await res.body());
  const manifest = JSON.parse(await zip.file('bundle-manifest.json').async('string'));
  expect(manifest.jsFiles).toContain('js/editor/focus/standalone.js');
  for (const f of manifest.jsFiles) {
    expect(f.startsWith('bundle/'), f).toBe(false);
    expect(zip.file(f), f).not.toBeNull();
  }
});
