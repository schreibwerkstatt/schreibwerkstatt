// Buchreihe (Tab «Reihe» der Bucheinstellungen) und Pflege der Welt-Fakten gegen
// die ECHTE App. Der Smoke rendert beide Oberflächen nur leer; hier laufen die
// Aktionen samt Server-Roundtrip: Reihe anlegen/verlassen, Fakt anlegen, ändern,
// löschen. Die Übernahme aus dem Vorband deckt der Integrationstest ab
// (tests/integration/book-series.test.js) — sie braucht ein zweites Buch.
//
// Das Seed-Buch ist geteilt: jeder Test räumt hinter sich auf (Reihe verlassen,
// Fakt löschen), Namen tragen einen Lauf-Suffix (reuseExistingServer).
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const RUN = String(Date.now()).slice(-6);

test('Reihe: anlegen zeigt Band 1, verlassen räumt die Reihe ab', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const card = page.locator('.card--settings');

  await page.evaluate(() => window.__app.toggleBookSettingsCard());
  await expect(card).toBeVisible();
  await card.locator('.tabs-btn', { hasText: 'Reihe' }).click();

  const name = `Saga ${RUN}`;
  await card.locator('#series-new-name').fill(name);
  await card.getByRole('button', { name: 'Reihe anlegen' }).click();

  const member = card.locator('.series-member--current');
  await expect(member).toContainText('1');
  await expect(card.locator('#series-name')).toHaveValue(name);

  await card.getByRole('button', { name: 'Reihe verlassen' }).click();
  await page.locator('#app-confirm-dialog').getByRole('button', { name: 'Reihe verlassen' }).click();
  await expect(card.locator('#series-new-name')).toBeVisible();
  const state = await page.evaluate(async (id) => (await fetch(`/book-series/${id}`)).json(), bookId);
  expect(state.series).toBeNull();
});

test('Welt-Fakten: anlegen, als gepflegt markiert, ändern, löschen', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const card = page.locator('.card--weltfakten');

  await page.evaluate(() => window.__app.toggleWorldFactsCard());
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Fakt', exact: true }).click();

  const panel = card.locator('.weltfakten-edit-panel');
  await expect(panel).toBeVisible();
  const fakt = `Der Turm hat ${RUN} Stufen`;
  await panel.locator('input[type="text"]').last().fill(`Turm ${RUN}`);
  await panel.locator('textarea').fill(fakt);
  await panel.getByRole('button', { name: 'Speichern' }).click();

  const row = card.locator('.weltfakten-row', { hasText: fakt });
  await expect(row).toBeVisible();
  await expect(row.locator('.weltfakten-manual-tag')).toBeVisible();

  await row.getByRole('button', { name: 'Fakt bearbeiten' }).click();
  const edited = `${fakt} und ein Dach`;
  await card.locator('.weltfakten-edit-panel textarea').fill(edited);
  await card.locator('.weltfakten-edit-panel').getByRole('button', { name: 'Speichern' }).click();
  const rowEdited = card.locator('.weltfakten-row', { hasText: edited });
  await expect(rowEdited).toBeVisible();

  await rowEdited.getByRole('button', { name: 'Löschen' }).click();
  await page.locator('#app-confirm-dialog').getByRole('button', { name: 'Löschen' }).click();
  await expect(rowEdited).toHaveCount(0);
  const left = await page.evaluate(async (id) => (await fetch(`/world-facts/${id}`)).json(), bookId);
  expect(left.fakten.some(f => String(f.fakt).includes(RUN))).toBe(false);
});
