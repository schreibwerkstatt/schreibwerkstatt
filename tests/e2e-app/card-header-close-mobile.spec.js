// Card-Header-Close auf Touch-Mobile: ein Header mit Titelspalte bleibt einzeilig,
// der Close-Button sitzt im Flex-Fluss hinter den Aktionen. Absolut oben rechts
// verankert ueberlappte sein 40px-Touch-Target die Action-Icons (das reservierte
// Header-Padding ist schmaler). Geometrie haengt am echten CSS — darum hier.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test.use({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true });

const CARDS = [
  ['chat-card', 'toggleChatCard'],
  ['reference-card', 'toggleReferenceCard'],
];

for (const [id, toggle] of CARDS) {
  test(`#${id}: Close-Button ueberlappt die Header-Aktionen nicht`, async ({ page }) => {
    await bootApp(page);
    await selectSeededBook(page);
    await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
    await page.evaluate((n) => window.__app[n](), toggle);
    const close = page.locator(`#${id} > .card-header > .btn-card-close`);
    await expect(close).toBeVisible();

    const geo = await page.evaluate((cardId) => {
      const h = document.querySelector(`#${cardId} > .card-header`);
      const c = h.querySelector(':scope > .btn-card-close').getBoundingClientRect();
      const btns = [...h.querySelectorAll('.card-actions button')]
        .map((b) => b.getBoundingClientRect()).filter((r) => r.width);
      return { closeLeft: c.left, closeW: c.width, actionsRight: Math.max(...btns.map((r) => r.right)), headerRight: h.getBoundingClientRect().right, closeRight: c.right };
    }, id);

    expect(geo.closeW, 'Touch-Target').toBeGreaterThanOrEqual(40);
    expect(geo.closeLeft - geo.actionsRight, 'Abstand Aktionen → Close').toBeGreaterThanOrEqual(8);
    expect(geo.closeRight).toBeLessThanOrEqual(geo.headerRight + 1);
  });
}
