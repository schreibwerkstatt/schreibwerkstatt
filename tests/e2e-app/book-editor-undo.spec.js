// Bucheditor Undo/Redo gegen die ECHTE App: eigener Verlauf pro Seite
// (public/js/cards/book-editor/history.js) statt des nativen Browser-Stacks.
//
// Warum E2E: die Fehlerklassen hängen am echten contenteditable — ein
// natives Undo, das Chromium auf eine bereits verlassene Seite anwendet, und
// Range-Replace, das am Browser-Stack vorbeiläuft. Beides sieht kein Unit-Test.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');

test.describe.configure({ mode: 'serial' });

const card = (page) => page.locator('.card--bookeditor');
const bodies = (page) => card(page).locator('.book-editor-page-body');
const data = (page, fn, arg) => page.evaluate(
  ([src, a]) => new Function('d', 'a', `return (${src})(d, a)`)(
    window.Alpine.$data(document.querySelector('.card--bookeditor')), a),
  [fn.toString(), arg],
);

async function openBookEditor(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__app && Array.isArray(window.Alpine.store('nav').books) && window.Alpine.store('nav').books.length > 0,
    null, { timeout: 30000 },
  );
  const bookId = await page.evaluate(() => window.Alpine.store('nav').books[0].id);
  await page.evaluate((id) => { location.hash = '#book/' + id; }, bookId);
  await page.waitForFunction(
    (id) => String(window.Alpine.store('nav').selectedBookId) === String(id)
            && Array.isArray(window.Alpine.store('nav').pages) && window.Alpine.store('nav').pages.length > 0,
    bookId, { timeout: 20000 },
  );
  await page.evaluate(() => window.__app.toggleBookEditorCard());
  await expect(bodies(page).first()).toBeVisible({ timeout: 15000 });
}

// Block aktivieren und warten, bis er fokussiert ist (Fokus kommt im $nextTick).
async function activate(page, i) {
  const body = bodies(page).nth(i);
  await body.click();
  await expect(body).toHaveAttribute('contenteditable', 'true');
  await expect.poll(
    () => page.evaluate((idx) => document.activeElement === document.querySelectorAll('.book-editor-page-body')[idx], i),
    { timeout: 5000 },
  ).toBe(true);
  return body;
}

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test('Strg+Z nimmt Getipptes zurück, Strg+Shift+Z stellt es wieder her', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await openBookEditor(page);
  const body = await activate(page, 0);
  const before = await body.innerHTML();

  await page.keyboard.type('UNDOPROBE ');
  await expect(body).toContainText('UNDOPROBE');
  expect(await data(page, (d) => d.bookEditorCanUndo())).toBe(true);

  await page.keyboard.press(`${mod}+z`);
  await expect(body).not.toContainText('UNDOPROBE');
  expect(await body.innerHTML()).toBe(before);
  expect(await data(page, (d) => d.bookEditorCanRedo())).toBe(true);

  await page.keyboard.press(`${mod}+Shift+z`);
  await expect(body).toContainText('UNDOPROBE');
  // Restore läuft durch _onBlockInput: block.html folgt dem DOM.
  expect(await data(page, (d) => d.blocks.find(b => b.pageId === d.activePageId).html)).toContain('UNDOPROBE');
  guard.assertClean('Bucheditor: Undo/Redo Tippen');
});

test('Undo nach Seitenwechsel lässt die verlassene Seite unberührt', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await openBookEditor(page);
  test.skip(await bodies(page).count() < 2, 'Testbuch braucht zwei Seiten');

  const a = await activate(page, 0);
  await page.keyboard.type('SEITEA ');
  const aPageId = await data(page, (d) => d.activePageId);

  const b = await activate(page, 1);
  await page.keyboard.type('SEITEB ');

  // Mehr Strg+Z als Schritte auf B: das native Undo würde den Überhang auf A
  // anwenden. Der eigene Verlauf bleibt auf B.
  for (let i = 0; i < 4; i++) await page.keyboard.press(`${mod}+z`);
  await expect(b).not.toContainText('SEITEB');
  await expect(a).toContainText('SEITEA');
  expect(await data(page, (d, id) => d.blocks.find(x => x.pageId === id).html, aPageId)).toContain('SEITEA');
  expect(await data(page, (d, id) => d.blocks.find(x => x.pageId === id).html, aPageId)).not.toContain('mermaid-render');

  // Zurück auf A: dessen Verlauf ist noch da.
  await activate(page, 0);
  await page.keyboard.press(`${mod}+z`);
  await expect(a).not.toContainText('SEITEA');
  guard.assertClean('Bucheditor: Undo nach Seitenwechsel');
});

test('Ersetzen im aktiven Block ist ein eigener Undo-Schritt', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await openBookEditor(page);
  const body = await activate(page, 0);
  await page.keyboard.type('ERSETZMICH ');

  await data(page, (d) => { d.openFind(); d.findTerm = 'ERSETZMICH'; d.findReplace = 'ERSETZT'; d.recomputeFindMatches(); });
  await expect.poll(() => data(page, (d) => d.findMatches.length), { timeout: 5000 }).toBeGreaterThan(0);
  await data(page, (d) => d.replaceAll());
  await expect(body).toContainText('ERSETZT');

  await data(page, (d) => d.bookEditorUndo());
  await expect(body).toContainText('ERSETZMICH');
  await expect(body).not.toContainText('ERSETZT ');
  await data(page, (d) => d.bookEditorUndo());
  await expect(body).not.toContainText('ERSETZMICH');
  guard.assertClean('Bucheditor: Replace + Undo');
});
