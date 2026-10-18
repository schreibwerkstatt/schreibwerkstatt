// Notebook-Editor: ein offline gescheiterter Save in der OFFENEN Edit-Session
// wird nach dem Wiederverbinden von selbst nachgeholt — ohne Reload, ohne
// zweiten Klick (edit/autosave.js#_installOnlineRetry → quickSave('retry')).
//
// Die Outbox (offline-outbox.spec.js) lässt die offene Seite bewusst aus, und
// der Background Sync (sw-drafts-sync.spec.js) ebenso — für sie gibt es nur
// diesen Weg. Zwei Anlässe, weil der Browser einen davon nicht meldet:
//   1. echtes Offline → `online`-Event
//   2. Server weg, Browser meldet weiter online → Tab-Fokus
//
// Letzte Seite des Seeds (andere Specs arbeiten auf `pages[0]`); afterEach
// stellt ihren Inhalt über den regulären PUT wieder her.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp, selectSeededBook, focusUntilItSticks } = require('./_helpers/app');
const { readDraftRecord } = require('./_helpers/drafts');

const EDITOR = '#editor-card .page-content-view--editing';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
// Der Netzwerkfehler des Save-Versuchs ist der Testgegenstand.
const NET_ERRORS = /Failed to fetch|NetworkError|Load failed|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|ERR_FAILED|\[quickSave\]/;

let restore = null;

test.afterEach(async ({ page, context }) => {
  await context.setOffline(false).catch(() => {});
  await page.unroute('**/content/pages/*').catch(() => {});
  if (!restore) return;
  const r = restore;
  restore = null;
  const status = await page.evaluate(async ({ id, html, name }) => {
    const res = await fetch('/content/pages/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, name, source: 'main', expected_updated_at: null }),
    });
    return res.status;
  }, r);
  expect(status, 'Testseite liess sich nicht zurücksetzen').toBeLessThan(300);
});

// Buch → letzte Seite → Notebook-Edit-Modus, Caret ans Ende.
async function editLastPage(page) {
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
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForFunction(() => window.__app.editMode === true, null, { timeout: 10000 });
  await focusUntilItSticks(page.locator(EDITOR));
  await page.keyboard.press(`${MOD}+End`);
  return info;
}

// Save scheitert am Netz: Session bleibt offen, Text liegt lokal.
async function expectHeldOffline(page, pageId, marker) {
  await page.waitForFunction(() => window.__app.saveOffline === true && window.__app.editSaving === false, null, { timeout: 10000 });
  const s = await page.evaluate(() => ({
    editMode: window.__app.editMode, dirty: window.__app.editDirty, kind: window.__app.saveFailKind,
  }));
  expect(s.editMode, 'gescheiterter Save darf die Session nicht abbauen').toBe(true);
  expect(s.dirty).toBe(true);
  expect(s.kind).toBe('network');
  const draft = await readDraftRecord(page, pageId);
  expect(draft?.html, 'Entwurf fehlt im lokalen Speicher').toContain(marker);
}

// Retry gelungen: Session sauber, Entwurf geräumt, Server trägt den Text.
async function expectRetried(page, pageId, marker) {
  await page.waitForFunction(
    () => window.__app.saveOffline === false && window.__app.editDirty === false && window.__app.editSaving === false,
    null, { timeout: 15000 },
  );
  expect(await page.evaluate(() => window.__app.editMode), 'Retry bleibt im Editor').toBe(true);
  await expect.poll(async () => (await readDraftRecord(page, pageId))?.html ?? null, { timeout: 5000 }).toBeNull();
  const serverHtml = await page.evaluate(async (id) => (await (await fetch('/content/pages/' + id)).json()).html, pageId);
  expect(serverHtml).toContain(marker);
}

test('offline gescheiterter Save wird beim online-Event nachgeholt', async ({ page, context }) => {
  const guard = attachConsoleGuard(page);
  guard.ignore(NET_ERRORS);
  const { id } = await editLastPage(page);
  const marker = 'Offlinesatz kommt nach';

  await context.setOffline(true);
  await page.keyboard.type(` ${marker}.`, { delay: 10 });
  await page.evaluate(() => window.__app.quickSave());
  await expectHeldOffline(page, id, marker);

  // Kein manuelles Event: Chromium meldet den Wechsel selbst.
  await context.setOffline(false);
  await expectRetried(page, id, marker);
  guard.assertClean();
});

test('Save gegen nicht erreichbaren Server wird beim Tab-Fokus nachgeholt', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  guard.ignore(NET_ERRORS);
  const { id } = await editLastPage(page);
  const marker = 'Serversatz kommt nach';

  // Nur der PUT fällt aus; der Browser bleibt online, also kein `online`-Event.
  await page.route('**/content/pages/*', (route) => (
    route.request().method() === 'PUT' ? route.abort('connectionrefused') : route.continue()
  ));
  await page.keyboard.type(` ${marker}.`, { delay: 10 });
  await page.evaluate(() => window.__app.quickSave());
  await expectHeldOffline(page, id, marker);
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);

  await page.unroute('**/content/pages/*');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expectRetried(page, id, marker);
  guard.assertClean();
});

// Dritter Anlass, ohne jedes Fenster-Event: hängt die Leitung (Zug, Tunnel),
// meldet der Browser weiter online, und im Fokusmodus wechselt niemand den
// Tab. Der zeitgesteuerte Retry (edit/autosave.js#_scheduleSaveRetry, Takt aus
// editor/notebook/save-timing.js) holt den Save trotzdem nach.
test('Save gegen nicht erreichbaren Server wird ohne Fokus-/online-Event zeitgesteuert nachgeholt', async ({ page }) => {
  test.setTimeout(60000);
  const guard = attachConsoleGuard(page);
  guard.ignore(NET_ERRORS);
  const { id } = await editLastPage(page);
  const marker = 'Zugsatz kommt nach';

  await page.route('**/content/pages/*', (route) => (
    route.request().method() === 'PUT' ? route.abort('connectionrefused') : route.continue()
  ));
  await page.keyboard.type(` ${marker}.`, { delay: 10 });
  await page.evaluate(() => window.__app.quickSave());
  await expectHeldOffline(page, id, marker);
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  expect(await page.evaluate(() => window.__app._saveRetryTimers?.has('page')), 'kein Retry geplant').toBe(true);

  // Verbindung zurück, aber KEIN Event — nur der Timer (Basis 10 s) darf retten.
  await page.unroute('**/content/pages/*');
  await page.waitForFunction(() => window.__app.saveOffline === false, null, { timeout: 25000 });
  await expectRetried(page, id, marker);
  expect(await page.evaluate(() => window.__app._saveRetryAttempt)).toBe(0);
  guard.assertClean();
});
