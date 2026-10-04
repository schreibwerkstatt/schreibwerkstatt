// Ideen-Board gegen die ECHTE App: Bahnen × Stufen, Filter, Verknuepfungen.
//
// Warum hier und nicht als Fixture-Harness: das Board haengt an drei Dingen, die
// nur die gebootete App hat — der BAHNEN-REIHENFOLGE aus `$store.nav.tree` (die
// SSoT der Buch-Ordnung, kein Karten-State), dem echten `PATCH /ideen/:id` (die
// Stufe ist ein CHECK-gegatetes Spaltenfeld) und dem Grid-CSS der Shell (dass
// eine Bahn ueber alle Spalten auf einer Linie liegt, ist eine Layout-Aussage).
// Nichts gestubbt.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const COLUMNS = ['offen', 'in_arbeit', 'erledigt', 'verworfen'];

// Die App-Suite faehrt alle Specs gegen EINEN Server mit EINEM Seed-Stand
// (playwright.app.config.js: `workers: 1`), und spaetere Specs zaehlen teils
// exakte Zeilen — plot-dnd.spec.js etwa erwartet genau seine drei Beats auf dem
// Board. Was dieses Spec an PLOT-Daten anlegt, raeumt es darum wieder weg;
// Loeschen des Akts nimmt seine Beats mit (CASCADE), und mit dem Beat faellt
// auch die Ideen-Kante. Die Ideen selbst bleiben stehen: sie zaehlt niemand.
const createdActIds = [];

test.afterAll(async ({ browser }) => {
  if (!createdActIds.length) return;
  const page = await browser.newPage();
  try {
    await page.goto('/');
    await page.waitForFunction(() => window.__app && window.Alpine.store('nav').selectedBookId);
    await page.evaluate(
      (ids) => Promise.all(ids.map(id => fetch(`/plot/acts/${id}`, { method: 'DELETE' }))),
      createdActIds,
    );
  } finally {
    await page.close();
  }
});

test('ideen-board: Bahnen aus dem Baum, Stufen-Spalten, Filter blendet aus und sagt es', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  // Drei Pendenzen: zwei an einer Seite, eine direkt am Kapitel — damit beide
  // Bahn-Arten im Board vorkommen.
  const made = await page.evaluate(async (id) => {
    const tree = await fetch(`/content/books/${id}/tree`).then(r => r.json());
    const chapter = tree.chapters?.[0];
    const pageId = chapter?.pages?.[0]?.id;
    const post = (payload) => fetch('/ideen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: id, ...payload }),
    }).then(r => r.json());

    const a = await post({ page_id: pageId, content: 'Beleg für die Jahreszahl nachtragen' });
    const b = await post({ page_id: pageId, content: 'Szene kürzen' });
    const c = await post({ chapter_id: chapter.id, content: 'Kapitelbogen prüfen' });
    return { chapterId: chapter.id, pageId, a: a.id, b: b.id, c: c.id, status: a.status };
  }, bookId);

  expect(made.pageId, 'Seed-Buch braucht eine Seite in einem Kapitel').toBeTruthy();
  // Frisch angelegt heisst unbearbeitet — der Default kommt vom Server.
  expect(made.status).toBe('offen');

  await page.evaluate((id) => { location.hash = `#book/${id}/ideen`; }, bookId);
  const card = page.locator('#ideen-board-card');
  await expect(card).toBeVisible();

  // ── Spalten: alle vier Stufen, auch die leeren ──────────────────────────
  for (const st of COLUMNS) {
    await expect(card.locator(`.ideen-board-head-col--${st}`)).toBeVisible();
  }

  // ── Bahnen: Kapitel-Bahn VOR der Bahn ihrer Seite (Baum-Reihenfolge) ────
  const laneKeys = await card.locator('.ideen-board-cell').evaluateAll(
    (cells) => [...new Set(cells.map(c => c.dataset.ideeLane))]);
  expect(laneKeys).toEqual([`chapter:${made.chapterId}`, `page:${made.pageId}`]);

  // ── Eine Karte sitzt in ihrer Bahn UND ihrer Spalte ─────────────────────
  const cardA = card.locator(`[data-idee-card-id="${made.a}"]`);
  await expect(cardA).toBeVisible();
  const cellOfA = card.locator(`[data-idee-lane="page:${made.pageId}"][data-idee-status-cell="offen"]`);
  await expect(cellOfA.locator(`[data-idee-card-id="${made.a}"]`)).toHaveCount(1);

  // ── Stufe setzen: derselbe Schreibpfad wie der Drag, nur mit der Tastatur ─
  await cardA.hover();
  await cardA.locator('.idee-board-step--in_arbeit').click();
  await expect(
    card.locator(`[data-idee-lane="page:${made.pageId}"][data-idee-status-cell="in_arbeit"] [data-idee-card-id="${made.a}"]`)
  ).toHaveCount(1);

  // …und sie steht wirklich in der DB, nicht nur im Karten-State.
  const persisted = await page.evaluate(async (id) => {
    const data = await fetch(`/ideen/board?book_id=${id}`).then(r => r.json());
    return Object.fromEntries(data.ideen.map(i => [i.id, i.status]));
  }, bookId);
  expect(persisted[made.a]).toBe('in_arbeit');

  // ── `verworfen` ist eine Stufe, kein Loeschen ───────────────────────────
  const cardB = card.locator(`[data-idee-card-id="${made.b}"]`);
  await cardB.hover();
  await cardB.locator('.idee-board-step--verworfen').click();
  // Per Default ausgeblendet — aber der Zaehler sagt, dass etwas fehlt.
  await expect(card.locator(`[data-idee-card-id="${made.b}"]`)).toHaveCount(0);
  await expect(card.locator('.filter-count')).toContainText('1');
  // Die Spalte zeigt trotzdem ihre Zahl: sie misst den GESAMTEN Bestand.
  await expect(card.locator('.ideen-board-head-col--verworfen .board-col-count')).toHaveText('1');

  // Einblenden bringt sie zurueck — sie war nie weg.
  await card.locator('.filter-toggle input[x-model="showVerworfen"]').check();
  await expect(card.locator(`[data-idee-card-id="${made.b}"]`)).toHaveCount(1);

  // ── Kapitel-Filter erfasst auch die Ideen der SEITEN des Kapitels ───────
  // (Das ist der Grund fuer `lane_chapter_id`; nach `chapter_id` gefiltert
  // fiele die Seiten-Bahn heraus.)
  await card.locator('.filter-bar .combobox-trigger').first().click();
  await page.locator('.combobox-option', { hasText: 'Kapitel' }).first().click();
  await expect(card.locator(`[data-idee-lane="page:${made.pageId}"]`).first()).toBeVisible();
  await expect(card.locator(`[data-idee-card-id="${made.c}"]`)).toHaveCount(1);
});

