// Recherche-Board: Sprung auf ein Fundstück, das der aktive Filter ausblendet —
// gegen die ECHTE App (Hash-Router → RECHERCHE_FOCUS_ITEM → _focusRechercheItemById,
// Filterleiste mit Persistenz-Layer, aufgeklappte Zeile).
// Erwartung: Filter zurücksetzen, neu laden, Detail öffnen. Ohne das blieb der
// Sprungwunsch still liegen und die Karte zeigte nur die gefilterte Liste.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('recherche: Sprung auf ausgefiltertes Fundstück setzt den Filter zurück und öffnet es', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  const ids = await page.evaluate(async (bid) => {
    const post = (payload) => fetch('/research', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: bid, ...payload }),
    }).then(r => r.json());
    const hidden = await post({ kind: 'fact', title: 'Versteckter Fakt' });
    const shown = await post({ kind: 'quote', title: 'Sichtbares Zitat' });
    return { hidden: hidden.id, shown: shown.id };
  }, bookId);

  await page.evaluate((bid) => { location.hash = `#book/${bid}/recherche`; }, bookId);
  const card = page.locator('#recherche-card');
  const row = (id) => card.locator(`.recherche-list [data-research-id="${id}"]`);
  await expect(row(ids.hidden)).toBeVisible();

  // Suchfeld: EIN Weg (value + entprelltes @input) setzt filterText und lädt.
  const search = card.locator('.filter-search-input--wide');
  await search.fill('Sichtbares');
  await expect(row(ids.hidden)).toHaveCount(0);
  await expect(row(ids.shown)).toBeVisible();

  await page.evaluate(([bid, id]) => { location.hash = `#book/${bid}/recherche/${id}`; }, [bookId, ids.hidden]);

  const opened = row(ids.hidden).locator('.research-detail');
  await expect(opened).toBeVisible();
  await expect(row(ids.hidden)).toContainText('Versteckter Fakt');
  await expect(search).toHaveValue('');
});

test('recherche: Sprung auf archiviertes Fundstück blendet das Archiv ein und öffnet es', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  const id = await page.evaluate(async (bid) => {
    const r = await fetch('/research', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: bid, kind: 'note', title: 'Archivierte Notiz' }),
    }).then(x => x.json());
    await fetch(`/research/${r.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });
    return r.id;
  }, bookId);

  await page.evaluate((bid) => { location.hash = `#book/${bid}/recherche`; }, bookId);
  const card = page.locator('#recherche-card');
  await expect(card).toBeVisible();
  await expect(card.locator(`.recherche-list [data-research-id="${id}"]`)).toHaveCount(0);

  await page.evaluate(([bid, iid]) => { location.hash = `#book/${bid}/recherche/${iid}`; }, [bookId, id]);
  const opened = card.locator(`.recherche-list [data-research-id="${id}"]`);
  await expect(opened.locator('.research-detail')).toBeVisible();
  await expect(opened).toContainText('Archivierte Notiz');
});
