// Schauplatz-Grid rendert schrittweise (list-window.js, Fenster 'grid'): ein Buch
// mit ~450 Orten blockierte beim Umschalten aufs Grid Sekunden den Main-Thread,
// weil jede Zeile mehrere Entitäts-Referenzen trägt. Geprüft wird gegen die echte
// App: Fenster greift, Sortierung läuft über die ganze Menge (nicht nur das
// Fenster), «Weitere anzeigen» lädt nach.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const CARD = '.card--orte';

test('schauplatz-grid: Fenster, Sortierung über alle Zeilen, nachladen', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(() => { try { localStorage.removeItem('sortableTable.orte.grid'); } catch (_) {} });
  await page.evaluate(() => window.__app.toggleOrteCard());
  const card = page.locator(CARD);
  await expect(card).toBeVisible();

  // Schrittweite aus der Karte selbst (list-window.js#LIST_WINDOW_STEP).
  const STEP = await page.evaluate(() => Alpine.$data(document.querySelector('.card--orte')).listWindowStep);
  const N = STEP + 50;
  await page.evaluate((n) => {
    const pad = (i) => String(i).padStart(3, '0');
    Alpine.store('catalog').orte = Array.from({ length: n }, (_, i) => ({
      id: `ort_${pad(i)}`, name: `Ort ${pad(i)}`, typ: 'stadt', kapitel: [], figuren: [],
    }));
    Alpine.$data(document.querySelector('.card--orte')).viewMode = 'grid';
  }, N);

  const grid = card.locator('.entity-grid-table');
  const rows = grid.locator('tbody tr');
  await expect(rows).toHaveCount(STEP);
  const more = card.locator('.list-window-more:visible');
  await expect(more).toHaveCount(1);

  // Name ist Default-Schlüssel (aufsteigend); ein Klick kehrt um. Die erste Zeile ist der letzte Ort der ganzen Menge, der
  // ausserhalb des ersten Fensters lag.
  const nameTh = grid.locator('th.sortable-th').nth(1);
  await nameTh.click();
  const firstName = grid.locator('tbody tr').first().locator('.entity-grid-cell-title > span:first-child');
  await expect(firstName).toHaveText(`Ort ${String(N - 1).padStart(3, '0')}`);

  // Ohne Scrollen klicken: Playwrights click() scrollt den Knopf ins Bild, dort
  // lädt observeListMore (list-window.js) schon selbst nach und blendet den Fuss
  // aus — der Klick wartete dann auf einen versteckten Knopf (Race, CI-rot).
  await more.evaluate((b) => b.click());
  await expect(rows).toHaveCount(N);
  await expect(card.locator('.list-window-more:visible')).toHaveCount(0);
});
