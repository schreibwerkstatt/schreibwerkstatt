// Recherche-Board, Mehrfachauswahl + Link-Pruefung — gegen die ECHTE App.
// Die Leiste haengt am echten Template-Baum (Auswahl-Modus, x-for-Checkboxen,
// Combobox/entityPicker in der Leiste) und am echten POST /research/bulk; ein
// Alpine-Ausdrucksfehler im Fragment zeigte sich nur hier.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('recherche: Auswählen markiert, Tag ergänzen und Archivieren wirken auf genau die markierten', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  const made = await page.evaluate(async (id) => {
    const post = (payload) => fetch('/research', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: id, ...payload }),
    }).then(r => r.json());
    const a = await post({ kind: 'fact', title: 'Bulk A' });
    const b = await post({ kind: 'fact', title: 'Bulk B' });
    const c = await post({ kind: 'note', title: 'Bulk C bleibt' });
    return { a: a.id, b: b.id, c: c.id };
  }, bookId);

  await page.evaluate((id) => { location.hash = `#book/${id}/recherche`; }, bookId);
  await expect(page.locator('#recherche-card')).toBeVisible();
  const row = (id) => page.locator(`.recherche-list [data-research-id="${id}"]`);
  await expect(row(made.a)).toBeVisible();

  // Ohne Auswahl-Modus keine Checkboxen und keine Leiste.
  await expect(row(made.a).locator('.research-item-select')).toBeHidden();
  await expect(page.locator('#recherche-card .selection-bar')).toBeHidden();

  await page.locator('#recherche-card .card-toolbar button', { hasText: 'Auswählen' }).click();
  await expect(page.locator('#recherche-card .selection-bar')).toBeVisible();
  await row(made.a).locator('.research-item-select').check();
  // Klick auf den Eintrag selbst markiert im Auswahl-Modus, statt den Dialog zu oeffnen.
  await row(made.b).locator('.research-item-text, .research-item-head').first().click({ position: { x: 200, y: 5 } });
  await expect(page.locator('.research-dialog[open]')).toHaveCount(0);
  await expect(page.locator('#recherche-card .selection-bar__all')).toContainText('2');

  await page.locator('#recherche-card .selection-bar .filter-search-input').fill('bulktag');
  await page.locator('#recherche-card .selection-bar button', { hasText: 'Tag ergänzen' }).click();
  await expect.poll(async () => page.evaluate(async (ids) => {
    const rows = await fetch(`/research?book_id=${ids.book}&tag=bulktag`).then(r => r.json());
    return rows.map(r => r.id).sort((x, y) => x - y);
  }, { book: bookId })).toEqual([made.a, made.b].sort((x, y) => x - y));

  // Nach der Aktion ist die Auswahl leer — erneut markieren und archivieren.
  await expect(page.locator('#recherche-card .selection-bar__all')).toContainText('0');
  await row(made.a).locator('.research-item-select').check();
  await row(made.b).locator('.research-item-select').check();
  await page.locator('#recherche-card .selection-bar button', { hasText: 'Archivieren' }).click();
  await expect(row(made.a)).toHaveCount(0);
  await expect(row(made.b)).toHaveCount(0);
  await expect(row(made.c)).toBeVisible();

  // Link-Pruefung und Abgleich stehen in der Toolbar.
  await expect(page.locator('#recherche-card .card-toolbar button', { hasText: 'Links prüfen' })).toBeVisible();
  await expect(page.locator('#recherche-card .card-toolbar button', { hasText: 'Mit Manuskript abgleichen' })).toBeVisible();
});