test('ideen-board: Verknuepfung ist beidseitig — Chip an der Idee, Plakette am Beat', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  // Ein Beat als Ziel + eine Pendenz, die darauf zeigt.
  const made = await page.evaluate(async (id) => {
    const post = (url, payload) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.json());

    const act = await post('/plot/acts', { book_id: id, name: 'Akt für die Pendenz' });
    const beat = await post('/plot/beats', { book_id: id, act_id: act.id, titel: 'Der Prozess beginnt' });

    const tree = await fetch(`/content/books/${id}/tree`).then(r => r.json());
    const pageId = tree.chapters?.[0]?.pages?.[0]?.id;
    const idee = await post('/ideen', { book_id: id, page_id: pageId, content: 'Beat hier tatsächlich einlösen' });

    const linked = await post(`/ideen/${idee.id}/links`, { target_kind: 'beat', target_id: beat.id });
    return { actId: act.id, beatId: beat.id, ideeId: idee.id, links: linked.links?.length ?? 0, label: linked.links?.[0]?.label };
  }, bookId);
  createdActIds.push(made.actId);

  expect(made.links).toBe(1);
  // Das Label kommt per JOIN zur Lesezeit, nicht als Snapshot.
  expect(made.label).toBe('Der Prozess beginnt');

  // ── Seite 1: die Beat-Referenz an der Idee, mit Sprung zum Beat ─────────
  await page.evaluate((id) => { location.hash = `#book/${id}/ideen`; }, bookId);
  const boardCard = page.locator('#ideen-board-card');
  await expect(boardCard).toBeVisible();
  const chip = boardCard.locator(`[data-idee-card-id="${made.ideeId}"] .idee-links .entity-ref--beat`);
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('Der Prozess beginnt');

  // ── Seite 2: die Ideen-Referenz am Beat, read-only, mit Sprung zurueck ──
  await page.evaluate((id) => { location.hash = `#book/${id}/plot`; }, bookId);
  await expect(page.locator('.card--plot')).toBeVisible();
  // `.first()`: die Beat-Karte steht im DOM zweimal (flaches Board + Raster-Board
  // teilen sich das Fragment plot-beat-cell.html), sichtbar ist immer nur eine.
  const plaque = page.locator(`[data-beat-id="${made.beatId}"] .idee-backlinks .entity-ref--idee`).first();
  await expect(plaque).toBeVisible();
  await expect(plaque).toContainText('Beat hier tatsächlich einlösen');
});

