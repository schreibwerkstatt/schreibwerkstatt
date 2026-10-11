// Bearbeitungsstand gegen die ECHTE App (docs/bearbeitungsstand.md): Setzen per
// Rechtsklick im Seitenbaum, Anzeige an Abschnitt + Kapitelkopf, Kachel in der
// Buchübersicht. Hier statt im Harness, weil der Weg Root (Kontextmenü,
// tree/edit-status.js), Store, Sidebar-Template und Server zusammen braucht.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard.js');
const { bootApp, selectSeededBook } = require('./_helpers/app.js');

const SHOT = process.env.EDIT_STATUS_SHOTS || '';

// Erstes Kapitel mit mindestens einem Abschnitt, aufgeklappt.
async function firstChapter(page) {
  return page.evaluate(() => {
    const item = window.Alpine.store('nav').tree.find(i => i.type === 'chapter' && !i.solo && i.pages.length > 0);
    item.open = true;
    return { id: item.id, pageIds: window.__app._chapterSubtreePageIds(item) };
  });
}

async function pickStatus(page, label) {
  await page.locator('.pagetree-context-menu [role="menuitemradio"]', { hasText: label }).click();
}

test('Stand per Rechtsklick setzen: Abschnitt, Kapitel, Übersicht', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  await page.waitForFunction(() => window.Alpine.store('badges').editStatusChain.length === 4);
  // Sauberer Ausgangsstand (Spec-Reruns teilen die DB).
  await page.evaluate(async (id) => {
    const tree = window.Alpine.store('nav').tree.filter(i => i.type === 'chapter');
    for (const c of tree) await fetch('/redaktion/chapter/' + c.id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: null }),
    });
    await window.__app.refreshPageStatus(id);
  }, bookId);

  const ch = await firstChapter(page);
  const firstPage = page.locator(`.page-item[data-page-id="${ch.pageIds[0]}"]`);
  await expect(firstPage).toBeVisible();

  // Abschnitt auf «redigiert».
  await firstPage.click({ button: 'right' });
  await pickStatus(page, 'redigiert');
  await expect(firstPage).toHaveClass(/edit-status--2/);
  // Die Segment-Anzeige ist ein echtes Element mit eigenem Tooltip.
  await firstPage.locator('.edit-status-meter').hover();
  await expect(page.locator('.tip-layer.tip-visible .tip-bubble')).toHaveText(/Bearbeitungsstand: redigiert/);
  // Der runde Lektorats-Punkt nennt den Stand als erste Zeile seines Popovers.
  await firstPage.locator('.page-status-dot').hover();
  await expect(page.locator('.page-status-tip .tok-tt-row').first()).toHaveText(/Bearbeitungsstand: redigiert/);
  await page.mouse.move(0, 0);
  if (SHOT) await page.locator('#partial-sidebar').screenshot({ path: `${SHOT}/tree-page.png` });

  // Klick auf die aktive Stufe nimmt sie zurück.
  await firstPage.click({ button: 'right' });
  await expect(page.locator('.pagetree-context-menu [aria-checked="true"]')).toHaveText(/redigiert/);
  if (SHOT) {
    await page.waitForTimeout(400); // Einblend-Transition des Menüs
    await page.screenshot({ path: `${SHOT}/menu-page.png`, clip: { x: 0, y: 380, width: 640, height: 520 } });
  }
  await pickStatus(page, 'redigiert');
  await expect(firstPage).toHaveClass(/edit-status--none/);

  // Ganzes Kapitel auf «final» — Kapitelkopf zeigt den abgeleiteten Stand, und
  // die App bietet an, den Stand als Fassung festzuhalten (hier abgelehnt).
  await page.evaluate(() => {
    window.__offers = [];
    window.__app.appConfirm = async (o) => { window.__offers.push(o.message); return false; };
  });
  const header = page.locator(`.tree-chapter-header[data-tree-key="c${ch.id}"]`);
  await header.click({ button: 'right' });
  await pickStatus(page, 'final');
  await expect(header).toHaveClass(/edit-status--3/);
  await expect(firstPage).toHaveClass(/edit-status--3/);
  await header.locator('.edit-status-meter').hover();
  await expect(page.locator('.tip-layer.tip-visible .tip-bubble')).toHaveText(/Bearbeitungsstand: final/);
  if (SHOT) await page.locator('#partial-sidebar').screenshot({ path: `${SHOT}/tree-chapter.png` });
  await expect.poll(() => page.evaluate(() => window.__offers.length)).toBe(1);

  // Stand-Filter: die fertigen Abschnitte verschwinden, der Rest bleibt.
  await page.locator('.sidebar-action-group [aria-pressed]').filter({ has: page.locator('use[href$="#list-filter"]') }).click();
  await expect(firstPage).toHaveCount(0);
  await expect(page.locator('.page-item').first()).toBeVisible();
  await page.evaluate(() => { window.__app.treeEditFilter = false; });
  await expect(firstPage).toBeVisible();

  // Übersicht: Kachel mit Verteilung.
  await page.evaluate(() => { window.__app.showBookOverviewCard = true; });
  const tile = page.locator('.overview-edit-status');
  await expect(tile).toBeVisible();
  await expect(tile.locator('.overview-stacked-seg--status3')).toHaveCount(1);
  if (SHOT) await tile.screenshot({ path: `${SHOT}/overview-tile.png` });

  // Notebook-Kopf: Stand des offenen Abschnitts anzeigen und setzen.
  const other = await page.evaluate((chId) => window.Alpine.store('nav').pages.find(p => p.chapter_id !== chId)?.id, ch.id);
  await page.evaluate((id) => window.__app.selectPage(window.Alpine.store('nav').pages.find(p => p.id === id)), other);
  const trigger = page.locator('.editor-edit-status__trigger');
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.locator('.editor-edit-status__menu [role="menuitemradio"]', { hasText: 'überarbeitet' }).click();
  await expect(trigger).toHaveText('überarbeitet');
  await expect(page.locator(`.page-item[data-page-id="${other}"]`)).toHaveClass(/edit-status--1/);
  if (SHOT) await page.locator('.editor-card__topbar').screenshot({ path: `${SHOT}/editor-head.png` });

  guard.assertClean();
});
