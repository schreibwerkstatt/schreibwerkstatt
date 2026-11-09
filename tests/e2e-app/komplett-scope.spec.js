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

test('Prognose zeigt, wie viel Text neu gelesen wird — ohne Preis', async ({ page }) => {
  // Antwort gestellt: ein echter Vorlauf bräuchte einen KI-Provider. Geprüft wird die
  // Darstellung (Plural, Versions-Hinweis, «Neu erstellen» schaltet auf «alles»).
  const delta = (extract) => ({
    lastRun: { endedAt: '2026-11-07T22:00:00.000Z', tokens: 1000, usd: 31.4 },
    totalChars: 1000000, changedChars: 0, added: 0, removed: 0, changedPages: 0,
    newPages: 0, deletedPages: 0, chapterCount: 0, topChapters: [], novelNames: [],
    affectedFigures: { count: 0, list: [] }, approx: false,
    verdict: { level: 'skip' }, extract,
  });
  let extract = { mode: 'multi', total: 7, cached: 5, chunks: [], versionChanged: false };
  await page.route('**/jobs/komplett-delta/**', route => route.fulfill({ json: delta(extract) }));

  await page.evaluate(() => window.__app.alleAktualisieren());
  const dialog = page.locator('dialog.komplett-scope-dialog');
  const box = dialog.locator('.komplett-delta');
  const line = box.locator('.komplett-delta-line', { hasText: /Kapitel|chapter/ });
  await expect(line).toHaveText(/2 Kapitel werden neu gelesen|2 chapters will be re-read/);
  // Kein Preis in der Prognose (die Kostenangabe beim letzten Lauf sehen nur Admins).
  await expect(line).not.toContainText('$');

  // «Neu erstellen» leert den Cache → alles.
  await dialog.locator('.komplett-scope-group--force .toggle-switch__btn').click();
  await expect(box).toContainText(/alle 7 Kapitel|all 7 chapters/);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  extract = { mode: 'multi', total: 7, cached: 0, chunks: [], versionChanged: true };
  await page.evaluate(() => window.__app.alleAktualisieren());
  await expect(box).toContainText(/alle 7 Kapitel|all 7 chapters/);
  await expect(box).toContainText(/Analyse-Vorgaben|analysis settings/);
  await page.keyboard.press('Escape');
});
