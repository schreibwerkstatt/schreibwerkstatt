// Find-Leiste (Notebook-Editor) vs. Leiste neben dem Editor: die Leiste ist
// position:fixed und an die Editor-Karte gekoppelt. Oeffnet eine Leiste
// (Abschnitts-Chat, Ideen), schrumpft die Editor-Karte — die Find-Leiste muss
// mitwandern, sonst steht sie ueber dem Panel. Beim Schliessen muss sie
// zurueckwandern.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

// Rechte Kante der Find-Leiste und der Editor-Karte.
async function geo(page) {
  return page.evaluate(() => {
    const find = document.querySelector('.edit-find');
    const card = document.querySelector('#editor-card');
    if (!find || !card) return null;
    const f = find.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    return { findRight: f.right, cardRight: c.right };
  });
}

// Klebt die Find-Leiste an der rechten Kante der Editor-Karte (12px Abstand)?
async function anchored(page) {
  return page.evaluate(() => {
    const find = document.querySelector('.edit-find');
    const card = document.querySelector('#editor-card');
    if (!find || !card) return false;
    const f = find.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    return Math.abs((c.right - 12) - f.right) < 1.5;
  });
}

// Editor im Edit-Modus oeffnen (die Find-Leiste existiert nur dort).
async function openEditor(page) {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector('#editor-card .page-content-view--editing', { timeout: 15000 });
}

test('Find-Leiste wandert mit der Editor-Karte, wenn eine Leiste aufgeht', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await openEditor(page);

  await page.keyboard.press('Control+F');
  await expect(page.locator('.edit-find')).toBeVisible();

  const before = await geo(page);
  expect(await anchored(page), 'Find-Leiste klebt nicht an der Editor-Karte').toBe(true);

  // Abschnitts-Chat geht auf: die Editor-Karte wird schmaler.
  await page.evaluate(() => window.__app.toggleChatCard());
  await expect(page.locator('#chat-card')).toBeVisible();
  await expect.poll(async () => (await geo(page)).cardRight).toBeLessThan(before.cardRight);
  await expect.poll(() => anchored(page), { message: 'Find-Leiste zieht nicht nach' }).toBe(true);

  // Chat schliessen: die Find-Leiste muss zurueckwandern.
  await page.evaluate(() => window.__app.toggleChatCard());
  await expect(page.locator('#chat-card')).toBeHidden();
  await expect.poll(async () => (await geo(page)).cardRight).toBeCloseTo(before.cardRight, 0);
  await expect.poll(() => anchored(page), { message: 'Find-Leiste kommt nicht zurueck' }).toBe(true);
});

test('Find-Leiste wandert auch mit der Ideen-Karte mit', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await openEditor(page);

  await page.keyboard.press('Control+F');
  await expect(page.locator('.edit-find')).toBeVisible();
  const before = await geo(page);

  await page.evaluate(() => window.__app.toggleIdeenCard());
  await expect(page.locator('#ideen-card')).toBeVisible();
  await expect.poll(async () => (await geo(page)).cardRight).toBeLessThan(before.cardRight);
  await expect.poll(() => anchored(page), { message: 'Find-Leiste zieht nicht nach' }).toBe(true);

  await page.evaluate(() => window.__app.toggleIdeenCard());
  await expect(page.locator('#ideen-card')).toBeHidden();
  await expect.poll(async () => (await geo(page)).cardRight).toBeCloseTo(before.cardRight, 0);
  await expect.poll(() => anchored(page), { message: 'Find-Leiste kommt nicht zurueck' }).toBe(true);
});
