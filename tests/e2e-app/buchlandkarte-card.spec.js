// Buchlandkarte-Karte gegen die ECHTE App (playwright.app.config.js).
//
// Der Smoke öffnet die Karte nur ohne Embedding-Backend — dort steht bloss der
// „nicht konfiguriert"-Hinweis. Hier wird das Backend-Flag im Config-Store
// gesetzt, Index-Status und Job abgefangen (`page.route`), damit die ganze
// Ergebnis-Kette echt rendert: Karte, Index-Stand, Ausreisser in absteigender
// Reihenfolge, Teilungsbefund mit Bruchstelle, Kapitel-Hervorhebung auf dem
// Canvas, Achsen-Enden, Verlaufsfärbung, der Tab „Verlauf" mit Matrix und
// Bruchstellen, Wiederherstellen aus dem Sitzungs-Cache ohne zweiten Lauf — und
// der Fall, dass der Index-Status nicht abfragbar ist.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const CARD = '#buchlandkarte-panel-map';

const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

// Matrix im Job-Format (oberes Dreieck als Bytes, base64): Abschnitte desselben
// Kapitels ähnlich, verschiedene unähnlich.
function matrixFor(ids, chapterOf) {
  const m = ids.length;
  const bytes = [];
  for (let i = 0; i < m; i++) {
    for (let j = i; j < m; j++) {
      const s = i === j ? 1 : chapterOf(ids[i]) === chapterOf(ids[j]) ? 0.6 : -0.3;
      bytes.push(Math.round((s + 1) * 127.5));
    }
  }
  return Buffer.from(bytes).toString('base64');
}

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
      options: { granularity: 'page', poles: null },
      pages: allIds.map(id => ({ id, chapterId: chapterOf(id), chunks: 2 })),
      projection: {
        mode: 'pca', granularity: 'page', thinned: 0,
        axes: [{ kind: 'pc', variance: 0.3 }, { kind: 'pc', variance: 0.12 }, { kind: 'pc', variance: 0.05 }],
        points: allIds.map((id, i) => ({
          id, chapterId: chapterOf(id), ix: null,
          c: [-0.9 + (1.8 * i) / Math.max(1, allIds.length - 1), (i % 2 ? 0.3 : -0.3), (i % 3) / 10],
        })),
      },
      matrix: {
        size: allIds.length,
        bins: allIds.map(id => [id]),
        data: matrixFor(allIds, chapterOf),
        kernel: 4,
        novelty: allIds.map((_, i) => (i === idsA.length ? 0.9 : i > 0 ? 0.1 : null)),
        boundaries: [{ ix: idsA.length, score: 0.9 }],
        echoes: [],
      },
      poleCandidates: [],
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

  // Achsen-Enden: zwei Raumachsen (Achse 1 × Achse 2) mit Abschnitten an beiden Enden.
  await expect(card.locator('.buchlandkarte-axis')).toHaveCount(2);
  await expect(card.locator('.buchlandkarte-axis').first().locator('.entity-ref').first()).toBeVisible();

  // Verlaufsfärbung: ein Datensatz, Punkte durch eine Linie verbunden.
  await card.locator('.buchlandkarte-view .seg-toggle button').nth(1).click();
  await expect.poll(() => page.evaluate(() => {
    const ds = window.Chart.getChart(document.getElementById('bookMapCanvas'))?.data?.datasets || [];
    return ds.length === 1 && ds[0].showLine === true;
  })).toBe(true);
  await card.locator('.buchlandkarte-view .seg-toggle button').nth(0).click();

  // Tab „Verlauf": Matrix gezeichnet, Bruchstelle an der Kapitelgrenze, Hash.
  await page.locator('#buchlandkarte-tab-matrix').click();
  await expect(card.locator('#bookMatrixCanvas')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.getElementById('bookMatrixCanvas').width)).toBeGreaterThan(0);
  const boundaryRows = card.locator('.buchlandkarte-table').filter({ has: page.locator('th', { hasText: /Bruch vor|Turn before/ }) }).locator('tbody tr');
  await expect(boundaryRows).toHaveCount(1);
  await expect(boundaryRows.first()).toContainText(/Kapitelgrenze|chapter boundary/);
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/\/buchverlauf$/);
  await page.locator('#buchlandkarte-tab-map').click();
  await expect(card.locator('#bookMapCanvas')).toBeVisible();

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

  await page.evaluate((id) => { location.hash = '#book/' + id + '/buchverlauf'; }, bookId);
  await expect(page.locator('#buchlandkarte-tab-matrix')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#buchlandkarte-panel-map')).toBeVisible();
  await expect(page.locator('#buchlandkarte-panel-redundanz')).toBeHidden();
});

