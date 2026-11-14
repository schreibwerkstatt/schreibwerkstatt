// Recherche-Board: Permalink #…/recherche/<itemId> in der Adresszeile folgt der
// aufgeklappten Zeile — gegen die ECHTE App (Hash-Router, nav.rechercheItemId,
// items.js#openDetail/closeDetail). Geprüft werden die Wege, auf denen die ID
// stehen bleiben könnte, obwohl keine Zeile (sichtbar) offen ist.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

async function seed(page, bookId, titles) {
  return page.evaluate(async ([bid, list]) => {
    const out = [];
    for (const title of list) {
      const r = await fetch('/research', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bid, kind: 'note', title }),
      }).then(x => x.json());
      out.push(r.id);
    }
    return out;
  }, [bookId, titles]);
}

async function openBoard(page, bookId) {
  await page.evaluate((bid) => { location.hash = `#book/${bid}/recherche`; }, bookId);
  const card = page.locator('#recherche-card');
  await expect(card).toBeVisible();
  return card;
}

test('recherche: Auf- und Zuklappen schreibt den Permalink und nimmt ihn zurück', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const [id] = await seed(page, bookId, ['Permalink-Notiz']);
  const card = await openBoard(page, bookId);
  const title = card.locator(`.recherche-list [data-research-id="${id}"] .row-expand`);

  await title.click();
  await expect(page).toHaveURL(new RegExp(`#book/${bookId}/recherche/${id}$`));
  await title.click();
  await expect(page).toHaveURL(new RegExp(`#book/${bookId}/recherche$`));
});

test('recherche: Wechsel ins Status-Board klappt die Zeile zu und kürzt die URL', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const [id] = await seed(page, bookId, ['Board-Notiz']);
  const card = await openBoard(page, bookId);
  const row = card.locator(`.recherche-list [data-research-id="${id}"]`);

  await row.locator('.row-expand').click();
  await expect(row.locator('.research-detail')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/recherche/${id}$`));

  await card.locator('.entity-view-toggle .tabs-btn').nth(1).click();
  await expect(page).toHaveURL(new RegExp(`#book/${bookId}/recherche$`));

  // Zurück in die Liste: keine Zeile mehr offen.
  await card.locator('.entity-view-toggle .tabs-btn').nth(0).click();
  await expect(row.locator('.research-detail')).toHaveCount(0);
});

test('recherche: Deep-Link auf ein unbekanntes Fundstück hinterlässt keine tote ID', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  await seed(page, bookId, ['Vorhandene Notiz']);
  await openBoard(page, bookId);

  await page.evaluate((bid) => { location.hash = `#book/${bid}/recherche/99999999`; }, bookId);
  await expect(page).toHaveURL(new RegExp(`#book/${bookId}/recherche$`));
});

test('recherche: Filter blendet die offene Zeile aus — URL verliert die ID', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const [id] = await seed(page, bookId, ['Gefilterte Notiz', 'Andere Notiz']);
  const card = await openBoard(page, bookId);
  const row = card.locator(`.recherche-list [data-research-id="${id}"]`);

  await row.locator('.row-expand').click();
  await expect(page).toHaveURL(new RegExp(`/recherche/${id}$`));

  await card.locator('.filter-search-input--wide').fill('Andere');
  await expect(row).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#book/${bookId}/recherche$`));
});
