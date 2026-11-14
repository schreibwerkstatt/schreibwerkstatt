// E2E-Smoke-Test für den Publikation-Tab der bookSettingsCard. Lädt das
// Harness, mockt /publication/* in tests/server.js, prüft Tab-Wechsel,
// Speichern (PUT) und Cover-Upload (Vorschau). Der EPUB-Export hat eine eigene
// Karte (epubExportCard) — Download-Test in tests/e2e/epub-export.spec.js.

const { test, expect } = require('./_helpers/fixtures');

// Serial: alle Tests teilen den Mock-State (publication{}). Reset je beforeEach.
test.describe.configure({ mode: 'serial' });

test.describe('publication-tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post('/__mock/publication-reset');
    await page.goto('/tests/fixtures/publication-harness.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__harnessReady === true);
  });

  // Panel = das card-form-grid, das das ISBN-Feld enthält (eindeutig).
  function panel(page) {
    return page.locator('.card-form-grid').filter({ has: page.locator('#pub-isbn') });
  }
  async function openTab(page) {
    await page.locator('.tabs-btn', { hasText: 'Publikation' }).click();
  }

  test('Tab-Klick zeigt Publikation-Panel + Felder', async ({ page }) => {
    await openTab(page);
    await expect(page.locator('#pub-isbn')).toBeVisible();
    await expect(page.locator('#pub-subtitle')).toBeVisible();
    await expect(page.locator('#pub-bio')).toBeVisible();
    await expect(panel(page).getByText('Cover & Autorfoto')).toBeVisible();
  });

  test('Felder ausfüllen + Speichern → PUT trägt Werte', async ({ page }) => {
    await openTab(page);
    await page.locator('#pub-isbn').fill('978-3-16-148410-0');
    await page.locator('#pub-subtitle').fill('Ein Untertitel');
    await page.locator('#pub-dedication').fill('Für alle Leser');
    // Speichern liegt im Karten-Header (saveActiveTab dispatcht je Tab), nicht im Panel.
    await page.locator('.card-actions button', { hasText: 'Speichern' }).click();

    await expect(async () => {
      const state = await page.request.get('/__mock/state').then(r => r.json());
      expect(state.lastPubPut).toBeTruthy();
      expect(state.lastPubPut.isbn).toBe('978-3-16-148410-0');
      expect(state.lastPubPut.subtitle).toBe('Ein Untertitel');
      expect(state.lastPubPut.dedication).toBe('Für alle Leser');
    }).toPass({ timeout: 5000 });
  });

  test('Cover-Upload → Vorschau-Bild erscheint', async ({ page }) => {
    await openTab(page);
    const coverBlock = page.locator('.pub-image-block').first();
    // Vorher: kein Bild, Hinweistext sichtbar.
    await expect(coverBlock.locator('img')).toHaveCount(0);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    await coverBlock.locator('input[type=file]').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: png });
    // uploadPublicationCover POSTet + ruft loadPublication → has_cover=true → <img>.
    await expect(coverBlock.locator('img')).toBeVisible({ timeout: 5000 });
  });

});
