// Aktionsmenue (public/js/action-menu.js) gegen die echte App: ⋯-Knopf,
// Rechtsklick und Long-Press oeffnen DASSELBE Menue; Esc schliesst und gibt den
// Fokus zurueck; ein Menue, das zuletzt im Detail-Dialog aufging, kommt beim
// naechsten Oeffnen aus der Liste wieder unter <body> (sonst laege es unsichtbar
// im geschlossenen Dialog). Gegen das Shell-CSS und den echten Template-Baum,
// darum e2e-app und kein Harness.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const RUN = Date.now();
let cleanup = [];

test.afterAll(async ({ browser }) => {
  if (!cleanup.length) return;
  const page = await browser.newPage();
  try {
    await page.goto('/');
    await page.waitForFunction(() => window.__app && window.Alpine.store('nav').selectedBookId);
    for (const url of cleanup) await page.evaluate((u) => fetch(u, { method: 'DELETE' }), url);
  } finally {
    await page.close();
  }
});

const itemLabels = (menu) => menu.evaluate((el) =>
  [...el.querySelectorAll('.context-menu-item')].filter((i) => i.offsetParent !== null).map((i) => i.textContent.trim()));

test('ideen-karte: Rechtsklick zeigt dasselbe Menue wie der ⋯-Knopf, Esc gibt den Fokus zurueck', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const made = await page.evaluate(async ([id, run]) => {
    const tree = await fetch(`/content/books/${id}/tree`).then((r) => r.json());
    const pageId = tree.chapters?.[0]?.pages?.[0]?.id;
    const idee = await fetch('/ideen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: id, page_id: pageId, content: `Menue-Probe ${run}` }),
    }).then((r) => r.json());
    return { pageId, ideeId: idee.id };
  }, [bookId, RUN]);
  cleanup.push(`/ideen/${made.ideeId}`);
  await page.evaluate(async (pid) => {
    await window.__app.selectPage(window.Alpine.store('nav').pages.find((p) => p.id === pid));
  }, made.pageId);
  await page.evaluate(() => window.__app.toggleIdeenCard());

  const item = page.locator(`#ideen-card [data-idee-id="${made.ideeId}"]`);
  await expect(item).toBeVisible();
  const trigger = item.locator('.idee-menu button');
  const menu = page.locator('#ideen-card').locator('xpath=//ancestor::body').locator('.context-menu[x-ref="actionMenu"]:visible');

  await trigger.click();
  await expect(menu).toHaveCount(1);
  const viaButton = await itemLabels(menu);
  expect(viaButton.length).toBeGreaterThan(2);
  // Fokus liegt im Menue (erster Eintrag), Esc schliesst und gibt ihn zurueck.
  await expect.poll(() => menu.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await item.locator('.idee-content').click({ button: 'right' });
  await expect(menu).toHaveCount(1);
  expect(await itemLabels(menu)).toEqual(viaButton);
  // An der Maus verankert: der linke Rand liegt beim Klickpunkt, nicht am Knopf.
  const box = await item.locator('.idee-content').boundingBox();
  const mbox = await menu.boundingBox();
  expect(Math.abs(mbox.x - (box.x + box.width / 2))).toBeLessThan(box.width / 2 + 2);
  await page.mouse.click(5, 5);
  await expect(menu).toHaveCount(0);
});

test('recherche: Long-Press oeffnet das Menue; nach dem Detail-Dialog geht es in der Liste wieder sichtbar auf', async ({ browser }) => {
  test.skip(test.info().project.name !== 'chromium', 'CDP-Touch nur in Chromium');
  const ctx = await browser.newContext({ hasTouch: true });
  const page = await ctx.newPage();
  try {
    await bootApp(page);
    const bookId = await selectSeededBook(page);
    const itemId = await page.evaluate(async ([id, run]) => {
      const made = await fetch('/research', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: id, kind: 'note', title: `Menue-Probe ${run}` }),
      }).then((r) => r.json());
      return made.id;
    }, [bookId, RUN]);
    cleanup.push(`/research/${itemId}`);
    await page.evaluate((id) => { location.hash = `#book/${id}/recherche`; }, bookId);
    const row = page.locator(`[data-research-id="${itemId}"]`);
    await expect(row).toBeVisible();
    const menu = page.locator('.research-item-menu');

    // Long-Press auf die Zeile (Touch hat keinen Rechtsklick). Erst ins Bild:
    // CDP-Touch trifft Viewport-Koordinaten.
    await row.scrollIntoViewIfNeeded();
    const box = await row.locator('.research-item-title').boundingBox();
    const x = box.x + 4, y = box.y + box.height / 2;
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await page.waitForTimeout(700);
    await expect(menu).toBeVisible();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    // Der nachgereichte Klick oeffnet weder die Detailansicht noch schliesst er das Menue.
    await page.waitForTimeout(250);
    await expect(menu).toBeVisible();
    await expect(page.locator('.research-dialog[open]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    // Im Detail-Dialog oeffnen: das Menue liegt dann im Dialog (Top-Layer).
    await page.evaluate(([b, i]) => { location.hash = `#book/${b}/recherche/${i}`; }, [bookId, itemId]);
    const dlg = page.locator('.research-dialog[open]');
    await expect(dlg).toBeVisible();
    await dlg.locator('.research-dialog__actions .icon-btn[aria-haspopup="menu"]').click();
    await expect(dlg.locator('.research-item-menu')).toBeVisible();
    // Erstes Esc schliesst das Menue (und nur das), zweites den Dialog.
    await page.keyboard.press('Escape');
    await expect(dlg.locator('.research-item-menu')).toBeHidden();
    await expect(page.locator('.research-dialog[open]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.research-dialog[open]')).toHaveCount(0);

    // Zurueck in der Liste: das Menue darf nicht im geschlossenen Dialog stecken.
    await row.locator('.research-item-actions > .icon-btn[aria-haspopup="menu"]').click({ force: true });
    await expect(menu).toBeVisible();
    expect(await menu.evaluate((el) => !el.closest('dialog'))).toBe(true);
  } finally {
    await ctx.close();
  }
});