// Geometrie-Test, darum hier und nicht im Fixture-Harness: der Picker wird nach
// <body> teleportiert und am geklickten Knopf verankert (public/js/popover-
// anchor.js). Ob er dort landet, entscheiden echte Bounding-Boxen im echten
// Shell-CSS — ein Harness saehe ihn „offen" und merkte nicht, dass er ausserhalb
// des Sichtfelds steht. Genau das war der Bug: der Klick sah wirkungslos aus.
test('ideen-board: Verknuepfungs-Picker oeffnet AM Knopf und schreibt die Kante', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  const made = await page.evaluate(async (id) => {
    const post = (url, payload) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.json());

    const act = await post('/plot/acts', { book_id: id, name: 'Akt für den Picker' });
    const beat = await post('/plot/beats', { book_id: id, act_id: act.id, titel: 'Wendepunkt am Fluss' });

    const tree = await fetch(`/content/books/${id}/tree`).then(r => r.json());
    const pageId = tree.chapters?.[0]?.pages?.[0]?.id;
    const idee = await post('/ideen', { book_id: id, page_id: pageId, content: 'Diesen Wendepunkt vorbereiten' });
    return { actId: act.id, beatId: beat.id, ideeId: idee.id };
  }, bookId);
  createdActIds.push(made.actId);

  await page.evaluate((id) => { location.hash = `#book/${id}/ideen`; }, bookId);
  const boardCard = page.locator('#ideen-board-card');
  await expect(boardCard).toBeVisible();

  const card = boardCard.locator(`[data-idee-card-id="${made.ideeId}"]`);
  await expect(card).toBeVisible();
  const trigger = card.getByRole('button', { name: 'Verknüpfen' });
  await trigger.click();

  const popover = page.locator('.idee-link-popover');
  await expect(popover).toBeVisible();
  // Die Kopfzeile nennt die Idee — sonst waere am schwebenden Popover nicht zu
  // sehen, woran gerade verknuepft wird.
  await expect(popover).toContainText('Diesen Wendepunkt vorbereiten');

  // ── Die eigentliche Aussage: das Popover klebt am Knopf ─────────────────
  const tb = await trigger.boundingBox();
  const pb = await popover.boundingBox();
  // Vertikal dicht dran — unter dem Knopf oder (bei Platzmangel) darueber.
  const gap = Math.min(Math.abs(pb.y - (tb.y + tb.height)), Math.abs(tb.y - (pb.y + pb.height)));
  expect(gap, `Popover ${gap}px vom Trigger entfernt`).toBeLessThan(24);
  // Horizontal ueberlappend (rechtsbuendig zum Knopf, am Rand geclampt).
  expect(pb.x).toBeLessThanOrEqual(tb.x + tb.width);
  expect(pb.x + pb.width).toBeGreaterThanOrEqual(tb.x);
  // Und vollstaendig im Bild — ein Popover unterhalb des Viewports ist so gut
  // wie keins.
  const vh = page.viewportSize().height;
  expect(pb.y).toBeGreaterThanOrEqual(0);
  expect(pb.y + pb.height).toBeLessThanOrEqual(vh);

  // ── Runde durch die echte Oberflaeche: Art waehlen, Ziel waehlen, sichern ─
  const kindBox = popover.locator('.combobox-wrap').first();
  await kindBox.locator('.combobox-trigger').click();
  await kindBox.locator('.combobox-option', { hasText: 'Beat' }).first().click();

  const targetBox = popover.locator('.combobox-wrap').nth(1);
  await targetBox.locator('.combobox-trigger').click();
  await targetBox.locator('.combobox-option', { hasText: 'Wendepunkt am Fluss' }).first().click();

  await popover.getByRole('button', { name: 'Verknüpfen' }).click();

  await expect(popover).toBeHidden();
  const chip = card.locator('.idee-links .entity-ref--beat');
  await expect(chip).toContainText('Wendepunkt am Fluss');
});

