// Bucheditor: Block-Level-Merge bei Stale-Write (cards/book-editor/conflict.js).
// Ein anderes Gerät speichert denselben Abschnitt, während er im Bucheditor
// offen ist:
//  - anderer Absatz → still gemergt, beide Änderungen auf dem Server, kein
//    Banner, der Remote-Absatz steht im Block;
//  - derselbe Absatz → Auflösungs-Modal; «Beide behalten» übernimmt beide
//    Fassungen, der Rest bleibt gemergt.

const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const card = (page) => page.locator('.card--bookeditor');
const data = (page, fn, arg) => page.evaluate(([src, a]) => {
  // eslint-disable-next-line no-new-func
  const f = new Function('d', 'a', `return (${src})(d, a);`);
  return f(window.Alpine.$data(document.querySelector('.card--bookeditor')), a);
}, [fn.toString(), arg]);

async function openApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__app && Array.isArray(window.Alpine.store('nav').books) && window.Alpine.store('nav').books.length > 0,
    null, { timeout: 30000 },
  );
  const bookId = await page.evaluate(() => window.Alpine.store('nav').books[0].id);
  await page.evaluate((id) => { location.hash = '#book/' + id; }, bookId);
  await page.waitForFunction(
    (id) => String(window.Alpine.store('nav').selectedBookId) === String(id)
            && Array.isArray(window.Alpine.store('nav').pages) && window.Alpine.store('nav').pages.length > 0,
    bookId, { timeout: 20000 },
  );
}

const readPage = (page, id) => page.evaluate(
  async (pid) => (await fetch(`/content/pages/${pid}?__fresh=1`)).json(), id);

