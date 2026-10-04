// Szenen-Karte gegen die ECHTE App (siehe playwright.app.config.js).
//
// Warum eine eigene Spec neben dem Smoke: das Dev-Seed-Buch hat keine Szenen —
// der Smoke oeffnet die Karte, aber Verteilung, Liste und Grid haengen an
// `x-show`/`x-for` ueber leeren Arrays und laufen dort nie durch den
// Template-Baum. Hier liefert eine Route-Interception den Szenen-Katalog mit
// den echten Kapitel-/Seiten-IDs des Seeds; geprueft werden die Aussagen, die
// nur am gerenderten DOM stehen: Textreihenfolge statt Titel-Alphabet, Zaehler
// ohne stale-Szenen, Verteilung als Filter-Umschalter, Grid-Sortierung nach
// Buchposition, Sammel-Loeschen der stale-Szenen.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test.describe.configure({ mode: 'serial' });

const json = (body) => (route) => route.fulfill({
  status: 200, contentType: 'application/json', body: JSON.stringify(body),
});

// Reihenfolge im Array = sort_order des Servers = Abfolge im Text.
function mockSzenen(ch1, ch2) {
  const p1 = ch1.pageIds[0];
  const p2 = ch2.pageIds[0];
  return [
    // Kapitel 2 zuerst im Array: die Karte muss nach Buchposition sortieren.
    { id: 31, chapter_id: ch2.id, kapitel: ch2.name, page_id: p2, seite: 'S2', titel: 'Heimkehr', wertung: 'schwach', kommentar: 'Kein Konflikt.', fig_ids: [], ort_ids: [] },
    // Gleiche Seite: «Zebra» steht im Text VOR «Ankunft».
    { id: 11, chapter_id: ch1.id, kapitel: ch1.name, page_id: p1, seite: 'S1', titel: 'Zebra', wertung: 'stark', kommentar: 'Traegt das Tempo.', fig_ids: [], ort_ids: [] },
    { id: 12, chapter_id: ch1.id, kapitel: ch1.name, page_id: p1, seite: 'S1', titel: 'Ankunft', wertung: 'mittel', kommentar: 'Der Dialog zieht sich.', fig_ids: [], ort_ids: [] },
    { id: 99, chapter_id: ch1.id, kapitel: ch1.name, page_id: p1, seite: 'S1', titel: 'Verschwunden', wertung: 'stark', kommentar: '', fig_ids: [], ort_ids: [], stale: true },
  ];
}

async function openWithScenes(page) {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const chapters = await page.evaluate(() =>
    window.Alpine.store('nav').tree
      .filter(i => i.type === 'chapter' && !i.solo && (i.pages || []).length)
      .map(i => ({ id: i.id, name: i.name, pageIds: i.pages.map(p => p.id) })));
  expect(chapters.length, 'Seed-Buch braucht >= 2 Kapitel mit Seiten').toBeGreaterThanOrEqual(2);
  const [ch1, ch2] = chapters;
  await page.route(`**/figures/scenes/${bookId}`, json({ szenen: mockSzenen(ch1, ch2), updated_at: '2026-10-01T10:00:00Z' }));
  await page.evaluate(() => window.__app.toggleSzenenCard());
  const card = page.locator('.card--szenen');
  await expect(card.locator('.entity-row').first()).toBeVisible({ timeout: 20000 });
  return { card, bookId, ch1, ch2 };
}

const titles = (card) => card.locator('.entity-list .entity-row .entity-row-title').allTextContents();

test('Szenen-Liste: Buchreihenfolge, Zaehler ohne stale, Verteilung filtert', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  const { card } = await openWithScenes(page);

  // Kapitel → Seite → Textreihenfolge; stale steht mit in der Liste.
  expect(await titles(card)).toEqual(['Zebra', 'Ankunft', 'Verschwunden', 'Heimkehr']);
  // Anriss des Kommentars in der Zeile.
  await expect(card.locator('.entity-row', { hasText: 'Ankunft' }).locator('.szenen-row-snippet'))
    .toHaveText('Der Dialog zieht sich.');

  // «Alle» zaehlt nur Szenen im Text; die stale-Szene hat eine eigene Zeile.
  const tabs = card.locator('.filter-bar .tabs-btn');
  await expect(tabs.first().locator('.tabs-btn-count')).toHaveText('3');
  await expect(card.locator('.szenen-stale-row')).toBeVisible();

  // Suche trifft auch den Kommentar.
  await card.locator('.filter-search-input').fill('dialog');
  expect(await titles(card)).toEqual(['Ankunft']);
  await card.locator('.filter-search-input').fill('');

  // Verteilung: Kapitel-Balken ist ein Filter-Umschalter.
  await card.locator('.szenen-uebersicht .collapsible-toggle').click();
  const bars = card.locator('.szenen-kapitel-bar-row');
  await expect(bars).toHaveCount(2);
  await expect(bars.first().locator('.szenen-kapitel-total')).toHaveText('2');
  await bars.nth(1).click();
  await expect(bars.nth(1)).toHaveAttribute('aria-pressed', 'true');
  expect(await titles(card)).toEqual(['Heimkehr']);
  await bars.nth(1).click();
  await expect(bars.nth(1)).toHaveAttribute('aria-pressed', 'false');
  await expect(card.locator('.entity-list .entity-row')).toHaveCount(4);

  guard.assertClean('Szenen-Karte: Liste');
});

test('Szenen-Grid: Kapitel nach Buchposition, Wertung nach Rang', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  const { card } = await openWithScenes(page);
  await page.evaluate(() => { try { localStorage.removeItem('sortableTable.szenen.grid'); } catch (_) {} });

  await card.locator('.entity-view-toggle .tabs-btn').nth(1).click();
  const grid = card.locator('.entity-grid-table');
  await expect(grid).toBeVisible();
  const gridTitles = () => grid.locator('tbody .entity-grid-cell-title > span:first-child').allTextContents();

  expect(await gridTitles()).toEqual(['Zebra', 'Ankunft', 'Verschwunden', 'Heimkehr']);
  await grid.locator('th.sortable-th').first().click(); // Wertung aufsteigend = stark zuerst
  const first = await gridTitles();
  expect(first.slice(0, 2).sort()).toEqual(['Verschwunden', 'Zebra']);
  expect(first[first.length - 1]).toBe('Heimkehr');

  guard.assertClean('Szenen-Karte: Grid');
});

test('Szenen: stale-Szenen gesammelt loeschen', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  const { card, bookId } = await openWithScenes(page);
  let deleted = false;
  await page.route(`**/figures/scenes/${bookId}/stale`, (route) => {
    deleted = route.request().method() === 'DELETE';
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, deleted: { scenes: 1 } }) });
  });

  await card.locator('.szenen-stale-row button').click();
  await page.locator('#app-confirm-dialog .confirm-dialog-btn--danger').click();
  await expect(card.locator('.szenen-stale-row')).toBeHidden();
  await expect(card.locator('.entity-list .entity-row')).toHaveCount(3);
  expect(deleted).toBe(true);

  guard.assertClean('Szenen-Karte: Sammel-Loeschen');
});
