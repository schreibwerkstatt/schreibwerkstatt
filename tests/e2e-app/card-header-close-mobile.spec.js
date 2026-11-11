// Card-Header-Close: der Close-Button sitzt im Flex-Fluss hinter den Aktionen,
// ueberlappt sie nicht und steht im selben Abstand wie die Aktions-Icons
// untereinander (--card-actions-gap) — auf Desktop und Touch-Mobile.
// Geometrie haengt am echten CSS — darum hier.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const VIEWPORTS = [
  ['Desktop', { viewport: { width: 1400, height: 900 } }],
  ['Mobile', { viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true }],
];

const CARDS = [
  ['chat-card', 'toggleChatCard'],
  ['reference-card', 'toggleReferenceCard'],
];

for (const [label, opts] of VIEWPORTS) test.describe(label, () => {
test.use(opts);
for (const [id, toggle] of CARDS) {
  test(`#${id}: Close-Button im Aktions-Abstand, ohne Ueberlappung`, async ({ page }) => {
    await bootApp(page);
    await selectSeededBook(page);
    await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
    await page.evaluate((n) => window.__app[n](), toggle);
    const close = page.locator(`#${id} > .card-header > .btn-card-close`);
    await expect(close).toBeVisible();

    const geo = await page.evaluate((cardId) => {
      const h = document.querySelector(`#${cardId} > .card-header`);
      const c = h.querySelector(':scope > .btn-card-close').getBoundingClientRect();
      const actions = h.querySelector('.card-actions');
      const btns = [...actions.querySelectorAll('button')]
        .map((b) => b.getBoundingClientRect()).filter((r) => r.width);
      return { closeLeft: c.left, actionsRight: Math.max(...btns.map((r) => r.right)), headerRight: h.getBoundingClientRect().right, closeRight: c.right, actionGap: parseFloat(getComputedStyle(actions).columnGap) };
    }, id);

    // Close steht im selben Abstand wie die Aktions-Icons untereinander.
    expect(geo.closeLeft - geo.actionsRight, 'Abstand Aktionen → Close').toBeCloseTo(geo.actionGap, 0);
    expect(geo.closeRight).toBeLessThanOrEqual(geo.headerRight + 1);
  });
}
});
