// Ideen-Board gegen die ECHTE App (volles CSS): eine Karte in eine leere Stufe
// ziehen laesst das Raster stehen — die Spalten bleiben gleich breit, die Bahn
// schiesst mitten im Drag nicht auf.
//
// Der Platzhalter der gezogenen Karte wandert schon waehrend des Drags in die
// Zielzelle und behaelt die Hoehe der Karte (sortable-dnd.js#startBoardDrag).
// Die Spaltenbreite haengt nicht am Inhalt (ideen-board.css) — sonst spraenge
// das Raster beim ersten Zug in eine leere Stufe um. Haengt an Grid-Geometrie
// und echtem SortableJS-Drag — darum hier, nicht im Harness.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const PREFIX = 'E2E-DragHoehe ';

async function cleanup(page, bookId) {
  await page.evaluate(async ({ id, prefix }) => {
    const board = await fetch(`/ideen/board?book_id=${id}`).then(r => r.json());
    const stale = (board.ideen || []).filter(i => String(i.content).startsWith(prefix));
    await Promise.all(stale.map(i => fetch(`/ideen/${i.id}`, { method: 'DELETE' })));
  }, { id: bookId, prefix: PREFIX });
}

test('ideen-board: Drag in eine leere Stufe — Spalten gleich breit, Bahnhoehe stabil', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  await cleanup(page, bookId);
  try {
    const ideeId = await page.evaluate(async ({ id, prefix }) => {
      const tree = await fetch(`/content/books/${id}/tree`).then(r => r.json());
      const pageId = tree.chapters.flatMap(c => c.pages || [])[0].id;
      const res = await fetch('/ideen', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: id, page_id: pageId,
          content: `${prefix}Stefans Lüge gegenüber Adrian widerspricht der Familienlegende, die Adrian am Tisch hört: entweder angleichen oder Adrians stummes Bemerken der zweiten Lüge zeigen`,
        }),
      }).then(r => r.json());
      return res.id;
    }, { id: bookId, prefix: PREFIX });

    await page.evaluate((id) => { location.hash = `#book/${id}/ideen`; }, bookId);
    const card = page.locator(`#ideen-board-card [data-idee-card-id="${ideeId}"]`);
    await expect(card).toBeVisible();
    // Zellen ueber ihre Daten-Attribute (Bahn × Stufe), nicht ueber die Zeile:
    // die ist `display: contents` und als Locator-Anker waehrend des Drags
    // unzuverlaessig.
    const lane = await card.evaluate(el => el.closest('[data-idee-lane]').dataset.ideeLane);
    const cellOf = (st) => page.locator(`#ideen-board-card [data-idee-lane="${lane}"][data-idee-status-cell="${st}"]`);
    const target = cellOf('in_arbeit');
    const STAGES = ['offen', 'in_arbeit', 'erledigt', 'verworfen'];
    const widths = () => page.evaluate(({ lane, stages }) => stages.map((st) => {
      const el = document.querySelector(`#ideen-board-card [data-idee-lane="${lane}"][data-idee-status-cell="${st}"]`);
      return el ? Math.round(el.getBoundingClientRect().width) : null;
    }).filter(w => w !== null), { lane, stages: STAGES });
    const spread = (ws) => Math.max(...ws) - Math.min(...ws);
    // Vorbedingung: «Offen» voll, «In Arbeit» leer, «Erledigt» ausgeblendet —
    // trotzdem alle gleich breit.
    const widthsBefore = await widths();
    expect(spread(widthsBefore)).toBeLessThan(2);

    const laneH = () => target.evaluate(el => el.getBoundingClientRect().height);
    const before = await laneH();
    // SortableJS bindet die Zellen nach dem Board-Load asynchron an.
    await page.waitForTimeout(400);
    const g = await card.locator('.idee-board-grip').boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    // Mehr als fallbackTolerance (5px), sonst startet der Zug nicht. Nur
    // waagrecht: der Griff sitzt knapp unter der Bahn darueber, und die waechst
    // beim Drag-Start als Drop-Zone nach unten — ein Zug nach unten laege
    // schon in ihr.
    await page.mouse.move(g.x + g.width / 2 + 8, g.y + g.height / 2, { steps: 4 });
    // Ziel erst nach dem Drag-Start messen: dann sind die Drop-Zonen aufgezogen.
    // Direkt hinspringen, ohne Zwischenpunkte: ein interpolierter Weg streift
    // fremde Bahnen, SortableJS setzt den Platzhalter dorthin, und das Raster
    // verschiebt sich unter dem gemessenen Ziel.
    const t = await target.boundingBox();
    await page.mouse.move(t.x + t.width / 2, t.y + 24);
    // Im Ziel braucht SortableJS noch ein paar Bewegungen, bis der Platzhalter
    // dorthin wechselt.
    for (let i = 1; i <= 5; i++) {
      await page.mouse.move(t.x + t.width / 2 + i, t.y + 24 + 4 * i);
      await page.waitForTimeout(50);
    }
    // Platzhalter steckt in der leeren Zielzelle.
    await expect(target.locator(`[data-idee-card-id="${ideeId}"]`)).toHaveCount(1);
    const mid = await laneH();
    const widthsMid = await widths();
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect(mid).toBeLessThanOrEqual(before + 4);
    expect(widthsMid).toEqual(widthsBefore);
  } finally {
    await cleanup(page, bookId);
  }
});
