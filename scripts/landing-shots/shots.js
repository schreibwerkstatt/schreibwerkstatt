'use strict';
// Playwright-Aufnahmen für die Landing-Screenshots.
//
// Jede Aufnahme zeigt die ECHTE Oberfläche mit dem Beispielbuch. Getrieben wird
// über die Alpine-Root (`window.__app`) statt über Klicks: die Toggles und der
// Lektorat-/Chat-/Review-Lauf sind Methoden der Root bzw. der Karte, und ein
// Klick auf ein Element, dessen Text sich ändert, wäre die brüchigere Variante.
//
// Die KI-Läufe (Lektorat, Chat, Bewertung) laufen als echte Jobs durch die
// Queue — die Antwort liefert der Stub aus scripts/landing-shots/mock-ai.js.
//
// Format: WebP, 460 CSS px breit (2× gerendert) im Verhältnis 3:2. Jede Aufnahme
// ist ein AUSSCHNITT — der Ausschnitt, auf dem die Funktion erkennbar ist. Die
// Landing-Page legt die Bilder in einen Rahmen mit demselben Verhältnis, damit
// das Raster nicht springt.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const VIEWPORT = { width: 1360, height: 900 };
const DPR = 2;

// Zielbreite der fertigen Bilder. Der Ausschnitt ist 460 CSS px breit und
// wird 2× gerendert — auf der Landing-Page erscheint er wieder 460 px breit,
// der Text der App also in Originalgrösse. Ein heruntergerechnetes Bild der
// ganzen Karte wäre auf der Landing unlesbar (5-px-Schrift).
const CROP_W = 460;
const CROP_H = 307;   // 3:2 (gerundet: 920 × 614 Pixel)
const OUT_WIDTH = CROP_W * DPR;
const OUT_HEIGHT = CROP_H * DPR;

// Aufnahme-Modus: Inhaltsspalten auf Kachelbreite begrenzen.
const CAPTURE_CSS = `
  .book-editor-row { max-width: 440px; }
  .card--review .bewertung-section,
  .card--review .bewertung-header,
  .card--review .stilbox { max-width: 440px; }
  .recherche-list { max-width: 420px; }
  .card--export .card-hint,
  .card--export .book-export-scope,
  .card--export .book-export-migration { max-width: 420px; }
`;

/**
 * Ausschnitt → WebP, immer exakt CROP_W × CROP_H CSS px (OUT_WIDTH × OUT_HEIGHT
 * Pixel, 3:2).
 *
 * `rect` = {x, y} in CSS px, relativ zur Oberkante des Ziel-Elements: dort
 * beginnt der Ausschnitt. Ist das Ziel kleiner als der Ausschnitt (ein
 * schmaler Vorschlags-Block, die Kommentar-Leiste), wird nicht das Ziel,
 * sondern sein nächster Vorfahre aufgenommen, der den ganzen Ausschnitt
 * enthält — das Bild zeigt dann die Umgebung des Ziels mit. Enthält kein
 * Vorfahre den Ausschnitt, bricht der Lauf ab: ein schmaleres Bild als
 * angekündigt wäre ein stiller Layout-Fehler auf der Landing.
 */
async function _shot(page, outDir, name, target, { rect = { x: 0, y: 0 } } = {}) {
  const tmp = path.join(outDir, `.${name}.png`);
  const el = page.locator(target).first();
  if (!(await el.count())) throw new Error(`Shot ${name}: Ziel ${target} nicht gefunden`);
  await el.scrollIntoViewIfNeeded();
  // Rahmen-Element suchen und den Ausschnitt relativ zu ihm ausdrücken. Relativ
  // statt absolut: das Scrollen beim Aufnehmen verschiebt beide gleich.
  const frame = await el.evaluate((node, { rx, ry, w, h }) => {
    const r = node.getBoundingClientRect();
    const x0 = r.left + rx;
    const y0 = r.top + ry;
    for (let n = node; n; n = n.parentElement) {
      const b = n.getBoundingClientRect();
      if (b.left <= x0 + 0.5 && b.top <= y0 + 0.5 && b.right >= x0 + w - 0.5 && b.bottom >= y0 + h - 0.5) {
        document.querySelectorAll('[data-landing-shot-frame]').forEach(e => e.removeAttribute('data-landing-shot-frame'));
        n.setAttribute('data-landing-shot-frame', '');
        return { dx: x0 - b.left, dy: y0 - b.top };
      }
    }
    const chain = [];
    for (let n = node; n && chain.length < 12; n = n.parentElement) {
      const b = n.getBoundingClientRect();
      chain.push(`${n.tagName.toLowerCase()}.${[...n.classList].join('.')} ${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}×${Math.round(b.height)}`);
    }
    return { chain, x0, y0 };
  }, { rx: rect.x, ry: rect.y, w: CROP_W, h: CROP_H });
  if (frame.chain) {
    throw new Error(`Shot ${name}: kein Element um ${target} enthält den Ausschnitt ${CROP_W}×${CROP_H} ab (${Math.round(frame.x0)}, ${Math.round(frame.y0)}):\n  ${frame.chain.join('\n  ')}`);
  }
  await page.locator('[data-landing-shot-frame]').screenshot({ path: tmp, type: 'png' });
  const meta = await sharp(tmp).metadata();
  const left = Math.round(frame.dx * DPR);
  const top = Math.round(frame.dy * DPR);
  if (left + OUT_WIDTH > meta.width || top + OUT_HEIGHT > meta.height) {
    fs.unlinkSync(tmp);
    throw new Error(`Shot ${name}: Aufnahme ${meta.width}×${meta.height} zu klein für den Ausschnitt ab (${left}, ${top})`);
  }
  const file = path.join(outDir, `${name}.webp`);
  await sharp(tmp)
    .extract({ left, top, width: OUT_WIDTH, height: OUT_HEIGHT })
    .webp({ quality: 88 })
    .toFile(file);
  fs.unlinkSync(tmp);
  await page.evaluate(() => document.querySelectorAll('[data-landing-shot-frame]').forEach(e => e.removeAttribute('data-landing-shot-frame')));
  const out = await sharp(file).metadata();
  if (out.width !== OUT_WIDTH || out.height !== OUT_HEIGHT) {
    throw new Error(`Shot ${name}: ${out.width}×${out.height} statt ${OUT_WIDTH}×${OUT_HEIGHT}`);
  }
  return { name, file };
}

