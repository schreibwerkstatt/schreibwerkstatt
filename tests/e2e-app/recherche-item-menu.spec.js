// Recherche-Board: das Aktionsmenue eines Fundstuecks (recherche-item-menu.html)
// muss ganz sichtbar und bedienbar sein, auch wenn sein Container kuerzer ist
// als das Menue — ein kurzer Fund im Detail-Dialog (der per Overflow klippt)
// und eine Liste mit einem einzigen Eintrag. Geometrie-Aussage gegen das echte
// Shell-CSS, darum hier und nicht im Fixture-Harness.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

// Letzter Menueeintrag (Loeschen) per Hit-Test: getroffen wird er nur, wenn
// das Menue weder geklippt noch verdeckt ist.
async function expectMenuFullyUsable(page, menu) {
  await expect(menu).toBeVisible();
  const res = await menu.evaluate((el) => {
    const last = el.querySelector('.context-menu-item--danger');
    const r = last.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const m = el.getBoundingClientRect();
    return {
      hitInside: !!hit && last.contains(hit),
      inViewport: m.top >= 0 && m.bottom <= window.innerHeight && m.left >= 0 && m.right <= window.innerWidth,
    };
  });
  expect(res.inViewport, 'Menue liegt ganz im Viewport').toBe(true);
  expect(res.hitInside, 'letzter Menueeintrag ist nicht geklippt').toBe(true);
}

test('recherche: Aktionsmenue bei kurzem Inhalt nicht geklippt (Detail-Dialog + Liste mit einem Eintrag)', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  const itemId = await page.evaluate(async (id) => {
    const list = await fetch(`/research?book_id=${id}&archived=1`).then(r => r.json());
    for (const it of (list.items || list || [])) {
      await fetch(`/research/${it.id}`, { method: 'DELETE' });
    }
    const made = await fetch('/research', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: id, kind: 'note', title: 'Kurz' }),
    }).then(r => r.json());
    return made.id;
  }, bookId);

  // ── Liste mit einem einzigen Eintrag ──────────────────────────────────────
  await page.evaluate((id) => { location.hash = `#book/${id}/recherche`; }, bookId);
  await expect(page.locator('#recherche-card')).toBeVisible();
  const row = page.locator(`[data-research-id="${itemId}"]`);
  await expect(row).toBeVisible();
  await row.locator('.research-item-actions > .icon-btn[aria-haspopup="menu"]').click();
  await expectMenuFullyUsable(page, row.locator('.research-item-menu'));
  await page.keyboard.press('Escape');
  await expect(row.locator('.research-item-menu')).toBeHidden();

  // ── Detail-Dialog eines kurzen Funds (Permalink) ──────────────────────────
  await page.evaluate(([b, i]) => { location.hash = `#book/${b}/recherche/${i}`; }, [bookId, itemId]);
  const dlg = page.locator('.research-dialog[open]');
  await expect(dlg).toBeVisible();
  await dlg.locator('.research-dialog__actions > .icon-btn[aria-haspopup="menu"]').click();
  await expectMenuFullyUsable(page, dlg.locator('.research-item-menu'));
});

// Status-Board: die Karte hebt sich beim Hover per transform an; laeuft beim
// Oeffnen eine Transition nach `none`, ist die Karte waehrenddessen der
// Containing-Block des fixed Menues — es sitzt kartenrelativ weit rechts und
// das Board (overflow-x: auto) blendet kurz einen Scrollbalken ein. Pro Frame
// messen, nicht nur den Endzustand.
test('recherche: Aktionsmenue im Status-Board laesst das Board nicht ueberlaufen', async ({ page }) => {
  // Breit genug, dass die vier Spalten ohne Scroll passen — sonst verschwindet
  // der Ausreisser in der ohnehin vorhandenen Scrollbreite.
  await page.setViewportSize({ width: 1400, height: 900 });
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  // Dritte Spalte: der Fehlversatz ist der Kartenabstand zum Viewport-Rand —
  // in der ersten Spalte zu klein, um ueber den Board-Rand zu ragen.
  const itemId = await page.evaluate(async (id) => {
    const made = await fetch('/research', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: id, kind: 'note', title: 'Board' }),
    }).then(r => r.json());
    await fetch(`/research/${made.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'eingearbeitet' }),
    });
    return made.id;
  }, bookId);
  await page.evaluate((id) => { location.hash = `#book/${id}/recherche`; }, bookId);
  await page.locator('#recherche-card .entity-view-toggle [role=tab]').nth(1).click();
  const btn = page.locator(`.research-status-card[data-research-card-id="${itemId}"] .research-item-actions > .icon-btn[aria-haspopup="menu"]`);
  await btn.hover();
  await page.waitForTimeout(300);
  // Bei schmalem Viewport laeuft das Board mit vier Spalten ohnehin ueber —
  // Massstab ist der Stand vor dem Klick, nicht null.
  const baseline = await page.evaluate(() => {
    const bd = document.querySelector('.research-status-board');
    return bd.scrollWidth - bd.clientWidth;
  });
  await page.evaluate(() => {
    window.__frames = [];
    const tick = () => {
      const bd = document.querySelector('.research-status-board');
      window.__frames.push(bd.scrollWidth - bd.clientWidth);
      if (window.__frames.length < 30) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await btn.click();
  await page.waitForFunction(() => window.__frames.length >= 30);
  const maxOverflow = await page.evaluate(() => Math.max(...window.__frames));
  expect(maxOverflow, 'Board waechst beim Oeffnen nicht in die Breite').toBeLessThanOrEqual(baseline);
});