test('buchlandkarte: eigene Pole gehen in den Lauf, KI-Benennung beschriftet die Achsen', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  // Die KI-Benennung braucht vier Abschnitte je Achsenende — das Seed-Buch hat
  // weniger; Abschnitte, die die Navigationsliste nicht kennt, zeigt die Karte
  // mit Ersatznamen.
  const navIds = await page.evaluate(() => window.Alpine.store('nav').pages.map(p => p.id));
  const ids = [...navIds, ...Array.from({ length: Math.max(0, 10 - navIds.length) }, (_, i) => 900001 + i)];
  const chapterOf = () => null;

  await page.route('**/search/semantic/status*', (route) => route.fulfill(json({
    enabled: true, indexed: true, byKind: [{ kind: 'page', chunks: 40 }],
  })));
  const mapBodies = [];
  let labelBody = null;
  await page.route('**/jobs/book-map', (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    mapBodies.push(body);
    return route.fulfill(json({ jobId: body.poles ? 'bm-poles' : 'bm-pca' }));
  });
  await page.route('**/jobs/book-map-label', (route) => {
    labelBody = JSON.parse(route.request().postData() || '{}');
    return route.fulfill(json({ jobId: 'bm-label' }));
  });
  const base = (mode, axes, poles) => ({
    model: 'bge-m3',
    options: { granularity: 'page', poles },
    pages: ids.map(id => ({ id, chapterId: null, chunks: 1 })),
    projection: {
      mode, granularity: 'page', thinned: 0, axes,
      points: ids.map((id, i) => ({ id, chapterId: null, ix: null, c: axes.map((_, k) => ((i + k) % ids.length) / ids.length - 0.5) })),
    },
    matrix: { size: ids.length, bins: ids.map(id => [id]), data: matrixFor(ids, chapterOf), kernel: 4, novelty: ids.map(() => null), boundaries: [], echoes: [] },
    poleCandidates: [{ kind: 'figure', id: 7, name: 'Tony' }],
    chapters: [], outliers: [], explainedVariance: mode === 'pca' ? 0.2 : null,
    truncatedPages: 0, totalPages: ids.length, missingPages: 0, stalePages: 0, lastIndexedAt: null, computedAt: '2026-02-02T00:00:00.000Z',
  });
  await page.route('**/jobs/bm-pca', (route) => route.fulfill(json({
    id: 'bm-pca', type: 'book-map', status: 'done', progress: 100,
    result: base('pca', [{ kind: 'pc', variance: 0.12 }, { kind: 'pc', variance: 0.08 }, { kind: 'pc', variance: 0.05 }], null),
  })));
  await page.route('**/jobs/bm-label', (route) => route.fulfill(json({
    id: 'bm-label', type: 'book-map-label', status: 'done', progress: 100,
    result: { axes: [
      { neg: 'Kontor', pos: 'Salon', diff: 'Geschäft gegen Familie.' },
      { neg: 'Szene', pos: 'Rückblick', diff: 'Gegenwart gegen Erinnerung.' },
      { neg: 'Stadt', pos: 'Land', diff: 'Ort.' },
    ] },
  })));
  await page.route('**/jobs/bm-poles', (route) => route.fulfill(json({
    id: 'bm-poles', type: 'book-map', status: 'done', progress: 100,
    result: base('poles', [{ kind: 'pole', variance: 0.04, poles: ['Tony', 'Geschäft'] }],
      { x: [{ kind: 'figure', id: 7 }, { kind: 'text', text: 'Geschäft' }], y: null }),
  })));

  await page.evaluate(() => {
    window.Alpine.store('config').semanticSearchEnabled = true;
    window.__app.toggleBuchlandkarteCard();
  });
  const card = page.locator(CARD);
  await card.locator('.buchlandkarte-toolbar button.primary').click();
  await page.waitForFunction(() => !!window.Chart?.getChart(document.getElementById('bookMapCanvas')));

  // KI-Benennung: drei Achsen mit je vier Abschnitten pro Ende, Labels landen im Achsentitel.
  await card.locator('.buchlandkarte-section-head button').click();
  await expect.poll(() => labelBody?.axes?.length).toBe(3);
  expect(labelBody.axes[0].neg.length).toBeGreaterThan(0);
  await expect(card.locator('.buchlandkarte-axis-diff').first()).toHaveText('Geschäft gegen Familie.');
  await expect.poll(() => page.evaluate(() =>
    window.Chart.getChart(document.getElementById('bookMapCanvas')).options.scales.x.title.text)).toContain('Kontor');

  // Eigene Pole: Figur gegen freien Begriff; ohne senkrechtes Paar läuft y durchs Buch.
  await card.locator('.buchlandkarte-options .seg-toggle').nth(1).locator('button').nth(1).click();
  const poles = card.locator('.buchlandkarte-poles .buchlandkarte-pole');
  await poles.nth(0).locator('.combobox-trigger').click();
  await poles.nth(0).locator('.combobox-option').filter({ hasText: 'Tony' }).click();
  await poles.nth(1).locator('.combobox-trigger').click();
  await poles.nth(1).locator('.combobox-option').filter({ hasText: /Freier Begriff|Free term/ }).click();
  await poles.nth(1).locator('.buchlandkarte-pole-text').fill('Geschäft');
  await card.locator('.buchlandkarte-toolbar button.primary').click();
  await expect.poll(() => mapBodies.length).toBe(2);
  expect(mapBodies[1].poles).toEqual({ x: [{ kind: 'figure', id: 7 }, { kind: 'text', text: 'Geschäft' }], y: null });
  await expect.poll(() => page.evaluate(() => {
    const c = window.Chart.getChart(document.getElementById('bookMapCanvas'));
    return c ? [c.options.scales.x.title.text, c.options.scales.y.title.text].join(' | ') : '';
  })).toMatch(/Geschäft.*Tony.*\|.*(Buchverlauf|Reading order)/);
});
