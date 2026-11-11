// Musik-Karte gegen die ECHTE App (playwright.app.config.js).
//
// Aussage: die Detailansicht eines Songs gruppiert die Figuren nach ihrer Rolle
// (eine Zeile je Rolle, Figuren ohne Rolle unter «Figuren» am Schluss), zeigt eine
// als Kapitelname aufgelöste «Erste Erwähnung» als Kapitel-Verweis, und die Suche
// trifft auch die Stimmung.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('Songs: Figuren nach Rolle gruppiert, erste Erwähnung als Kapitel, Suche über Stimmung', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const chapterId = await page.evaluate(() => {
    const t = window.Alpine.store('nav').tree || [];
    const ch = t.find(x => x.type === 'chapter') || null;
    return ch ? ch.id : 1;
  });
  await page.route(`**/songs/${bookId}`, route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      updated_at: '2026-01-01T00:00:00.000Z',
      songs: [{
        id: 'song_1', titel: 'Heroes', interpret: 'David Bowie', genre: 'Rock', kontext_typ: 'leitmotiv',
        beschreibung: 'Im Auto', stimmung: 'melancholisch', erste_erwaehnung: 'Kapitel X',
        erste_erwaehnung_page_id: null, erste_erwaehnung_chapter_id: chapterId,
        figuren: [
          { fig_id: 'fig_a', name: 'Anna', kontext_typ: 'hört' },
          { fig_id: 'fig_b', name: 'Ben', kontext_typ: 'spielt' },
          { fig_id: 'fig_c', name: 'Clara', kontext_typ: null },
        ],
        kapitel: [{ chapter_id: chapterId, name: 'Kapitel X', haeufigkeit: 2 }],
      }, {
        id: 'song_2', titel: 'Imagine', interpret: 'John Lennon', genre: 'Pop', kontext_typ: 'hört',
        beschreibung: '', stimmung: 'ruhig', erste_erwaehnung: null,
        erste_erwaehnung_page_id: null, erste_erwaehnung_chapter_id: null, figuren: [], kapitel: [],
      }],
    }),
  }));

  await page.evaluate(() => window.__app.toggleSongsCard());
  const card = page.locator('.card--songs');
  await expect(card.locator('[data-song-id="song_1"]')).toBeVisible();
  await card.locator('[data-song-id="song_1"]').click();

  const detail = card.locator('.entity-detail').first();
  const labels = await detail.locator('.entity-meta-row > .entity-meta-label').allTextContents();
  const de = await page.evaluate(() => ['songs.firstMention', 'songs.figRolle.spielt', 'songs.figRolle.hört', 'songs.figuren']
    .map(k => window.__app.t(k)));
  // Reihenfolge: Erste Erwähnung, dann Rollen aktiv vor passiv, «Figuren» ohne Rolle am Schluss.
  expect(labels.filter(l => de.includes(l))).toEqual(de);
  const row = (label) => detail.locator('.entity-meta-row').filter({ has: page.locator('.entity-meta-label', { hasText: label }) });
  await expect(row(de[0]).locator('.entity-ref--kapitel')).toHaveCount(1);
  await expect(row(de[1]).locator('.entity-ref')).toHaveCount(1);
  await expect(row(de[2]).locator('.entity-ref')).toHaveCount(1);
  await expect(row(de[3]).locator('.entity-ref')).toHaveCount(1);

  await card.locator('.filter-search-input').fill('ruhig');
  await expect(card.locator('[data-song-id]')).toHaveCount(1);
  await expect(card.locator('[data-song-id="song_2"]')).toBeVisible();
});

test('Songs: Sprung auf einen Song öffnet die geschlossene Karte, leert Filter und wählt ihn', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const song = (id, titel) => ({
    id, titel, interpret: '', genre: '', kontext_typ: 'erwähnt', beschreibung: 'Beschreibung ' + titel, stimmung: '',
    erste_erwaehnung: null, erste_erwaehnung_page_id: null, erste_erwaehnung_chapter_id: null, figuren: [], kapitel: [],
  });
  await page.route(`**/songs/${bookId}`, route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ updated_at: null, songs: [song('song_a', 'Alpha'), song('song_b', 'Beta')] }),
  }));
  // Katalog noch leer und ein Filter, der den Ziel-Song ausblenden würde.
  await page.evaluate(() => {
    window.Alpine.store('catalog').songs = [];
    window.Alpine.store('catalogUi').songsFilters.suche = 'alpha';
  });
  await page.evaluate(() => window.__app.openSongById('song_b'));
  const card = page.locator('.card--songs');
  await expect(card.locator('[data-song-id="song_b"]')).toBeVisible();
  await expect(card.locator('.entity-detail').filter({ hasText: 'Beschreibung Beta' })).toBeVisible();
  expect(await page.evaluate(() => window.Alpine.store('catalogUi').songsFilters.suche)).toBe('');
});

// Die Liste rendert schrittweise (list-window.js): erst ein Fenster, der Rest über
// «Weitere anzeigen». Ein Sprung auf einen Song hinter dem Fenster (Deep-Link,
// Palette, Verweis) zieht das Fenster mit, sonst stünde die Zeile nicht im DOM.
test('Songs: Liste schrittweise, Sprung hinter das Fenster deckt die Zeile auf', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const N = 200;
  const pad = (i) => String(i).padStart(3, '0');
  await page.route(`**/songs/${bookId}`, route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      updated_at: '2026-01-01T00:00:00.000Z',
      songs: Array.from({ length: N }, (_, i) => ({ id: `song_${pad(i)}`, titel: `Song ${pad(i)}`, kapitel: [], figuren: [] })),
    }),
  }));
  await page.evaluate(() => window.__app.toggleSongsCard());
  const card = page.locator('.card--songs');
  const rows = card.locator('.song-list .entity-row');
  const step = await page.evaluate(() => Alpine.$data(document.querySelector('.card--songs')).listWindowStep);
  await expect(rows).toHaveCount(step);
  await expect(card.locator('.list-window-more:visible')).toHaveCount(1);

  const target = `song_${pad(N - 1)}`;
  await page.evaluate((id) => { Alpine.store('catalogUi').selectedSongId = id; }, target);
  await expect(card.locator(`.entity-row[data-song-id="${target}"]`)).toHaveCount(1);
});
