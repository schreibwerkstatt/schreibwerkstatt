// Höhen-Invariante der Compact-Controls: Knopf (.btn-compact), Combobox-Trigger
// und Filter-Suchfeld stehen in derselben Toolbar-Zeile und müssen exakt gleich
// hoch sein (--size-compact-line-height + Padding-Tokens). Auf Touch sind sie,
// die Reiter des Ansichts-Umschalters und die Symbol-Knöpfe der Karte exakt so hoch wie auf dem Desktop —
// DESIGN.md „Touch“: Touch ändert das Verhalten, nicht die Grösse. Hängt am
// echten Shell-CSS, darum hier.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

async function measureRecherche(page) {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const id = await page.evaluate(async (b) => (await fetch('/research', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ book_id: b, kind: 'note', title: 'Höhe', body: 'x' }),
  }).then((r) => r.json())).id, bookId);
  await page.evaluate((b) => { location.hash = `#book/${b}/recherche`; }, bookId);
  const toolbar = page.locator('.card-toolbar:has(.filter-bar)').first();
  await expect(toolbar.locator('.filter-search-input')).toBeVisible();
  const h = (loc) => loc.evaluateAll((els) => els
    .filter((e) => e.getClientRects().length)
    .map((e) => Math.round(e.getBoundingClientRect().height * 10) / 10));
  const res = {
    coarse: await page.evaluate(() => matchMedia('(pointer: coarse)').matches),
    controls: await h(toolbar.locator('.btn-compact, .combobox-trigger, .filter-search-input')),
    tabs: await h(page.locator('.entity-view-toggle .tabs-btn')),
    icons: await h(page.locator('#recherche-card .icon-btn, #recherche-card .btn-card-close')),
  };
  await page.evaluate((i) => fetch(`/research/${i}`, { method: 'DELETE' }), id);
  return res;
}

// Seriell: der Touch-Test vergleicht mit den Höhen des Desktop-Tests. Ein
// zweiter Kontext/Browser taugt nicht als Desktop-Referenz — Chromium meldet
// dort nach einer Touch-Emulation ebenfalls `pointer: coarse`.
test.describe.configure({ mode: 'serial' });
let desk = null;

test('Desktop: Compact-Knopf, Combobox und Suchfeld der Toolbar sind gleich hoch', async ({ page }) => {
  desk = await measureRecherche(page);
  expect(desk.coarse, 'Referenz ohne Touch-Emulation').toBe(false);
  const { controls } = desk;
  expect(controls.length, 'Controls gefunden').toBeGreaterThan(4);
  expect(Math.max(...controls) - Math.min(...controls), `Höhen ${controls.join(', ')}`).toBeLessThan(0.6);
});

test.describe('Touch', () => {
  test.use({ viewport: { width: 1194, height: 834 }, hasTouch: true, isMobile: true });
  test('Touch: Controls und Ansichts-Reiter so hoch wie auf dem Desktop', async ({ page }) => {
    const touch = await measureRecherche(page);
    expect(touch.coarse, 'Emulation = Touch').toBe(true);
    expect(desk, 'Desktop-Referenz gemessen').not.toBeNull();
    expect(touch.tabs.length, 'Reiter gefunden').toBeGreaterThan(1);
    expect(touch.controls, 'Controls').toEqual(desk.controls);
    expect(touch.tabs, 'Reiter').toEqual(desk.tabs);
    expect(touch.icons.length, 'Symbol-Knöpfe gefunden').toBeGreaterThan(0);
    expect(touch.icons, 'Symbol-Knöpfe').toEqual(desk.icons);
  });
});
