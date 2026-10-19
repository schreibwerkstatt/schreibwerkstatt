// Revisionsliste gegen die ECHTE App: eine Revision mit Quelle 'split'
// («Abschnitt teilen», lib/content-store#splitPage) zeigt Badge «Geteilt» und
// eine Entitäts-Referenz auf die andere Hälfte; der Klick darauf springt zum
// Abschnitt und öffnet NICHT die Revisionsansicht der Zeile. Eine gelöschte
// Hälfte bleibt sichtbar, aber nicht klickbar.
//
// WARUM DIESE SCHICHT: das Zusammenspiel aus klickbarer Zeile, x-entity-ref-
// Direktive und Seitenbaum sieht nur die gebootete App.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook, focusUntilItSticks } = require('./_helpers/app');

test('Split-Revision: Badge + Verweis auf die andere Hälfte, Klick springt dorthin', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const ids = await page.evaluate(() => window.Alpine.store('nav').pages.slice(0, 2).map(p => p.id));
  expect(ids.length).toBe(2);
  const [here, other] = ids;
  await page.evaluate(async (id) => {
    const p = window.Alpine.store('nav').pages.find(x => x.id === id);
    await window.__app.selectPage(p);
  }, here);
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.waitForSelector('.page-revisions-bar', { state: 'attached', timeout: 15000 });

  await page.evaluate(({ other }) => {
    window.__viewerOpened = 0;
    const comp = window.Alpine.$data(document.querySelector('.page-revisions-bar'));
    comp.openViewer = async () => { window.__viewerOpened++; };
    const now = new Date().toISOString();
    comp.revisions = [
      { id: 3, created_at: now, source: 'split', summary: `split → #${other}`, chars: 10 },
      { id: 2, created_at: now, source: 'split', summary: 'split from #999999999', chars: 10 },
      { id: 1, created_at: now, source: 'main', summary: 'before split', chars: 20 },
    ];
    comp.total = 3;
    comp.listOpen = true;
  }, { other });

  const rows = page.locator('.page-revisions-list .history-item--clickable');
  await expect(rows).toHaveCount(3);
  const splitLabel = await page.evaluate(() => window.__app.t('editor.revisions.source.split'));
  await expect(rows.nth(0).locator('.page-revisions-row__source')).toHaveText(splitLabel);
  await expect(rows.nth(2).locator('.revision-split')).toHaveCount(0);

  // Gelöschte Hälfte: Verweis da, aber nicht auflösbar.
  await expect(rows.nth(1).locator('.entity-ref')).toHaveClass(/entity-ref--unresolved/);

  // Verweis auf die vorhandene Hälfte: trägt deren Namen, Klick springt hin.
  const otherName = await page.evaluate((id) => window.Alpine.store('nav').pages.find(p => p.id === id).name, other);
  const ref = rows.nth(0).locator('.revision-split .entity-ref');
  await expect(ref).toContainText(otherName);
  await ref.click();
  await expect.poll(() => page.evaluate(() => window.__app.currentPage?.id)).toBe(other);
  expect(await page.evaluate(() => window.__viewerOpened)).toBe(0);
});

// Die Zeile hört selbst auf Enter/Space (@keydown.enter.prevent → Ansicht) —
// ohne den Stopp am Verweis-Wrapper öffnete Enter auf dem fokussierten Verweis
// die Revisionsansicht und unterdrückte den Sprung.
test('Split-Revision: Enter auf dem Verweis springt, öffnet keine Revisionsansicht', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const [here, other] = await page.evaluate(() => window.Alpine.store('nav').pages.slice(0, 2).map(p => p.id));
  await page.evaluate(async (id) => {
    await window.__app.selectPage(window.Alpine.store('nav').pages.find(x => x.id === id));
  }, here);
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.waitForSelector('.page-revisions-bar', { state: 'attached', timeout: 15000 });
  await page.evaluate(({ other }) => {
    window.__viewerOpened = 0;
    const comp = window.Alpine.$data(document.querySelector('.page-revisions-bar'));
    comp.openViewer = async () => { window.__viewerOpened++; };
    comp.revisions = [{ id: 3, created_at: new Date().toISOString(), source: 'split', summary: `split → #${other}`, chars: 10 }];
    comp.total = 1;
    comp.listOpen = true;
  }, { other });
  const ref = page.locator('.page-revisions-list .revision-split .entity-ref');
  // x-entity-ref löst den Namen asynchron auf; bis dahin ist der Knopf disabled
  // und nimmt weder Fokus noch Enter. Der Editor kann den Fokus nach dem
  // Seitenwechsel noch einmal an sich ziehen — darum nachfassen, bis er sitzt.
  await expect(ref).toBeEnabled();
  await focusUntilItSticks(ref);
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__app.currentPage?.id)).toBe(other);
  expect(await page.evaluate(() => window.__viewerOpened)).toBe(0);
});
