// E2E-Smoke-Test für die epubExportCard (eigene Karte; war früher inline im
// Publikation-Tab der bookSettingsCard). Lädt das Harness, mockt
// /jobs/epub-export* in tests/server.js und prüft, dass der Export-Button den
// Job startet, pollt und die EPUB-Datei als Download auslöst.

const { test, expect } = require('./_helpers/fixtures');

test.describe('epub-export-card', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post('/__mock/publication-reset');
    await page.goto('/tests/fixtures/epub-export-harness.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__harnessReady === true);
  });

  test('Export-Button löst EPUB-Download aus', async ({ page }) => {
    const exportBtn = page.locator('.card-header button.primary', { hasText: 'Exportieren' });
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      exportBtn.click(),
    ]);
    expect(download.suggestedFilename()).toBe('book.epub');
  });

  // Regression: als editor ruft exportEpub() savePublication() vor dem Export.
  // Im Harness bleibt pubLoaded false (kein false→true-Wechsel von
  // showEpubExportCard, den der $watch beobachten könnte) → loadPublication lief
  // nie. Ohne den pubLoaded-Guard würde der Export ein Full-Replace-PUT mit
  // leeren Defaults schicken und damit Titelei/Cover-Metadaten (book_publication)
  // löschen. Erwartet: kein destruktiver PUT, Export läuft trotzdem mit DB-Stand.
  test('Export als editor mit ungeladener Meta löscht book_publication nicht', async ({ page }) => {
    await page.evaluate(() => { window.__app.currentBookRole = 'editor'; });
    const exportBtn = page.locator('.card-header button.primary', { hasText: 'Exportieren' });
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      exportBtn.click(),
    ]);
    expect(download.suggestedFilename()).toBe('book.epub');
    const state = await page.request.get('/__mock/state').then(r => r.json());
    expect(state.lastPubPut).toBeNull();
  });
});
