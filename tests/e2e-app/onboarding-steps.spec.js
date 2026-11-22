// «Erste Schritte», Etappe «Ersten Abschnitt lektorieren»: der CTA
// (onboarding-card.js#doStep → app-onboarding.js#startFirstLektorat) öffnet
// einen Abschnitt mit Text und startet dort den Lektorat-Job. Der Job-POST wird
// abgefangen — geprüft wird nur, dass der richtige Abschnitt geöffnet und für
// ihn ein Lauf angestossen wird, nicht der Lauf selbst.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('Etappe lektorat: CTA öffnet den ersten Abschnitt mit Text und startet den Lauf', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const posted = [];
  await page.route('**/jobs/check', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posted.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jobId: 'onb-test' }) });
  });
  const expected = await page.evaluate(async () => {
    const app = window.__app;
    // Seiten-Stats abwarten, damit «mit Text» bestimmbar ist.
    const pages = window.Alpine.store('nav').pages;
    for (let i = 0; i < 50 && pages.some(p => !app.tokEsts?.[p.id]); i++) await new Promise(r => setTimeout(r, 100));
    const first = pages.find(p => (app.tokEsts?.[p.id]?.chars || 0) > 0);
    if (!first) throw new Error('Seed-Buch ohne Abschnitt mit Text');
    await app.toggleOnboardingCard();
    const el = document.querySelector('.card--onboarding');
    window.Alpine.$data(el).doStep('lektorat');
    return first.id;
  });
  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0].page_id).toBe(expected);
  expect(await page.evaluate(() => window.__app.currentPage?.id)).toBe(expected);
});
