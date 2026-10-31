// Bucheinstellungen gegen die ECHTE App: Ungespeichert-Erkennung und Rückfrage
// beim Verlassen (public/js/book/book-settings/save-paths.js).
//  - frisch geladen ist der Kopf-Knopf gesperrt (nichts ungespeichert)
//  - wer mit Ungespeichertem eine andere Karte öffnet, wird gefragt;
//    «Speichern» schreibt den Stand noch auf das Buch, «Verwerfen» nicht
//  - gespeichert werden nur geänderte Pfade (kein /publication-PUT, wenn nur
//    der Buchkontext geändert wurde)
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

async function openContext(page) {
  await page.evaluate(() => window.__app.toggleBookSettingsCard());
  const card = page.locator('.card--book-settings');
  await expect(card).toBeVisible();
  await expect(card.locator('.tabs-btn', { hasText: 'Kontext' })).toBeVisible();
  await card.locator('.tabs-btn', { hasText: 'Kontext' }).click();
  // Pflichtfelder des Wegwerf-Buchs setzen und als Ausgangsstand übernehmen,
  // damit der Pfad «settings» speichern darf.
  await page.evaluate(() => {
    const c = window.Alpine.$data(document.querySelector('.card--book-settings'));
    if (!c.bookSettingsBuchtyp) c.bookSettingsBuchtyp = 'roman';
    if ((c.categoryPool || []).length && !c.bookCategoryId) c.bookCategoryId = String(c.categoryPool[0].id);
    c._markClean('settings');
  });
  return card;
}

test('Ungespeichertes: Rückfrage beim Kartenwechsel, Speichern schreibt nur den geänderten Pfad', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const card = await openContext(page);
  const save = card.locator('.card-header button[data-label-ok]');
  await expect(save).toBeDisabled();

  const marker = `Kontext ${Date.now()}`;
  await card.locator('#bs-buchkontext').fill(marker);
  await expect(save).toBeEnabled();

  const puts = [];
  page.on('request', (r) => { if (r.method() === 'PUT') puts.push(new URL(r.url()).pathname); });

  // Andere Karte öffnen → Bucheinstellungen schliessen → Rückfrage.
  const saved = page.waitForResponse(r => r.url().endsWith(`/booksettings/${bookId}`) && r.request().method() === 'PUT');
  await page.evaluate(() => window.__app.toggleMyStatsCard());
  const dialog = page.locator('#app-confirm-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  expect((await saved).ok()).toBe(true);

  const stored = await page.evaluate(async (id) => (await fetch(`/booksettings/${id}`)).json(), bookId);
  expect(stored.buch_kontext).toBe(marker);
  expect(puts).not.toContain(`/publication/${bookId}`);

  // Aufräumen.
  await page.evaluate(async (id) => {
    await fetch(`/booksettings/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ buch_kontext: null }) });
  }, bookId);
});

test('Ungespeichertes: «Verwerfen» schreibt nichts, Wiederöffnen zeigt den Serverstand', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const card = await openContext(page);
  const before = await page.evaluate(async (id) => (await fetch(`/booksettings/${id}`)).json(), bookId);

  await card.locator('#bs-buchkontext').fill('wird verworfen');
  await page.evaluate(() => window.__app.toggleMyStatsCard());
  const dialog = page.locator('#app-confirm-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Verwerfen' }).click();
  await expect(dialog).toBeHidden();

  const after = await page.evaluate(async (id) => (await fetch(`/booksettings/${id}`)).json(), bookId);
  expect(after.buch_kontext ?? null).toBe(before.buch_kontext ?? null);

  await page.evaluate(() => window.__app.toggleBookSettingsCard());
  await card.locator('.tabs-btn', { hasText: 'Kontext' }).click();
  await expect(card.locator('#bs-buchkontext')).toHaveValue(before.buch_kontext || '');
});
