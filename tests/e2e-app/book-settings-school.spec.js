// Bucheinstellungen › Reiter «Schule» gegen die ECHTE App
// (docs/figur-lebenslauf.md «Schullaufbahn»): Schalter ein (HarmoS als Start),
// Vorlage per Combobox wechseln, Stufen-Jahre erscheinen, Speichern schreibt ueber
// /booksettings/:id/schulsystem und die Antwort kommt normalisiert zurueck.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('schulsystem: Vorlage waehlen, Jahre editieren, speichern', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  await page.evaluate(() => window.__app.toggleBookSettingsCard());
  const card = page.locator('.card--settings');
  await expect(card).toBeVisible();
  await card.locator('.tabs-btn', { hasText: 'Schule' }).click();

  const section = card.locator('.book-settings-section', { hasText: 'Schulsystem' });
  await expect(section).toBeVisible();
  // Aus: nur der Schalter, keine Felder.
  await expect(section.locator('.combobox-trigger')).toHaveCount(0);
  await section.locator('#bs-schule-aktiv').check();
  await expect(section.locator('.card-form-label', { hasText: 'Kindergarten' })).toBeVisible();
  // Die Combobox schliesst bei jedem Scroll; erst die Karten-Scroll-Animation und
  // das Hineinscrollen der Sektion abwarten, dann oeffnen.
  const trigger = section.locator('.combobox-trigger').first();
  await trigger.scrollIntoViewIfNeeded();
  await expect.poll(async () => {
    const y1 = await trigger.evaluate(el => el.getBoundingClientRect().top);
    await page.waitForTimeout(150);
    return y1 === await trigger.evaluate(el => el.getBoundingClientRect().top);
  }).toBe(true);
  await trigger.click();
  await page.locator('.combobox-option', { hasText: 'CH Solothurn (1990er)' }).click();

  // Stufen der Vorlage erscheinen als Jahre-Felder, darunter das Obergymnasium.
  await expect(section.locator('.card-form-label', { hasText: 'Obergymnasium' })).toBeVisible();

  // Der Header-Knopf speichert alle Abschnitte; das Wegwerf-Buch hat keinen
  // Buchtyp und keine Kategorie, ohne die das Hauptformular nicht speichert.
  await page.evaluate(() => {
    const c = window.Alpine.$data(document.querySelector('.card--settings'));
    if (!c.bookSettingsBuchtyp) c.bookSettingsBuchtyp = 'roman';
    if ((c.categoryPool || []).length && !c.bookCategoryId) c.bookCategoryId = String(c.categoryPool[0].id);
  });
  const saved = page.waitForResponse(r => r.url().endsWith(`/booksettings/${bookId}/schulsystem`) && r.request().method() === 'PUT');
  await card.locator('.card-header button[data-label-ok]').click();
  const body = await (await saved).json();
  expect(body.schulsystem.vorlage).toBe('ch_so_1990');
  expect(body.schulsystem.jahre.obergym).toBe(4);
  expect(body.schulsystem.stichtag).toEqual({ monat: 4, tag: 30 });

  // Aufraeumen: geteiltes Wegwerf-Buch ohne Schulsystem zuruecklassen.
  await page.evaluate(async (id) => {
    await fetch(`/booksettings/${id}/schulsystem`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schulsystem: null }),
    });
  }, bookId);
});