/** Wartet, bis die Root ein Flag gesetzt hat (Alpine-Reaktivität). */
async function _waitRoot(page, expr, timeout = 30000) {
  await page.waitForFunction(expr, null, { timeout });
}

async function captureAll({ base, seed, outDir }) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  const page = await context.newPage();
  // Browser-Fehler lassen den Lauf scheitern: ein Bild, das neben einem
  // Laufzeitfehler entstand, zeigt womöglich eine halb gerenderte Karte.
  const errors = [];
  const watch = (p, label) => {
    p.on('pageerror', e => errors.push(`${label} pageerror: ${e.message || e}`));
    p.on('console', m => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`); });
  };
  watch(page, 'app');

  const shots = [];

  // ── Boot + Buch wählen ─────────────────────────────────────────────────────
  await page.goto(`${base}/#book/${seed.bookId}`, { waitUntil: 'domcontentloaded' });
  await _waitRoot(page, () => !!window.__app && !!window.Alpine?.store('nav')?.selectedBookId);
  await page.waitForTimeout(1200);
  // Job-Toasts («Abschnitts-Lektorat fertig») sind Bedienhinweise, keine
  // Produktabbildung — sie würden auf jedem Bild unten rechts kleben.
  await page.addStyleTag({ content: '.toast-live { display: none !important; }' });
  // Aufnahme-Modus: die Inhaltsspalten der Karten auf Kachelbreite (460 px)
  // begrenzen. Sonst laufen die Zeilen über den Ausschnitt hinaus und der
  // Screenshot schneidet sie mitten im Wort ab.
  await page.addStyleTag({ content: CAPTURE_CSS });

  // ── 1. Schreiben: Bucheditor (Manuskript-Stream) ───────────────────────────
  await page.evaluate(async () => {
    window.__app._closeOtherMainCards?.(null);
    await window.__app.toggleBookEditorCard();
  });
  await page.waitForSelector('.card--bookeditor', { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(2500);
  shots.push(await _shot(page, outDir, 'schreiben', '.book-editor-stream', { rect: { x: 20, y: 6 } }));

  // ── 2. KI-Lektorat: Befunde am Abschnitt ──────────────────────────────────
  await page.evaluate(async () => {
    window.__app._closeOtherMainCards?.(null);
    await window.__app.selectPage(window.Alpine.store('nav').pages[0]);
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__app.runCheck());
  await _waitRoot(page, () => window.__app.checkDone === true && (window.__app.lektoratFindings || []).length > 0);
  await page.waitForTimeout(1200);
  shots.push(await _shot(page, outDir, 'lektorat', '.lektorat-split-findings', { rect: { x: 0, y: 0 } }));

  // ── 3. Sparrings-Chat: Textersetzung am Abschnitt ──────────────────────────
  await page.evaluate(async () => {
    await window.__app.toggleChatCard();
    await window.__app.loadChatSessions?.();
  });
  await page.waitForSelector('.card--chat', { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const card = window.Alpine.$data(document.querySelector('.card--chat'));
    card.chatInput = 'Trägt der erste Satz?';
    return card.sendChatMessage();
  });
  await _waitRoot(page, () => {
    const card = document.querySelector('.card--chat');
    if (!card) return false;
    const d = window.Alpine.$data(card);
    return (d.chatMessages || []).some(m => m.role === 'assistant');
  });
  await page.waitForTimeout(1500);
  // Der Verlauf scrollt von selbst ans Ende (die neueste Nachricht). Sichtbar
  // sind damit die Textersetzungs-Vorschläge mit «Übernehmen» / «Verwerfen» —
  // das Versprechen der Kachel. Aufgenommen wird der Vorschlags-Block selbst,
  // nicht die Karte: die Pixelzahl ändert sich sonst mit jedem Text.
  // Die Chat-Spalte ist neben dem Editor 420 px breit — schmaler als der
  // Ausschnitt. Für diese Aufnahme auf 500 px verbreitern, damit der
  // Ausschnitt ganz in der Karte liegt (kein Streifen Editor am Rand).
  await page.addStyleTag({ content: '.editor-chat-split { grid-template-columns: minmax(0, 1fr) 500px; }' });
  await page.waitForTimeout(600);
  shots.push(await _shot(page, outDir, 'chat', '.chat-vorschlaege', { rect: { x: -12, y: 32 } }));

  // ── 4. Buchanalyse: Figuren ───────────────────────────────────────────────
  await page.evaluate(async () => {
    window.__app._closeOtherMainCards?.(null);
    await window.__app.toggleFiguresCard();
  });
  await page.waitForSelector('.card--figuren', { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(2000);
  shots.push(await _shot(page, outDir, 'buchanalyse', '.card--figuren', { rect: { x: 300, y: 300 } }));

  // ── 5. Bewertung: Buch-Review ─────────────────────────────────────────────
  await page.evaluate(async () => {
    window.__app._closeOtherMainCards?.(null);
    await window.__app.toggleBookReviewCard();
  });
  await page.waitForSelector('.card--review', { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--review'));
    await card.runBookReview();
  });
  await _waitRoot(page, () => {
    const card = document.querySelector('.card--review');
    if (!card) return false;
    const d = window.Alpine.$data(card);
    return !!(d.bookReviewOut || '').includes('bewertung-header');
  });
  await page.waitForTimeout(1200);
  shots.push(await _shot(page, outDir, 'bewertung', '.card--review', { rect: { x: 0, y: 0 } }));

  // ── 6. Plot-Werkstatt: Beat-Board ─────────────────────────────────────────
  await page.evaluate(async () => {
    window.__app._closeOtherMainCards?.(null);
    await window.__app.togglePlotCard();
  });
  await page.waitForSelector('.card--plot', { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(2000);
  shots.push(await _shot(page, outDir, 'plot', '.card--plot', { rect: { x: 10, y: 380 } }));

  // ── 7. Recherche: Wissensboard ────────────────────────────────────────────
  await page.evaluate(async () => {
    window.__app._closeOtherMainCards?.(null);
    await window.__app.toggleRechercheCard();
  });
  await page.waitForSelector('.card--recherche', { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(2000);
  shots.push(await _shot(page, outDir, 'recherche', '.card--recherche', { rect: { x: 0, y: 150 } }));

  // ── 8. Export ─────────────────────────────────────────────────────────────
  await page.evaluate(async () => {
    window.__app._closeOtherMainCards?.(null);
    await window.__app.toggleExportCard();
  });
  await page.waitForSelector('.card--export', { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(1500);
  shots.push(await _shot(page, outDir, 'export', '.card--export', { rect: { x: 0, y: 0 } }));

  // ── 9. Testleser: geteilter Abschnitt (ohne Session) ───────────────────────
  const shareToken = seed.shareTokens?.page;
  if (!shareToken) throw new Error('Shot testleser: seed.shareTokens.page fehlt — der Seed hat keinen geteilten Abschnitt angelegt');
  {
    // Eigener Context: der Leser ist ein anonymer Besucher ohne Konto. Seine
    // Identität setzen wir vorher, sonst öffnet beim ersten Laden das
    // Namens-Modal und verdeckt genau den Teil, den der Screenshot zeigen soll.
    // Breiter Viewport: ab 1100 px stellt der Leser die Kommentare als
    // Seitenleiste neben den Text (Google-Docs-Stil) — genau die Ansicht, die
    // «Kommentare hängen an der Textstelle» erzählt.
    const readerCtx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
    await readerCtx.addInitScript(() => {
      try {
        localStorage.setItem('sw_share_reader_name', 'Lektorin Anna');
        localStorage.setItem('sw_share_reader_token', 'rlandingshotsreader01');
      } catch { /* privat/blockiert */ }
    });
    const reader = await readerCtx.newPage();
    watch(reader, 'share');
    await reader.goto(`${base}/share/${shareToken}`, { waitUntil: 'domcontentloaded' });
    await reader.waitForTimeout(3000);
    // Die Kommentar-Leiste rechts: verankerte Anmerkung mit Zitat + Antwort des
    // Autors. Aufgenommen wird die Leiste selbst — ihre Position hängt am
    // Anker der ersten Anmerkung, nicht an festen Pixeln.
    // Die Leiste ist höchstens 440 px breit, schmaler als der Ausschnitt: der
    // Rahmen ist dann der Seitenrand rechts daneben (leer), die Karte bleibt
    // links bündig und ganz im Bild.
    shots.push(await _shot(reader, outDir, 'testleser', '.share-comments', { rect: { x: 0, y: 186 } }));
    await reader.close();
    await readerCtx.close();
  }

  await browser.close();
  if (errors.length) {
    throw new Error('Browser-Fehler während der Aufnahmen:\n' + errors.slice(0, 20).join('\n'));
  }
  return shots;
}

module.exports = { captureAll };