// Drag-Geometrie, darum hier und nicht im Fixture-Harness: was der Zeiger
// waehrend des Zugs traegt, ist ein Klon im <body> (SortableJS forceFallback,
// Optionen in public/js/sortable-dnd.js) — ohne Spalten-Kontext und ohne
// Karten-Akzent. Ein Harness saehe die Statusaenderung und merkte nicht, dass
// der Klon der Maus hinterherlerpt oder konturlos bleibt.
test('ideen-board: Drag-Klon haengt am Zeiger und traegt die Karte in die Spalte', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  const made = await page.evaluate(async (id) => {
    const tree = await fetch(`/content/books/${id}/tree`).then(r => r.json());
    const pageId = tree.chapters?.[0]?.pages?.[0]?.id;
    const idee = await fetch('/ideen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: id, page_id: pageId, content: 'Diese Notiz wandert per Zug' }),
    }).then(r => r.json());
    return { pageId, ideeId: idee.id };
  }, bookId);

  await page.evaluate((id) => { location.hash = `#book/${id}/ideen`; }, bookId);
  const boardCard = page.locator('#ideen-board-card');
  await expect(boardCard).toBeVisible();
  const source = boardCard.locator(`[data-idee-card-id="${made.ideeId}"]`);
  await expect(source).toBeVisible();
  // SortableJS bindet die Zellen nach dem Board-Load asynchron an
  // (_ensureBoardSortables → nextTick); vor dem Zug kurz abwarten.
  await page.waitForTimeout(400);

  const grip = await source.locator('.idee-board-grip').boundingBox();
  const target = boardCard.locator(`[data-idee-lane="page:${made.pageId}"][data-idee-status-cell="in_arbeit"]`);
  const drop = await target.boundingBox();

  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  // Mehr als fallbackTolerance(5px), sonst startet SortableJS den Zug nicht.
  await page.mouse.move(grip.x + grip.width / 2 + 8, grip.y + grip.height / 2 + 14, { steps: 4 });

  const clone = page.locator('body > .idee-board-card--dragging');
  await expect(clone).toBeVisible();

  // ── Der Klon haengt am Zeiger ───────────────────────────────────────────
  // SortableJS setzt sein `transform` pro Mousemove per Inline-Style. Erbt der
  // Klon eine transform-Transition von der Karte, laeuft er der Maus hinterher
  // statt mitzugehen — die Karte sieht dann stehengeblieben aus.
  const dur = await clone.evaluate(el => getComputedStyle(el).transitionDuration);
  expect(dur.split(',').map(s => s.trim()).every(d => parseFloat(d) === 0),
    `Drag-Klon hat eine Transition (${dur}) und lerpt dem Zeiger hinterher`).toBe(true);

  // Und er bewegt sich wirklich: zwei Zeigerpositionen, zwei Kastenlagen.
  const boxA = await clone.boundingBox();
  await page.mouse.move(drop.x + drop.width / 2, drop.y + 24, { steps: 10 });
  await page.waitForTimeout(80);
  const boxB = await clone.boundingBox();
  expect(Math.abs(boxB.x - boxA.x) + Math.abs(boxB.y - boxA.y),
    'Drag-Klon bleibt beim Ziehen an derselben Stelle stehen').toBeGreaterThan(20);

  // ── Und er ist sichtbar ausgestaltet ────────────────────────────────────
  // Im <body> fehlen --ideen-status-accent und --card-accent; ohne Rueckfall
  // faellt der Rahmen auf currentColor und der Grund auf transparent zurueck.
  const look = await clone.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { border: cs.borderTopColor, bg: cs.backgroundColor, shadow: cs.boxShadow, text: cs.color };
  });
  expect(look.border).not.toBe(look.text);
  expect(look.bg).not.toBe('rgba(0, 0, 0, 0)');
  expect(look.shadow).not.toBe('none');

  // Der zurueckgelassene Slot ist als Platzhalter erkennbar, nicht als zweite
  // Karte: Inhalt unsichtbar (der Klon ist die einzige sichtbare Karte).
  await expect(source).toHaveClass(/idee-board-card--ghost/);
  const ghostChildVisible = await source.evaluate(
    el => getComputedStyle(el.firstElementChild).visibility);
  expect(ghostChildVisible).toBe('hidden');

  await page.mouse.move(drop.x + drop.width / 2, drop.y + 28, { steps: 3 });
  await page.waitForTimeout(60);
  await page.mouse.up();

  // ── Der Zug traegt genau eine Aussage: die neue Stufe, persistiert ──────
  await expect(
    target.locator(`[data-idee-card-id="${made.ideeId}"]`)
  ).toHaveCount(1, { timeout: 10000 });
  await page.waitForFunction(async (args) => {
    const data = await fetch(`/ideen/board?book_id=${args.bookId}`).then(r => r.json());
    return data.ideen.find(i => i.id === args.ideeId)?.status === 'in_arbeit';
  }, { bookId, ideeId: made.ideeId }, { timeout: 10000 });
  // Kein Drag-Rest: der Klon ist weg, die Drop-Zonen sind wieder normal.
  await expect(page.locator('body > .idee-board-card--dragging')).toHaveCount(0);
  await expect(page.locator('body.ideen-dnd-active')).toHaveCount(0);
});

