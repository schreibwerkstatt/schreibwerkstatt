// Seitenbaum der Sidebar gegen die ECHTE App (sidebar.html + book/tree/*).
//
// WARUM DIESE SCHICHT: die Zusagen haengen am gerenderten Template-Baum
// (x-for mit x-show, gebundene tabindex/href, Fokus) und an der echten
// Ladepipeline (loadPages mit SW-Quelle, Fehlerpfad) — ein Harness hat beides nicht.
//
// Geprüfte Zusagen:
//   1. Seiten sind echte Links auf ihre Hash-Route; ein normaler Klick öffnet
//      die Seite in der App.
//   2. Der Baum hat genau EINEN Tab-Stopp; Pfeiltasten wandern, ← springt zum
//      Kapitel, ←/→ klappen ein offenes/zugeklapptes Kapitel.
//   3. Die Suche findet Kapitelnamen und zeigt dann alle Seiten des Kapitels.
//   4. Eine Seite, die von ausserhalb des Baums geöffnet wird, deckt ihr
//      zugeklapptes Kapitel auf.
//   5. Ein Reload desselben Buchs (Job/Wake) behält Suche und Baum; ein
//      gescheiterter Reload leert den Baum nicht und meldet `false`.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const TREE = '#partial-sidebar [role="tree"]';

async function chapterByName(page, name) {
  return page.evaluate((n) => {
    const it = window.Alpine.store('nav').tree.find(i => !i.solo && i.name === n);
    return it ? { id: it.id, pageIds: it.pages.map(p => p.id) } : null;
  }, name);
}

test.describe('Seitenbaum', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page);
    await selectSeededBook(page);
    await page.waitForSelector(`${TREE} a.page-item`);
  });

  test('Seiten sind Links, Klick öffnet in der App', async ({ page }) => {
    const ch = await chapterByName(page, 'Kapitel 2');
    expect(ch).not.toBeNull();
    const pid = ch.pageIds[0];
    const bookId = await page.evaluate(() => window.Alpine.store('nav').selectedBookId);
    const link = page.locator(`${TREE} a.page-item[data-page-id="${pid}"]`);
    await expect(link).toHaveAttribute('href', `#book/${bookId}/page/${pid}`);
    await expect(link).toHaveAttribute('role', 'treeitem');
    await link.click();
    await page.waitForFunction((id) => window.__app.currentPage?.id === id, pid);
    await expect(link).toHaveAttribute('aria-current', 'page');
  });

  test('ein Tab-Stopp, Pfeiltasten wandern und klappen', async ({ page }) => {
    await expect(page.locator(`${TREE} [data-tree-key][tabindex="0"]`)).toHaveCount(1);
    const ch = await chapterByName(page, 'Kapitel 1');
    const header = page.locator(`${TREE} [data-tree-key="c${ch.id}"]`);
    const firstPage = page.locator(`${TREE} [data-tree-key="p${ch.pageIds[0]}"]`);
    await page.evaluate(() => window.__app.setAllChaptersOpen(true));

    await header.focus();
    await page.keyboard.press('ArrowDown');
    await expect(firstPage).toBeFocused();
    await expect(page.locator(`${TREE} [data-tree-key][tabindex="0"]`)).toHaveCount(1);
    await expect(firstPage).toHaveAttribute('tabindex', '0');

    // ← auf einer Seite → Kapitelkopf; ← auf offenem Kapitel → zu; → → auf.
    await page.keyboard.press('ArrowLeft');
    await expect(header).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(firstPage).toBeHidden();
    await page.keyboard.press('ArrowRight');
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(firstPage).toBeVisible();
  });

  test('Suche findet Kapitelnamen', async ({ page }) => {
    const ch = await chapterByName(page, 'Kapitel 2');
    await page.fill('#partial-sidebar .page-search', 'Kapitel 2');
    for (const pid of ch.pageIds) {
      await expect(page.locator(`${TREE} a.page-item[data-page-id="${pid}"]`)).toBeVisible();
    }
    const other = await chapterByName(page, 'Kapitel 1');
    await expect(page.locator(`${TREE} a.page-item[data-page-id="${other.pageIds[0]}"]`)).toHaveCount(0);
  });

  test('von aussen geöffnete Seite deckt ihr Kapitel auf', async ({ page }) => {
    const ch = await chapterByName(page, 'Kapitel 2');
    const pid = ch.pageIds[ch.pageIds.length - 1];
    await page.evaluate((id) => {
      const it = window.Alpine.store('nav').tree.find(i => i.id === id);
      window.__app.setChapterOpen(it, false);
    }, ch.id);
    const link = page.locator(`${TREE} a.page-item[data-page-id="${pid}"]`);
    await expect(link).toBeHidden();
    const bookId = await page.evaluate(() => window.Alpine.store('nav').selectedBookId);
    await page.evaluate(([b, p]) => { location.hash = `#book/${b}/page/${p}`; }, [bookId, pid]);
    await page.waitForFunction((id) => window.__app.currentPage?.id === id, pid);
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('tabindex', '0');
  });

  test('Reload desselben Buchs behält Suche und Baum, auch bei Fehler', async ({ page, consoleGuard }) => {
    await page.fill('#partial-sidebar .page-search', 'Kapitel');
    await page.waitForFunction(() => window.__app.pageSearch === 'Kapitel');
    const ok = await page.evaluate(() => window.__app.loadPages({ source: 'job' }));
    expect(ok).toBe(true);
    expect(await page.evaluate(() => window.__app.pageSearch)).toBe('Kapitel');
    await expect(page.locator('#partial-sidebar .card.tree-card--loading')).toHaveCount(0);

    // Gescheiterter Reload (Wake ohne Netz → SW/Server 503): Baum bleibt stehen.
    consoleGuard.ignore(/\[loadPages\]|503|Failed to load resource/);
    const before = await page.evaluate(() => window.Alpine.store('nav').tree.length);
    await page.route('**/content/books/*/tree*', route => route.fulfill({ status: 503, body: '{"error":"offline"}', contentType: 'application/json' }));
    const res = await page.evaluate(() => window.__app.loadPages({ source: 'wake' }));
    await page.unroute('**/content/books/*/tree*');
    expect(res).toBe(false);
    expect(await page.evaluate(() => window.Alpine.store('nav').tree.length)).toBe(before);
    await expect(page.locator(`${TREE} a.page-item`).first()).toBeVisible();
  });
});
