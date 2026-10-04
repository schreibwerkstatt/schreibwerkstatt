// Redundanz-Radar-Karte gegen die ECHTE App (playwright.app.config.js).
//
// Der Smoke öffnet die Karte nur ohne Embedding-Backend — dort steht bloss der
// „nicht konfiguriert"-Hinweis, die Ergebnis-Ansicht bleibt ungerendert. Hier
// wird das Backend-Flag im Config-Store gesetzt und die Leserouten werden
// abgefangen (`page.route`), damit die ganze Ergebnis-Kette echt rendert: das
// gespeicherte Ergebnis beim Öffnen, Band nach der Schwelle des Ergebnisses,
// Ausblenden einer Seite, die nicht mehr im Buch steht, Aufklappen der Passage,
// Ignorieren eines Paars und der Hinweis auf einen veralteten Index.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const CARD = '.card--redundanz';

test('redundanz: gespeichertes Ergebnis rendert, Ignorieren + Aufklappen', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const pages = await page.evaluate(() => window.Alpine.store('nav').pages.slice(0, 3).map(p => p.id));
  expect(pages.length).toBeGreaterThanOrEqual(3);
  const [p1, p2, p3] = pages;
  const GONE = 987654321; // Seite, die es im Buch nicht (mehr) gibt
  const long = 'Der Nebel lag über dem Hafen, und die Möwen schrien. '.repeat(12);

  await page.route('**/search/semantic/status*', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      enabled: true, indexed: true, lastIndexedAt: '2026-02-01T00:00:00.000Z', staleCount: 3,
      byKind: [{ kind: 'page', chunks: 12 }],
    }),
  }));
  await page.route('**/jobs/active*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ jobId: null }),
  }));
  let dismissed = null;
  await page.route(`**/redundancy/${bookId}/dismissals`, async (route) => {
    dismissed = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, dismissedCount: 1 }) });
  });
  await page.route(`**/redundancy/${bookId}`, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      dismissedCount: 0,
      result: {
        threshold: 0.88, skipAdjacent: true, comparedChunks: 12, comparedPairs: 50,
        totalFound: 3, truncated: false, truncatedChunks: 0,
        indexedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-15T10:00:00.000Z',
        pairs: [
          { a_id: p1, a_ix: 0, a_text: long, b_id: p3, b_ix: 0, b_text: 'Kurze Gegenstelle mit genug Text.', score: 0.93 },
          { a_id: p2, a_ix: 0, a_text: 'Zweites Paar, erste Seite.', b_id: p3, b_ix: 1, b_text: 'Zweites Paar, zweite Seite.', score: 0.89 },
          { a_id: p1, a_ix: 1, a_text: 'Paar mit verschwundener Seite.', b_id: GONE, b_ix: 0, b_text: 'weg', score: 0.95 },
        ],
        figures: { pairs: [], totalFound: 0, truncated: false, figuresCompared: 0 },
      },
    }),
  }));

  await page.evaluate(() => {
    window.Alpine.store('config').semanticSearchEnabled = true;
    window.__app.toggleRedundanzCard();
  });
  const card = page.locator(CARD);
  await expect(card).toBeVisible();

  // Gespeichertes Ergebnis: zwei Paare sichtbar (das mit der verschwundenen Seite nicht).
  const items = card.locator('.redundanz-pair');
  await expect(items).toHaveCount(2);
  // Band folgt der Schwelle des Ergebnisses (0.88 = streng).
  await expect(card.locator('.tabs-btn--active')).toHaveText(/Streng|Strict/);
  // Index neuer als das Ergebnis + geänderte Einträge → beide Hinweise.
  await expect(card.locator('.redundanz-stale')).toBeVisible();
  await expect(card.locator('.redundanz-meta .card-hint--warn').filter({ hasText: /neu aufgebaut|rebuilt/ })).toBeVisible();

  // Lange Passage klappt auf.
  const first = items.first();
  const snippet = first.locator('.redundanz-snippet').first();
  await expect(snippet).not.toHaveClass(/redundanz-snippet--open/);
  await first.locator('.redundanz-side').first().locator('.redundanz-link').click();
  await expect(snippet).toHaveClass(/redundanz-snippet--open/);

  // Ignorieren: POST mit dem Paar, Eintrag verschwindet, Zähler erscheint.
  await first.locator('.redundanz-pair-head .redundanz-link').click();
  await expect(items).toHaveCount(1);
  expect(dismissed).toEqual({ kind: 'page', a_id: p1, b_id: p3 });
  await expect(card.locator('.redundanz-dismissed')).toBeVisible();
});
