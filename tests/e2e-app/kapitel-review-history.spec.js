// Kapitel-Bewertung: aktuelle Bewertung + Verlauf gegen die ECHTE App
// (siehe playwright.app.config.js).
//
// Prüft am gerenderten Template-Baum (verschachteltes x-for/x-if), was nur
// dort sichtbar ist:
//   - der jüngste Verlaufseintrag steht als aktuelle Bewertung oben, auch ohne
//     Lauf in dieser Sitzung (nach Reload),
//   - der Verlauf darunter listet nur die älteren Einträge,
//   - die Notenänderung erscheint nur zwischen vergleichbaren Läufen (gleicher
//     Umfang, gleiches Modell).

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test.describe.configure({ mode: 'serial' });

const json = (body) => (route) => route.fulfill({
  status: 200, contentType: 'application/json', body: JSON.stringify(body),
});

function review(note, summary, extra = {}) {
  return {
    gesamtnote: note, gesamtnote_begruendung: 'b', zusammenfassung: summary,
    staerken: [], schwaechen: [], empfehlungen: [], fazit: 'f', ...extra,
  };
}

test('aktuelle Bewertung oben, ältere im Verlauf, Trend nur bei gleichem Umfang', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const ch = await page.evaluate(() =>
    window.Alpine.store('nav').tree.find(i => i.type === 'chapter' && !i.solo && (i.pages || []).length));
  const cid = ch.id;

  const history = {
    [cid]: [
      // newest-first
      { id: 3, chapter_id: cid, reviewed_at: '2026-10-03T10:00:00.000Z', model: 'm1',
        review_json: review(5, 'NEUESTE-ZUSAMMENFASSUNG', { includeSubchapters: false }) },
      // gleicher Umfang + Modell wie #1 → Trend an Eintrag #2 (gegenüber #1)
      { id: 2, chapter_id: cid, reviewed_at: '2026-10-02T10:00:00.000Z', model: 'm1',
        review_json: review(4, 'MITTLERE', { includeSubchapters: false }) },
      // anderer Umfang → kein Trend an Eintrag #2
      { id: 1, chapter_id: cid, reviewed_at: '2026-10-01T10:00:00.000Z', model: 'm1',
        review_json: review(2, 'ALTE', { includeSubchapters: true }) },
    ],
  };
  await page.route(`**/history/chapter-reviews/${bookId}`, json(history));

  await page.evaluate((id) => {
    window.__app.kapitelReviewChapterId = String(id);
    return window.__app.toggleKapitelReviewCard();
  }, cid);

  const card = page.locator('.card--kapitel');
  await expect(card.locator('.kapitel-review-latest-meta')).toBeVisible({ timeout: 20000 });
  await expect(card.getByText('NEUESTE-ZUSAMMENFASSUNG')).toBeVisible();

  // Verlauf: nur die beiden älteren Einträge.
  const items = card.locator('.card-history-section .history-item');
  await expect(items).toHaveCount(2);

  // Eintrag „MITTLERE" (#2) hat einen Vorgänger mit anderem Umfang → kein Trend.
  await expect(items.nth(0).locator('.review-trend')).toBeHidden();
  // Eintrag „ALTE" (#1) hat keinen Vorgänger → kein Trend; Umfangs-Tag sichtbar.
  await expect(items.nth(1).locator('.review-trend')).toBeHidden();
  const withSubs = await page.evaluate(() => window.__app.t('kapitelReview.scopeWithSubs'));
  await expect(items.nth(1).getByText(withSubs)).toBeVisible();

  // Trend der aktuellen Bewertung (#3 gegenüber #2, gleicher Umfang + Modell)
  // rechnet die Karte: +1.
  const delta = await card.evaluate((el) => window.Alpine.$data(el).kapitelReviewNoteDelta(0));
  expect(delta).toBe(1);

  // Der Bewerten-Knopf heisst „Neu bewerten", obwohl in dieser Sitzung kein Lauf war.
  const rerun = await page.evaluate(() => window.__app.t('kapitelReview.rerun'));
  await expect(card.locator(`button[aria-label="${rerun}"]`)).toBeVisible();

  guard.assertClean();
});