// Schreibt wie ein anderes Gerät (ohne Save-Kennung) gegen den aktuellen Stand.
const remoteWrite = (page, id, edit) => page.evaluate(async ([pid, src]) => {
  const cur = await (await fetch(`/content/pages/${pid}?__fresh=1`)).json();
  // eslint-disable-next-line no-new-func
  const html = new Function('h', `return (${src})(h);`)(cur.html);
  const r = await fetch(`/content/pages/${pid}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html, expected_updated_at: cur.updated_at }),
  });
  return r.status;
}, [id, edit.toString()]);

// Eigenen Abschnitt mit drei Absätzen anlegen (Server vergibt die Block-IDs)
// und den Bucheditor öffnen. Eigener Abschnitt, weil andere Specs desselben
// Laufs den Inhalt des ersten Abschnitts erwarten; afterEach räumt ihn ab.
let createdPageId = null;
async function seedAndOpen(page, tag) {
  await openApp(page);
  const html = `<p>Eins ${tag}.</p><p>Zwei ${tag}.</p><p>Drei ${tag}.</p>`;
  const created = await page.evaluate(async ([h, name]) => {
    const r = await fetch('/content/pages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: window.Alpine.store('nav').selectedBookId, name, html: h }),
    });
    return { status: r.status, body: await r.json() };
  }, [html, `Merge ${tag}`]);
  expect(created.status).toBe(200);
  const pageId = created.body.id;
  createdPageId = pageId;
  await page.evaluate(() => window.__app.toggleBookEditorCard());
  const body = card(page).locator(`[data-book-editor-page="${pageId}"]`);
  await expect(body).toContainText(`Zwei ${tag}.`, { timeout: 15000 });
  return { pageId, body };
}

test.afterEach(async ({ page }) => {
  if (createdPageId == null) return;
  const id = createdPageId;
  createdPageId = null;
  await page.evaluate((pid) => fetch(`/content/pages/${pid}`, { method: 'DELETE' }), id).catch(() => {});
});

async function typeAtEndOfParagraph(page, body, n, text) {
  await body.click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList?.contains('book-editor-page-body') === true)).toBe(true);
  await body.locator('p').nth(n).click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
}

const blockState = (page, pageId) => data(page, (d, id) => {
  const b = d.blocks.find((x) => x.pageId === id);
  return { dirty: b.dirty, conflict: !!b.conflict, saving: b.saving, modal: d.conflictResolution?.pageId === id };
}, pageId);

test('anderer Absatz remote geändert: still gemergt, beide Änderungen gespeichert', async ({ page }) => {
  const { pageId, body } = await seedAndOpen(page, 'M1');
  // Block aktivieren, dann schreibt das «andere Gerät» Absatz drei.
  await typeAtEndOfParagraph(page, body, 0, ' lokal');
  expect(await remoteWrite(page, pageId, (h) => h.replace('Drei M1.', 'Drei M1 remote.'))).toBe(200);

  await data(page, (d) => d.saveAllDirty());
  await expect.poll(async () => (await blockState(page, pageId)).dirty, { timeout: 15000 }).toBe(false);
  const s = await blockState(page, pageId);
  expect(s.conflict).toBe(false);
  expect(s.modal).toBe(false);

  const server = (await readPage(page, pageId)).html;
  expect(server).toContain('Eins M1. lokal');
  expect(server).toContain('Drei M1 remote.');
  expect(server.match(/<p\b/g).length).toBe(3);
  // Der aktive Block zeigt den gemergten Stand, nicht die alte eigene Fassung.
  await expect(body).toContainText('Drei M1 remote.');
});

test('Undo nach stillem Merge nimmt nur die eigene Änderung zurück, die fremde bleibt', async ({ page }) => {
  const { pageId, body } = await seedAndOpen(page, 'M4');
  await typeAtEndOfParagraph(page, body, 0, ' lokal');
  expect(await remoteWrite(page, pageId, (h) => h.replace('Drei M4.', 'Drei M4 remote.'))).toBe(200);
  await data(page, (d) => d.saveAllDirty());
  await expect.poll(async () => (await blockState(page, pageId)).dirty, { timeout: 15000 }).toBe(false);
  await expect(body).toContainText('Drei M4 remote.');

  // Der Verlauf überlebt den Merge (gehoben, nicht verworfen) …
  expect(await data(page, (d) => d.bookEditorCanUndo())).toBe(true);
  await page.keyboard.press('Control+z');
  // … und das Undo nimmt nur « lokal» heraus, nie den Remote-Absatz.
  await expect(body).not.toContainText('Eins M4. lokal');
  await expect(body).toContainText('Eins M4.');
  await expect(body).toContainText('Drei M4 remote.');
  // Gespeichert wird das Undo regulär — ohne 409, ohne die fremde Änderung zu verlieren.
  await data(page, (d) => d.saveAllDirty());
  await expect.poll(async () => (await readPage(page, pageId)).html, { timeout: 15000 }).not.toContain('lokal');
  const server = (await readPage(page, pageId)).html;
  expect(server).toContain('Drei M4 remote.');
  expect((await blockState(page, pageId)).conflict).toBe(false);
});

test('derselbe Absatz remote geändert: Modal, «Beide behalten» übernimmt beide Fassungen', async ({ page }) => {
  const { pageId, body } = await seedAndOpen(page, 'M2');
  await typeAtEndOfParagraph(page, body, 1, ' lokal');
  expect(await remoteWrite(page, pageId, (h) => h.replace('Zwei M2.', 'Zwei M2 remote.').replace('Eins M2.', 'Eins M2 remote.'))).toBe(200);

  await data(page, (d) => d.saveAllDirty());
  const modal = card(page).locator('.conflict-overlay');
  await expect(modal).toBeVisible({ timeout: 15000 });
  await expect(modal.locator('.conflict-block')).toHaveCount(1);
  // Solange das Modal offen ist, bleibt der Server-Stand unverändert.
  expect((await readPage(page, pageId)).html).not.toContain('lokal');

  await modal.locator('.conflict-block__both').click();
  await modal.locator('.conflict-modal__actions .primary').click();
  await expect(modal).toBeHidden();
  await expect.poll(async () => (await blockState(page, pageId)).dirty, { timeout: 15000 }).toBe(false);
  expect((await blockState(page, pageId)).conflict).toBe(false);

  const server = (await readPage(page, pageId)).html;
  expect(server).toContain('Eins M2 remote.');
  expect(server).toContain('Zwei M2. lokal');
  expect(server).toContain('Zwei M2 remote.');
  expect(server).toContain('Drei M2.');
  expect(server.match(/<p\b/g).length).toBe(4);
});

test('Modal abbrechen verwirft nichts: Banner bleibt, «Konflikt lösen …» öffnet es neu', async ({ page }) => {
  const { pageId, body } = await seedAndOpen(page, 'M3');
  await typeAtEndOfParagraph(page, body, 0, ' lokal');
  expect(await remoteWrite(page, pageId, (h) => h.replace('Eins M3.', 'Eins M3 remote.'))).toBe(200);

  await data(page, (d) => d.saveAllDirty());
  const modal = card(page).locator('.conflict-overlay');
  await expect(modal).toBeVisible({ timeout: 15000 });
  await modal.locator('.conflict-modal__actions button:not(.primary)').click();
  await expect(modal).toBeHidden();
  const s = await blockState(page, pageId);
  expect(s.conflict).toBe(true);
  expect(s.dirty).toBe(true);
  await expect(body).toContainText('Eins M3. lokal');

  await card(page).locator('.book-editor-conflict:visible button.primary').click();
  await expect(modal).toBeVisible({ timeout: 15000 });
  // «Überall die andere»: Remote-Fassung des kollidierenden Absatzes.
  await modal.locator('.conflict-modal__bulk button').nth(1).click();
  await modal.locator('.conflict-modal__actions .primary').click();
  await expect.poll(async () => (await blockState(page, pageId)).dirty, { timeout: 15000 }).toBe(false);
  const server = (await readPage(page, pageId)).html;
  expect(server).toContain('Eins M3 remote.');
  expect(server).not.toContain('lokal');
});
