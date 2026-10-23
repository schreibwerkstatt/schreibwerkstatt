// Das Steuerzeichen-Overlay (¶/↵) vermisst nur den sichtbaren Bereich des
// Editors (public/js/editor/notebook/format-marks.js, Band-Filter) und zeichnet
// bei jeder Verschiebung dieses Bereichs selbst neu — ohne Zutun des Tests.
//
// Geprueft wird das Verhalten, nicht die Implementierung:
//   1) Der Layer traegt deutlich weniger Marken als der Abschnitt hergibt
//      (Filter arbeitet).
//   2) Jede Marke liegt im Sichtfenster (nichts ausserhalb wird gezeichnet).
//   3) Die Marken sitzen auf den richtigen Stellen (der erste Pfeil auf dem
//      <br> des ersten sichtbaren Absatzes).
//   4) Editor scrollt selbst: nach dem Scrollen zeichnet der Scroll-Listener
//      am Editor das neue Fenster.
//   5) Vollbild (die Karte scrollt, der Editor nicht): nach dem Scrollen der
//      Karte zeichnet der Capture-Listener auf window das neue Fenster; nach
//      einer Fenster-Vergroesserung der resize-Listener den neu sichtbaren Teil.
// Kein manueller _renderFormatMarks()-Aufruf nach dem Scrollen/Resize — sonst
// pruefte der Test die Listener nicht.

const { test, expect } = require('../e2e/_helpers/fixtures');

const EDIT_SEL = '#editor-card .page-content-view--editing';

// 60 Absaetze mit je einem Soft-Break: 2 Marken je Absatz (Pfeil + Absatzmarke).
const PARAS = 60;
const HTML = Array.from(
  { length: PARAS },
  (_, i) => `<p>Absatz ${i + 1} mit Soft-Break<br>zweite Zeile</p>`,
).join('');

async function bootAndEnterEditor(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__app && Array.isArray(window.Alpine.store('nav').books) && window.Alpine.store('nav').books.length > 0,
    null, { timeout: 30000 });
  const bookId = await page.evaluate(() => window.Alpine.store('nav').books[0].id);
  await page.evaluate((id) => { location.hash = '#book/' + id; }, bookId);
  await page.waitForFunction(
    (id) => String(window.Alpine.store('nav').selectedBookId) === String(id)
            && Array.isArray(window.Alpine.store('nav').pages) && window.Alpine.store('nav').pages.length > 0,
    bookId, { timeout: 20000 });
  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 10000 });
  await page.waitForTimeout(200);
}

// Overlay einschalten und den Abschnitt fuellen. Der Toggle persistiert die Pref
// (localStorage) — die Pref startet je Browser-Kontext auf "aus".
async function setupMarks(page) {
  await page.evaluate(({ sel, html }) => {
    const root = document.querySelector(sel);
    root.innerHTML = html;
    window.__app.pageEditorShowMarks = false;
    window.__notebookCard.togglePageEditorShowMarks(); // → an, installiert Overlay
  }, { sel: EDIT_SEL, html: HTML });
  await expect.poll(async () => (await layerState(page)).total).toBeGreaterThan(0);
}

// Zustand des Layers lesen: Marken (Anzahl + Positionen) und das Editor-Fenster.
// Toleranzen: das Overlay vermisst mit 24px Rand ueber das Fenster hinaus
// (damit eine Marke am Rand nicht erst beim naechsten Scroll auftaucht), und
// die Absatzmarke eines am unteren Rand angeschnittenen Blocks liegt um eine
// Zeilenhoehe darunter — beides wird vom Layer geclippt und ist unsichtbar.
// "weit ausserhalb" (150px) darf nie vorkommen: das waere die Vollvermessung.
const OUTSIDE_TOLERANCE_PX = 30;
const FAR_OUTSIDE_TOLERANCE_PX = 150;

