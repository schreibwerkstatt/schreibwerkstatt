// Focus-Editor ohne Netz und wieder mit Netz, gegen die echte App:
// Wer im Fokusmodus offline weiterschreibt, bleibt im Fokusmodus; sobald das
// Netz zurück ist, speichert der Retry (editor/notebook/edit/autosave.js,
// `online`-Trigger) den ganzen Stand — ohne Escape, ohne Neuladen — und der
// lokale Entwurf ist danach geräumt.
//
// Ergänzt #12 der Akzeptanzliste (focus-acceptance-app.spec.js: Offline +
// Escape behält den Entwurf) um das Wiederverbinden im Fokus.
const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp, selectSeededBook } = require('./_helpers/app');
const { readDraftRecord } = require('./_helpers/drafts');

// Letzte Seite des Seeds (wie die Akzeptanz-Spec); afterEach stellt sie wieder her.
let restore = null;

test.afterEach(async ({ page, context }) => {
  await context.setOffline(false).catch(() => {});
  if (!restore) return;
  const r = restore;
  restore = null;
  const status = await page.evaluate(async ({ id, html, name }) => {
    for (const k of Object.keys(localStorage)) if (k.includes('draft')) localStorage.removeItem(k);
    const res = await fetch('/content/pages/' + id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, name, source: 'main', expected_updated_at: null }),
    });
    return res.status;
  }, r);
  expect(status, 'Testseite liess sich nicht zurücksetzen').toBeLessThan(300);
});

async function waitFocusState(page, state, timeout = 15000) {
  await page.waitForFunction((s) => {
    const el = document.querySelector('.focus-editor');
    return !!el && window.Alpine?.$data(el)?._focusState === s;
  }, state, { timeout });
}

const serverHtml = (page, id) => page.evaluate(async (pid) => (await (await fetch(`/content/pages/${pid}?__fresh=1`)).json()).html, id);

test('offline weitergeschrieben, Netz zurück: Retry speichert im Fokusmodus', async ({ page, context }) => {
  test.setTimeout(90000);
  const guard = attachConsoleGuard(page);
  // Die Netzwerkfehler des Offline-Saves sind Testgegenstand.
  guard.ignore(/Failed to fetch|NetworkError|Load failed|ERR_INTERNET_DISCONNECTED|\[quickSave\]/);

  await bootApp(page);
  await selectSeededBook(page);
  const info = await page.evaluate(async () => {
    const pages = window.Alpine.store('nav').pages;
    const p = pages[pages.length - 1];
    await window.__app.selectPage(p);
    return { id: p.id, name: p.name };
  });
  await page.waitForFunction(() => window.__app.showEditorCard === true && window.__app.originalHtml != null, null, { timeout: 15000 });
  restore = { ...info, html: await page.evaluate(() => window.__app.originalHtml) };
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('editor:focus:enter-from-pageview')));
  await waitFocusState(page, 'active');
  await page.waitForTimeout(200);

  await context.setOffline(true);
  await page.keyboard.type(' Offlinesatz im Fokus.', { delay: 10 });
  // Der Autosave (sonst nach AUTOSAVE_IDLE_MS Tipp-Pause) scheitert am Netz:
  // Offline-Zustand, Entwurf lokal. Hier direkt der Save, den der Timer auslöst.
  await page.evaluate(() => window.__app.quickSave('autosave').catch(() => {}));
  await page.waitForFunction(() => window.__app.saveOffline === true, null, { timeout: 30000 });
  await page.keyboard.type(' Zweiter Offlinesatz.', { delay: 10 });
  await expect.poll(async () => (await readDraftRecord(page, info.id))?.html || '', { timeout: 15000 })
    .toContain('Zweiter Offlinesatz');

  await context.setOffline(false);
  await page.waitForFunction(() => window.__app.saveOffline === false && window.__app.editDirty === false, null, { timeout: 30000 });

  expect(await page.evaluate(() => window.__app.focusActive), 'Fokusmodus muss offen bleiben').toBe(true);
  await waitFocusState(page, 'active');
  const html = await serverHtml(page, info.id);
  expect(html).toContain('Offlinesatz im Fokus.');
  expect(html).toContain('Zweiter Offlinesatz.');
  await expect.poll(async () => (await readDraftRecord(page, info.id))?.html ?? null).toBeNull();
  guard.assertClean();
});
