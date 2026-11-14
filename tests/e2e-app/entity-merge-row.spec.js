// «zusammenführen mit…» an einer Katalog-Zeile, die nicht mehr im Text steht —
// geteilter Zeilen-Picker der Figuren-, Schauplatz- und Szenen-Liste
// (book/entity-merge-picker.js, partials/entity-merge-picker.html) gegen die
// ECHTE App.
//
// Warum hier: Testgegenstand ist die Kette über drei Karten — String-Include des
// Pickers je Karte, teleportiertes Popover am Zeilen-Knopf, Combobox mit den
// aktiven Einträgen derselben Gattung (Inline-x-effect über $store.catalog) und
// der echte POST. Der Smoke öffnet die Karten nur mit leeren/aktiven Listen.
//
// «Nicht mehr im Text» setzt nur die Komplettanalyse; hier wird das Flag im
// Katalog-Store gesetzt (die Zeile braucht nur `stale`). Figuren und Schauplätze
// mergen echt; Szenen lassen sich nicht per API anlegen — dort prüft eine
// Route-Interception den Request-Body.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const RUN = String(Date.now()).slice(-6);

// Combobox im Picker: Trigger klicken, dann die Option-Zeile.
async function pickTarget(page, name) {
  const popover = page.locator('.picker-popover:visible');
  await popover.locator('.combobox-trigger').click();
  const opt = popover.locator('.combobox-option', { hasText: name });
  await expect(opt).toHaveCount(1);
  await opt.click();
}

const markStale = (page, key, id) => page.evaluate(({ key, id }) => {
  const c = window.Alpine.store('catalog');
  c[key] = c[key].map(e => (String(e.id) === String(id) ? { ...e, stale: true } : e));
}, { key, id });

test('figuren: stale-Zeile → Picker → Ziel → Merge, Quelle weg', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const SRC = `Zeilen-Merge Quelle ${RUN}`;
  const TGT = `Zeilen-Merge Ziel ${RUN}`;
  const ids = await page.evaluate(async ({ bookId, SRC, TGT, RUN }) => {
    const existing = (await (await fetch(`/figures/${bookId}`)).json())?.figuren || [];
    const src = { id: `fig_row_src_${RUN}`, name: SRC, typ: 'nebenfigur', beziehungen: [], kapitel: [], eigenschaften: [] };
    const tgt = { id: `fig_row_tgt_${RUN}`, name: TGT, typ: 'hauptfigur', beziehungen: [], kapitel: [], eigenschaften: [] };
    const r = await fetch(`/figures/${bookId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figuren: [...existing, src, tgt] }),
    });
    if (!r.ok) throw new Error(`PUT /figures ${r.status}`);
    return { src: src.id, tgt: tgt.id };
  }, { bookId, SRC, TGT, RUN });

  await page.evaluate(() => window.__app.toggleFiguresCard());
  const card = page.locator('.card--figuren');
  await expect(card.locator(`[data-figid="${ids.src}"]`)).toBeVisible();
  await markStale(page, 'figuren', ids.src);

  const row = card.locator(`[data-figid="${ids.src}"]`);
  const mergeBtn = row.locator('.entity-row-action.btn-compact');
  await mergeBtn.click();
  await expect(mergeBtn).toHaveAttribute('aria-expanded', 'true');
  const popover = page.locator('.picker-popover:visible');
  await expect(popover.locator('.picker-popover__subject')).toHaveText(SRC);
  // Quelle selbst und verwaiste Einträge stehen nicht zur Wahl.
  await popover.locator('.combobox-trigger').click();
  await expect(popover.locator('.combobox-option', { hasText: SRC })).toHaveCount(0);
  await popover.locator('.combobox-trigger').click();

  await pickTarget(page, TGT);
  await popover.locator('.picker-popover__actions .danger').click();
  await page.locator('#app-confirm-dialog[open] .confirm-dialog-btn--danger').click();

  await expect(card.locator('.card-form-saved', { hasText: SRC })).toBeVisible();
  await expect(page.locator('.picker-popover:visible')).toHaveCount(0);
  await expect(card.locator(`[data-figid="${ids.src}"]`)).toHaveCount(0);
  const names = await page.evaluate(async (id) =>
    ((await (await fetch(`/figures/${id}`)).json())?.figuren || []).map(f => f.name), bookId);
  expect(names).not.toContain(SRC);
  expect(names).toContain(TGT);
});

test('schauplätze: stale-Zeile → Picker → Merge', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const SRC = `Zeilen-Ort Quelle ${RUN}`;
  const TGT = `Zeilen-Ort Ziel ${RUN}`;
  const ids = await page.evaluate(async ({ bookId, SRC, TGT }) => {
    const post = async (name) => (await (await fetch(`/locations/${bookId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    })).json()).id;
    return { src: await post(SRC), tgt: await post(TGT) };
  }, { bookId, SRC, TGT });

  await page.evaluate(() => window.__app.toggleOrteCard());
  const card = page.locator('.card--orte');
  const row = card.locator(`.entity-row[data-ortid="${ids.src}"]`);
  await expect(row).toBeVisible();
  await markStale(page, 'orte', ids.src);

  await row.locator('.entity-row-action.btn-compact').click();
  await pickTarget(page, TGT);
  await page.locator('.picker-popover:visible .picker-popover__actions .danger').click();
  await page.locator('#app-confirm-dialog[open] .confirm-dialog-btn--danger').click();

  await expect(card.locator('.card-form-saved', { hasText: SRC })).toBeVisible();
  await expect(card.locator(`.entity-row[data-ortid="${ids.src}"]`)).toHaveCount(0);
  await page.evaluate(async ({ bookId, id }) => {
    await fetch(`/locations/${bookId}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }, { bookId, id: ids.tgt });
});

test('szenen: stale-Zeile → Picker zeigt aktive Szenen mit Kapitel, POST trägt INTEGER-IDs', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  let body = null;
  await page.route(`**/figures/scenes/${bookId}/merge`, async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, sourceName: 'Abschied', targetName: 'Ankunft', moved: { scene_figures: 2 } }) });
  });

  await page.evaluate(() => window.__app.toggleSzenenCard());
  const card = page.locator('.card--szenen');
  await expect(card).toBeVisible();
  await page.waitForFunction(() => !window.Alpine.$data(document.querySelector('.card--szenen')).cardLoading);
  await page.evaluate(() => {
    window.Alpine.store('catalog').szenen = [
      { id: 9101, titel: 'Abschied', wertung: 'mittel', stale: true, kapitel: 'Kapitel A', fig_ids: [] },
      { id: 9102, titel: 'Ankunft', wertung: 'stark', kapitel: 'Kapitel B', fig_ids: [] },
      { id: 9103, titel: 'Verworfen', wertung: 'schwach', stale: true, kapitel: 'Kapitel B', fig_ids: [] },
    ];
  });

  const row = card.locator('.entity-row[data-szeneid="9101"]');
  await row.locator('.entity-row-action.btn-compact').click();
  const popover = page.locator('.picker-popover:visible');
  await popover.locator('.combobox-trigger').click();
  // Nur die aktive Szene, mit Kapitel im Label; verwaiste nicht.
  await expect(popover.locator('.combobox-option')).toHaveText(['Ankunft · Kapitel B']);
  await popover.locator('.combobox-option').click();
  await popover.locator('.picker-popover__actions .danger').click();
  await page.locator('#app-confirm-dialog[open] .confirm-dialog-btn--danger').click();

  await expect.poll(() => body).toEqual({ source_id: 9101, target_id: 9102 });
  await expect(card.locator('.card-form-saved', { hasText: 'Abschied' })).toBeVisible();
});
