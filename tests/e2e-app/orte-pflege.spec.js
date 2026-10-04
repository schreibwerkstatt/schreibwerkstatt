// Schauplatz-Karte: Pflege (anlegen, bearbeiten, löschen) und Hierarchie gegen
// die ECHTE App (playwright.app.config.js) — docs/schauplaetze.md.
//
// Warum diese Schicht: die Karte besteht aus verschachtelten Fragment-Includes
// (orte-list → orte-detail / orte-edit), das Formular steckt im x-if einer
// x-for-Zeile und nutzt Comboboxen, die Karten-Methoden über den gemergten Scope
// aufrufen. Ein Fixture-Harness sähe weder die Include-Kette noch verschluckte
// Alpine-Expression-Fehler (der Console-Guard der Fixtures schon).
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const CARD = '.card--orte';
const RUN = String(Date.now()).slice(-6);

test('schauplätze: anlegen, Unterort eingerückt, bearbeiten, Typ übersetzt, löschen', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  await page.evaluate(() => window.__app.toggleOrteCard());
  const card = page.locator(CARD);
  await expect(card).toBeVisible();

  // 1) Anlegen über das Formular der Karte.
  const stadtName = `Olten ${RUN}`;
  await card.getByRole('button', { name: /Neuer Schauplatz|New location/ }).click();
  const form = card.locator('.ort-edit-panel .ort-edit');
  await expect(form).toBeVisible();
  await form.locator('input[type="text"]').first().fill(stadtName);
  await form.locator('.ort-edit-actions button.primary').click();
  await expect(form).toHaveCount(0);
  const stadtRow = card.locator('.ort-list .entity-row', { hasText: stadtName });
  await expect(stadtRow).toBeVisible();
  await expect(stadtRow.locator('.ort-manual-tag')).toBeVisible();

  // 2) Unterort mit Typ per API (Combobox-Bedienung ist nicht Testgegenstand),
  //    dann neu laden: er steht eingerückt direkt unter dem Elternort.
  const hotelName = `Hotel Krone ${RUN}`;
  const ids = await page.evaluate(async ({ bookId, stadtName, hotelName }) => {
    const list = (await (await fetch(`/locations/${bookId}`)).json()).orte;
    const stadt = list.find(o => o.name === stadtName).id;
    const r = await fetch(`/locations/${bookId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: hotelName, typ: 'gebaeude', parent: stadt }),
    });
    const hotel = (await r.json()).id;
    await window.__app.loadOrte(bookId);
    return { stadt, hotel };
  }, { bookId, stadtName, hotelName });

  const hotelItem = card.locator('.ort-list > div', { has: page.locator(`.entity-row[data-ortid="${ids.hotel}"]`) });
  await expect(hotelItem).toHaveClass(/ort-list-item--child/);
  const order = await card.locator('.ort-list .entity-row').evaluateAll(
    (rows) => rows.map(r => r.dataset.ortid));
  expect(order.indexOf(ids.hotel)).toBe(order.indexOf(ids.stadt) + 1);
  await expect(hotelItem.locator('.entity-typ-tag')).toHaveText(/^(Gebäude|Building)$/);

  // 3) Detail öffnen: Elternort als Referenz, dann bearbeiten.
  await hotelItem.locator('.entity-row').click();
  const detail = hotelItem.locator('.entity-detail');
  await expect(detail.locator('.entity-ref').first()).toBeVisible();
  await detail.getByRole('button', { name: /Bearbeiten|Edit/ }).click();
  const editForm = detail.locator('.ort-edit');
  await expect(editForm).toBeVisible();
  const renamed = `Gasthof Krone ${RUN}`;
  await editForm.locator('input[type="text"]').first().fill(renamed);
  await editForm.locator('.ort-edit-actions button.primary').click();
  await expect(card.locator('.ort-list .entity-row', { hasText: renamed })).toBeVisible();
  const saved = await page.evaluate(async ({ bookId, id }) =>
    (await (await fetch(`/locations/${bookId}`)).json()).orte.find(o => o.id === id), { bookId, id: ids.hotel });
  expect(saved.manually_edited).toBe(true);
  expect(saved.parent).toBe(ids.stadt);

  // 4) Löschen (selbst angelegt): Bestätigungsdialog, Kind fällt auf die Wurzel.
  await stadtRow.locator('.entity-row-delete').click();
  await page.locator('#app-confirm-dialog[open] .confirm-dialog-btn--danger').click();
  await expect(card.locator('.ort-list .entity-row', { hasText: stadtName })).toHaveCount(0);
  await expect(card.locator('.ort-list > div', { has: page.locator(`.entity-row[data-ortid="${ids.hotel}"]`) }))
    .not.toHaveClass(/ort-list-item--child/);

  await page.evaluate(async ({ bookId, id }) => {
    await fetch(`/locations/${bookId}/${id}`, { method: 'DELETE' });
  }, { bookId, id: ids.hotel });
});
