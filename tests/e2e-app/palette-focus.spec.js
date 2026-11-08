// Command-Palette: das Suchfeld muss beim Öffnen SYNCHRON den Fokus bekommen —
// noch im selben Klick-/Tasten-Handler. iOS/iPadOS öffnet die Bildschirm-
// tastatur nur, wenn focus() im Aufruf-Stack der Geste läuft; ein Fokus erst in
// $nextTick setzt zwar activeElement, lässt die Tastatur aber zu. Deshalb wird
// hier direkt nach dem dispatch geprüft, ohne zu warten (palette-card.js#
// _focusPaletteInputNow). Mutationsgeprüft: mit Fokus nur in $nextTick fallen
// beide Fälle.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp } = require('./_helpers/app');

test('Palette: Klick auf den Hero fokussiert das Suchfeld synchron', async ({ page }) => {
  await bootApp(page);
  const focusedInSameTask = await page.evaluate(() => {
    document.querySelector('.palette-hero').click();
    return document.activeElement?.classList.contains('palette-input') === true;
  });
  expect(focusedInSameTask).toBe(true);
  await expect(page.locator('.palette-input')).toBeFocused();
  await page.keyboard.type('fig');
  await expect(page.locator('.palette-input')).toHaveValue('fig');
});

test('Palette: Cmd/Ctrl+K fokussiert das Suchfeld synchron, auch aus einem Feld heraus', async ({ page }) => {
  await bootApp(page);
  await page.locator('.page-search').first().focus();
  const focusedInSameTask = await page.evaluate(() => {
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'k', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    return document.activeElement?.classList.contains('palette-input') === true;
  });
  expect(focusedInSameTask).toBe(true);
  await expect(page.locator('.palette-input')).toBeFocused();
});
