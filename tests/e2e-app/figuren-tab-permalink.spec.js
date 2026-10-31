// Reiter-Permalink der Figuren-Karte gegen die ECHTE App: #…/figuren/<reiter>.
//
// Warum diese Schicht: der Reiter lebt in der Sub-Komponente (figurenGraphModus),
// der Hash-Router liest den Store-Spiegel (catalogUi.figurenTab). Ob Spiegel-Watcher,
// Lazy-Partial und Karten-Wunsch beim Deep-Link zusammenspielen, sieht nur die
// gebootete App.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, waitBooted } = require('./_helpers/app');

const CARD = '.card--figuren';
const modus = (page) => page.evaluate(
  (sel) => window.Alpine.$data(document.querySelector(sel))?.figurenGraphModus, CARD);

test('figuren: Deep-Link öffnet den Reiter, Reiterwechsel schreibt den Hash', async ({ page }) => {
  await bootApp(page);
  const bookId = await page.evaluate(() => window.Alpine.store('nav').books[0].id);

  await page.evaluate((id) => { location.hash = `#book/${id}/figuren/praesenz`; }, bookId);
  await expect(page.locator(CARD)).toBeVisible();
  await expect.poll(() => modus(page)).toBe('praesenz');

  // Reload auf dem Permalink: Karte wird erst durch den Deep-Link gemountet.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitBooted(page);
  await expect(page.locator(CARD)).toBeVisible();
  await expect.poll(() => modus(page)).toBe('praesenz');
  expect(new URL(page.url()).hash).toBe(`#book/${bookId}/figuren/praesenz`);

  // Reiterwechsel per Klick → Hash folgt; zurück auf die Liste → ohne Suffix.
  // Reiter-Reihenfolge wie FIGUREN_TABS: liste, figur, familie, soziogramm, …
  const tabs = page.locator(`${CARD} .tabs-btn`);
  await tabs.nth(3).click();
  await expect.poll(() => new URL(page.url()).hash).toBe(`#book/${bookId}/figuren/soziogramm`);
  await tabs.nth(0).click();
  await expect.poll(() => new URL(page.url()).hash).toBe(`#book/${bookId}/figuren`);
});
