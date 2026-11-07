// Ideen in Serie in der Ideen-Karte neben dem Abschnitt, gegen die ECHTE App:
// tippen, Enter, weitertippen — ohne Maus. Auf Prod wurden so 84 Ideen in einer
// Stunde angelegt, Abschnitt fuer Abschnitt, alle 10–20 s eine.
//
// Warum hier: der Fokus haengt am echten Template (`:disabled` am Feld waehrend
// des Speicherns) und am Seitenwechsel ueber den echten Baum.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const PREFIX = 'E2E-Serie ';

async function cleanup(page, bookId) {
  await page.evaluate(async ({ id, prefix }) => {
    const board = await fetch(`/ideen/board?book_id=${id}`).then(r => r.json());
    const stale = (board.ideen || []).filter(i => String(i.content).startsWith(prefix));
    await Promise.all(stale.map(i => fetch(`/ideen/${i.id}`, { method: 'DELETE' })));
  }, { id: bookId, prefix: PREFIX });
}

test('ideen-karte: Enter legt an und der Cursor bleibt im Feld — Serie ohne Maus', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  await cleanup(page, bookId);
  try {
    const pageIds = await page.evaluate(async (id) => {
      const tree = await fetch(`/content/books/${id}/tree`).then(r => r.json());
      return tree.chapters.flatMap(c => c.pages || []).map(p => p.id).slice(0, 2);
    }, bookId);
    await page.evaluate(async (pid) => {
      await window.__app.selectPage(window.Alpine.store('nav').pages.find(p => p.id === pid));
    }, pageIds[0]);
    await page.evaluate(() => window.__app.toggleIdeenCard());

    const input = page.locator('#ideen-card .ideen-input-row .ideen-input');
    await expect(input).toBeFocused();

    for (const n of [1, 2, 3]) {
      await page.keyboard.type(`${PREFIX}${n}`);
      await page.keyboard.press('Enter');
      await expect(page.locator('#ideen-card .idee-content', { hasText: `${PREFIX}${n}` })).toBeVisible();
      await expect(input).toHaveValue('');
      await expect(input).toBeFocused();
    }

    // Abschnittswechsel: die Ideen-Leiste bleibt offen, zeigt den neuen
    // Abschnitt, und der Cursor steht wieder im Feld.
    if (pageIds[1]) {
      await page.evaluate(async (pid) => {
        await window.__app.selectPage(window.Alpine.store('nav').pages.find(p => p.id === pid));
      }, pageIds[1]);
      await expect.poll(() => page.evaluate(() => window.__app.showIdeenCard)).toBe(true);
      await expect(page.locator('#ideen-card .idee-content', { hasText: `${PREFIX}1` })).toHaveCount(0);
      await expect(input).toBeFocused();
    }
  } finally {
    await cleanup(page, bookId);
  }
});
