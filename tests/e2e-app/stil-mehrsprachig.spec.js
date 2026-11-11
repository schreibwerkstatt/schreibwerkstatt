// Mehrsprachiges Werk in Autorenprofil und Meine Statistik, gegen die echte App.
//
// Die Engine-Regeln (je Sprache vergleichen, Dialoganteil sprachübergreifend,
// Lesbarkeit je Sprache mitteln) prüfen die Unit-Tests. Hier geht es um das, was
// nur der gerenderte Template-Baum zeigt: eine Tabelle je Vergleichsabschnitt mit
// ihrer Überschrift, der Hinweis an der Sprache mit nur einem Buch, und je Sprache
// eine Lesbarkeitsgruppe mit Sprachpräfix. Die Antworten kommen aus der echten
// Engine (lib/author-profile.js), nicht aus einer handgeschriebenen Attrappe —
// sonst könnte die Form der Antwort von der Karte wegdriften, ohne dass es auffällt.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp, selectSeededBook } = require('./_helpers/app');
const { computeAuthorProfile, AUTHOR_PROFILE_THRESHOLDS: T } = require('../../lib/author-profile');

function profileInput(specs) {
  const books = [], lexicon = [], pageStats = [];
  specs.forEach((s, i) => {
    books.push({ book_id: s.id, created_at: `2020-0${i + 1}-01T00:00:00Z`, excluded: 0, language: s.language });
    lexicon.push({
      book_id: s.id, tokens: T.MIN_TOKENS + 5000, pages: 10, scanned_at: '2026-01-01T00:00:00Z',
      content_sig: `sig${s.id}`, mattr: 0.5, mattr_window: 1000, mtld: 100, hapax_ratio: 0.5,
      yule_k: 40, heaps_beta: 0.78, lex_density: 0.6,
    });
    pageStats.push({
      book_id: s.id, pages: 10, words: s.words, chars: 6000, sentences: 100,
      dialog_chars: s.dialog, adverb_count: 20, passive_count: 5, filler_count: 10,
      lix_w: s.lix * s.words, lix_wsum: s.words, flesch_w: s.flesch * s.words, flesch_wsum: s.words,
    });
  });
  return { books, lexicon, pageStats };
}

test('Autorenprofil: je Sprache eine Tabelle, Dialoganteil über alle Sprachen', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  const measurement = computeAuthorProfile(profileInput([
    { id: 9101, language: 'de', words: 1200, dialog: 600, lix: 45, flesch: 55 },
    { id: 9102, language: 'en', words: 900, dialog: 1800, lix: 25, flesch: 85 },
    { id: 9103, language: 'de', words: 1400, dialog: 900, lix: 48, flesch: 52 },
  ]));
  await page.route('**/me/author-profile', (route) => route.fulfill({
    json: { ...measurement, profile: null, basisSig: 'x', profileStale: false },
  }));
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(() => window.__app.toggleAutorenprofilCard());

  const card = page.locator('.card--autorenprofil');
  await expect(card.locator('.ap-table')).toHaveCount(3);
  const titles = card.locator('.card-section > .card-section-title');
  await expect(titles).toHaveText([/Deutsch|German/, /English|Englisch/, /Über alle Sprachen|Across all languages/]);

  // Deutscher Abschnitt: zwei Bücher + Median; englischer: ein Buch, kein Median, Hinweis.
  const [de, en, cross] = [0, 1, 2].map(i => card.locator('.ap-table').nth(i));
  await expect(de.locator('thead .ap-book-th')).toHaveCount(2);
  await expect(de.locator('thead .ap-median-th')).toBeVisible();
  await expect(en.locator('thead .ap-book-th')).toHaveCount(1);
  await expect(en.locator('thead .ap-median-th')).toBeHidden();
  const needsSecond = card.locator('.card-hint:visible', { hasText: /zweites Buch in dieser Sprache|second book in this language/ });
  await expect(needsSecond).toHaveCount(1);
  await expect(needsSecond).toBeVisible();
  // Sprachübergreifend: alle drei Bücher, genau eine Kennzahl (Dialoganteil).
  await expect(cross.locator('thead .ap-book-th')).toHaveCount(3);
  await expect(cross.locator('tbody tr:not(.ap-group-row)')).toHaveCount(1);
  // Flesch steht nicht im sprachübergreifenden Abschnitt.
  await expect(de.locator('tbody th[scope="row"]')).toHaveCount(12);

  await card.screenshot({ path: test.info().outputPath('autorenprofil-mehrsprachig.png') });
  guard.assertClean('Autorenprofil mehrsprachig');
});

