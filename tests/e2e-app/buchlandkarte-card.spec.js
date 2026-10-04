// Buchlandkarte-Karte gegen die ECHTE App (playwright.app.config.js).
//
// Der Smoke öffnet die Karte nur ohne Embedding-Backend — dort steht bloss der
// „nicht konfiguriert"-Hinweis. Hier wird das Backend-Flag im Config-Store
// gesetzt, Index-Status und Job abgefangen (`page.route`), damit die ganze
// Ergebnis-Kette echt rendert: Karte, Index-Stand, Ausreisser in absteigender
// Reihenfolge, Teilungsbefund mit Bruchstelle, Kapitel-Hervorhebung auf dem
// Canvas, Wiederherstellen aus dem Sitzungs-Cache ohne zweiten Lauf — und der
// Fall, dass der Index-Status nicht abfragbar ist.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const CARD = '#buchlandkarte-panel-map';

const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

test('buchlandkarte: Ergebnis rendert, Ausreisser absteigend, Teilung, Hervorhebung, Cache', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const nav = await page.evaluate(() => window.Alpine.store('nav').pages
    .filter(p => p.chapter_id != null)
    .map(p => ({ id: p.id, chapterId: p.chapter_id })));
  const byChapter = new Map();
  for (const p of nav) {
    if (!byChapter.has(p.chapterId)) byChapter.set(p.chapterId, []);
    byChapter.get(p.chapterId).push(p.id);
  }
  const chapters = [...byChapter.entries()].filter(([, ids]) => ids.length >= 2);
  expect(chapters.length).toBeGreaterThanOrEqual(2);
  const [[chA, idsA], [chB, idsB]] = chapters;
  // Drittes Kapitel: weder Fokus noch Nachbar → muss abblenden. Das Seed-Buch
  // hat nur zwei Kapitel; ein Kapitel, das die Navigationsliste nicht kennt,
  // hängt die Karte hinten an — genau das nutzt der Test.
  const [chC, idsC] = chapters[2] || [987654, [987654321]];
  const allIds = [...idsA, ...idsB, ...idsC];
  const chapterOf = (id) => (idsA.includes(id) ? chA : idsB.includes(id) ? chB : chC);
  // Teilung von Kapitel A in zwei zusammenhängende Hälften (Gliederungsreihenfolge).
  const half = Math.ceil(idsA.length / 2);
  const splitA = idsA.length >= 2 ? [idsA.slice(0, half), idsA.slice(half)] : null;

  await page.route('**/search/semantic/status*', (route) => route.fulfill(json({
    enabled: true, indexed: true, lastIndexedAt: '2026-02-01T00:00:00.000Z', staleCount: 0,
    byKind: [{ kind: 'page', chunks: 40 }],
  })));
  let posts = 0;
  await page.route('**/jobs/book-map', (route) => { posts++; return route.fulfill(json({ jobId: 'bm-e2e' })); });
  await page.route('**/jobs/bm-e2e', (route) => route.fulfill(json({
    id: 'bm-e2e', type: 'book-map', status: 'done', progress: 100,
    result: {
      model: 'bge-m3',
      pages: allIds.map((id, i) => ({
        id, chapterId: chapterOf(id),
        x: -0.9 + (1.8 * i) / Math.max(1, allIds.length - 1), y: (i % 2 ? 0.3 : -0.3), chunks: 2,
      })),
      chapters: [
        { chapterId: chA, pages: idsA.length, cohesion: 0.62, spread: 0.4, nearestChapterId: chB, nearestScore: 0.35,
          split: splitA && splitA[1].length ? { silhouette: 0.6, groups: splitA } : null },
        { chapterId: chB, pages: idsB.length, cohesion: 0.81, spread: 0.2, nearestChapterId: chA, nearestScore: 0.35, split: null },
        { chapterId: chC, pages: idsC.length, cohesion: null, spread: null, nearestChapterId: chB, nearestScore: -0.1, split: null },
      ],
      outliers: [
        { id: idsB[0], chapterId: chB, distance: 0.2 },
        { id: idsA[0], chapterId: chA, distance: 0.4 },
      ],
      explainedVariance: 0.42, truncatedPages: 0,
      totalPages: allIds.length + 3, missingPages: 3, stalePages: 2,
      lastIndexedAt: '2026-02-01T00:00:00.000Z', computedAt: '2026-02-02T00:00:00.000Z',
    },
  })));

  await page.evaluate(() => {
    window.Alpine.store('config').semanticSearchEnabled = true;
    window.__app.toggleBuchlandkarteCard();
  });
  const card = page.locator(CARD);
  await expect(card).toBeVisible();
  await card.locator('.buchlandkarte-toolbar button.primary').click();

  // Karte gezeichnet.
  await expect(card.locator('#bookMapCanvas')).toBeVisible();
  await page.waitForFunction(() => !!window.Chart?.getChart(document.getElementById('bookMapCanvas')));

  // Index-Stand: fehlende + geänderte Seiten.
  await expect(card.locator('.buchlandkarte-meta')).toContainText(/3 (von|of) \d+/);
  await expect(card.locator('.buchlandkarte-meta .card-hint--warn').filter({ hasText: /geändert|changed/ }))
    .toContainText(/^2 /);

  // Ausreisser: der weiteste zuerst.
  const outlierRows = card.locator('.buchlandkarte-table').nth(1).locator('tbody tr');
  await expect(outlierRows).toHaveCount(2);
  await expect(outlierRows.first().locator('td').last()).toHaveText('40%');

  // Teilungsbefund mit Sprung zur Bruchstelle.
  if (splitA && splitA[1].length) {
    const split = card.locator('.buchlandkarte-split').filter({ hasText: /Zerfällt|Splits/ });
    await expect(split).toHaveCount(1);
    await expect(split.locator('.entity-ref')).toBeVisible();
  }

  // Hervorhebung: Klick auf Kapitel A → A und sein Nachbar B voll, ein drittes
  // Kapitel abgeblendet; zweiter Klick hebt auf.
  const alphas = () => page.evaluate(() => Object.fromEntries(
    window.Chart.getChart(document.getElementById('bookMapCanvas')).data.datasets
      .map(ds => [String(ds.chapterId), String(ds.backgroundColor).slice(-2)])));
  const btnA = card.locator('.buchlandkarte-focus-btn').filter({
    hasText: await page.evaluate((id) => (window.Alpine.store('nav').pages.find(p => String(p.chapter_id) === String(id)) || {}).chapterName, chA),
  }).first();
  await btnA.click();
  await expect(btnA).toHaveAttribute('aria-pressed', 'true');
  await expect(card.locator('tr.buchlandkarte-row--focus')).toHaveCount(1);
  const on = await alphas();
  expect(on[String(chA)]).toBe('cc');
  expect(on[String(chB)]).toBe('cc');
  expect(on[String(chC)]).toBe('22');
  await btnA.click();
  await expect(btnA).toHaveAttribute('aria-pressed', 'false');
  const off = await alphas();
  expect(Object.values(off).every(a => a === 'cc')).toBe(true);

  // Schliessen + wieder öffnen: Ergebnis aus dem Sitzungs-Cache, kein zweiter Lauf.
  await page.evaluate(() => window.__app.toggleBuchlandkarteCard());
  await expect(card).toBeHidden();
  await page.evaluate(() => window.__app.toggleBuchlandkarteCard());
  await expect(card.locator('#bookMapCanvas')).toBeVisible();
  await expect(outlierRows).toHaveCount(2);
  expect(posts).toBe(1);
});

