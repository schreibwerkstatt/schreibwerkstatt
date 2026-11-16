// Vorlage beim Anlegen eines KI-Profils (Provider-Tab, Sub-Tab «Profile») gegen die
// ECHTE App: die Combobox meldet die Wahl per `combobox-change`, das füllt das
// Formular, und Speichern legt das Profil mit genau dieser Belegung an. Host und
// API-Key bleiben leer (= Instanz-Einstellung). Beim Bearbeiten keine Vorlage.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp } = require('./_helpers/app');

const cardData = () => window.Alpine.$data(document.querySelector('[x-data="adminSettingsCard"]'));

test('Profil-Vorlage füllt das Formular, Speichern legt das Profil so an', async ({ page }) => {
  await bootApp(page);
  await page.evaluate(async () => { await window.__app.toggleAdminSettingsCard(); });
  const card = page.locator('[x-show="$app.showAdminSettingsCard"]').first();
  await expect(card).toBeVisible();
  await page.evaluate((fn) => {
    const c = window.Alpine.$data(document.querySelector('[x-data="adminSettingsCard"]'));
    c.adminSettingsTab = 'provider';
    c.adminSettingsProviderSubtab = 'profiles';
  });

  await card.getByRole('button', { name: /Profil anlegen|Create profile|Neues Profil/i }).first().click();
  const form = card.locator('fieldset.admin-profiles-form');
  await expect(form).toBeVisible();

  const row = form.locator('.card-form-row').filter({ hasText: /^\s*(Vorlage|Template)/ }).first();
  await expect(row).toBeVisible();
  await row.locator('.combobox-wrap button, .combobox-wrap [role="combobox"]').first().click();
  await page.getByRole('option', { name: /Qwen 3\.8 27B Thinking/ }).click();

  const f = await page.evaluate(() => {
    const c = window.Alpine.$data(document.querySelector('[x-data="adminSettingsCard"]'));
    return JSON.parse(JSON.stringify(c.adminProfilesForm));
  });
  expect(f).toMatchObject({
    provider: 'openai-compat', model: 'qwen3.8-27b-think', cloud: 'true', think: 'true',
    max_parallel: 2, context_window: 196608, max_tokens_out: 32768, host: '', api_key: '',
  });
  expect(f.name).toContain('Qwen 3.8 27B Thinking');
  expect(f.notes).toMatch(/4000/);

  await form.getByRole('button', { name: /Speichern|Save/ }).first().click();
  await expect(form).toBeHidden();
  const saved = await page.evaluate(async () => {
    const r = await fetch('/admin/ai-profiles');
    return (await r.json()).profiles.find(p => p.model === 'qwen3.8-27b-think');
  });
  expect(saved).toMatchObject({
    provider: 'openai-compat', cloud: true, think: true, max_parallel: 2,
    context_window: 196608, max_tokens_out: 32768, host: null,
  });

  // Bearbeiten: keine Vorlagen-Zeile, ein bestehendes Profil wird nicht überschrieben.
  await page.evaluate((id) => {
    const c = window.Alpine.$data(document.querySelector('[x-data="adminSettingsCard"]'));
    c.adminProfilesEdit(c.adminProfilesList.find(p => p.id === id));
  }, saved.id);
  await expect(form).toBeVisible();
  await expect(row).toBeHidden();
});