test('Meine Statistik: Lesbarkeit je Sprache, nie gemischt', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  const today = new Date().toISOString().slice(0, 10);
  await page.route('**/me/profile-stats-history', (route) => route.fulfill({
    json: {
      history: [
        { book_id: 9201, recorded_at: today, chars: 300000, words: 50000, avg_flesch_de: 53, avg_lix: 46, avg_sentence_len: 15 },
        { book_id: 9202, recorded_at: today, chars: 100000, words: 20000, avg_flesch_de: 84, avg_lix: 25, avg_sentence_len: 9 },
      ],
      writing: [], lektorat: [], sessions: [],
      languages: { 9201: 'de', 9202: 'en' },
    },
  }));
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(() => window.__app.toggleMyStatsCard());

  const groups = page.locator('.mystats-readability-group');
  await expect(groups).toHaveCount(2);
  // Hauptsprache (mehr Text) zuerst, Werte ungemischt: 53 (DE), 84 (EN).
  await expect(groups.nth(0).locator('.overview-consistency-label').first()).toHaveText(/^Deutsch · Flesch/);
  await expect(groups.nth(1).locator('.overview-consistency-label').first()).toHaveText(/^English · Flesch/);
  await expect(groups.nth(0).locator('.overview-consistency-value').first()).toContainText('53');
  await expect(groups.nth(1).locator('.overview-consistency-value').first()).toContainText('84');

  await groups.first().locator('xpath=ancestor::div[contains(@class,"overview-tile")]')
    .screenshot({ path: test.info().outputPath('mystats-lesbarkeit-mehrsprachig.png') });
  guard.assertClean('Meine Statistik mehrsprachig');
});

// Permalink + stiller Reload: die Karte hat eine eigene URL (#autorenprofil), ein
// Deep-Link öffnet sie, und ein Reload bei stehender Karte (Aufwachen nach
// Tabwechsel/Reconnect feuert CARD_REFRESH) lässt die Tabellen stehen statt sie
// gegen das Skeleton zu tauschen — sonst springt die Karte.
test('Autorenprofil: #autorenprofil-Permalink, Reload ohne Skeleton', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  const measurement = computeAuthorProfile(profileInput([
    { id: 9101, language: 'de', words: 1200, dialog: 600, lix: 45, flesch: 55 },
    { id: 9103, language: 'de', words: 1400, dialog: 900, lix: 48, flesch: 52 },
  ]));
  let calls = 0;
  await page.route('**/me/author-profile', async (route) => {
    calls += 1;
    if (calls > 1) await new Promise(r => setTimeout(r, 800));
    await route.fulfill({ json: { ...measurement, profile: null, basisSig: 'x', profileStale: false } });
  });
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(() => window.__app.toggleAutorenprofilCard());
  await expect(page).toHaveURL(/#autorenprofil$/);

  const card = page.locator('.card--autorenprofil');
  await expect(card.locator('.ap-table').first()).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('card:refresh', { detail: { name: 'autorenprofil' } })));
  await expect.poll(() => calls).toBe(2);
  // Während der verzögerte Reload läuft: Tabelle sichtbar, kein Skeleton.
  // Bewusst ohne Retry gemessen — ein auto-wartendes toBeVisible() würde
  // einfach das Ende des Reloads abwarten und das Springen nie sehen.
  const midReload = await page.evaluate(() => {
    const c = document.querySelector('.card--autorenprofil');
    const vis = (el) => !!el && el.offsetParent !== null;
    return { table: vis(c.querySelector('.ap-table')), skeleton: vis(c.querySelector('[x-skeleton]')) };
  });
  expect(midReload).toEqual({ table: true, skeleton: false });

  // Deep-Link: Karte zu, dann per Hash wieder auf.
  await page.evaluate(() => { window.__app.showAutorenprofilCard = false; });
  await page.evaluate(() => { location.hash = '#autorenprofil'; });
  await expect(card).toBeVisible();
  guard.assertClean('Autorenprofil Permalink');
});
