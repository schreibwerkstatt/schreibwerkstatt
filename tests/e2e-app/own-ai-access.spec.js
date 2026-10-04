// Eigener KI-Zugang im Profil gegen die ECHTE App: der Abschnitt haengt am
// Admin-Schalter `ai.user_api.enabled`, der Speichern-Fehler kommt lokalisiert
// aus dem Server (SSRF-Guard), ein gespeicherter Key wird nie zurueckgegeben und
// Entfernen raeumt den Zugang wieder ab. Server: routes/me-ai-access.js.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp } = require('./_helpers/app');

async function setEnabled(page, value) {
  const r = await page.request.put('/admin/settings/ai.user_api.enabled', { data: { value } });
  expect(r.ok()).toBeTruthy();
}

async function openProfile(page) {
  await page.evaluate(async () => {
    if (!window.__app.showUserSettingsCard) await window.__app.toggleUserSettingsCard();
  });
  const card = page.locator('[x-data="userSettingsCard"]');
  await expect(card).toBeVisible();
  return card;
}

test.afterEach(async ({ page }) => {
  await page.request.delete('/me/ai-access');
  await setEnabled(page, false);
});

test('Eigener KI-Zugang: Schalter, Host-Guard, Speichern ohne Key-Echo, Entfernen', async ({ page }) => {
  // Schalter vor dem ersten Dokument-Load setzen: `page.request` braucht keine
  // geladene Seite, und ein `goto` vor `bootApp` waere eine zweite Navigation,
  // die die Boot-Fetches der ersten abbricht (Console-Guard).
  await setEnabled(page, false);
  await bootApp(page);
  let card = await openProfile(page);
  const section = card.locator('.card-form-row--ai-access');
  await expect(section).toHaveCount(0);

  await setEnabled(page, true);
  await page.evaluate(() => window.__app.toggleUserSettingsCard());
  card = await openProfile(page);
  await expect(section).toBeVisible();
  await section.locator('.collapsible-toggle').click();

  // OpenAI-kompatibel auf einen internen Host → Server lehnt ab, Meldung lokalisiert.
  await section.getByRole('radio', { name: /OpenAI/ }).click();
  await section.locator('input[type="url"]').fill('http://127.0.0.1:8080');
  await section.locator('input[type="text"]').first().fill('some-model');
  await section.locator('.ai-access-actions button').first().click();
  await expect(section.locator('.card-form-error')).toBeVisible();
  await expect(section.locator('.card-form-error')).not.toHaveText('AI_ACCESS_HOST_BLOCKED');

  // Claude mit Key → gespeichert, Key kommt nicht zurueck, Aktiv-Hinweis steht.
  await section.getByRole('radio', { name: 'Claude' }).click();
  await section.locator('input[type="password"]').fill('sk-ant-e2e-secret');
  await section.locator('.ai-access-actions button').first().click();
  await expect(section.locator('.card-form-saved')).toBeVisible();
  await expect(section.locator('input[type="password"]')).toHaveValue('');
  const got = await (await page.request.get('/me/ai-access')).json();
  expect(got.access.provider).toBe('claude');
  expect(got.access.has_api_key).toBe(true);
  expect(JSON.stringify(got)).not.toContain('sk-ant-e2e-secret');

  page.once('dialog', d => d.accept());
  await section.locator('.ai-access-actions button.danger').click();
  await expect(section.locator('.ai-access-actions button.danger')).toBeHidden();
  const after = await (await page.request.get('/me/ai-access')).json();
  expect(after.access).toBeNull();
});
