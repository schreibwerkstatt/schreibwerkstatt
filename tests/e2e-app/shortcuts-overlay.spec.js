// Tastenkürzel gegen die ECHTE App: das Overlay (`?`) samt nachgeladenem
// zweitem Teil, Ctrl/Cmd+Shift+F → Volltextsuche, und dass Ctrl+Enter in der
// Fassungsansicht nur die Fassung wiederherstellt, nicht zusätzlich das
// Lektorat startet.
//
// WARUM DIESE SCHICHT: das Overlay hängt an der Partial-Kaskade
// (shortcuts.html lädt shortcuts-more.html nach), die Kürzel an globalen
// Window-Listenern mehrerer Module — beides sieht nur die gebootete App.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('Overlay: beide Teile geladen, alle Texte übersetzt', async ({ page }) => {
  await bootApp(page);
  await page.keyboard.press('?');
  const dlg = page.locator('#shortcuts-dialog');
  await expect(dlg).toBeVisible();
  // Abschnitt aus dem nachgeladenen Teil.
  const bookEditorTitle = await page.evaluate(() => window.__app.t('shortcuts.section.bookEditor'));
  await expect(dlg.locator('.card-section-title', { hasText: bookEditorTitle })).toBeVisible();
  const texts = await dlg.locator('.card-section-title, .shortcuts-desc, kbd').allInnerTexts();
  expect(texts.filter(t => /^shortcuts\.[a-zA-Z.]+$/.test(t.trim()))).toEqual([]);
  expect(texts.filter(t => !t.trim())).toEqual([]);
});

test('Ctrl+Shift+F öffnet die Volltextsuche mit Fokus im Suchfeld', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  await page.keyboard.press('Control+Shift+F');
  await expect.poll(() => page.evaluate(() => !!window.__app.showSearchCard)).toBe(true);
  await expect(page.locator('.search-q')).toBeFocused();
  // Zweiter Druck lässt die Karte offen (kein Toggle).
  await page.locator('.search-q').evaluate(el => el.blur());
  await page.keyboard.press('Control+Shift+F');
  await expect(page.locator('.search-q')).toBeFocused();
  expect(await page.evaluate(() => window.__app.showSearchCard)).toBe(true);
});

test('Ctrl+Shift+F im Notebook-Editor: weder Suche noch Finder', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector('#editor-card .page-content-view--editing', { timeout: 15000 });
  await page.locator('#editor-card .page-content-view--editing').click();
  await page.keyboard.press('Control+Shift+F');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__app.showSearchCard)).toBe(false);
  expect(await page.evaluate(() => window.__app.editMode)).toBe(true);
  const findOpen = () => page.evaluate(() => {
    const el = document.querySelector('[x-data="editorFindCard"]');
    return !!(el && window.Alpine.$data(el).findOpen);
  });
  expect(await findOpen()).toBe(false);
  // Ctrl+F ohne Shift öffnet den Finder weiterhin.
  await page.keyboard.press('Control+F');
  await expect.poll(findOpen).toBe(true);
});

test('Ctrl+Enter in der Fassungsansicht: wiederherstellen, kein Lektorat', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.waitForSelector('.page-revisions-bar', { state: 'attached', timeout: 15000 });
  await page.evaluate(() => {
    window.__restored = 0;
    window.__ranCheck = 0;
    window.__app.runCheck = () => { window.__ranCheck++; };
    const comp = window.Alpine.$data(document.querySelector('.page-revisions-bar'));
    comp.restore = async () => { window.__restored++; };
    const rev = { id: 1, created_at: new Date().toISOString() };
    // Ohne Revisionen ist die Leiste (und damit der Dialog darin) ausgeblendet.
    comp.revisions = [rev];
    comp.viewerRev = rev;
    comp.viewerOpen = true;
    comp.$refs.viewerDialog.showModal();
  });
  await expect(page.locator('dialog.revision-viewer')).toBeVisible();
  await page.keyboard.press('Control+Enter');
  await expect.poll(() => page.evaluate(() => window.__restored)).toBe(1);
  expect(await page.evaluate(() => window.__ranCheck)).toBe(0);

  // Gegenprobe: Ansicht zu → Ctrl+Enter startet wieder das Lektorat.
  await page.evaluate(() => window.Alpine.$data(document.querySelector('.page-revisions-bar')).$refs.viewerDialog.close());
  await expect(page.locator('dialog.revision-viewer')).toBeHidden();
  await page.keyboard.press('Control+Enter');
  await expect.poll(() => page.evaluate(() => window.__ranCheck)).toBe(1);
  expect(await page.evaluate(() => window.__restored)).toBe(1);
});
