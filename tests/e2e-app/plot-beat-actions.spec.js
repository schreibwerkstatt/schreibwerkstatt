// Schnellaktionen der Beat-Karte (DESIGN.md „Hover-Reveal"): im Ruhezustand
// unsichtbar, auf Hover sichtbar. Gegen die echte App, weil die Mechanik am vollen
// CSS hängt (components/hover-reveal.css + plot/board.css).
const { test, expect } = require('../e2e/_helpers/fixtures');

test('plot: Beat-Aktionen erscheinen erst auf Hover', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__app && window.Alpine.store('nav').selectedBookId);
  const bookId = await page.evaluate(() => window.Alpine.store('nav').selectedBookId);

  const ids = await page.evaluate(async (bookId) => {
    const post = (url, body) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json());
    const act = await post('/plot/acts', { book_id: bookId, name: 'Aktionen-Akt' });
    const beat = await post('/plot/beats', { book_id: bookId, act_id: act.id, titel: 'Aktionen-Beat' });
    return { actId: act.id, beatId: beat.id };
  }, bookId);

  // Die App-Suite teilt EINEN Seed-Stand: der Akt fällt am Ende wieder weg (seine
  // Beats per CASCADE), sonst schiebt er spätere Board-Specs (plot-dnd) aus dem Bild.
  try {
    await page.evaluate(() => window.__app.togglePlotCard());
    const card = page.locator(`.card--plot .plot-board .plot-beat[data-beat-id="${ids.beatId}"]`);
    await expect(card).toBeVisible();
    const actions = card.locator('.plot-beat-actions');

    // Zeiger weg von der Karte → Aktionen unsichtbar (Platz bleibt, opacity 0).
    await page.mouse.move(0, 0);
    await expect(actions).toHaveCSS('opacity', '0');

    await card.locator('.plot-beat-title').hover();
    await expect(actions).toHaveCSS('opacity', '1');
    await expect(actions.getByRole('button')).toHaveCount(2);
  } finally {
    await page.evaluate((id) => fetch(`/plot/acts/${id}`, { method: 'DELETE' }), ids.actId);
  }
});