test('ideen-board: Kapitel und Bahnen klappen — und der Stand ueberlebt den Reload', async ({ page }) => {
  // Warum gegen die echte App: die Klappung haengt an drei Dingen ausserhalb der
  // reinen Rechnung — der Bahnen-Reihenfolge aus `$store.nav.tree`, dem
  // localStorage-Filter-Scope (pro Buch, ueber den Reload hinweg) und daran,
  // dass die Drop-Zonen nach dem Zuklappen neu angebunden werden.

  await bootApp(page);
  const bookId = await selectSeededBook(page);

  const made = await page.evaluate(async (id) => {
    const tree = await fetch(`/content/books/${id}/tree`).then(r => r.json());
    const chapter = tree.chapters?.[0];
    const pageId = chapter?.pages?.[0]?.id;
    const row = await fetch('/ideen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: id, page_id: pageId, content: 'Klapptest: Zeitangabe prüfen' }),
    }).then(r => r.json());
    return { chapterId: chapter.id, pageId, ideeId: row.id };
  }, bookId);

  const openBoard = async () => {
    await page.evaluate((id) => { location.hash = `#book/${id}/ideen`; }, bookId);
    const card = page.locator('#ideen-board-card');
    await expect(card).toBeVisible();
    await expect(card.locator(`[data-idee-lane="page:${made.pageId}"]`).first()).toBeAttached();
    return card;
  };

  let card = await openBoard();
  const chapterRow = card.locator(`.ideen-board-row:has([data-idee-lane="chapter:${made.chapterId}"])`);
  const pageCells = card.locator(`[data-idee-lane="page:${made.pageId}"]`);

  // ── Kapitel zuklappen: die Seiten-Bahn faellt in die Kapitelzeile ────────
  await chapterRow.locator('.ideen-board-pages').click();
  await expect(pageCells).toHaveCount(0);
  // Nichts verschwindet still: die Kapitelzeile nennt, was sie schluckt.
  await expect(chapterRow.locator('.ideen-board-folded').first()).toBeVisible();
  // Die Karte selbst ist damit aus dem DOM — sie ist gefaltet, nicht geloescht.
  await expect(card.locator(`[data-idee-card-id="${made.ideeId}"]`)).toHaveCount(0);

  // ── Reload: der Stand liegt pro Buch im localStorage ────────────────────
  await bootApp(page);
  await selectSeededBook(page);
  card = await page.locator('#ideen-board-card');
  await page.evaluate((id) => { location.hash = `#book/${id}/ideen`; }, bookId);
  await expect(card).toBeVisible();
  await expect(card.locator(`[data-idee-lane="page:${made.pageId}"]`)).toHaveCount(0);

  // ── Wieder aufklappen: die Bahn ist zurueck, samt ihrer Karte ────────────
  await card.locator(`.ideen-board-row:has([data-idee-lane="chapter:${made.chapterId}"]) .ideen-board-pages`).click();
  await expect(card.locator(`[data-idee-lane="page:${made.pageId}"]`).first()).toBeAttached();
  await expect(card.locator(`[data-idee-card-id="${made.ideeId}"]`)).toHaveCount(1);

  // ── Zweite Achse: die Karten EINER Bahn einklappen ──────────────────────
  const pageRow = card.locator(`.ideen-board-row:has([data-idee-lane="page:${made.pageId}"])`);
  await pageRow.locator('.ideen-board-fold').click();
  await expect(card.locator(`[data-idee-card-id="${made.ideeId}"]`)).toHaveCount(0);
  // Die Bahn bleibt stehen und zaehlt, was sie verbirgt.
  await expect(pageRow.locator(`[data-idee-lane="page:${made.pageId}"]`).first()).toBeAttached();
  await expect(pageRow.locator('.ideen-board-folded').first()).toBeVisible();
});
