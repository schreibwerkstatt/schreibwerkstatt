// Admin-Einstellungen + Admin-Benutzer gegen die ECHTE App:
// - Zustandszeile je Feld (ungespeichert → geändert → wird zurückgesetzt) und
//   Sammel-Speichern über PUT /admin/settings; ein leeres Zahlenfeld heisst
//   «Standard», nicht 0.
// - Eigene Zeile der Benutzertabelle: Rolle und Sperren gesperrt.
// Hängt am echten Alpine-Baum (settingField im Scope der Karte, tabs()-Panels).

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp } = require('./_helpers/app');

const KEY = 'auth.registration.expire_days';

async function cardData(page, expr, arg) {
  return page.evaluate(expr, arg);
}

test('Einstellungen: Feldzustand, Sammel-Speichern, Zurücksetzen auf Standard', async ({ page }) => {
  await bootApp(page);
  await page.evaluate(async () => { await window.__app.toggleAdminSettingsCard(); });
  const card = page.locator('[x-show="$app.showAdminSettingsCard"]').first();
  await expect(card).toBeVisible();
  const field = card.locator('.setting-field').filter({ hasText: KEY }).first();
  await expect(field).toBeVisible();
  const state = field.locator('.setting-field__state');

  // Ausgangslage: Standard (DB-Zeile weg), keine Zustandszeile.
  await page.evaluate(async (k) => { await fetch('/admin/settings/' + k, { method: 'DELETE' }); }, KEY);
  await cardData(page, () => window.Alpine.$data(document.querySelector('[x-data="adminSettingsCard"]')).adminSettingsLoad());
  await expect(state).toBeHidden();

  // Ändern → «ungespeichert».
  const def = await cardData(page, (k) => window.Alpine.$data(document.querySelector('[x-data="adminSettingsCard"]')).adminSettingsMap[k].default, KEY);
  await cardData(page, ([k, v]) => { window.Alpine.$data(document.querySelector('[x-data="adminSettingsCard"]')).adminSettingsForm[k] = v; }, [KEY, def + 7]);
  await expect(state).toHaveText(/ungespeichert|unsaved/);

  // Speichern (ein Request) → «geändert» + Zurücksetzen-Knopf.
  const puts = [];
  page.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes('/admin/settings')) puts.push(r.url()); });
  await cardData(page, () => window.Alpine.$data(document.querySelector('[x-data="adminSettingsCard"]')).adminSettingsSave());
  expect(puts.length).toBe(1);
  expect(puts[0]).toMatch(/\/admin\/settings$/);
  await expect(state).toHaveText(/geändert|changed/);
  const reset = field.locator('.setting-field__reset');
  await expect(reset).toBeVisible();

  // Leeres Zahlenfeld = Standard (nicht 0).
  await cardData(page, (k) => { window.Alpine.$data(document.querySelector('[x-data="adminSettingsCard"]')).adminSettingsForm[k] = null; }, KEY);
  await expect(state).toHaveText(/zurückgesetzt|reset/);
  await cardData(page, ([k, v]) => { window.Alpine.$data(document.querySelector('[x-data="adminSettingsCard"]')).adminSettingsForm[k] = v; }, [KEY, def + 7]);

  // Zurücksetzen-Knopf → markiert, Speichern löscht die DB-Zeile.
  await reset.click();
  await expect(state).toHaveText(/zurückgesetzt|reset/);
  await cardData(page, () => window.Alpine.$data(document.querySelector('[x-data="adminSettingsCard"]')).adminSettingsSave());
  const after = await page.evaluate(async (k) => (await (await fetch('/admin/settings/' + k)).json()).setting, KEY);
  expect(after.isDefault).toBe(true);
  expect(after.value).toBe(def);
  await expect(state).toBeHidden();
});

test('Benutzer: eigene Zeile — Rolle und Sperren gesperrt', async ({ page }) => {
  await bootApp(page);
  await page.evaluate(async () => { await window.__app.toggleAdminUsersCard(); });
  const card = page.locator('[x-show="$app.showAdminUsersCard"]').first();
  await expect(card).toBeVisible();
  const me = await page.evaluate(() => window.Alpine.store('session').currentUser.email);
  const row = card.locator('.admin-users-table tbody tr').filter({ hasText: me }).first();
  await expect(row).toBeVisible();
  await expect(row.locator('.combobox-wrap').first()).toHaveClass(/combobox-wrap--disabled/);
  await expect(row.locator('.admin-users-actions button', { hasText: /Sperren|Suspend/ })).toBeDisabled();
  await expect(row.locator('.admin-users-actions button.danger', { hasText: /Löschen|Delete/ })).toBeHidden();
});
