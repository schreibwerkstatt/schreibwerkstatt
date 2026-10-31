// Bücher aus lauter Ein-Abschnitt-Kapiteln (Kurzgeschichten-Sammlung, Roman mit
// einem Abschnitt je Kapitel) gegen die ECHTE App: Sidebar-Zeile, Anlegen beim
// Klick auf ein leeres Kapitel, Namen angleichen. Eigenes Wegwerf-Buch — das
// Seed-Buch hat Mehr-Abschnitt-Kapitel und schaltet die Ein-Abschnitt-Logik ab.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard.js');
const { bootApp } = require('./_helpers/app.js');

const TEMP_BOOK = 'zz-Ein-Abschnitt-Testbuch';

async function seedSingleSectionBook(page) {
  return page.evaluate(async (name) => {
    const { contentRepo } = await import('/js/repo/content.js');
    const r = await fetch('/content/books', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new Error('Buch anlegen fehlgeschlagen: HTTP ' + r.status);
    const bookId = (await r.json()).id;
    const mk = async (chapter, pageName) => {
      const ch = await contentRepo.createChapter({ book_id: bookId, name: chapter });
      const pg = pageName == null ? null
        : await contentRepo.createPage({ book_id: bookId, chapter_id: ch.id, name: pageName, html: '<p>x</p>' });
      return { chapterId: ch.id, pageId: pg?.id ?? null };
    };
    return {
      bookId,
      same: await mk('Prolog', 'Prolog'),
      other: await mk('Kapitel 2: Das erste Date', 'Kapitel 2'),
      empty: await mk('Kapitel 3', null),
    };
  }, TEMP_BOOK);
}

async function openBook(page, bookId) {
  await page.evaluate(() => window.__app.loadBooks({ fresh: true, skipPages: true }));
  await page.evaluate((id) => { location.hash = '#book/' + id; }, bookId);
  await page.waitForFunction(
    (id) => String(window.Alpine.store('nav').selectedBookId) === String(id)
            && (window.Alpine.store('nav').pages || []).length >= 2,
    bookId, { timeout: 20000 },
  );
}

test.afterEach(async ({ page }) => {
  await page.evaluate(async (name) => {
    const b = (window.Alpine.store('nav').books || []).find(x => x.name === name);
    if (b) await fetch('/content/books/' + b.id, { method: 'DELETE', credentials: 'same-origin' });
  }, TEMP_BOOK).catch(() => {});
});

test('Klick auf ein leeres Kapitel legt den gleichnamigen Abschnitt an und oeffnet ihn', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const seed = await seedSingleSectionBook(page);
  await openBook(page, seed.bookId);

  await page.locator('.tree-chapter-header', { hasText: 'Kapitel 3' }).click();
  await page.waitForFunction((cid) =>
    (window.Alpine.store('nav').pages || []).some(p => p.chapter_id === cid && p.name === 'Kapitel 3'),
  seed.empty.chapterId, { timeout: 10000 });
  // Kein Umweg ueber die Namensabfrage der Kapitelbewertung.
  await expect(page.locator('.card--kapitel')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__app.currentPage?.name)).toBe('Kapitel 3');
  guard.assertClean('empty chapter creates section');
});

test('Ein-Abschnitt-Zeile: Namen angleichen, nur ein Loeschen-Eintrag', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const seed = await seedSingleSectionBook(page);
  await openBook(page, seed.bookId);

  const otherRow = page.locator(`.page-item[data-page-id="${seed.other.pageId}"]`);
  await expect(otherRow.locator('.page-item-section-name')).toHaveText('Kapitel 2');

  await otherRow.click({ button: 'right' });
  const menu = page.locator('.context-menu:visible');
  await expect(menu.getByText('Abschnittsnamen an Kapitel angleichen')).toBeVisible();
  await expect(menu.getByText('Abschnitt löschen …')).toBeHidden();
  await expect(menu.getByText('Kapitel löschen …')).toBeVisible();
  await menu.getByText('Abschnittsnamen an Kapitel angleichen').click();

  await expect(otherRow.locator('.page-item-section-name')).toBeHidden();
  await expect.poll(() => page.evaluate((id) =>
    window.Alpine.store('nav').pages.find(p => p.id === id)?.name, seed.other.pageId))
    .toBe('Kapitel 2: Das erste Date');

  // Gleichnamige Zeile bietet das Angleichen nicht an.
  await page.keyboard.press('Escape');
  await page.locator(`.page-item[data-page-id="${seed.same.pageId}"]`).click({ button: 'right' });
  await expect(page.locator('.context-menu:visible').getByText('Abschnittsnamen an Kapitel angleichen')).toBeHidden();
  await page.keyboard.press('Escape');
  guard.assertClean('align titles');
});
