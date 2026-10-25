// Klick auf eine Job-Pill im Footer (navigateToJob) gegen die ECHTE App: Ziele,
// deren Reiter bzw. Session die Karte selbst hält, laufen über
// cards/card-request.js — die Karte ist beim Sprung oft noch nicht gemountet.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('Exposé-Job öffnet die Bucheinstellungen auf dem Reiter Exposé', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  await page.evaluate((id) => window.__app.navigateToJob({ type: 'expose', bookId: id }), bookId);
  const card = page.locator('.card--settings');
  await expect(card).toBeVisible();
  await expect(card.locator('.tabs-btn--active')).toHaveText(/Exposé/);
});

test('Figur-Alter-Job öffnet die Figuren-Karte auf dem Reiter Alter', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  await page.evaluate((id) => window.__app.navigateToJob({ type: 'figur-alter', bookId: id }), bookId);
  const card = page.locator('.card--figuren');
  await expect(card).toBeVisible();
  // Das Seed-Buch hat keine Figuren — die Reiterleiste ist dann ausgeblendet,
  // geprüft wird der Reiter-State der Karte.
  await expect.poll(() => page.evaluate(() =>
    window.Alpine.$data(document.querySelector('.card--figuren')).figurenGraphModus)).toBe('alter');
});

test('Chat-Job öffnet den Abschnitt und darin genau diese Chat-Session', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const pageId = await page.evaluate(() => window.Alpine.store('nav').pages[0].id);
  // Zwei Sessions: die angesprungene ist die ältere, nicht die oberste der Liste.
  const [older, newer] = await page.evaluate(async ({ bookId, pageId }) => {
    const mk = async () => (await (await fetch('/chat/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: bookId, page_id: pageId, book_name: 'x', page_name: 'y' }),
    })).json()).id;
    const a = await mk();
    const b = await mk();
    return [a, b];
  }, { bookId, pageId });
  expect(older).toBeTruthy();
  expect(newer).toBeTruthy();

  await page.evaluate(({ bookId, sid }) => window.__app.navigateToJob({ type: 'chat', bookId, dedupId: sid }),
    { bookId, sid: older });
  await expect(page.locator('#chat-card')).toBeVisible();
  await expect.poll(() => page.evaluate(() => String(window.__app.currentPage?.id))).toBe(String(pageId));
  await expect.poll(() => page.evaluate(() =>
    window.Alpine.$data(document.getElementById('chat-card')).chatSessionId)).toBe(older);

  // Karte schon offen: der Sprung auf die andere Session lädt sie direkt.
  await page.evaluate(({ bookId, sid }) => window.__app.navigateToJob({ type: 'chat', bookId, dedupId: sid }),
    { bookId, sid: newer });
  await expect.poll(() => page.evaluate(() =>
    window.Alpine.$data(document.getElementById('chat-card')).chatSessionId)).toBe(newer);
});
