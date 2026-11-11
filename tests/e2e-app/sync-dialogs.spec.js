// Blog-Sync-Dialoge (partials/sync-dialogs.html) gegen die ECHTE App.
//
// Warum hier: beide Dialoge haengen am Root und werden lazy geladen; frueher
// lag der Konflikt-Diff in der Buchorganizer-Karte und blieb unsichtbar, wenn er
// bei geschlossenem Organizer (aus dem Notebook-Editor) aufging. Das sieht nur
// die gebootete App mit vollem CSS und echtem Template-Baum.
// Server-Seite des Blogs (/links, /remote) per page.route: geprueft wird das
// Frontend, nicht WordPress.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard.js');
const { bootApp, selectSeededBook } = require('./_helpers/app.js');

async function connectFakeBlog(page, { linked = true, conflict = false } = {}) {
  const { bookId, pageId } = await page.evaluate(() => ({
    bookId: Alpine.store('nav').selectedBookId,
    pageId: (Alpine.store('nav').pages || [])[0]?.id,
  }));
  expect(pageId).toBeTruthy();
  const past = '2020-01-01T00:00:00.000Z';
  const future = '2999-01-01T00:00:00.000Z';
  await page.route(`**/blog/${bookId}/links`, route => route.fulfill({
    json: {
      connected: true, baseUrl: 'https://wp.example',
      links: linked ? [{
        page_id: pageId, blog_id: 1, wp_post_id: 77, wp_status: 'draft',
        last_pulled_at: past, last_pushed_at: past,
        conflict_state: conflict ? 'detected' : null, locked_blocks: null,
      }] : [],
    },
  }));
  await page.route(`**/blog/${bookId}/pages/${pageId}/remote`, route => route.fulfill({
    json: { remoteId: 77, title: 'Im Blog', html: '<p>Alter Satz im Blog.</p>', modifiedAt: future },
  }));
  await page.evaluate(() => window.__blogCard.loadLinks());
  await page.waitForFunction(() => window.__blogCard?.connected === true);
  return { bookId, pageId };
}

test('Push-Dialog: Vorschau gegen den Blog, Status, Veroeffentlichen/Planen; Esc schliesst', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  const { pageId } = await connectFakeBlog(page);

  await page.evaluate((id) => window.__blogCard.push(id), pageId);
  const dlg = page.locator('dialog.sync-push-dialog').first();
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.badge--remote-draft')).toBeVisible();
  // Diff: der Blogstand steht als entfernt (del) im Wort-Diff.
  await expect(dlg.locator('.sync-push-diff del, .sync-push-diff .diff-del').first()).toBeVisible();
  await expect(dlg.getByRole('button', { name: /veröffentlichen|publish/i })).toBeVisible();
  await expect(dlg.locator('input[type="datetime-local"]')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  expect(await page.evaluate(() => window.__blogCard.pushDialog)).toBeNull();
  guard.assertClean();
});

test('Konflikt-Diff geht auch bei geschlossenem Buchorganizer auf', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  const { pageId } = await connectFakeBlog(page, { conflict: true });
  expect(await page.evaluate(() => !!window.__app.showBookOrganizerCard)).toBe(false);

  await page.evaluate((id) => window.__blogCard.openConflict(id), pageId);
  const dlg = page.locator('dialog.sync-conflict-dialog').first();
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.sync-conflict-content').nth(1)).toContainText('Alter Satz im Blog.');
  await dlg.getByRole('button', { name: /abbrechen|cancel/i }).click();
  await expect(dlg).toBeHidden();
  guard.assertClean();
});