const layerState = (page) => page.evaluate(([sel, tol, far]) => {
  const root = document.querySelector(sel);
  const layer = root.parentElement.querySelector('.page-editor-marks-layer');
  const marks = [...layer.querySelectorAll('.format-mark')];
  const r0 = root.getBoundingClientRect();
  // Sichtfenster: scrollt der Editor selbst, seine Box; sonst (Vollbild, der
  // Editor waechst ueber den Viewport hinaus) die Box geschnitten mit dem
  // Viewport.
  const ownScroll = root.scrollHeight > root.clientHeight + 1;
  const box = ownScroll ? r0 : { top: Math.max(r0.top, 0), bottom: Math.min(r0.bottom, window.innerHeight) };
  const brs = [...root.querySelectorAll('br')];
  const firstBrRect = brs.length ? brs[0].getBoundingClientRect() : null;
  const outsideBy = (m) => {
    const r = m.getBoundingClientRect();
    if (r.bottom < box.top) return box.top - r.bottom;
    if (r.top > box.bottom) return r.top - box.bottom;
    return 0;
  };
  return {
    total: marks.length,
    arrows: marks.filter(m => m.classList.contains('format-mark--br')).length,
    // Marken, die ausserhalb des Editor-Fensters liegen.
    outside: marks.filter(m => outsideBy(m) > tol).length,
    // Marken weit ausserhalb — duerfen nie vorkommen.
    farOutside: marks.filter(m => outsideBy(m) > far).length,
    boxTop: Math.round(box.top),
    boxBottom: Math.round(box.bottom),
    scrollTop: root.scrollTop,
    scrollHeight: root.scrollHeight,
    clientHeight: root.clientHeight,
    firstArrowTop: marks.length
      ? Math.round(marks.filter(m => m.classList.contains('format-mark--br'))[0]?.getBoundingClientRect().top ?? NaN)
      : null,
    firstBrTop: firstBrRect ? Math.round(firstBrRect.top) : null,
    // Letzter Pfeil und letztes <br> des Abschnitts: nach dem Scrollen muss der
    // letzte Pfeil auf dem letzten <br> sitzen (der Abschnitt ist zu Ende im
    // Fenster). Vorher liegt das letzte <br> weit unterhalb des Fensters.
    lastArrowTop: marks.length
      ? Math.round(marks.filter(m => m.classList.contains('format-mark--br')).slice(-1)[0]?.getBoundingClientRect().top ?? NaN)
      : null,
    lastBrTop: brs.length ? Math.round(brs[brs.length - 1].getBoundingClientRect().top) : null,
    // Unterkante der tiefsten Marke — waechst, wenn das Fenster hoeher wird.
    maxMarkBottom: marks.length ? Math.round(Math.max(...marks.map(m => m.getBoundingClientRect().bottom))) : null,
    innerHeight: window.innerHeight,
  };
}, [EDIT_SEL, OUTSIDE_TOLERANCE_PX, FAR_OUTSIDE_TOLERANCE_PX]);

