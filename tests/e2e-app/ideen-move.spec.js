// „Verschieben" auf der IDEEN-KARTE gegen die echte App: eine Kapitel-Idee zieht
// über den Picker in einen Abschnitt — die Ankerart wechselt, der alte Anker
// wird geleert (routes/ideen.js PATCH, app.js#ideenMovePickerOptions).
//
// Warum e2e-app: der Picker ist eine Combobox in einer Sub-x-data, deren Optionen
// über $app aus dem echten Baum kommen — ob die Gruppen samt Abschnitten dort
// ankommen, sieht nur die gebootete App.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

let createdIdeeId = null;

test.afterAll(async ({ browser }) => {
  if (!createdIdeeId) return;
  const page = await browser.newPage();
  try {
    await page.goto('/');
    await page.waitForFunction(() => window.__app && window.Alpine.store('nav').selectedBookId);
    await page.evaluate((id) => fetch(`/ideen/${id}`, { method: 'DELETE' }), createdIdeeId);
  } finally {
    await page.close();
  }
});

test('ideen-karte: Kapitel-Idee per Picker in einen Abschnitt verschieben', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  const made = await page.evaluate(async (id) => {
    const tree = await fetch(`/content/books/${id}/tree`).then(r => r.json());
    const chapter = tree.chapters.find(c => c.pages?.length);
    const target = chapter.pages[0];
    const idee = await fetch('/ideen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: id, chapter_id: chapter.id, content: 'Zeitangabe im Kapitel prüfen' }),
    }).then(r => r.json());
    return { chapterId: chapter.id, pageId: target.id, pageName: target.name, ideeId: idee.id };
  }, bookId);
  createdIdeeId = made.ideeId;

  await page.evaluate((cid) => window.__app.toggleChapterIdeenCard(cid), made.chapterId);
  const card = page.locator('#ideen-card');
  const item = card.locator(`[data-idee-id="${made.ideeId}"]`);
  await expect(item).toBeVisible();

  const trigger = item.locator('.idee-menu button');
  const tr = await trigger.boundingBox();
  await trigger.click();
  await page.getByRole('menuitem', { name: 'Verschieben' }).click();

  // Verschieben ist ein Popover wie das Verknuepfen, verankert am Menue-KNOPF
  // der Idee — nicht am Menue-Eintrag, der mit dem Menue verschwindet (sonst
  // stuende das Popover unter dem Menue statt an der Idee).
  const panel = page.locator('.idee-move-popover');
  await expect(panel).toBeVisible();
  const pr = await panel.boundingBox();
  const above = pr.y + pr.height <= tr.y;
  expect(Math.abs(above ? tr.y - (pr.y + pr.height) : pr.y - (tr.y + tr.height))).toBeLessThanOrEqual(8);
  await expect(panel.locator('.picker-popover__subject')).toHaveText('Zeitangabe im Kapitel prüfen');
  await panel.locator('.combobox-trigger').click();
  // Abschnitte stehen neben den Kapiteln — der eigene Kapitel-Anker fehlt.
  const option = panel.locator('.combobox-option', { hasText: made.pageName })
    .filter({ hasNotText: 'ganzes Kapitel' }).first();
  await expect(option).toBeVisible();
  await option.click();
  await panel.getByRole('button', { name: 'Verschieben' }).click();

  await expect(item).toHaveCount(0);
  const moved = await page.evaluate(async ({ pid, iid }) => {
    const rows = await fetch(`/ideen?page_id=${pid}`).then(r => r.json());
    return (Array.isArray(rows) ? rows : rows.ideen || []).find(r => r.id === iid) || null;
  }, { pid: made.pageId, iid: made.ideeId });
  expect(moved?.page_id).toBe(made.pageId);
  expect(moved?.chapter_id).toBeNull();
});
