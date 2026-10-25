// Strukturänderungen ohne Netz (repo/structure-queue.js): ein Abschnitt, offline
// angelegt und beschrieben, und ein offline umbenannter Abschnitt landen beim
// Wiederverbinden auf dem Server — der neue Abschnitt mit seinem Inhalt und
// seiner echten ID im offenen Editor, ohne Konflikt und ohne Doppel.

const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('Abschnitt offline anlegen, beschreiben, umbenennen — beim Wiederverbinden auf dem Server', async ({ page, context }) => {
  test.setTimeout(90000);
  await bootApp(page);
  await selectSeededBook(page);
  const { chapterId, renameId } = await page.evaluate(() => {
    const ch = window.Alpine.store('nav').tree.find((it) => it.type === 'chapter' && !it.solo && it.pages?.length);
    const other = window.Alpine.store('nav').pages.find((p) => p.chapter_id !== ch.id) || window.Alpine.store('nav').pages[0];
    return { chapterId: ch.id, renameId: other.id };
  });

  // Einmal online einen Abschnitt öffnen: ohne Service Worker (lokal aus) gibt
  // es die Editor-Partials sonst offline nicht — in der App liegen sie im Precache.
  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
  await page.waitForFunction(() => window.__app.pageContentLoading === false, null, { timeout: 15000 });

  await context.setOffline(true);
  // Anlegen über das Baum-Kontextmenü (Namensdialog gestubbt).
  await page.evaluate(async (id) => {
    window.__app.appPrompt = async () => 'Zugabschnitt';
    window.__app.actionMenuTarget = { kind: 'chapter', id };
    await window.__app.pagetreeCtxNewPage();
  }, chapterId);
  await page.waitForFunction(() => window.__app.currentPage?.id < 0, null, { timeout: 15000 });
  await page.waitForFunction(() => window.__app.editMode === true, null, { timeout: 15000 });
  await page.keyboard.type('Geschrieben im Tunnel.');
  await page.evaluate(() => window.__app.quickSave());
  expect(await page.evaluate((id) => window.__app.renamePageById(id, 'Umbenannt offline'), renameId)).toBe(true);
  expect(await page.evaluate(() => window.Alpine.store('session').pendingSyncCount)).toBeGreaterThanOrEqual(2);

  await context.setOffline(false);
  await page.evaluate(() => window.__app._flushOutbox());
  await page.waitForFunction(() => window.__app.currentPage?.id > 0, null, { timeout: 15000 });
  const realId = await page.evaluate(() => window.__app.currentPage.id);

  const server = await page.evaluate(async ([pid, rid]) => {
    const p = await (await fetch(`/content/pages/${pid}?__fresh=1`)).json();
    const r = await (await fetch(`/content/pages/${rid}?__fresh=1`)).json();
    const tree = await (await fetch(`/content/books/${p.book_id}/tree?__fresh=1`)).json();
    const all = [...(tree.topPages || []), ...(tree.chapters || []).flatMap(function walk(c) { return [...(c.pages || []), ...(c.subchapters || []).flatMap(walk)]; })];
    return { name: p.name, html: p.html, chapter: p.chapter_id, renamed: r.name, copies: all.filter((x) => x.name === 'Zugabschnitt').length };
  }, [realId, renameId]);
  expect(server.name).toBe('Zugabschnitt');
  expect(server.chapter).toBe(chapterId);
  expect(server.copies).toBe(1);
  expect(server.renamed).toBe('Umbenannt offline');
  // Der Text ist entweder schon mit dem Anlegen oder über den Entwurf angekommen.
  await expect.poll(async () => page.evaluate(async (pid) => (await (await fetch(`/content/pages/${pid}?__fresh=1`)).json()).html, realId), { timeout: 15000 })
    .toContain('Geschrieben im Tunnel.');
  expect(await page.evaluate(() => window.__app.editConflict)).toBeFalsy();
  expect(await page.evaluate(() => window.Alpine.store('session').pendingSyncCount)).toBe(0);
});

// Die Warteschlange liegt in IndexedDB (nicht localStorage) und übersteht ein
// Neuladen: nach dem Start steht der vorgemerkte Abschnitt wieder im Baum — die
// Baum-Überlagerung wartet auf das asynchrone Laden (tree/load.js). Der Server
// bleibt für das Anlegen unerreichbar, bis der Test ihn freigibt; lokal ist der
// Service Worker aus, ein echtes Offline-Neuladen gäbe es ohne ihn nicht.
test('offline angelegter Abschnitt liegt in IndexedDB und übersteht ein Neuladen', async ({ page, context }) => {
  test.setTimeout(90000);
  await bootApp(page);
  await selectSeededBook(page);
  const chapterId = await page.evaluate(() => window.Alpine.store('nav').tree.find((it) => it.type === 'chapter' && !it.solo && it.pages?.length).id);
  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
  await page.waitForFunction(() => window.__app.pageContentLoading === false, null, { timeout: 15000 });

  await context.setOffline(true);
  await page.evaluate(async (id) => {
    window.__app.appPrompt = async () => 'Nach Neuladen';
    window.__app.actionMenuTarget = { kind: 'chapter', id };
    await window.__app.pagetreeCtxNewPage();
  }, chapterId);
  await page.waitForFunction(() => window.__app.currentPage?.id < 0, null, { timeout: 15000 });

  const stored = await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('schreibwerkstatt-structure-queue');
    req.onsuccess = () => {
      const all = req.result.transaction('ops').objectStore('ops').getAll();
      all.onsuccess = () => resolve({
        idb: all.result.map((o) => o.body?.name),
        ls: Object.keys(localStorage).filter((k) => k.startsWith('structure_queue_u:')).length,
      });
    };
  }));
  expect(stored.idb).toContain('Nach Neuladen');
  expect(stored.ls).toBe(0);

  // Anlegen bleibt unzustellbar, der Rest der App lädt normal.
  const block = (route) => (route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue());
  await page.route('**/content/pages', block);
  await context.setOffline(false);
  await page.reload();
  await page.waitForFunction(() => window.Alpine?.store('nav')?.pages?.some((p) => p.id < 0 && p.name === 'Nach Neuladen'), null, { timeout: 20000 });

  await page.unroute('**/content/pages', block);
  await page.evaluate(() => window.__app._flushOutbox());
  await page.waitForFunction(() => window.Alpine.store('session').pendingSyncCount === 0, null, { timeout: 15000 });
  const copies = await page.evaluate(async (cid) => {
    const book = window.Alpine.store('nav').selectedBookId;
    const tree = await (await fetch(`/content/books/${book}/tree?__fresh=1`)).json();
    const walk = (c) => [...(c.pages || []), ...(c.subchapters || []).flatMap(walk)];
    return [...(tree.topPages || []), ...(tree.chapters || []).flatMap(walk)].filter((x) => x.name === 'Nach Neuladen' && x.chapter_id === cid).length;
  }, chapterId);
  expect(copies).toBe(1);
});
