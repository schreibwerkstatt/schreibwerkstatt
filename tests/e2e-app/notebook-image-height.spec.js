// Höhe des NOTEBOOK-Seitenkastens mit Bildern und Nachrichtenverläufen,
// gegen die ECHTE App (Verlauf: Testfall am Dateiende).
//
// WARUM DIESE SCHICHT: die Invariante hängt an der CSS-Höhenkette
// (`--pcv-max-h` → `max-height` von `.page-content-view`, Padding, Zoom) und am
// echten `load` eines Bildes — ein Fixture-Harness ohne App-CSS misst dort
// nichts Belastbares.
//
// Geprüft: ein Bild, das die Wortzahl-Schätzung nicht kennt, steht vollständig
// im Kasten, ohne innere Scrollbar —
//   1. im Edit-Modus, direkt nach dem Einfügen (fester 70vh-Deckel, der Kasten
//      wächst bis dahin mit — hier darf keine Schätzung dazwischenkommen),
//   2. in der Leseansicht nach dem Speichern (gemessener `--pcv-max-h`).
//
// Deckel bei 900 px Fensterhöhe: Edit 630 px, Leseansicht 720 px. Das Bild ist
// so gewählt, dass der Inhalt unter beiden bleibt, aber deutlich über der
// Schätzung der Leseansicht (320 px Pauschale + eine Zeile Text + Padding ≈
// 405 px) liegt — nur die Messung hält es dort sichtbar.
//
// Der Test legt eine eigene Seite an (fremder Seitentext triebe die Schätzung
// von selbst an den Deckel) und löscht sie am Ende wieder: die Smoke-DB lebt
// über den ganzen Lauf, und die neue Seite stünde sonst als `pages[0]` in den
// Specs, die per Index öffnen.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';
const READ_SEL = '#editor-card .page-content-view:not(.page-content-view--editing)';

const IMG_H = 380;
const IMG_SRC = 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="${IMG_H}"><rect width="300" height="${IMG_H}" fill="#88a"/></svg>`,
);

async function openFreshPage(page, bookId, html = '<p>Kurz.</p>') {
  const id = await page.evaluate(async ({ bid, html }) => {
    const { contentRepo } = await import('/js/repo/content.js');
    const created = await contentRepo.createPage({ book_id: parseInt(bid, 10), name: 'Bildhoehe', html });
    await window.__app.loadPages();
    const p = window.Alpine.store('nav').pages.find((x) => x.id === created.id);
    await window.__app.selectPage(p);
    return created.id;
  }, { bid: bookId, html });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  return id;
}

async function deletePage(page, id) {
  // Über den App-Weg: der räumt auch die offene Seite ab, ein nackter
  // Repo-Delete liesse einen Refetch ins 404 laufen.
  const ok = await page.evaluate((pid) => window.__app.deletePageById(pid, { confirm: false }), id);
  expect(ok).toBe(true);
}

// Kasten zeigt alles, wenn der Inhalt nicht über die sichtbare Höhe ragt.
async function overflowPx(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    return el.scrollHeight - el.clientHeight;
  }, sel);
}

async function checkHeights(page) {
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });

  // Dasselbe Markup, das `buildFigureHtml` erzeugt; der Datei-Dialog lässt sich
  // hier nicht fahren.
  await page.evaluate(({ sel, src }) => {
    document.querySelector(sel).insertAdjacentHTML('beforeend',
      `<figure><img src="${src}" alt="Test"><figcaption>Legende</figcaption></figure><p><br></p>`);
  }, { sel: EDIT_SEL, src: IMG_SRC });
  await page.waitForFunction((s) => document.querySelector(`${s} img`)?.complete, EDIT_SEL);

  // 1. Edit-Modus.
  await expect.poll(() => overflowPx(page, EDIT_SEL), { timeout: 5000 }).toBeLessThanOrEqual(0);

  await page.evaluate(async () => { await window.__app.saveEdit(); });
  await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 15000 });
  await page.waitForFunction((s) => document.querySelector(`${s} img`)?.complete, READ_SEL);

  // 2. Leseansicht: gleiche Seite, gerendert aus dem gespeicherten HTML.
  await expect.poll(() => overflowPx(page, READ_SEL), { timeout: 5000 }).toBeLessThanOrEqual(0);
}

test('Bild: Seitenkasten wächst im Edit-Modus und in der Leseansicht mit', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const pageId = await openFreshPage(page, bookId);
  try {
    await checkHeights(page);
  } finally {
    await deletePage(page, pageId);
  }
});

// Nachrichtenverlauf: kurze Nachrichten, jede eine eigene Blase mit Abstand —
// die Wortzahl-Schätzung (≈7 Wörter/Zeile) sieht hier drei Zeilen Prosa, der
// gerenderte Verlauf ist ein Vielfaches davon hoch. Ohne Messung deckelt
// `--pcv-max-h` den Kasten auf die Schätzung und das Ende des Verlaufs liegt
// hinter einer inneren Scrollbar.
const THREAD_LINES = 10;
const THREAD_HTML = '<p>Kurz.</p><div class="msg-thread"><p class="msg-name">Lena</p>'
  + Array.from({ length: THREAD_LINES }, (_, i) => `<p class="${i % 2 ? 'msg-out' : 'msg-in'}">ok ${i}</p>`).join('')
  + '<p class="msg-meta">Dienstag, 14:32</p></div>';

test('Nachrichtenverlauf: Leseansicht misst statt zu schätzen', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const pageId = await openFreshPage(page, bookId, THREAD_HTML);
  try {
    await page.waitForSelector(`${READ_SEL} .msg-thread`, { timeout: 15000 });
    // Nicht vakuös: der Verlauf ragt deutlich über den Mindestdeckel (20 %
    // Fensterhöhe, darunter fiele die Schätzung) und bleibt unter dem
    // Höchstdeckel (80 %, darüber scrollt der Kasten zu Recht).
    const { contentPx, vh } = await page.evaluate((s) => ({
      contentPx: document.querySelector(s).scrollHeight, vh: window.innerHeight,
    }), READ_SEL);
    expect(contentPx).toBeGreaterThan(vh * 0.2 + 100);
    expect(contentPx).toBeLessThan(vh * 0.8);
    await expect.poll(() => overflowPx(page, READ_SEL), { timeout: 5000 }).toBeLessThanOrEqual(0);
  } finally {
    await deletePage(page, pageId);
  }
});
