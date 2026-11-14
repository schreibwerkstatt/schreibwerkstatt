// Tabellenansichten der Werkstätten tragen dasselbe Aktionsmenü wie ihre Liste
// (DESIGN.md «Werkstatt-Bedienvertrag»): Szenen-Raster, Schauplatz-Raster und
// Motiv-Gliederung. Geprüft gegen die echte App, weil nur dort Teleport-Ziel,
// Menü-Instanz der Karte und der Zeilen-Scope (`row.s`, `o`, `it.m`) zusammen-
// kommen: Rechtsklick auf die Zeile und der ⋯-Knopf öffnen je das Menü mit
// Einträgen für genau diese Zeile, Esc schliesst es — ohne Konsolenfehler.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test.describe.configure({ mode: 'serial' });

const MENU = '.context-menu[x-ref="actionMenu"]:visible';

async function expectMenuFor(page, row, actionKey) {
  const menu = page.locator(MENU);
  await row.click({ button: 'right' });
  await expect(menu).toHaveCount(1);
  await expect(menu.locator('.context-menu-item').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  const dots = row.locator('button[aria-haspopup="menu"]').last();
  await row.hover();
  await dots.click();
  await expect(menu).toHaveCount(1);
  await expect(dots).toHaveAttribute('aria-expanded', 'true');
  expect(await page.evaluate((k) => {
    const open = [...document.querySelectorAll('[x-data]')].map((el) => window.Alpine.$data(el))
      .find((d) => d && typeof d.isActionMenuOpen === 'function' && d.isActionMenuOpen(k));
    return !!open;
  }, actionKey), `Menü gehört zur Zeile ${actionKey}`).toBe(true);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
}

test('Szenen-Raster: Zeile hat das Aktionsmenü', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const ch = await page.evaluate(() => window.Alpine.store('nav').tree
    .find(i => i.type === 'chapter' && (i.pages || []).length));
  await page.route(`**/figures/scenes/${bookId}`, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ updated_at: '2026-10-01T10:00:00Z', szenen: [
      { id: 41, chapter_id: ch.id, kapitel: ch.name, page_id: ch.pages[0].id, seite: 'S1', titel: 'Raster-Szene', wertung: 'stark', kommentar: '', fig_ids: [], ort_ids: [] },
    ] }),
  }));
  await page.evaluate(() => window.__app.toggleSzenenCard());
  const card = page.locator('.card--szenen');
  await expect(card.locator('.entity-row').first()).toBeVisible({ timeout: 20000 });
  await page.evaluate(() => { window.Alpine.$data(document.querySelector('.card--szenen')).viewMode = 'grid'; });

  const row = card.locator('.entity-grid-table tbody tr', { hasText: 'Raster-Szene' });
  await expect(row).toBeVisible();
  await expectMenuFor(page, row, 'szene:41');
  guard.assertClean('Szenen-Raster Aktionsmenü');
});

test('Schauplatz-Raster: Zeile hat das Aktionsmenü', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(() => window.__app.toggleOrteCard());
  const card = page.locator('.card--orte');
  await expect(card).toBeVisible();
  await page.evaluate(() => {
    window.Alpine.store('catalog').orte = [{ id: 'ort_raster', name: 'Raster-Ort', typ: 'stadt', kapitel: [], figuren: [] }];
    window.Alpine.$data(document.querySelector('.card--orte')).viewMode = 'grid';
  });

  const row = card.locator('.entity-grid-table tbody tr', { hasText: 'Raster-Ort' });
  await expect(row).toBeVisible();
  await expectMenuFor(page, row, 'ort:ort_raster');
  guard.assertClean('Schauplatz-Raster Aktionsmenü');
});

test('Motiv-Gliederung: Motiv- und Themenzeile haben das Aktionsmenü', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(() => window.__app.toggleMotivCard());
  await page.waitForFunction(() => {
    const el = document.querySelector('.card--motiv');
    const c = el && window.Alpine.$data(el);
    return c && !c.loading;
  }, null, { timeout: 15000 });

  const ids = await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--motiv'));
    card.newThemeName = `Menü-Thema ${Date.now()}`;
    await card.addTheme();
    const theme = card.themes.find(t => t.name === card.themes[card.themes.length - 1].name);
    card.newMotifName = `Menü-Motiv ${Date.now()}`;
    await card.addMotif();
    const motifId = card.selectedMotifId;
    await card.selectMotif(null);
    card.setMotivView('outline');
    return { motifId, themeId: theme.id, themeName: theme.name };
  });

  const table = page.locator('.motiv-outline-table');
  await expect(table).toBeVisible();
  const motifRow = table.locator('.motiv-outline-row', { hasText: 'Menü-Motiv' }).first();
  await expectMenuFor(page, motifRow, `motivtree:m${ids.motifId}`);
  const themeRow = table.locator('.motiv-outline-group', { hasText: ids.themeName });
  await expectMenuFor(page, themeRow, `motivtree:t${ids.themeId}`);
  guard.assertClean('Motiv-Gliederung Aktionsmenü');
});
