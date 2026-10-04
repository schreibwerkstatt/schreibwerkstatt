// Fehler-Heatmap gegen die ECHTE App (siehe playwright.app.config.js).
//
// Warum neben dem Smoke: das Dev-Seed-Buch hat keine Lektorats-Befunde, die
// Tabelle haengt an einem `x-if` und liefe dort nie durch den Template-Baum.
// Hier wird /history/fehler-heatmap per Route-Interception befuellt. Geprueft
// wird, was nur am echten DOM sichtbar ist: die Zellvarianten aus
// buildFehlerRows landen als Klassen, die Farbe folgt der Dichte, die
// Summenzeile steht im tfoot und der Trend markiert Naeherungspunkte.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const json = (body) => (route) => route.fulfill({
  status: 200, contentType: 'application/json', body: JSON.stringify(body),
});

test('Fehler-Heatmap rendert Dichte-Farbe, Mindestmenge, Summenzeile und Naeherungs-Hinweis', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);

  // Drei Kapitel: K1 lang mit vielen Befunden (duenn), K2 kurz mit wenigen
  // (dicht), K3 zu wenig gepruefter Text, K4 ungeprueft.
  const heat = {
    mode: 'open',
    chapters: [
      { chapter_id: 901, chapter_name: 'Lang', pages_total: 4, pages_checked: 4, words: 20000, words_checked: 20000 },
      { chapter_id: 902, chapter_name: 'Kurz', pages_total: 1, pages_checked: 1, words: 1000, words_checked: 1000 },
      { chapter_id: 903, chapter_name: 'Prolog', pages_total: 1, pages_checked: 1, words: 80, words_checked: 80 },
      { chapter_id: 904, chapter_name: 'Neu', pages_total: 2, pages_checked: 0, words: 3000, words_checked: 0 },
    ],
    matrix: {
      901: { stil: { count: 20, per1k: 1, pages: 3 } },
      902: { stil: { count: 5, per1k: 5, pages: 1 } },
      903: { stil: { count: 4, per1k: 50, pages: 1 } },
    },
    details: { '901:stil': [{ page_id: 1, page_name: 'S1', count: 20, samples: [] }] },
    totals: { stil: 29 },
  };
  const trend = { versions: [
    { seq: 1, label: 'v1', words: 9000, created_at: '2026-01-01T00:00:00.000Z', published: false, metrics: { open: { total: 9, byTyp: {} }, applied: { total: 0, byTyp: {} }, all: { total: 9, byTyp: {} } } },
    { seq: 2, label: 'v2', words: 9500, created_at: '2026-02-01T00:00:00.000Z', published: false, metrics: { open: { total: 6, byTyp: {} }, applied: { total: 0, byTyp: {} }, all: { total: 6, byTyp: {} }, words_checked: 3000 } },
  ] };
  await page.route('**/history/fehler-heatmap/**', json(heat));
  await page.route('**/history/fehler-trend/**', json(trend));

  await page.evaluate(() => window.__app.toggleFehlerHeatmapCard());
  const card = page.locator('.card--heatmap');
  const rows = card.locator('.heatmap-table tbody tr');
  await expect(rows).toHaveCount(4, { timeout: 20000 });

  const stilIdx = await page.evaluate(() => {
    const comp = window.Alpine.$data(document.querySelector('.card--heatmap'));
    return comp.fehlerHeatmapTypen.indexOf('stil');
  });
  // Spalte = 2 Meta-Spalten (th + Abdeckung) + Typ-Index.
  const stilCell = (r) => rows.nth(r).locator('td.heatmap-cell').nth(stilIdx);

  // Dichte entscheidet: K1 (20 Befunde, 1/1k) gruen, K2 (5 Befunde, 5/1k) rot.
  await expect(stilCell(0)).toHaveClass(/heatmap-cell--tinted/);
  await expect(stilCell(0)).toHaveText('20');
  expect(await stilCell(0).evaluate(el => el.style.getPropertyValue('--heatmap-t'))).toBe('0%');
  expect(await stilCell(1).evaluate(el => el.style.getPropertyValue('--heatmap-t'))).toBe('100%');
  // Die Farbe kommt wirklich an (color-mix mit calc() ist gueltig) und die
  // Zahl bleibt voll deckend — Teilabdeckung blasst nur den Hintergrund ab.
  const look = await stilCell(1).evaluate(el => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, opacity: cs.opacity };
  });
  expect(look.bg).not.toBe('rgba(0, 0, 0, 0)');
  expect(look.opacity).toBe('1');

  // K3 unter der Mindestmenge: Zahl, keine Farbe; K4 ungeprueft: schraffiert.
  await expect(stilCell(2)).toHaveClass(/heatmap-cell--lowdata/);
  await expect(stilCell(2)).toHaveText('4');
  await expect(stilCell(3)).toHaveClass(/heatmap-cell--empty/);

  // Geprueft ohne Befund in einer anderen Spalte: '–', aber nicht klickbar.
  const grammatikIdx = await page.evaluate(() =>
    window.Alpine.$data(document.querySelector('.card--heatmap')).fehlerHeatmapTypen.indexOf('grammatik'));
  const zero = rows.nth(0).locator('td.heatmap-cell').nth(grammatikIdx);
  await expect(zero).toHaveText('–');
  await expect(zero).not.toHaveClass(/heatmap-cell--clickable/);

  // Klick oeffnet das Detail-Panel der Zelle.
  await stilCell(0).click();
  await expect(card.locator('.heatmap-detail')).toBeVisible();

  // Summenzeile im tfoot: Anzahl des ganzen Buchs.
  const total = card.locator('.heatmap-table tfoot tr.heatmap-total-row td.heatmap-cell').nth(stilIdx);
  await expect(total).toHaveText('29');

  // Trend: v1 hat keine words_checked → Naeherungs-Hinweis sichtbar.
  await expect(card.locator('.fehler-trend-note')).toBeVisible();

  guard.assertClean();
});
