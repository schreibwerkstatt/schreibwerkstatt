// E2E-Smoke der Ereignisse-Karte.
//
// Lädt eine Harness-Page, die `ereignisseCard` mit Mock-Daten (Mix aus
// Punkt-, Spannen-, Unknown- und 'sonstiges'-Events) gegen ein minimales
// Root mountet. Tests prüfen Render-Pfad: Subtyp-Icon-Mapping, Spannen-CSS,
// Unbekannt-Bucket-Klasse, Subtyp-Filter, und dass die formatEventDate-
// Logik die strukturierten Felder korrekt rendert.

const { test, expect } = require('./_helpers/fixtures');

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/ereignisse-harness.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
});

test('rendert alle Mock-Events mit korrekten Subtyp-Icons', async ({ page }) => {
  // Karte ist sichtbar — Filter-Count zeigt 5/5.
  await expect(page.locator('[data-test="filter-count"]')).toHaveText('5 / 5');

  // Subtyp → Icon-Mapping pro Event.
  const cases = [
    { id: 1, icon: 'heart' },        // hochzeit
    { id: 2, icon: 'plane' },        // reise
    { id: 3, icon: 'skull' },        // tod
    { id: 4, icon: 'more-horizontal' }, // sonstiges
    { id: 5, icon: 'landmark' },     // extern_politisch
  ];
  for (const { id, icon } of cases) {
    const item = page.locator(`[data-test="event-${id}"]`);
    await expect(item).toBeVisible();
    // <svg data-test-icon="…"> trägt die geplante Icon-ID.
    const svg = item.locator('svg.gz-subtyp-icon');
    await expect(svg).toHaveAttribute('data-test-icon', icon);
    // <use href> referenziert das passende Sprite-Symbol.
    const useHref = await svg.locator('use').getAttribute('href');
    expect(useHref).toBe(`/public/icons.svg#${icon}`);
  }
});

test('Spannen-Event hat gz-item--span + --span-years Custom-Prop', async ({ page }) => {
  const span = page.locator('[data-test="event-2"]');     // Reise 1851–1853
  await expect(span).toHaveClass(/gz-item--span/);
  // --span-years = (1853-1851) = 2.
  const styleAttr = await span.getAttribute('style');
  expect(styleAttr || '').toMatch(/--span-years:\s*2/);

  // Punkt-Event hat KEINE Span-Klasse.
  const punkt = page.locator('[data-test="event-1"]');
  await expect(punkt).not.toHaveClass(/gz-item--span/);
});

test('Unknown-Date-Event hat gz-item--unknown', async ({ page }) => {
  const unknown = page.locator('[data-test="event-4"]'); // Vorfall, kein datum_year
  await expect(unknown).toHaveClass(/gz-item--unknown/);
  // Datum-Anzeige fällt auf datum_label zurück.
  await expect(unknown.locator('.gz-datum')).toHaveText('vor der Reise');
});

test('Subtyp-Filter beschränkt sichtbare Events auf gewählten Subtyp', async ({ page }) => {
  await page.locator('[data-test="subtyp-filter"]').selectOption('hochzeit');
  await expect(page.locator('[data-test="filter-count"]')).toHaveText('1 / 5');
  await expect(page.locator('[data-test="event-1"]')).toBeVisible();
  await expect(page.locator('[data-test="event-2"]')).not.toBeVisible();
  await expect(page.locator('[data-test="event-3"]')).not.toBeVisible();

  // Filter zurücksetzen.
  await page.locator('[data-test="subtyp-filter"]').selectOption('');
  await expect(page.locator('[data-test="filter-count"]')).toHaveText('5 / 5');

  // Subtyp 'sonstiges' matcht das Event ohne explizites subtyp-Feld.
  await page.locator('[data-test="subtyp-filter"]').selectOption('sonstiges');
  await expect(page.locator('[data-test="filter-count"]')).toHaveText('1 / 5');
  await expect(page.locator('[data-test="event-4"]')).toBeVisible();
});

test('Subtyp-Badge-Klasse spiegelt Subtyp wider', async ({ page }) => {
  const hochzeit = page.locator('[data-test="event-1"]');
  await expect(hochzeit).toHaveClass(/gz-item--subtyp-hochzeit/);
  // CSS-Custom-Prop --gz-subtyp-color setzt sich durch die Variant-Klasse.
  const color = await hochzeit.evaluate(el => getComputedStyle(el).getPropertyValue('--gz-subtyp-color'));
  expect(color.trim()).not.toBe('');
});

test('formatEventDate rendert Punkt-, Spannen- und Unbekannt-Datum korrekt', async ({ page }) => {
  // Punkt 12. Mai 1850 → "12.05.1850" (über padStart in der formatEventDate-Logik).
  await expect(page.locator('[data-test="event-1"] .gz-datum')).toHaveText('12.05.1850');
  // Spanne 1851–1853 — Format-String aus i18n; Harness-i18n gibt Key zurück.
  // Format ist 'events.span {"start":"1851","ende":"1853"}' — wichtig ist nur,
  // dass beide Jahreszahlen erscheinen.
  const spanText = await page.locator('[data-test="event-2"] .gz-datum').textContent();
  expect(spanText).toContain('1851');
  expect(spanText).toContain('1853');
});
