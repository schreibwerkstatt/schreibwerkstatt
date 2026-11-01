// Deckt die Tiles der Buch-Übersicht ab, die aus GETEILTEN Partial-Fragmenten
// gerendert werden — gegen die echte App (siehe playwright.app.config.js):
//   partials/bookoverview-presence-matrix.html  (Figuren / Schauplätze / Motive)
//   partials/bookoverview-chapter-bars.html     (Findings / Lektoratszeit)
//
// Warum eine eigene Spec: der allgemeine Smoke öffnet zwar jede Karte, aber das
// Dev-Seed-Buch hat weder Figuren noch Schauplätze, Motive, Heatmap-Findings
// oder Lektoratszeit — alle fünf Tiles hängen an einem `x-if` und werden dort
// nie gerendert. Die Fragment-Auflösung (`<!-- @include -->`) und die
// Scope-Weitergabe von `kind`/`labelKey` aus dem umgebenden `x-data` blieben
// damit ungetestet. Hier werden die Endpoints per Route-Interception befüllt,
// sodass alle fünf Tiles wirklich durch den Alpine-Template-Baum laufen.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');

// Die Kapitel-IDs des Seed-Buchs stehen erst zur Laufzeit fest; die Mocks
// werden deshalb nach dem Laden des Trees mit echten IDs gebaut.
function mockPayloads(chapterIds) {
  const [c1, c2] = chapterIds;
  return {
    figuren: {
      figuren: [
        { id: 'f1', name: 'Josef K.', kurzname: 'K.', rolle: 'protagonist' },
        { id: 'f2', name: 'Fräulein Bürstner', kurzname: 'Bürstner' },
      ],
    },
    szenen: {
      szenen: [
        { chapter_id: c1, fig_ids: ['f1', 'f2'], wertung: 'stark' },
        { chapter_id: c1, fig_ids: ['f1'], wertung: 'mittel' },
        { chapter_id: c2, fig_ids: ['f1', 'f2'], wertung: 'schwach' },
      ],
    },
    orte: {
      orte: [
        { id: 'o1', name: 'Gerichtskanzlei', typ: 'gebaeude', kapitel: [
          { chapter_id: c1, name: 'A', haeufigkeit: 4 },
          { chapter_id: c2, name: 'B', haeufigkeit: 2 },
        ] },
        { id: 'o2', name: 'Dom', typ: 'gebaeude', kapitel: [
          { chapter_id: c2, name: 'B', haeufigkeit: 3 },
        ] },
      ],
    },
    motifs: {
      motifs: [
        { id: 1, name: 'Schuld', occChapters: [{ chapterId: c1, n: 6 }, { chapterId: c2, n: 2 }] },
        { id: 2, name: 'Bürokratie', occChapters: [{ chapterId: c1, n: 3 }] },
      ],
    },
    heat: {
      chapters: [
        { chapter_id: c1, chapter_name: 'A', words: 400, pages_total: 3, pages_checked: 3 },
        { chapter_id: c2, chapter_name: 'B', words: 200, pages_total: 2, pages_checked: 2 },
      ],
      matrix: {
        [c1]: { stil: { count: 7 }, grammatik: { count: 2 } },
        [c2]: { stil: { count: 1 } },
      },
      totals: { stil: 8, grammatik: 2 },
    },
    lektoratTime: {
      per_chapter: [
        { chapter_id: c1, seconds: 900, pages_count: 3 },
        { chapter_id: c2, seconds: 240, pages_count: 2 },
      ],
    },
  };
}

async function bootWithBook(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__app && window.Alpine.store('nav').books?.length > 0,
    null, { timeout: 30000 },
  );
  const bookId = await page.evaluate(() => window.Alpine.store('nav').books[0].id);
  await page.evaluate((id) => { location.hash = '#book/' + id; }, bookId);
  await page.waitForFunction(
    (id) => String(window.Alpine.store('nav').selectedBookId) === String(id)
            && window.Alpine.store('nav').pages?.length > 0
            && window.Alpine.store('nav').tree?.length > 0,
    bookId, { timeout: 20000 },
  );
  return bookId;
}

