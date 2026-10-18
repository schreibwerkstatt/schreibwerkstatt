// Warnung beim Schliessen des Tabs, gegen die echte App — die Verdrahtung der
// beiden beforeunload-Handler, nicht nur die reine Entscheidung
// (tests/unit/outbox-unload-warning.test.mjs):
//
//   - app-outbox.js: offline vorgemerkte Strukturänderung, Server nicht
//     erreichbar → Warnung (Warteschlangen sendet kein Service Worker nach)
//   - nichts wartet, online → keine Warnung
//   - app-init.js: offene Edit-Seite mit ungespeicherten Änderungen → Warnung
//
// `page.close({ runBeforeUnload: true })` löst den echten beforeunload aus; ein
// Handler, der ihn abfängt, erzeugt einen `beforeunload`-Dialog.
const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

// Schliessen und melden, ob ein beforeunload-Dialog kam. Der Dialog wird
// angenommen, damit der Tab wirklich zugeht.
async function closeAndCatchDialog(page) {
  let asked = false;
  page.on('dialog', (d) => { if (d.type() === 'beforeunload') asked = true; d.accept().catch(() => {}); });
  await page.close({ runBeforeUnload: true });
  await page.waitForEvent('close', { timeout: 5000 }).catch(() => {});
  return asked;
}

// Der Browser zeigt den beforeunload-Dialog nur nach einer Nutzergeste im Tab.
const userGesture = (page) => page.mouse.click(5, 5);

test('nichts wartet: Schliessen ohne Rückfrage', async ({ context }) => {
  const page = await context.newPage();
  await bootApp(page);
  await selectSeededBook(page);
  await userGesture(page);
  expect(await closeAndCatchDialog(page)).toBe(false);
});

test('offline umbenannt (vorgemerkt), Server nicht erreichbar: Rückfrage', async ({ context }) => {
  const page = await context.newPage();
  await bootApp(page);
  await selectSeededBook(page);
  const pageId = await page.evaluate(() => window.Alpine.store('nav').pages[1].id);
  const name = await page.evaluate(() => window.Alpine.store('nav').pages[1].name);

  await context.setOffline(true);
  // Umbenennen über das Repo wie die UI: ohne Netz landet es in der
  // Struktur-Warteschlange (repo/content.js → structure-queue.js).
  const res = await page.evaluate(async ([id, n]) => {
    const { contentRepo } = await import('/js/repo/content.js');
    return contentRepo.updatePage(id, { name: n + ' offline' });
  }, [pageId, name]);
  expect(res.pending, 'Umbenennen wurde nicht vorgemerkt').toBe(true);
  await expect.poll(() => page.evaluate(() => window.Alpine.store('session').pendingSyncCount)).toBeGreaterThan(0);

  await userGesture(page);
  expect(await closeAndCatchDialog(page), 'keine Warnung trotz wartender Strukturänderung').toBe(true);

  // Aufräumen: Warteschlange in einem frischen Tab online abspielen und den
  // alten Namen zurückschreiben.
  await context.setOffline(false);
  const p2 = await context.newPage();
  await bootApp(p2);
  await selectSeededBook(p2);
  await p2.evaluate(() => window.__app._flushOutbox());
  await expect.poll(() => p2.evaluate(() => window.Alpine.store('session').pendingSyncCount)).toBe(0);
  const status = await p2.evaluate(async ([id, n]) => (await fetch('/content/pages/' + id, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n }),
  })).status, [pageId, name]);
  expect(status).toBeLessThan(300);
  await p2.close();
});

test('offene Edit-Seite mit ungespeicherten Änderungen: Rückfrage', async ({ context }) => {
  const page = await context.newPage();
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => {
    await window.__app.selectPage(window.Alpine.store('nav').pages[1]);
    window.__app.startEdit();
  });
  await page.waitForFunction(() => window.__app.editMode === true, null, { timeout: 10000 });
  const editor = page.locator('#editor-card .page-content-view--editing').first();
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' ungespeichert');
  await page.waitForFunction(() => window.__app.editDirty === true, null, { timeout: 5000 });

  expect(await closeAndCatchDialog(page), 'keine Warnung trotz ungespeicherter Änderung').toBe(true);

  // Den liegengebliebenen Entwurf verwerfen, sonst bietet ihn der nächste Test an.
  const p2 = await context.newPage();
  await bootApp(p2);
  await p2.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.includes('draft')) localStorage.removeItem(k); });
  await p2.evaluate(async () => {
    const m = await import('/js/editor/draft-storage.js');
    for (const id of m.listDraftPageIds()) m.clearDraft(id);
  });
  await p2.close();
});
