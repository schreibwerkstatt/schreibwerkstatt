// E2E-Regression der Klick→Scroll-Pfade der Ereignisse-Karte.
//
// Mountet ereignisseCard mit dem echten Band-/Hinweis-/Listen-Markup und einer
// langen Liste (20 datiert + 78 undatiert) gegen ein Mock-Root. Bewacht den
// $el-vs-$root-Bug: aus einem @click-Handler heraus zeigt Alpines $el auf das
// geklickte Kind (Band-Marker bzw. Achse-Hinweis), nicht auf die Karten-Wurzel.
// scrollToEventIndex/selectTimelineEvent müssen über $root suchen — sonst
// findet der querySelector nichts und es wird nicht gescrollt.

const { test, expect } = require('./_helpers/fixtures');

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto('/tests/fixtures/ereignisse-scroll-harness.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
});

test('Klick auf den Undatiert-Hinweis scrollt zum ersten undatierten Eintrag', async ({ page }) => {
  // Hinweis zeigt die Anzahl undatierter Events (98 - 20 datierte = 78).
  await expect(page.locator('[data-test="hint"]')).toContainText('78');

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('[data-test="hint"]').click();
  await page.waitForTimeout(600);

  // Seite muss tatsächlich nach unten gescrollt sein (erstes undatiertes Event
  // liegt unterhalb der 20 datierten, also ausserhalb des Viewports).
  const scrollY = await page.evaluate(() => window.scrollY);
  expect(scrollY).toBeGreaterThan(0);
});

test('Klick auf einen Band-Marker scrollt zum verknüpften Listeneintrag', async ({ page }) => {
  const markers = page.locator('.gz-band-marker:not(.gz-band-marker--more)');
  const count = await markers.count();
  await page.evaluate(() => window.scrollTo(0, 0));
  // Letzter Marker → datiertes Event weiter unten in der Liste.
  await markers.nth(count - 1).click();
  await page.waitForTimeout(600);

  const scrollY = await page.evaluate(() => window.scrollY);
  expect(scrollY).toBeGreaterThan(0);
});
