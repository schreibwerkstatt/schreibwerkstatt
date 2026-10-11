// Ø-Auswertung der Buchentwicklung gegen die ECHTE App (playwright.app.config.js).
//
// Warum diese Schicht: die Kennzahlen-Zeile und die Overlay-Serien entstehen
// erst, wenn die Karte mit ECHTEN Reihen rendert. Das Seed-Buch hat keine
// book_stats_history, der Smoke sieht nur den Leer-Hinweis — ein Tippfehler in
// einer Alpine-Expression der neuen Zeile faende dort niemand (Alpine schluckt
// Expression-Fehler). Die Chart.js-Datasets sind ausserdem nur am gemounteten
// Canvas pruefbar.
//
// Die Reihen werden direkt in die Komponente gelegt statt ueber Sync erzeugt:
// `/sync/book/:id` schreibt genau einen Snapshot fuer HEUTE, ein Durchschnitt
// ueber einen Zeitraum braucht aber eine Zeitachse.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test.describe.configure({ mode: 'serial' });

// 11 Tage, taeglich +1000 Zeichen — Ø-Zuwachs 1000/Tag, 7000/Woche.
// Relativ zu heute: die Zeitraum-Filter (z. B. 30 Tage) schneiden ab heute ab,
// feste Kalenderdaten fielen sonst irgendwann aus dem Fenster.
function seedRows() {
  const rows = [];
  const now = new Date();
  for (let i = 0; i < 11; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 10 + i)).toISOString().slice(0, 10);
    rows.push({
      recorded_at: d,
      chars: 10000 + i * 1000,
      words: 1500 + i * 150,
      page_count: 5,
      chapter_count: 2,
      tok: 2500 + i * 250,
      unique_words: 800,
      avg_sentence_len: 14.5,
    });
  }
  return rows;
}

async function renderWith(page, metric, range) {
  await page.evaluate(({ rows, metric, range }) => {
    const c = window.Alpine.$data(document.querySelector('.card--bookstats'));
    c.bookStatsData = rows;
    c.bookStatsMetric = metric;
    c.bookStatsRange = range;
    return c.renderStatsChart();
  }, { rows: seedRows(), metric, range });
}

function chartInfo(page) {
  return page.evaluate(() => {
    const chart = window.Chart.getChart(document.getElementById('book-stats-chart'));
    return chart ? chart.data.datasets.map(d => ({ label: d.label, points: d.data.filter(v => v != null).length })) : null;
  });
}

test('Buchentwicklung: Ø-Zeile und Ø-Overlays rendern mit echten Reihen', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);

  await page.evaluate(() => window.__app.toggleBookStatsCard());
  const card = page.locator('.card--bookstats');
  await expect(card).toBeVisible();

  // Erst den Karten-Load abwarten: er laeuft beim Oeffnen an und wuerde die
  // gleich gesetzten Reihen sonst mit dem einen echten Snapshot ueberschreiben.
  await page.waitForFunction(
    () => window.Alpine.$data(document.querySelector('.card--bookstats')).bookStatsData.length > 0,
    null,
    { timeout: 20000 },
  );

  // Bestandsgroesse: Ø-ZUWACHS pro Tag/Woche/Monat + Ø-Entwicklungsgerade.
  await renderWith(page, 'chars', 0);
  const badges = card.locator('.book-stats-avg .tok-badge');
  await expect(card.locator('.book-stats-avg')).toBeVisible();
  await expect(badges).toHaveCount(3);
  await expect(badges.nth(0)).toHaveText(/\+1[’'.,]?000\s*\/\s*Tag/);
  await expect(badges.nth(1)).toHaveText(/\+7[’'.,]?000\s*\/\s*Woche/);
  await expect(card.locator('.book-stats-avg .card-hint')).toHaveText(/11/);

  let sets = await chartInfo(page);
  expect(sets.map(s => s.label)).toEqual(['Zeichen', 'Ø-Entwicklung']);
  expect(sets[1].points).toBe(11);

  // Tagesmenge: Ø/Tag, Ø/Woche, Ø/Monat, Σ — dazu Ø-Linie + gleitender Ø.
  await renderWith(page, 'delta_chars', 30);
  await expect(badges).toHaveCount(4);
  await expect(badges.nth(0)).toHaveText(/1[’'.,]?000\s*\/\s*Tag/);
  sets = await chartInfo(page);
  expect(sets.map(s => s.label)).toEqual(['Δ Zeichen/T', 'Ø Zeitraum', 'Gleitender Ø (7 T)']);

  // Verhaeltniszahl: ein Ø-Wert, keine Hochrechnung auf Woche/Monat.
  await renderWith(page, 'avg_sentence_len', 0);
  await expect(badges).toHaveCount(1);
  await expect(badges.nth(0)).toHaveText(/14[.,]5/);

  // Toggle aus: die Overlays verschwinden, die Kennzahlen bleiben.
  await card.locator('.book-stats-controls .btn-group button', { hasText: 'Ø' }).click();
  await expect.poll(async () => (await chartInfo(page)).length).toBe(1);
  await expect(badges).toHaveCount(1);

  guard.assertClean();
});
