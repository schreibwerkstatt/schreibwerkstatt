// Zeilen-Konvention der Katalog-Karten gegen die ECHTE App (DESIGN.md «Listen-Anriss»,
// «Context-Menu»): Titel-Klick öffnet das Bearbeiten, Klick daneben speichert
// (Inline-Edit), ⋯ öffnet das Aktionsmenü, und «Zusammenführen mit …» aus dem Menü
// führt auch zwei AKTIVE Figuren zusammen (geteilter Merge-Picker).
//
// Warum hier: Testgegenstand ist das Zusammenspiel aus Titel-Knopf (`.stop`, sonst
// schlösse derselbe Klick das frisch geöffnete Formular per `@click.outside`),
// teleportiertem Menü, Picker am Menü-Anker und echtem PATCH/POST.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const RUN = String(Date.now()).slice(-6);

test('figuren: Titel öffnet Bearbeiten, Klick daneben speichert, Menü führt aktive Figuren zusammen', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const SRC = `Menü-Quelle ${RUN}`;
  const TGT = `Menü-Ziel ${RUN}`;
  const ids = await page.evaluate(async ({ bookId, SRC, TGT, RUN }) => {
    const existing = (await (await fetch(`/figures/${bookId}`)).json())?.figuren || [];
    const src = { id: `fig_menu_src_${RUN}`, name: SRC, typ: 'nebenfigur', beziehungen: [], kapitel: [], eigenschaften: [] };
    const tgt = { id: `fig_menu_tgt_${RUN}`, name: TGT, typ: 'hauptfigur', beziehungen: [], kapitel: [], eigenschaften: [] };
    const r = await fetch(`/figures/${bookId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figuren: [...existing, src, tgt] }),
    });
    if (!r.ok) throw new Error(`PUT /figures ${r.status}`);
    return { src: src.id, tgt: tgt.id };
  }, { bookId, SRC, TGT, RUN });

  await page.evaluate(() => window.__app.toggleFiguresCard());
  const card = page.locator('.card--figuren');
  const srcRow = card.locator(`.entity-row[data-figid="${ids.src}"]`);
  await expect(srcRow).toBeVisible();

  // 1) Titel → Zeile offen UND Formular da.
  await srcRow.locator('.entity-row-title-btn').click();
  const form = card.locator('.figur-edit');
  await expect(form).toBeVisible();
  await expect(srcRow.locator('.row-expand')).toHaveAttribute('aria-expanded', 'true');

  // 2) Klick daneben committet den Entwurf.
  await form.locator(`#figur-edit-${ids.src}-beruf`).fill(`Uhrmacher ${RUN}`);
  await card.locator('.card-title').click();
  await expect(form).toHaveCount(0);
  await expect.poll(() => page.evaluate(async ({ bookId, id }) =>
    ((await (await fetch(`/figures/${bookId}`)).json()).figuren.find(f => f.id === id) || {}).beruf, { bookId, id: ids.src }))
    .toBe(`Uhrmacher ${RUN}`);

  // 3) ⋯ → «Zusammenführen mit …» an einer AKTIVEN Figur → Picker → Merge.
  await srcRow.locator('button[aria-haspopup="menu"]').click();
  const menu = page.locator('.context-menu[x-ref="actionMenu"]:visible');
  await expect(menu.getByRole('menuitem').first()).toContainText(/Bearbeiten|Edit/);
  await menu.getByRole('menuitem', { name: /Zusammenführen mit|Merge into/ }).click();
  const popover = page.locator('.picker-popover:visible');
  await expect(popover.locator('.picker-popover__subject')).toHaveText(SRC);
  await popover.locator('.combobox-trigger').click();
  await popover.locator('.combobox-option', { hasText: TGT }).click();
  await popover.locator('.picker-popover__actions .danger').click();
  await page.locator('#app-confirm-dialog[open] .confirm-dialog-btn--danger').click();

  await expect(card.locator(`.entity-row[data-figid="${ids.src}"]`)).toHaveCount(0);
  const names = await page.evaluate(async (id) =>
    ((await (await fetch(`/figures/${id}`)).json())?.figuren || []).map(f => f.name), bookId);
  expect(names).not.toContain(SRC);
  expect(names).toContain(TGT);
});