test('buchlandkarte: Index-Status nicht abfragbar → kein „kein Index", Lauf bleibt möglich', async ({ page, consoleGuard }) => {
  // Der Browser meldet die 500-Antwort selbst als Konsolenfehler — erwartet.
  consoleGuard.ignore(/500|Failed to load resource/);
  await bootApp(page);
  await selectSeededBook(page);
  await page.route('**/search/semantic/status*', (route) => route.fulfill(json({ error_code: 'STATUS_FAILED' }, 500)));

  await page.evaluate(() => {
    window.Alpine.store('config').semanticSearchEnabled = true;
    window.__app.toggleBuchlandkarteCard();
  });
  const card = page.locator(CARD);
  await expect(card).toBeVisible();
  await expect(card.locator('.card-hint--warn').first()).toBeVisible();
  await expect(card.locator('.buchlandkarte-toolbar button.primary')).toBeVisible();
  await expect(card.getByText(/noch keinen Semantik-Index|no semantic index/)).toBeHidden();
});

test('buchlandkarte: Tabs — #redundanz öffnet „Doppelungen", Tab-Wechsel schreibt den Hash', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  await page.evaluate((id) => { location.hash = '#book/' + id + '/redundanz'; }, bookId);
  const shell = page.locator('.card--buchlandkarte');
  await expect(shell).toBeVisible();
  await expect(page.locator('#buchlandkarte-panel-redundanz')).toBeVisible();
  await expect(page.locator('#buchlandkarte-panel-map')).toBeHidden();
  await expect(page.locator('#buchlandkarte-tab-redundanz')).toHaveAttribute('aria-selected', 'true');

  await page.locator('#buchlandkarte-tab-map').click();
  await expect(page.locator('#buchlandkarte-panel-map')).toBeVisible();
  await expect(page.locator('#buchlandkarte-panel-redundanz')).toBeHidden();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#book/' + bookId + '/landkarte');

  await page.locator('#buchlandkarte-tab-redundanz').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#book/' + bookId + '/redundanz');
});
