// Command-Palette als Sprungbrett auf Reiter und Abschnitte, gegen die ECHTE
// App: Bucheinstellungs-Reiter, PDF-Export-Reiter (Experten-Reiter schaltet den
// Modus), Abschnitt der Benutzereinstellungen (klappt auf) und «Was ist neu».
// Die Karten holen den Wunsch über cards/card-request.js ab — kalt (Karte erst
// durch den Sprung gemountet) und warm (Karte schon offen) sind zwei Wege.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

async function runPalette(page, query) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('palette:open')));
  const input = page.locator('.palette-input');
  await expect(input).toBeVisible();
  await input.fill(query);
  await expect(page.locator('.palette-item--active')).toBeVisible();
  await input.press('Enter');
  await expect(input).toBeHidden();
}

test('Palette springt auf Reiter und Abschnitte', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);

  // Bucheinstellungen kalt, dann warm auf einen zweiten Reiter.
  await runPalette(page, 'Bucheinstellungen: Publikation');
  const settings = page.locator('.card--settings').filter({ has: page.locator('.tabs-btn', { hasText: 'Publikation' }) });
  await expect(settings.locator('.tabs-btn', { hasText: 'Publikation' })).toHaveAttribute('aria-selected', 'true');
  await runPalette(page, 'Bucheinstellungen: Reihe');
  await expect(settings.locator('.tabs-btn', { hasText: 'Reihe' })).toHaveAttribute('aria-selected', 'true');

  // PDF-Export: Experten-Reiter schaltet den Modus um.
  await runPalette(page, 'PDF-Export: Cover');
  await expect.poll(() => page.evaluate(() => {
    const el = document.querySelector('[x-data="pdfExportCard"]');
    const d = el && window.Alpine.$data(el);
    return d ? `${d.activeTab}/${d.uiMode}` : null;
  })).toBe('cover/expert');

  // Benutzereinstellungen: Abschnitt klappt auf.
  await runPalette(page, 'Profil: Geräte');
  const devices = page.locator('[data-settings-section="devices"] .collapsible-toggle');
  await expect(devices).toHaveAttribute('aria-expanded', 'true');
  await expect(devices).toBeInViewport();

  // Hilfe auf den Neuigkeiten.
  await runPalette(page, 'Was ist neu');
  await expect(page.locator('.tabs-btn[aria-selected="true"]', { hasText: 'Neuigkeiten' })).toBeVisible();
});

// Esc verwirft die Palette, ohne bis zu window-Esc-Handlern durchzureichen —
// die schlössen sonst mit (Vollbild des Notebook-Editors, Figuren-Graph,
// Snapshot-Reader …), und die Palette zu verwerfen kostete den Kontext.
test('Esc schliesst die Palette, ohne window-Esc-Handler auszuloesen', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(() => {
    window.__escSeen = 0;
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.__escSeen++; });
    window.dispatchEvent(new CustomEvent('palette:open'));
  });
  const input = page.locator('.palette-input');
  await expect(input).toBeVisible();
  await input.fill('einst');
  await input.press('Escape');
  await expect(input).toBeHidden();
  expect(await page.evaluate(() => window.__escSeen)).toBe(0);
});

// Volltext `?`: Textstellen und übrige Arten kommen aus zwei Anfragen mit festen
// Plätzen — acht Figuren-Treffer verdrängen den Abschnitt nicht. Meldet der
// Server weitere Treffer, öffnet die letzte Zeile die Suchkarte mit der Anfrage.
test('Volltext: Abschnitt bleibt neben vielen Figuren sichtbar, «Alle Treffer» öffnet die Suche', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const seen = [];
  await page.route('**/search?*', (route) => {
    const u = new URL(route.request().url());
    const kinds = u.searchParams.get('kind') || '';
    seen.push(kinds);
    const hit = (kind, i, title) => ({ kind, entity_id: i, nav_id: i, book_id: bookId, title, snippet: '', rank: -1 });
    const body = kinds.startsWith('page')
      ? { hits: [hit('page', 901, 'Die Textstelle')], more: true }
      : { hits: Array.from({ length: 8 }, (_, i) => hit('figure', 100 + i, 'Figur ' + i)), more: false };
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('palette:open')));
  const input = page.locator('.palette-input');
  await input.fill('? textstelle');
  const items = page.locator('.palette-item');
  await expect(items.filter({ hasText: 'Die Textstelle' })).toBeVisible();
  const all = items.filter({ hasText: 'Alle Treffer in der Suche öffnen' });
  await expect(all).toBeVisible();
  // 1 Abschnitt + 7 Figuren + «Alle Treffer».
  await expect(items).toHaveCount(9);

  await all.click();
  await expect(input).toBeHidden();
  await expect(page.locator('.search-q')).toHaveValue('textstelle');
  await expect.poll(() => seen.some(k => k.includes('page') && k.includes('figure'))).toBe(true);
});
