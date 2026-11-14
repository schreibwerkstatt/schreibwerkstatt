// Recherche-Board, Filter „nach Verknüpfung" — gegen die ECHTE App.
// Regression: der Ziel-Picker (entityPicker) koppelt über x-modelable, und das
// synct asynchron (Effect-Flush) — im combobox-change-Handler stand noch der
// alte Wert. Vom Kapitel-Indikator gefiltert, liess „Alle Einträge" den Filter
// deshalb unverändert stehen; eine konkrete Auswahl griff erst einen Schritt später.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('recherche: vom Kapitel gefiltert, „Alle Einträge" hebt den Filter auf', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  const made = await page.evaluate(async (id) => {
    const chapterId = window.Alpine.store('nav').tree.find(n => n.type === 'chapter' && !n.solo)?.id;
    const post = (url, payload) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.json());
    const linked = await post('/research', { book_id: id, kind: 'fact', title: 'Am Kapitel' });
    const other = await post('/research', { book_id: id, kind: 'fact', title: 'Ohne Kapitel' });
    await post(`/research/${linked.id}/links`, { target_kind: 'chapter', target_id: chapterId });
    return { chapterId, linked: linked.id, other: other.id };
  }, bookId);
  expect(made.chapterId).toBeTruthy();

  await page.evaluate((cid) => window.__app.openRechercheForChapter(cid), made.chapterId);
  const card = page.locator('#recherche-card');
  const row = (id) => card.locator(`.recherche-list [data-research-id="${id}"]`);
  await expect(row(made.linked)).toBeVisible();
  await expect(row(made.other)).toHaveCount(0);

  // Ziel-Picker (zweite Combobox der Verknüpfungs-Gruppe) → „Alle Einträge".
  const picker = card.locator('.filter-bar [x-data^="entityPicker"]');
  await picker.locator('.combobox-trigger, button').first().click();
  await page.locator('.combobox-option', { hasText: 'Alle Einträge' }).first().click();

  await expect(row(made.other)).toBeVisible();
  await expect(row(made.linked)).toBeVisible();
});

// Gleiche Kopplung in der Mehrfachauswahl: die erste Status-Wahl muss sofort
// wirken, nicht erst mit der nächsten.
test('recherche: Status in der Mehrfachauswahl wirkt mit der ersten Wahl', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const id = await page.evaluate(async (bid) => {
    const r = await fetch('/research', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: bid, kind: 'fact', title: 'Bulk-Status' }),
    }).then(x => x.json());
    return r.id;
  }, bookId);

  await page.evaluate((bid) => { location.hash = `#book/${bid}/recherche`; }, bookId);
  const card = page.locator('#recherche-card');
  const row = card.locator(`.recherche-list [data-research-id="${id}"]`);
  await expect(row).toBeVisible();
  await row.locator('.research-item-select').check();

  const bar = page.locator('#recherche-card .selection-bar');
  await bar.locator('[x-data^="combobox"]').first().locator('button').first().click();
  await page.locator('.combobox-option', { hasText: 'Eingearbeitet' }).first().click();

  await expect.poll(() => page.evaluate(async (args) => {
    const rows = await fetch(`/research?book_id=${args.bid}`).then(r => r.json());
    return rows.find(r => r.id === args.id)?.status;
  }, { bid: bookId, id })).toBe('eingearbeitet');
});
