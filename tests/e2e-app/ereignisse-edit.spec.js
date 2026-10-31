// Ereignisse-Karte in der echten App: Ereignis bearbeiten (Inline-Formular aus
// partials/ereignisse-edit.html, PATCH /figures/zeitstrahl/:book_id/:event_id)
// und die Band-Auswahl, die einem Filterwechsel standhält. Gegen die echte App,
// weil das Formular per string-seitigem Include im x-for steht und Combobox,
// $editKeys und Band-Marker nur dort im echten Template-Baum zusammenkommen.
// Der Zeitstrahl kommt aus page.route — es gibt keine Route, die Ereignisse anlegt.
const { test, expect } = require('../e2e/_helpers/fixtures');

const _ev = (id, year, ereignis, extra = {}) => ({
  id, datum: String(year), datum_label: String(year), datum_year: year, datum_month: null, datum_day: null,
  datum_ende_year: null, datum_ende_month: null, datum_ende_day: null, story_tag: null,
  datum_unsicher: false, ereignis, typ: 'persoenlich', subtyp: 'umzug', bedeutung: '',
  storyline_id: null, manually_edited: false, sort_order: 0,
  kapitel: [], chapter_ids: [], seiten: [], page_ids: [], figuren: [], ...extra,
});

async function openCard(page, events) {
  await page.goto('/');
  await page.waitForFunction(() => window.__app && window.Alpine.store('nav').selectedBookId);
  const bookId = await page.evaluate(() => window.Alpine.store('nav').selectedBookId);
  const state = { events, patches: [] };
  await page.route(new RegExp(`/figures/zeitstrahl/${bookId}(\\?.*)?$`), route =>
    route.fulfill({ json: { ereignisse: state.events, chronology: null } }));
  await page.route(new RegExp(`/figures/zeitstrahl/${bookId}/\\d+$`), async route => {
    const body = route.request().postDataJSON();
    const id = Number(route.request().url().split('/').pop());
    state.patches.push({ id, body });
    state.events = state.events.map(e => (e.id === id ? { ...e, ...body.fields, manually_edited: true } : e));
    await route.fulfill({ json: { ok: true, changed: Object.keys(body.fields) } });
  });
  await page.evaluate(() => window.__app.toggleEreignisseCard());
  await expect(page.locator('.card--ereignisse .gz-item')).toHaveCount(events.length);
  return state;
}

test('ereignisse: bearbeiten speichert per PATCH und zeigt «Manuell bearbeitet»', async ({ page }) => {
  const state = await openCard(page, [_ev(1, 1985, 'Anna zieht nach Bern'), _ev(2, 1990, 'Hochzeit')]);
  const row = page.locator('.card--ereignisse .gz-item[data-event-id="1"]');
  await row.locator('.gz-edit-btn').click();
  const form = row.locator('.gz-edit');
  await expect(form).toBeVisible();
  await expect(row.locator('.gz-content:not(.gz-edit)')).toBeHidden();
  await form.locator('#event-edit-1-ereignis').fill('Anna zieht nach Basel');
  await form.locator('#event-edit-1-ereignis').press('Control+s');
  await expect(form).toBeHidden();
  expect(state.patches).toEqual([{ id: 1, body: { fields: { ereignis: 'Anna zieht nach Basel' } } }]);
  await expect(row.locator('.gz-ereignis')).toHaveText('Anna zieht nach Basel');
  await expect(row.locator('.gz-manual-badge')).toBeVisible();
});

test('ereignisse: Esc verwirft, leerer Text beim Klick daneben speichert nichts', async ({ page }) => {
  const state = await openCard(page, [_ev(1, 1985, 'Anna zieht nach Bern'), _ev(2, 1990, 'Hochzeit')]);
  const row = page.locator('.card--ereignisse .gz-item[data-event-id="1"]');
  await row.locator('.gz-edit-btn').click();
  await row.locator('#event-edit-1-ereignis').fill('Weg damit');
  await row.locator('#event-edit-1-ereignis').press('Escape');
  await expect(row.locator('.gz-edit')).toBeHidden();
  await row.locator('.gz-edit-btn').click();
  await row.locator('#event-edit-1-ereignis').fill('');
  await page.locator('.card--ereignisse .card-title').click();
  await expect(row.locator('.gz-edit')).toBeHidden();
  expect(state.patches).toEqual([]);
  await expect(row.locator('.gz-ereignis')).toHaveText('Anna zieht nach Bern');
});

test('ereignisse: Band-Auswahl folgt dem Ereignis, nicht der Listenposition', async ({ page }) => {
  await openCard(page, [_ev(1, 1985, 'Anna zieht nach Bern'), _ev(2, 1990, 'Hochzeit Anna'), _ev(3, 1995, 'Hochzeit Ben')]);
  const card = page.locator('.card--ereignisse');
  // Anna (Listenposition 0) auf dem Band wählen …
  await card.locator('.gz-band-marker[data-ev-index="0"]').click();
  await expect(card.locator('.gz-band-marker--selected')).toHaveAttribute('data-ev-index', '0');
  await expect(card.locator('.gz-item--selected')).toHaveAttribute('data-event-id', '1');
  // … dann so filtern, dass Anna herausfällt: Position 0 ist jetzt «Hochzeit
  // Anna», und deren Marker darf NICHT als gewählt leuchten.
  await card.locator('.filter-search-input').fill('Hochzeit');
  await expect(card.locator('.gz-item')).toHaveCount(2);
  await expect(card.locator('.gz-band-marker--selected')).toHaveCount(0);
  // Filter weg → Anna ist wieder gewählt.
  await card.locator('.filter-search-input').fill('');
  await expect(card.locator('.gz-band-marker--selected')).toHaveAttribute('data-ev-index', '0');
});
