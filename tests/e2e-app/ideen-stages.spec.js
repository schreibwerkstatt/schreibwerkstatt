// Ideen-Stufen pro Buch gegen die ECHTE App (docs/ideen-board.md, „Stufen pro
// Buch"): Spaltenzahl des Rasters, angebotene Stufen-Knoepfe, Umschalten ueber
// den Schalter „Spalten" — und dass eine Idee in einer abgeschalteten Stufe
// ihre Spalte behaelt.
//
// Hier und nicht im Unit-Test, weil die Spaltenzahl eine Layout-Aussage ist
// (Grid-CSS der Shell: `--ideen-cols` je Modifier-Klasse).
//
// Die App-Suite teilt EINEN Seed-Stand; ideen-board.spec.js erwartet vier
// Spalten. Darum stellt dieses Spec die Stufen am Ende wieder auf alle vier.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const ALL = ['offen', 'in_arbeit', 'erledigt', 'verworfen'];

async function putStages(page, bookId, stages) {
  return page.evaluate(({ id, s }) => fetch('/ideen/stages', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ book_id: id, stages: s }),
  }).then(r => r.json()), { id: bookId, s: stages });
}

async function gridColumnCount(board) {
  return board.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
}

test('ideen-stages: zwei Stufen → zwei Spalten, Zuschalten ueber „Spalten", belegte Stufe bleibt', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const ideeIds = [];
  try {
    const chapterId = await page.evaluate(async (id) => {
      const tree = await fetch(`/content/books/${id}/tree`).then(r => r.json());
      return tree.chapters[0].id;
    }, bookId);
    const idee = await page.evaluate(({ id, cid }) => fetch('/ideen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: id, chapter_id: cid, content: 'Stufen-Probe' }),
    }).then(r => r.json()), { id: bookId, cid: chapterId });
    ideeIds.push(idee.id);

    expect((await putStages(page, bookId, [])).stages).toEqual(['offen', 'erledigt']);

    await page.evaluate((id) => { location.hash = `#book/${id}/ideen`; }, bookId);
    const card = page.locator('#ideen-board-card');
    const board = card.locator('.ideen-board');
    await expect(board).toBeVisible();

    // Zwei Stufen: Spaltenkoepfe, Raster (Bahn + 2), Stufen-Knoepfe.
    await expect(card.locator('.ideen-board-head-col')).toHaveCount(2);
    expect(await gridColumnCount(board)).toBe(3);
    const probe = card.locator(`[data-idee-card-id="${idee.id}"]`);
    await expect(probe.locator('.idee-board-step:visible')).toHaveText(['Erledigt']);
    await expect(card.locator('.filter-toggle', { hasText: 'Verworfene anzeigen' })).toBeHidden();

    // Zuschalten ueber die Oberflaeche.
    await card.locator('.ideen-board-stages-toggle').click();
    const stagesPanel = card.locator('.ideen-board-stages');
    await stagesPanel.locator('.filter-toggle', { hasText: 'In Arbeit' }).locator('input').check();
    await expect(card.locator('.ideen-board-head-col')).toHaveCount(3);
    expect(await gridColumnCount(board)).toBe(4);
    await expect(probe.locator('.idee-board-step:visible')).toHaveText(['In Arbeit', 'Erledigt']);

    // Idee in „In Arbeit", dann Stufe wieder abschalten: die Spalte bleibt,
    // markiert, und bietet sich nicht mehr als Ziel an.
    await probe.locator('.idee-board-step', { hasText: 'In Arbeit' }).click();
    await expect(card.locator(`[data-idee-status-cell="in_arbeit"] [data-idee-card-id="${idee.id}"]`)).toHaveCount(1);
    await stagesPanel.locator('.filter-toggle', { hasText: 'In Arbeit' }).locator('input').uncheck();
    await expect(card.locator('.ideen-board-head-col--inactive')).toHaveCount(1);
    await expect(card.locator('.ideen-board-head-col')).toHaveCount(3);
    await expect(probe.locator('.idee-board-step:visible')).toHaveText(['Offen', 'Erledigt']);

    // Herausziehen geht: danach ist die Spalte leer und verschwindet.
    await probe.locator('.idee-board-step', { hasText: 'Erledigt' }).click();
    await expect(card.locator('.ideen-board-head-col')).toHaveCount(2);
    await expect(card.locator('.ideen-board-head-col--inactive')).toHaveCount(0);
  } finally {
    await putStages(page, bookId, ALL);
    await page.evaluate((ids) => Promise.all(ids.map(id => fetch(`/ideen/${id}`, { method: 'DELETE' }))), ideeIds);
  }
});
