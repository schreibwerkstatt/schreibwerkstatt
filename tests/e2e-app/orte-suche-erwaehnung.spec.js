// Orte-Karte gegen die ECHTE App (playwright.app.config.js).
//
// Aussage: die Suche trifft einen Schauplatz auch über den Namen einer Figur, die dort
// auftritt, und eine als Kapitelname aufgelöste «Erste Erwähnung» erscheint in der
// Detailansicht als Kapitel-Verweis statt als Rohtext.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('Orte: Suche über Figurennamen, erste Erwähnung als Kapitel-Verweis', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const chapterId = await page.evaluate(() => {
    const ch = (window.Alpine.store('nav').tree || []).find(x => x.type === 'chapter');
    return ch ? ch.id : 1;
  });
  const ort = (id, name, extra) => ({
    id, name, typ: 'GEBAEUDE', beschreibung: '', stimmung: '', land: null, lat: null, lng: null,
    erste_erwaehnung: null, erste_erwaehnung_page_id: null, erste_erwaehnung_chapter_id: null,
    parent: null, stale: false, manual_fields: [], analysis_known: true, figuren: [], kapitel: [], ...extra,
  });
  await page.route(`**/locations/${bookId}`, route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      updated_at: '2026-01-01T00:00:00.000Z',
      orte: [
        ort('ort_t1', 'Turmzimmer', { figuren: ['fig_zz'], erste_erwaehnung: 'Kapitel X', erste_erwaehnung_chapter_id: chapterId }),
        ort('ort_t2', 'Gartenhaus', {}),
      ],
    }),
  }));

  await page.evaluate(() => window.__app.toggleOrteCard());
  const card = page.locator('.card--orte');
  await expect(card.locator('[data-ortid="ort_t1"]').first()).toBeVisible();
  await page.evaluate(() => {
    const c = window.Alpine.store('catalog');
    c.figuren = [...c.figuren, { id: 'fig_zz', name: 'Zorabella Quist', kurzname: 'Zora' }];
  });

  await card.locator('.filter-search-input').first().fill('zorabella');
  await expect(card.locator('[data-ortid="ort_t1"]').first()).toBeVisible();
  await expect(card.locator('[data-ortid="ort_t2"]')).toHaveCount(0);

  await card.locator('[data-ortid="ort_t1"]').first().locator('.row-expand').click();
  const label = await page.evaluate(() => window.__app.t('orte.firstMention'));
  const row = card.locator('.entity-meta-row').filter({ has: page.locator('.entity-meta-label', { hasText: label }) });
  await expect(row.locator('.entity-ref--kapitel')).toHaveCount(1);
});
