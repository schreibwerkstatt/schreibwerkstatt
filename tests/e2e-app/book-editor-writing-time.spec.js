// Schreibzeit im Bucheditor gegen die ECHTE App (docs/book-editor.md „Schreibzeit").
//
// Warum E2E: das Flag entsteht aus zwei Komponenten — bookEditorCard setzt
// `bookEditorWriting` am Root, der Schreibzeit-Zähler (book/writing-time.js)
// liest es. Ein Tippfehler im $watch oder ein fehlender Watch-Eintrag liesse
// beide Seiten einzeln korrekt aussehen, und die Zeit würde nie gebucht.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');

const bodies = (page) => page.locator('.card--bookeditor .book-editor-page-body');
const root = (page, fn) => page.evaluate(`(${fn.toString()})(window.__app)`);

test('Bucheditor: Schreibzeit läuft nur mit aktiviertem Abschnitt, Scrollen ist keine Eingabe', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__app && Array.isArray(window.Alpine.store('nav').books) && window.Alpine.store('nav').books.length > 0,
    null, { timeout: 30000 },
  );
  const bookId = await page.evaluate(() => window.Alpine.store('nav').books[0].id);
  await page.evaluate((id) => { location.hash = '#book/' + id; }, bookId);
  await page.waitForFunction(
    (id) => String(window.Alpine.store('nav').selectedBookId) === String(id)
            && (window.Alpine.store('nav').pages || []).length > 0,
    bookId, { timeout: 20000 },
  );
  await page.evaluate(() => window.__app.toggleBookEditorCard());
  await expect(bodies(page).first()).toBeVisible({ timeout: 15000 });

  // Karte offen, aber nichts aktiviert: Lesen zählt nicht.
  expect(await root(page, (a) => a.bookEditorWriting)).toBe(false);
  expect(await root(page, (a) => a._writingTimeActive())).toBe(false);

  await bodies(page).first().click();
  await expect(bodies(page).first()).toHaveAttribute('contenteditable', 'true');
  await expect.poll(() => root(page, (a) => a.bookEditorWriting)).toBe(true);
  expect(await root(page, (a) => a._writingTimeActive())).toBe(true);

  // Scrollen frischt nur die allgemeine Aktivität auf, nicht die Eingabe.
  await root(page, (a) => { a._writingLastInput = 1; a._writingLastActivity = 1; });
  await page.mouse.wheel(0, 200);
  await expect.poll(() => root(page, (a) => a._writingLastActivity > 1)).toBe(true);
  expect(await root(page, (a) => a._writingLastInput)).toBe(1);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => root(page, (a) => a._writingLastInput > 1)).toBe(true);

  // Karte zu: kein Schreiben mehr.
  await page.evaluate(() => window.__app.toggleBookEditorCard());
  await expect.poll(() => root(page, (a) => a.bookEditorWriting)).toBe(false);
  guard.assertClean('Bucheditor: Schreibzeit');
});
