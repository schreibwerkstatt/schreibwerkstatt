// Lauf-Verlauf (DESIGN.md «Lauf-Verlauf») gegen die ECHTE App: die geteilte
// Zeile run-history-row.html mit ihrem Adapter je Karte.
//
// Geprüft wird am gerenderten Template-Baum, was nur dort sichtbar ist:
//   - Buchbewertung: Löschen sitzt als Symbol IN der Zeile (nicht mehr im
//     aufgeklappten Detail), Klick klappt auf, Löschen fragt per appConfirm
//     und nimmt die Zeile nach bestätigtem DELETE aus der Liste.
//   - Plot-Prüfung: Zeile aus der echten Lade-Methode (makeRunHistoryMethods),
//     Zähl-Text über tn() (Singular), Öffnen als Toggle, Löschen.
//   - Motiv-Brainstorm: Öffnen scrollt zum Vorschlags-Panel der KARTE — die
//     Kartenmethode läuft über den Adapter mit dem `$root` der Karte, nicht
//     dem der Verlaufsleiste (verschachteltes x-data).
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const DIALOG = '#app-confirm-dialog';
const json = (body) => (route) => route.fulfill({
  status: 200, contentType: 'application/json', body: JSON.stringify(body),
});

test('Buchbewertung: Löschen in der Zeile, Aufklappen, Rückfrage', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  let deleted = null;
  await page.route('**/history/review/*', (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    deleted = route.request().url();
    return json({ ok: true })(route);
  });
  await page.evaluate(() => window.__app.toggleBookReviewCard());
  const card = page.locator('.card--review');
  await expect(card).toBeVisible();
  await page.evaluate(() => {
    const review = (note, z) => ({ gesamtnote: note, gesamtnote_begruendung: 'b', zusammenfassung: z,
      staerken: [], schwaechen: [], empfehlungen: [], fazit: 'f' });
    window.__app.bookReviewHistory = [
      { id: 9102, reviewed_at: '2026-10-02T10:00:00.000Z', model: 'modell-b', review_json: review(5, 'ZWEITE') },
      { id: 9101, reviewed_at: '2026-10-01T10:00:00.000Z', model: 'modell-a', review_json: review(3, 'ERSTE') },
    ];
  });
  const rows = card.locator('.card-history-section .history-item');
  await expect(rows).toHaveCount(2);
  const first = rows.first();
  await expect(first.locator('.review-stars')).toBeVisible();
  await expect(first.locator('.tag', { hasText: 'modell-b' })).toBeVisible();
  // Löschen ist direktes Kind der Zeile, im Detail gibt es keinen Löschknopf.
  await expect(first.locator(':scope > .history-item-delete')).toHaveCount(1);

  await first.click();
  await expect(first).toHaveClass(/history-item--open/);
  await expect(first.locator('.history-chevron')).toHaveClass(/open/);
  const detail = card.locator('.history-detail:visible');
  await expect(detail).toContainText('ZWEITE');
  await expect(detail.locator('button[aria-label]')).toHaveCount(0);

  // Löschen: Rückfrage, abbrechen lässt die Zeile stehen …
  await first.hover();
  await first.locator('.history-item-delete').click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).not.toBeVisible();
  await expect(rows).toHaveCount(2);
  // … bestätigen nimmt sie nach dem DELETE heraus.
  await first.hover();
  await first.locator('.history-item-delete').click();
  await page.locator(DIALOG).locator('.confirm-dialog-btn--danger').click();
  await expect(rows).toHaveCount(1);
  expect(deleted).toMatch(/\/history\/review\/9102$/);
  await expect(rows.first()).toContainText('modell-a');
});

test('Plot-Prüfung: geteilte Zeile, Zähl-Text, Öffnen als Toggle, Löschen', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const run = { id: 9201, created_at: '2026-10-03 08:30:00', konflikt_count: 1, model: 'pruef-modell' };
  await page.route('**/plot/consistency-runs?*', json([run]));
  await page.route('**/plot/consistency-runs/9201', (route) => (route.request().method() === 'DELETE'
    ? json({ ok: true })(route)
    : json({ ...run, result: { konflikte: [], fazit: 'FAZIT-9201', erledigt: [] } })(route)));
  await page.evaluate(() => window.__app.togglePlotCard());
  const card = page.locator('.card--plot');
  await expect(card).toBeVisible();

  const row = card.locator('.history-bar .history-item');
  await expect(row).toHaveCount(1);
  const one = await page.evaluate(() => window.__app.tn('plot.consistency.konfliktCount', 1));
  await expect(row.locator('.tag', { hasText: one })).toBeVisible();
  await expect(row.locator('.tag', { hasText: 'pruef-modell' })).toBeVisible();
  // SQLite-Zeitstempel ohne Zone gilt als UTC (parseServerTs) und erscheint in
  // der App-Zeitzone (Default Europe/Zurich, Oktober = UTC+2).
  await expect(row.locator('.history-date')).toContainText('2026');
  await expect(row.locator('.history-date')).toContainText('10:30');

  await row.click();
  await expect(row).toHaveClass(/history-item--open/);
  const sel = () => page.evaluate(() => window.Alpine.$data(document.querySelector('.card--plot')).selectedRunId);
  expect(await sel()).toBe(9201);
  await row.click();
  await expect(row).not.toHaveClass(/history-item--open/);
  expect(await sel()).toBe(null);

  await row.hover();
  await row.locator('.history-item-delete').click();
  await page.locator(DIALOG).locator('.confirm-dialog-btn--danger').click();
  await expect(row).toHaveCount(0);
});

test('Motiv-Brainstorm: Öffnen scrollt zum Vorschlags-Panel der Karte', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const run = { id: 9301, created_at: '2026-10-04T09:00:00.000Z', vorschlag_count: 2, model: null };
  await page.route('**/motifs/brainstorm-runs?*', json([run]));
  await page.route('**/motifs/brainstorm-runs/9301', json({
    ...run, result: { vorschlaege: [
      { typ: 'motiv', name: 'Spiegel', beschreibung: 'x', trigger_terms: [] },
      { typ: 'thema', name: 'Schuld', beschreibung: 'y' },
    ] },
  }));
  await page.evaluate(() => window.__app.toggleMotivCard());
  const card = page.locator('.card--motiv');
  await expect(card).toBeVisible();
  const row = card.locator('.history-bar .history-item');
  await expect(row).toHaveCount(1);
  const two = await page.evaluate(() => window.__app.tn('motiv.brainstorm.vorschlagCount', 2));
  await expect(row.locator('.tag:visible')).toHaveText([two]); // ohne Modell kein Modell-Tag

  await page.evaluate(() => {
    window.__scrolled = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (...a) { window.__scrolled.push(this.className); return orig.apply(this, a); };
  });
  await row.click();
  await expect(row).toHaveClass(/history-item--open/);
  await expect(card.locator('.motiv-suggestions')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__scrolled.some(c => String(c).includes('motiv-suggestions')))).toBe(true);
});
