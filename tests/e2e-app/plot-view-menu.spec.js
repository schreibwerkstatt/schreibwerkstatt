// Ansichts-Menue der Plot-Filterleiste (plot-view-menu.html): die drei
// Schalter des Arbeitsmodus stehen in einem Menue statt als Haken in der
// Leiste. Gegen die echte App, weil `menu()` und die per User persistierten
// Schalter erst in der gebooteten Karte zusammenspielen.
const { test, expect } = require('../e2e/_helpers/fixtures');

test('plot: Ansichts-Menue schaltet, bleibt dabei offen und zaehlt Abweichungen am Knopf', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__app && window.Alpine.store('nav').selectedBookId);
  const bookId = await page.evaluate(() => window.Alpine.store('nav').selectedBookId);

  const ids = await page.evaluate(async (bookId) => {
    const post = (url, body) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json());
    const act = await post('/plot/acts', { book_id: bookId, name: 'Ansichts-Akt' });
    const beat = await post('/plot/beats', { book_id: bookId, act_id: act.id, titel: 'Ansichts-Beat' });
    return { actId: act.id, beatId: beat.id };
  }, bookId);

  // Geteilter Seed-Stand der App-Suite: Akt samt Beat fallen am Ende wieder weg,
  // die Schalter gehen auf die Grundansicht zurueck (per User persistiert).
  try {
    await page.evaluate(() => window.__app.togglePlotCard());
    const card = page.locator('.card--plot');
    const toggle = card.locator('.plot-view-toggle');
    const panel = card.locator('.plot-view-menu-panel');
    const item = (label) => panel.locator('[role="menuitemcheckbox"]', { hasText: label });
    await expect(toggle).toBeVisible();
    // Die Haken stehen nicht mehr einzeln in der Leiste.
    await expect(card.locator('.filter-bar .filter-toggle')).toHaveCount(0);
    await expect(toggle.locator('.btn-count')).toBeHidden();

    await toggle.click();
    await expect(panel).toBeVisible();
    // Ohne archivierte Akte bietet das Menue das Archiv nicht an.
    await expect(item('Archiv')).toBeHidden();

    await item('Nur Titel').click();
    await expect(item('Nur Titel')).toHaveAttribute('aria-checked', 'true');
    await expect(card).toHaveClass(/plot--compact/);
    // Schalter halten das Menue offen — der naechste ist einen Klick entfernt.
    await expect(panel).toBeVisible();
    await item('ausblenden').click();
    await expect(item('ausblenden')).toHaveAttribute('aria-checked', 'true');
    await expect(toggle.locator('.btn-count')).toHaveText('2');

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    // Geschlossen sagt die Zahl am Knopf, dass die Ansicht abweicht.
    await expect(toggle.locator('.btn-count')).toHaveText('2');
  } finally {
    await page.evaluate(async (ids) => {
      const plot = window.Alpine.$data(document.querySelector('.card--plot'));
      plot.setPlotDensity(false);
      plot.plotHideImBuch = false;
      await fetch(`/plot/beats/${ids.beatId}`, { method: 'DELETE' });
      await fetch(`/plot/acts/${ids.actId}`, { method: 'DELETE' });
    }, ids);
  }
});
