// Ideen-Board mit vielen offenen Ideen gegen die ECHTE App (volles CSS): auf
// Prod stehen 100+ offene Ideen an einem Dutzend Abschnitten. Zwei Aussagen:
//
// * Spaltenkoepfe und Bahntitel kleben beim Scrollen — das Raster ist dafuer
//   sein eigener, auf Fensterhoehe gedeckelter Scrollbereich. Ohne Deckel
//   scrollt die Seite, und `sticky` haengt an einem Kasten, der sich nie bewegt.
// * Eine Stufe ohne sichtbare Karte (leer oder ausgeblendet) wird schmal, die
//   belegte bekommt die Breite (actions.js#columnTracks).
//
// Haengt an Hoehenkette und Grid-Geometrie — darum hier, nicht im Harness.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const PREFIX = 'E2E-Viele ';

async function cleanup(page, bookId) {
  await page.evaluate(async ({ id, prefix }) => {
    const board = await fetch(`/ideen/board?book_id=${id}`).then(r => r.json());
    const stale = (board.ideen || []).filter(i => String(i.content).startsWith(prefix));
    await Promise.all(stale.map(i => fetch(`/ideen/${i.id}`, { method: 'DELETE' })));
  }, { id: bookId, prefix: PREFIX });
}

test('ideen-board: 100+ offene Ideen — Koepfe kleben, leere Spalten schmal', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  await cleanup(page, bookId);
  try {
    await page.evaluate(async ({ id, prefix }) => {
      const tree = await fetch(`/content/books/${id}/tree`).then(r => r.json());
      const pids = tree.chapters.flatMap(c => c.pages || []).map(p => p.id);
      for (let i = 0; i < 105; i++) {
        await fetch('/ideen', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ book_id: id, page_id: pids[i % pids.length], content: `${prefix}${i} Tom fragt Lilli, gemeinsam eine neue Couch auszusuchen` }),
        });
      }
    }, { id: bookId, prefix: PREFIX });

    await page.evaluate((id) => { location.hash = `#book/${id}/ideen`; }, bookId);
    const board = page.locator('#ideen-board-card .ideen-board');
    await expect(board.locator('[data-idee-card-id]').first()).toBeVisible();

    // Belegte Spalte «Offen» deutlich breiter als die leeren daneben.
    const widths = await page.$$eval('#ideen-board-card .ideen-board-head-col',
      els => els.map(e => [e.className.match(/ideen-board-head-col--(\w+)/)[1], e.getBoundingClientRect().width]));
    const w = Object.fromEntries(widths);
    expect(w.offen).toBeGreaterThan(2 * w.erledigt);

    // Weit hinein scrollen: Kopf klebt am oberen Rand des Rasters, und der
    // Titel der Bahn, die gerade durchs Bild laeuft, steht direkt darunter.
    const m = await board.evaluate((b) => {
      b.scrollIntoView();
      b.scrollTop = b.scrollHeight / 2;
      const top = b.getBoundingClientRect().top;
      const head = b.querySelector('.ideen-board-head-col').getBoundingClientRect();
      const lanes = [...b.querySelectorAll('.ideen-board-lane')].map(l => l.getBoundingClientRect());
      const heads = [...b.querySelectorAll('.ideen-board-lane-head')].map(l => l.getBoundingClientRect());
      const i = lanes.findIndex(r => r.top < head.bottom && r.bottom > head.bottom + 100);
      return { scrolled: b.scrollTop > 0, top, headTop: head.top, headBottom: head.bottom, laneHeadTop: i >= 0 ? heads[i].top : null };
    });
    expect(m.scrolled).toBe(true);
    expect(Math.abs(m.headTop - m.top)).toBeLessThan(2);
    expect(m.laneHeadTop).not.toBeNull();
    expect(Math.abs(m.laneHeadTop - m.headBottom)).toBeLessThan(4);
  } finally {
    await cleanup(page, bookId);
  }
});
