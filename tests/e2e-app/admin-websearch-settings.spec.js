// Websuche-Tab der Admin-Settings gegen die ECHTE App: Tab erreichbar, alle fünf
// Felder mit übersetzten Labels, Auswahl-Optionen aus i18n, und die Probe-Suche
// meldet ohne URL einen Fehler statt still nichts zu tun.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp } = require('./_helpers/app');

test('Websuche-Tab: Felder, Optionen, Probe-Suche ohne URL', async ({ page }) => {
  await bootApp(page);
  await page.evaluate(async () => { await window.__app.toggleAdminSettingsCard(); });
  const card = page.locator('[x-show="$app.showAdminSettingsCard"]').first();
  await expect(card).toBeVisible();

  await card.locator('.admin-settings-tab', { hasText: /^(Websuche|Web search)$/ }).click();
  // Direkt adressiert statt `:visible`: im Moment des Tab-Wechsels ist sonst noch
  // der vorherige Abschnitt sichtbar.
  const section = card.locator(`section[x-show="adminSettingsTab === 'websearch'"]`);
  await expect(section).toBeVisible();
  await expect(section.locator('.setting-field')).toHaveCount(5);

  const labels = await section.locator('.setting-field').allInnerTexts();
  for (const txt of labels) expect(txt).not.toMatch(/admin\.settings\./);

  const values = await page.evaluate(() => {
    const c = window.Alpine.$data(document.querySelector('[x-data="adminSettingsCard"]'));
    return [c.adminSettingsForm['websearch.provider'], c.adminSettingsForm['websearch.claude']];
  });
  expect(values).toEqual(['off', 'anthropic']);

  await section.getByRole('button', { name: /Probe-Suche|Test search/ }).click();
  const result = card.locator('.admin-settings-test-result');
  await expect(result).toBeVisible();
  await expect(result).toContainText('NO_URL');
});
