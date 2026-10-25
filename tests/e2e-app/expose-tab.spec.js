// Exposé-Reiter der Bucheinstellungen gegen die ECHTE App (volles CSS, echte
// Template-Kette). Der Lauf selbst ist gestubbt (GET /expose/:book) — der Job
// ist im Integrationstest abgedeckt (tests/integration/expose.test.js). Hier:
// Reiter erscheint, Eckdaten kommen live aus dem Formular, Bearbeiten macht den
// Stand «offen» (Word-Download erst nach Speichern), «übernehmen» füllt das
// Klappentext-Feld des Buchs — dieselbe Spalte wie im Reiter Publikation.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const RUN = {
  id: 9001, profil: 'narrativ', basis: 'single', model: 'mock',
  result: {
    logline: 'Anna sucht ihren Bruder.', kurzinhalt: 'Kurz.', synopse: 'Lang.\n\nMit Ende.',
    figuren: [{ fig_id: 'fig_x', text: 'Die Suchende.' }], klappentext: 'Ein Sommer, ein Verschwinden.',
  },
  edited: null, warnungen: [{ key: 'expose.warn.unfertig' }],
  created_at: '2026-10-25T10:00:00.000Z', updated_at: '2026-10-25T10:00:00.000Z',
};

test('Exposé-Reiter: Eckdaten live, Bearbeiten, Klappentext übernehmen', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  await page.route(`**/expose/${bookId}`, (route) => route.fulfill({
    json: { latest: RUN, history: [{ id: RUN.id, profil: 'narrativ', basis: 'single', created_at: RUN.created_at, has_edits: false }], normseiten: 42 },
  }));

  await page.evaluate(() => window.__app.toggleBookSettingsCard());
  const card = page.locator('.card--settings');
  await expect(card).toBeVisible();
  await card.locator('.tabs-btn', { hasText: 'Exposé' }).click();

  const panel = card.locator('[role="tabpanel"]').filter({ has: page.locator('.expose-facts') });
  await expect(panel).toBeVisible();
  await expect(panel.locator('.expose-facts')).toContainText('42');
  const bookName = await card.locator('#book-settings-name, input[x-model="bookSettingsName"]').first().inputValue().catch(() => null);
  if (bookName) await expect(panel.locator('.expose-facts')).toContainText(bookName);
  await expect(panel.locator('.expose-warnings')).toContainText('nicht als fertig markiert');

  await expect(panel.locator('#expose-logline')).toHaveValue('Anna sucht ihren Bruder.');
  await expect(panel.getByRole('link', { name: 'Als Word herunterladen' })).toBeVisible();
  await panel.locator('#expose-logline').fill('Meine Logline');
  await expect(panel.getByText('Für den Word-Download zuerst speichern.')).toBeVisible();

  const buch = panel.locator('#expose-klappentext-buch');
  await buch.fill('');
  await panel.getByRole('button', { name: 'Als Klappentext des Buchs übernehmen' }).click();
  await expect(buch).toHaveValue('Ein Sommer, ein Verschwinden.');
  await expect(panel.getByRole('button', { name: 'Ist der Klappentext des Buchs' })).toBeDisabled();

  // Dieselbe Spalte wie im Reiter Publikation.
  await card.locator('.tabs-btn', { hasText: 'Publikation' }).click();
  await expect(card.locator('#pub-description')).toHaveValue('Ein Sommer, ein Verschwinden.');
});
