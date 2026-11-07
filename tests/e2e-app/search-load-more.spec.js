// Suchkarte: Volltext-Treffer seitenweise. Der Server meldet `more`, wenn hinter
// der geladenen Liste weitere Treffer liegen (lib/search.js#query holt eine Zeile
// mehr); die Karte zeigt dann «50+» statt einer scheinbar vollständigen Zahl und
// hängt mit «Mehr laden» die nächste Seite an (offset = geladene Treffer).
//
// Server-Seite (more-Flag, leere Folgeseite ohne Trigram-Fallback) testet
// tests/unit/search-query.test.mjs; hier nur die Verdrahtung in der echten Karte,
// darum mit abgefangenen /search-Antworten.

const { test, expect } = require('@playwright/test');
const { bootApp } = require('./_helpers/app');

function _hits(from, n) {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'page', entity_id: 900000 + from + i, nav_id: 900000 + from + i, book_id: 1,
    title: `Treffer ${from + i}`, snippet: '', rank: -1,
  }));
}

test('Suchkarte: «50+» und «Mehr laden» hängen die nächste Seite an', async ({ page }) => {
  await bootApp(page);
  const offsets = [];
  await page.route(/\/search\?/, async (route) => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get('offset') || 0);
    offsets.push(offset);
    const body = offset === 0
      ? { hits: _hits(0, 50), fallback: false, more: true }
      : { hits: _hits(offset, 3), fallback: false, more: false };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.evaluate(() => window.__app.toggleSearchCard());
  await page.locator('.search-q').fill('Anna');

  const hits = page.locator('.search-hit');
  await expect(hits).toHaveCount(50);
  const moreLabel = await page.evaluate(() => window.__app.t('search.results.countMore', { n: 50 }));
  await expect(page.locator('.search-status--meta')).toHaveText(moreLabel);

  const btn = page.locator('.search-more button');
  await expect(btn).toBeVisible();
  await btn.click();

  await expect(hits).toHaveCount(53);
  expect(offsets).toContain(50);
  await expect(btn).toBeHidden();
  const countLabel = await page.evaluate(() => window.__app.tn('search.results.count', 53));
  await expect(page.locator('.search-status--meta')).toHaveText(countLabel);
});
