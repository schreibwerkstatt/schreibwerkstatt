// Strang-Bearbeiten in der Plot-Werkstatt: dieselbe Tastaturbelegung wie der
// Beat-Edit (public/CLAUDE.md «Edit-Formulare») — Esc verwirft, Ctrl+S speichert
// und schliesst, Klick daneben speichert. Gegen die echte App, weil `$editKeys`
// eine Magic der gebooteten Root ist und das Swimlane-Grid erst mit einem Strang
// erscheint.
const { test, expect } = require('../e2e/_helpers/fixtures');

test('plot: Strang-Edit — Esc verwirft, Ctrl+S und Klick daneben speichern', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__app && window.Alpine.store('nav').selectedBookId);
  const bookId = await page.evaluate(() => window.Alpine.store('nav').selectedBookId);

  const ids = await page.evaluate(async (bookId) => {
    const post = (url, body) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json());
    const act = await post('/plot/acts', { book_id: bookId, name: 'Tasten-Akt' });
    const thread = await post('/plot/threads', { book_id: bookId, name: 'Tasten-Strang' });
    return { actId: act.id, threadId: thread.id };
  }, bookId);
  const serverName = () => page.evaluate(async ({ b, id }) => {
    const r = await fetch(`/plot?book_id=${b}`).then(x => x.json());
    return (r.threads || []).find(t => t.id === id)?.name;
  }, { b: bookId, id: ids.threadId });

  // Geteilter Seed-Stand der App-Suite: Akt und Strang fallen am Ende wieder weg.
  try {
    await page.evaluate(() => window.__app.togglePlotCard());
    const laneName = page.locator('.card--plot .plot-swim-lane-name', { hasText: 'Tasten-Strang' });
    await expect(laneName).toBeVisible();
    const input = page.locator('.card--plot .plot-swim-lane-edit .plot-thread-name-input');
    const openEdit = async () => {
      await page.locator('.card--plot .plot-swim-lane-name', { hasText: /Tasten-Strang/ }).dblclick();
      await input.click();
    };

    await openEdit();
    await input.fill('verworfen');
    await page.keyboard.press('Escape');
    await expect(input).toHaveCount(0);
    expect(await serverName()).toBe('Tasten-Strang');

    await openEdit();
    await input.fill('Tasten-Strang B');
    await page.keyboard.press('Control+s');
    await expect(input).toHaveCount(0);
    await expect.poll(serverName).toBe('Tasten-Strang B');

    await openEdit();
    await input.fill('Tasten-Strang C');
    await page.locator('.card--plot .card-header').first().click({ position: { x: 5, y: 5 } });
    await expect(input).toHaveCount(0);
    await expect.poll(serverName).toBe('Tasten-Strang C');
  } finally {
    await page.evaluate(async (ids) => {
      await fetch(`/plot/threads/${ids.threadId}`, { method: 'DELETE' });
      await fetch(`/plot/acts/${ids.actId}`, { method: 'DELETE' });
    }, ids);
  }
});
