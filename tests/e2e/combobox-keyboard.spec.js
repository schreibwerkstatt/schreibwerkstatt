const { test, expect } = require('./_helpers/fixtures');

// Combobox-Tastatur- und Fokus-Verhalten gegen die echte Komponente (im
// Buch-erstellen-Harness, also in einem <dialog> — dort landet der Fokus beim
// Klick auf eine Option auf dem Dialog, was die Liste nicht vorzeitig
// schliessen darf).
//
// - Dropdown existiert nur, solange es offen ist (`x-if`): geschlossene
//   Comboboxen tragen weder Liste noch x-anchor-Nachfuehrung.
// - Escape/Enter geben den Fokus an den Trigger zurueck statt an <body>.
// - Tab aus dem Suchfeld schliesst die Liste.

const URL = 'http://localhost:8765/tests/fixtures/book-create-harness.html';

async function openHarness(page) {
  await page.route('**/local/categories', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ categories: [{ id: 1, name: 'Belletristik' }, { id: 2, name: 'Sachbuch' }] }),
  }));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Alpine && window.__harnessReady);
  await page.locator('#open-btn').click();
  await expect(page.locator('#book-create-dialog')).toBeVisible();
}

test('geschlossene Combobox rendert kein Dropdown', async ({ page }) => {
  await openHarness(page);
  const box = page.locator('#field-buchtyp');
  await expect(box.locator('.combobox-dropdown')).toHaveCount(0);
  await box.locator('.combobox-trigger').click();
  await expect(box.locator('.combobox-dropdown')).toBeVisible();
  await expect(box.locator('.combobox-search')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(box.locator('.combobox-dropdown')).toHaveCount(0);
});

test('Escape und Enter geben den Fokus an den Trigger zurueck', async ({ page }) => {
  await openHarness(page);
  const box = page.locator('#field-buchtyp');
  const trigger = box.locator('.combobox-trigger');

  await trigger.click();
  await expect(box.locator('.combobox-search')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await expect(box.locator('.combobox-search')).toBeFocused();
  await page.keyboard.type('Sach');
  await expect(box.locator('.combobox-option--hl')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(box.locator('.combobox-value')).toHaveText('Sachbuch');
  await expect(trigger).toBeFocused();
});

test('Tab aus dem Suchfeld schliesst die Liste', async ({ page }) => {
  await openHarness(page);
  const box = page.locator('#field-buchtyp');
  await box.locator('.combobox-trigger').click();
  await expect(box.locator('.combobox-search')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(box.locator('.combobox-dropdown')).toHaveCount(0);
});
