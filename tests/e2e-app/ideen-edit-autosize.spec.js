// Edit-Feld einer Idee gegen die ECHTE App, auf beiden Oberflaechen (Ideen-Board
// und Ideen-Karte neben dem Editor): beim Wechsel in den Edit-Modus bleibt eine
// lange Idee lesbar — das Feld waechst mit dem Inhalt statt den Text auf drei
// Zeilen zu stauchen, und der Cursor steht schon darin.
//
// Geometrie haengt am vollen CSS (`field-sizing` bzw. JS-Fallback, Spaltenbreite
// des Boards) — darum hier und nicht im Fixture-Harness.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const LONG = [
  'Im dritten Kapitel muss klarer werden, warum Anna den Brief nicht sofort öffnet. Bisher wirkt es wie Zufall – eigentlich sollte die Angst vor der Nachricht ihres Vaters spürbar sein.',
  'Idee: eine kurze Rückblende an den Tag, an dem er gegangen ist, ca. eine halbe Seite. Dabei auf den Geruch von Tabak achten (Motiv aus Kap. 1) und den Regen nicht schon wieder bemühen.',
  'Offene Frage: weiss Lukas zu diesem Zeitpunkt schon von dem Brief?',
].join('\n\n');

// Das Feld zeigt den ganzen Text ohne inneres Scrollen und ist mindestens so
// hoch wie der Lesetext vorher (kleine Toleranz fuer Rand/Innenabstand).
async function expectGrownAndFocused(input, readHeight) {
  await expect(input).toBeFocused();
  const m = await input.evaluate(el => ({ h: el.getBoundingClientRect().height, sh: el.scrollHeight, ch: el.clientHeight }));
  expect(m.sh).toBeLessThanOrEqual(m.ch + 1);
  expect(m.h).toBeGreaterThanOrEqual(readHeight * 0.9);
}

let createdId = null;

test.afterEach(async ({ page }) => {
  if (createdId) await page.evaluate((id) => fetch(`/ideen/${id}`, { method: 'DELETE' }), createdId);
  createdId = null;
});

test('ideen: Edit-Feld waechst mit langer Idee — Board und Karte', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const made = await page.evaluate(async ({ id, content }) => {
    const tree = await fetch(`/content/books/${id}/tree`).then(r => r.json());
    const pageId = tree.chapters[0].pages[0].id;
    const row = await fetch('/ideen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: id, page_id: pageId, content }),
    }).then(r => r.json());
    return { pageId, ideeId: row.id };
  }, { id: bookId, content: LONG });
  createdId = made.ideeId;

  // ── Ideen-Board ─────────────────────────────────────────────────────────
  await page.evaluate((id) => { location.hash = `#book/${id}/ideen`; }, bookId);
  const boardCard = page.locator(`#ideen-board-card [data-idee-card-id="${made.ideeId}"]`);
  await expect(boardCard).toBeVisible();
  const boardRead = await boardCard.locator('.idee-board-text').evaluate(el => el.getBoundingClientRect().height);
  await boardCard.hover();
  await boardCard.locator('.idee-board-card-actions button').first().click();
  await expectGrownAndFocused(boardCard.locator('.idee-edit-input'), boardRead);
  // Waehrend des Bearbeitens weichen die schwebenden Aktionen und Stufen-Knoepfe.
  await expect(boardCard.locator('.idee-board-card-actions')).toBeHidden();
  await expect(boardCard.locator('.idee-board-steps')).toBeHidden();
  await page.keyboard.press('Escape');

  // ── Ideen-Karte neben dem Editor ────────────────────────────────────────
  await page.evaluate(async (pid) => {
    await window.__app.selectPage(window.Alpine.store('nav').pages.find(p => p.id === pid));
  }, made.pageId);
  await page.evaluate(() => window.__app.toggleIdeenCard());
  const item = page.locator(`#ideen-card [data-idee-id="${made.ideeId}"]`);
  await expect(item).toBeVisible();
  const cardRead = await item.locator('.idee-content').evaluate(el => el.getBoundingClientRect().height);
  await item.locator('.idee-menu button').click();
  await page.getByRole('menuitem', { name: 'Bearbeiten' }).click();
  await expectGrownAndFocused(item.locator('.idee-edit-input'), cardRead);
});
