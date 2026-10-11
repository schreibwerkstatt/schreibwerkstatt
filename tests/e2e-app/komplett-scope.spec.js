// Lauf-Umfang-Modal der Komplettanalyse gegen die ECHTE App.
//
// Warum diese Schicht: der Dialog haengt an drei Dingen, die ein Unit-Test nicht
// zusammen sieht — dem `modal()`-Primitiv (natives <dialog> + showModal), dem
// `toggleSwitch`-Primitiv pro Schritt (x-modelable auf einen dynamischen
// Schluessel in `komplettScope`) und der Vorbelegung aus dem Server. Faellt eine
// dieser Kopplungen aus, rendert der Dialog leer oder ein Schalter bewegt nichts
// — beides sieht im Unit-Test wie ein Erfolg aus.
//
// Der Lauf selbst wird NICHT gestartet: ein echter Komplettanalyse-Job braucht
// einen KI-Provider. Geprueft wird bis zum Startknopf.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
});

test('Modal fragt den Umfang, der Schalter wirkt, der Startknopf zaehlt mit', async ({ page }) => {
  await page.evaluate(() => window.__app.alleAktualisieren());

  const dialog = page.locator('dialog.komplett-scope-dialog');
  await expect(dialog).toBeVisible();
  // Kern-Schritte stehen als Inventar drin — ohne Schalter.
  await expect(dialog.locator('.komplett-scope-core-item')).not.toHaveCount(0);
  const switches = dialog.locator('.toggle-switch__btn');
  const switchCount = await switches.count();
  expect(switchCount).toBeGreaterThan(1); // Schritte + «neu erstellen»

  // Vorbelegung: ohne frueheren Lauf laeuft alles.
  const before = await page.evaluate(() => window.__app.komplettScopeCount());
  expect(before.on).toBe(before.total);
  const startBtn = dialog.locator('.confirm-dialog-btn--primary');
  const fullLabel = (await startBtn.textContent()).trim();

  // Ein Schritt abgewaehlt: der State folgt dem Klick UND der Startknopf beschriftet sich um.
  await dialog.locator('.komplett-scope-step').first().locator('.toggle-switch__btn').click();
  await expect.poll(async () => (await page.evaluate(() => window.__app.komplettScopeCount())).on)
    .toBe(before.total - 1);
  await expect(startBtn).not.toHaveText(fullLabel);

  // Voreinstellung «Alles» stellt wieder her.
  await dialog.getByRole('button', { name: /Alles|Everything/ }).click();
  await expect.poll(async () => (await page.evaluate(() => window.__app.komplettScopeCount())).on)
    .toBe(before.total);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('Kein Schritt gewaehlt → der Lauf laesst sich nicht starten', async ({ page }) => {
  await page.evaluate(() => window.__app.alleAktualisieren());
  const dialog = page.locator('dialog.komplett-scope-dialog');
  await expect(dialog).toBeVisible();

  await page.evaluate(() => {
    for (const k of Object.keys(window.__app.komplettScope)) window.__app.komplettScope[k] = false;
  });
  await expect(dialog.locator('.confirm-dialog-btn--primary')).toBeDisabled();

  // Zustand fuer nachfolgende Specs zuruecksetzen (geteilte smoke.db/Session).
  await page.evaluate(() => { window.__app.setKomplettScopePreset('all'); window.__app.komplettScopeOpen = false; });
});

test('Indikation «Lohnt sich ein Lauf?» rendert die Empfehlung', async ({ page }) => {
  await page.evaluate(() => window.__app.alleAktualisieren());
  const dialog = page.locator('dialog.komplett-scope-dialog');
  await expect(dialog).toBeVisible();
  // Seed-Buch ohne abgeschlossenen Lauf → Stufe «never», der Hinweis steht sichtbar drin.
  const box = dialog.locator('.komplett-delta');
  await expect(box).toHaveClass(/komplett-delta--never/);
  await expect(box.locator('.komplett-delta-verdict')).toHaveText(/Noch nie analysiert|Never analysed/);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