test('Steuerzeichen: nur der sichtbare Bereich wird vermessen', async ({ page }) => {
  await bootAndEnterEditor(page);
  await setupMarks(page);

  const st = await layerState(page);

  // Der Abschnitt ist laenger als das Editor-Fenster (sonst waere nichts zu filtern).
  expect(st.scrollHeight).toBeGreaterThan(st.clientHeight + 10);

  // 1) Deutlich weniger Marken als der Abschnitt hergibt (2 je Absatz → 120).
  expect(st.total).toBeGreaterThan(0);
  expect(st.total).toBeLessThan(PARAS * 2 * 0.5);

  // 2) Nichts weit ausserhalb des Editor-Fensters gezeichnet.
  expect(st.farOutside).toBe(0);
  expect(st.outside).toBeLessThanOrEqual(4);

  // 3) Die Marken sitzen auf den richtigen Stellen: der erste Pfeil auf dem <br>
  //    des ersten Absatzes (oberhalb des Fensters liegt nichts).
  expect(st.firstArrowTop).not.toBeNull();
  expect(Math.abs(st.firstArrowTop - st.firstBrTop)).toBeLessThan(40);

  // 4) Scrollen im Editor: der Layer folgt und zeigt die Marken des neuen
  //    Fensters (Pfeile wieder da, Positionen jetzt weiter unten).
  await page.evaluate((sel) => {
    const root = document.querySelector(sel);
    root.scrollTop = root.scrollHeight;
  }, EDIT_SEL);
  // Der Listener zeichnet neu: der letzte Pfeil wandert auf das letzte <br>.
  await expect.poll(async () => {
    const s = await layerState(page);
    return Math.abs(s.lastArrowTop - s.lastBrTop);
  }).toBeLessThan(40);

  const scrolled = await layerState(page);
  expect(scrolled.scrollTop).toBeGreaterThan(0);
  expect(scrolled.total).toBeGreaterThan(0);
  expect(scrolled.total).toBeLessThan(PARAS * 2 * 0.5);
  expect(scrolled.farOutside).toBe(0);
  expect(scrolled.outside).toBeLessThanOrEqual(4);
  // Der letzte Pfeil sitzt jetzt auf dem letzten <br> des Abschnitts — der
  // Filter hat das neue Fenster vermessen, nicht das alte stehen gelassen.
  expect(Math.abs(scrolled.lastArrowTop - scrolled.lastBrTop)).toBeLessThan(40);
  // Vorher lag das letzte <br> weit unterhalb des Fensters.
  expect(Math.abs(st.lastArrowTop - st.lastBrTop)).toBeGreaterThan(100);
});

test('Steuerzeichen im Vollbild: Karten-Scroll und Fenster-Resize zeichnen neu', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await bootAndEnterEditor(page);
  await setupMarks(page);
  await page.evaluate(() => window.__notebookCard.togglePageEditorFullscreen());
  await page.waitForSelector('#editor-card.editor-card--fullscreen');

  // Im Vollbild scrollt der Editor nicht selbst, er waechst ueber den Viewport.
  await expect.poll(async () => {
    const s = await layerState(page);
    return s.scrollHeight - s.clientHeight;
  }).toBeLessThanOrEqual(1);
  // Neu gezeichnet (ResizeObserver): nur der Viewport-Ausschnitt.
  await expect.poll(async () => (await layerState(page)).farOutside).toBe(0);
  const st = await layerState(page);
  expect(st.total).toBeGreaterThan(0);
  expect(st.total).toBeLessThan(PARAS * 2 * 0.5);
  expect(st.outside).toBeLessThanOrEqual(4);
  expect(Math.abs(st.lastArrowTop - st.lastBrTop)).toBeGreaterThan(100);

  // 5a) Fenster hoeher ziehen: die Editor-Box bleibt gleich (kein
  //     ResizeObserver), der resize-Listener zeichnet den neu sichtbaren Teil.
  await page.setViewportSize({ width: 1280, height: 1000 });
  await expect.poll(async () => (await layerState(page)).maxMarkBottom).toBeGreaterThan(st.innerHeight + 100);

  // 5b) Die Karte scrollen: der Capture-Listener auf window zeichnet neu, der
  //     letzte Pfeil sitzt auf dem letzten <br>.
  await page.evaluate(() => {
    const card = document.querySelector('#editor-card');
    card.scrollTop = card.scrollHeight;
  });
  await expect.poll(async () => {
    const s = await layerState(page);
    return Math.abs(s.lastArrowTop - s.lastBrTop);
  }).toBeLessThan(40);
  const scrolled = await layerState(page);
  expect(scrolled.farOutside).toBe(0);
  expect(scrolled.outside).toBeLessThanOrEqual(4);
  expect(scrolled.total).toBeLessThan(PARAS * 2 * 0.5);
});