test('Präsenz-Matrizen + Kapitel-Balken rendern aus den geteilten Fragmenten', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  const bookId = await bootWithBook(page);

  const chapterIds = await page.evaluate(() =>
    window.Alpine.store('nav').tree
      .filter(i => i.type === 'chapter' && !i.solo && i.parent_id == null)
      .map(i => i.id));
  expect(chapterIds.length, 'Seed-Buch braucht ≥ 2 Top-Level-Kapitel').toBeGreaterThanOrEqual(2);

  const mock = mockPayloads(chapterIds);
  // Die Übersicht holt ihre Tile-Daten gebündelt (GET /overview/:id): die echte
  // Antwort durchreichen und nur die Teile der fünf Tiles ersetzen.
  await page.route(`**/overview/${bookId}*`, async (route) => {
    const real = await (await route.fetch()).json();
    const parts = {
      ...real.parts,
      figuren: { data: mock.figuren },
      szenen: { data: mock.szenen },
      orte: { data: mock.orte },
      motifs: { data: mock.motifs },
      heat: { data: mock.heat },
      lektorat: { data: mock.lektoratTime },
    };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ parts }) });
  });

  // Übersicht neu laden, damit die gemockten Endpoints greifen. Bewusst über
  // den Re-Klick-Pfad der offenen Karte (`onReclick: 'refresh'` →
  // `card:refresh`): der Listener dafür fehlte, der Re-Klick war ein stiller
  // No-Op. Wenn die Tiles unten stehen, greift er.
  await page.waitForFunction(() => window.__app.showBookOverviewCard === true, null, { timeout: 20000 });
  await page.evaluate(() => window.__app.toggleBookOverviewCard());

  const card = page.locator('.card--bookoverview');

  // ── Präsenz-Matrizen: drei Tiles aus EINEM Fragment ──────────────────────
  for (const [labelKey, colName] of [
    ['overview.figPresence', 'K.'],
    ['overview.ortPresence', 'Gerichtskanzlei'],
    ['overview.motifPresence', 'Schuld'],
  ]) {
    const label = await page.evaluate((k) => window.__app.t(k), labelKey);
    const tile = card.locator('.overview-tile', { hasText: label });
    await expect(tile, `${labelKey}: Tile gerendert`).toBeVisible();
    // Spaltenkopf beweist, dass `kind` aus dem x-data im Fragment ankommt.
    await expect(tile.locator('.overview-presence-col-head', { hasText: colName })).toBeVisible();
    // Zeilen = Wurzel-Kapitel, Zellen tragen die Intensitäts-Custom-Property.
    await expect(tile.locator('.overview-presence-row-head').first()).toBeVisible();
    const filled = tile.locator('.overview-presence-cell:not(.overview-presence-cell--empty)');
    expect(await filled.count(), `${labelKey}: belegte Zellen`).toBeGreaterThan(0);
    // Klickziel ist ein Button IN der Zelle, das <td> bleibt Tabellenzelle
    // (role=button nähme Screenreadern Zeile/Spalte).
    await expect(filled.first().locator('button.heatmap-cell-btn')).toHaveCount(1);
    await expect(filled.first()).not.toHaveAttribute('role', /./);
    await expect(tile.locator('.overview-presence-row-head').first()).not.toHaveAttribute('role', /./);
  }

  // Zell-Tooltip kommt aus overviewPresenceTip(kind, …) — belegt, dass der
  // Dispatcher die richtige i18n-Variante pro Variante zieht.
  const figLabel = await page.evaluate(() => window.__app.t('overview.figPresence'));
  const figTile = card.locator('.overview-tile', { hasText: figLabel });
  const tip = await figTile.locator('.overview-presence-cell:not(.overview-presence-cell--empty)')
    .first().getAttribute('data-tip');
  expect(tip).toContain('K.');

  // ── Kapitel-Balken: zwei Tiles aus EINEM Fragment ────────────────────────
  for (const labelKey of ['overview.chapterFindings', 'overview.chapterLektoratTime']) {
    const label = await page.evaluate((k) => window.__app.t(k), labelKey);
    const tile = card.locator('.overview-tile', { hasText: label });
    await expect(tile, `${labelKey}: Tile gerendert`).toBeVisible();
    const rows = tile.locator('.overview-chapter-row');
    expect(await rows.count(), `${labelKey}: Zeilen`).toBeGreaterThanOrEqual(2);
    // Wert-Spalte kommt aus overviewChapterBarValue(kind, ch) — nie leer.
    await expect(rows.first().locator('.overview-chapter-count')).not.toBeEmpty();
    // Ungeprüfte/untracked Kapitel werden herausgefiltert: die entfernte
    // nocheck-Variante darf nicht zurückkehren.
    expect(await tile.locator('.overview-chapter-row--nocheck').count()).toBe(0);
  }

  guard.assertClean('Buch-Übersicht mit geteilten Tile-Fragmenten');
});

// Die klickbare Verteilungs-Zeile steckt in einem nackten <li> (role=button nie
// am <li>). Reicht das <li> die Spalten nicht als Subgrid weiter, fallen die
// Zeilen einzeln in die drei Listenspalten: Median-Striche stehen versetzt,
// Name/Balken/Meta nicht mehr untereinander.
test('Kapitel-Länge vs. Median: Zeilen über die volle Breite, Median-Strich fluchtet', async ({ page }) => {
  await bootWithBook(page);
  await page.waitForFunction(() => window.__app.showBookOverviewCard === true, null, { timeout: 20000 });
  const label = await page.evaluate(() => window.__app.t('overview.chapterDist'));
  const tile = page.locator('.card--bookoverview .overview-tile', { hasText: label });
  await expect(tile).toBeVisible();

  const geo = await tile.locator('.overview-chapter-list').evaluate((list) => {
    const lr = list.getBoundingClientRect();
    return [...list.querySelectorAll('.overview-chapter-row')].map((row) => {
      const r = row.getBoundingClientRect();
      const t = row.querySelector('.overview-chapter-median-tick').getBoundingClientRect();
      return { width: r.width, listWidth: lr.width, tickX: t.left + t.width / 2 };
    });
  });
  expect(geo.length, 'Seed-Buch braucht ≥ 2 Kapitel').toBeGreaterThanOrEqual(2);
  for (const g of geo) expect(g.width).toBeGreaterThan(g.listWidth * 0.9);
  for (const g of geo) expect(Math.abs(g.tickX - geo[0].tickX)).toBeLessThan(1);
});
