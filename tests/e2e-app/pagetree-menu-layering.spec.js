// Ebenen rund um die Desktop-Sidebar: die fixe Job-Queue-Leiste muss über dem
// Pagetree liegen, und das Pagetree-Rechtsklickmenü muss trotzdem über allem
// Inhalt stehen. Beides hängt am Stacking-Context der `position: sticky`-Sidebar
// und am echten Shell-CSS, darum hier und nicht im Fixture-Harness.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('pagetree: Job-Queue-Leiste liegt über der Sidebar, Kontextmenü bleibt bedienbar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await bootApp(page);
  await selectSeededBook(page);

  const item = page.locator('.layout-sidebar .page-item').first();
  await expect(item).toBeVisible();

  // ── Job-Queue-Leiste über dem Tree ────────────────────────────────────────
  // Aufgeklappte Leiste mit vielen Jobs wächst nach oben in den Tree hinein.
  await page.evaluate(() => {
    const jobs = window.Alpine.store('jobs');
    jobs.jobQueueItems = Array.from({ length: 16 }, (_, i) => (
      { id: `fake-${i}`, status: 'running', label: 'jobQueue.label', statusText: 'jobQueue.label', progress: i }));
    jobs.jobQueueExpanded = true;
  });
  const bar = page.locator('.job-queue-bar');
  await expect(bar).toBeVisible();
  const barOnTop = await page.evaluate(() => {
    const side = document.querySelector('.layout-sidebar').getBoundingClientRect();
    const b = document.querySelector('.job-queue-bar').getBoundingClientRect();
    const x = side.left + side.width / 2;
    const y = b.top + 4;
    const hit = document.elementFromPoint(x, y);
    return { overlaps: b.top + 4 < side.bottom, onTop: !!hit && !!hit.closest('.job-queue-bar') };
  });
  expect(barOnTop.overlaps, 'Testaufbau: Leiste ragt in die Sidebar').toBe(true);
  expect(barOnTop.onTop, 'Job-Queue-Leiste verdeckt den Tree, nicht umgekehrt').toBe(true);
  await page.evaluate(() => { const jobs = window.Alpine.store('jobs'); jobs.jobQueueItems = []; jobs.jobQueueExpanded = false; });

  // ── Kontextmenü: am <body>, ganz sichtbar, letzter Eintrag trifft ─────────
  await item.click({ button: 'right' });
  const menu = page.locator('.pagetree-context-menu');
  await expect(menu).toBeVisible();
  const res = await menu.evaluate((el) => {
    const items = [...el.querySelectorAll('.context-menu-item')].filter(i => i.offsetParent !== null);
    const last = items[items.length - 1];
    const r = last.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      outsideSidebar: !el.closest('.layout-sidebar'),
      hitInside: !!hit && last.contains(hit),
    };
  });
  expect(res.outsideSidebar, 'Menü hängt nicht im Stacking-Context der Sidebar').toBe(true);
  expect(res.hitInside, 'letzter Menüeintrag ist nicht verdeckt').toBe(true);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});
