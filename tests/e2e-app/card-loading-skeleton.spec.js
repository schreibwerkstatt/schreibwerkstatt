// Lade-Skelett beim Öffnen einer Karte gegen die ECHTE App
// (playwright.app.config.js; DESIGN.md „Skeleton-Loader").
//
// Aussage: solange der erste Fetch einer Karte hängt, zeigt sie das Skelett
// (`x-skeleton`, sichtbar über `cardLoading` aus setupCardLifecycle) — und
// NICHT den Leerzustand, dessen CTA bei Figuren eine teure Komplettanalyse
// anbietet. Erst nach der Antwort verschwindet das Skelett.
//
// Der Fetch wird per Route-Interception festgehalten, bis der Test ihn
// freigibt; nur so ist der Zwischenzustand im echten Template-Baum greifbar.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test.describe.configure({ mode: 'serial' });

// Hält passende Requests fest, bis `release()` gerufen wird.
async function holdRoute(page, pattern, body) {
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.route(pattern, async (route) => {
    await gate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return release;
}

test('Figuren: Skelett statt Leerzustand, solange der Katalog lädt', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  const release = await holdRoute(page, `**/figures/${bookId}`, {
    figuren: [{ id: 'fig_skel_1', name: 'Skelett-Probe', typ: 'hauptfigur', beziehungen: [], kapitel: [], eigenschaften: [] }],
  });
  await page.evaluate(() => { window.Alpine.store('catalog').figuren = []; });

  await page.evaluate(() => { window.__app.toggleFiguresCard(); });
  const card = page.locator('.card--figuren');
  const skeleton = card.locator('.entity-skeleton');

  await expect(skeleton).toBeVisible({ timeout: 10000 });
  await expect(skeleton.locator('.entity-skeleton-row')).toHaveCount(6);
  await expect(card.locator('.card-empty:visible')).toHaveCount(0);

  release();
  await expect(skeleton).toBeHidden({ timeout: 10000 });
  await expect(card.locator('.card-empty:visible')).toHaveCount(0);
  await expect(card).toContainText('Skelett-Probe');
});

test('Kapitel-Bewertung: Skelett-Kacheln, solange das Dashboard lädt', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  const chapterId = await page.evaluate(() =>
    window.Alpine.store('nav').tree.find(i => i.type === 'chapter' && !i.solo && (i.pages || []).length)?.id);
  expect(chapterId, 'Seed-Buch braucht ein Kapitel mit Abschnitten').toBeTruthy();

  const release = await holdRoute(page, `**/history/style-stats/${bookId}`, null);

  await page.evaluate((id) => {
    window.__app.kapitelReviewChapterId = String(id);
    return window.__app.toggleKapitelReviewCard();
  }, chapterId);

  const dash = page.locator('.card--kapitel .kapitel-dashboard');
  await expect(dash).toBeVisible({ timeout: 20000 });
  await expect(dash.locator('.skeleton-tile')).toHaveCount(3);
  // Ohne geladene Historie kein „Noch nicht bewertet"-Aufruf.
  await expect(dash.locator('.overview-tile--cta')).toHaveCount(0);

  release();
  await expect(dash.locator('.skeleton-tile:visible')).toHaveCount(0, { timeout: 10000 });
});

// Listen-Karten ohne eigenes Fetch-Flag: Skelett und Leerzustand hängen nur an
// `cardLoading`. Der Katalog wird geleert, damit die Karte wirklich leer startet.
const LIST_CARDS = [
  { name: 'Szenen', card: '.card--szenen', toggle: 'toggleSzenenCard', route: (id) => `**/figures/scenes/${id}`, body: { szenen: [] }, clear: 'szenen' },
  { name: 'Songs', card: '.card--songs', toggle: 'toggleSongsCard', route: (id) => `**/songs/${id}`, body: { songs: [] }, clear: 'songs' },
  { name: 'Welt-Fakten', card: '.card--weltfakten', toggle: 'toggleWorldFactsCard', route: (id) => `**/world-facts/${id}`, body: { fakten: [] } },
  { name: 'Kontinuität', card: '.card--kontinuitaet', toggle: 'toggleKontinuitaetCard', route: (id) => `**/jobs/kontinuitaet/${id}`, body: null },
];

for (const c of LIST_CARDS) {
  test(`${c.name}: Skelett statt Leerzustand, solange die Liste lädt`, async ({ page }) => {
    await bootApp(page);
    const bookId = await selectSeededBook(page);
    const release = await holdRoute(page, c.route(bookId), c.body);
    if (c.clear) await page.evaluate((k) => { window.Alpine.store('catalog')[k] = []; }, c.clear);

    await page.evaluate((t) => { window.__app[t](); }, c.toggle);
    const card = page.locator(c.card);
    const skeleton = card.locator('.entity-skeleton');

    await expect(skeleton).toBeVisible({ timeout: 10000 });
    await expect(card.locator('.card-empty:visible')).toHaveCount(0);

    release();
    await expect(skeleton).toBeHidden({ timeout: 10000 });
    // Nach der (leeren) Antwort steht der Leerzustand.
    await expect(card.locator('.card-empty:visible')).toHaveCount(1);
  });
}
