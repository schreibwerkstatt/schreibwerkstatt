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
const CROP_H = 307;   // 3:2
const OUT_WIDTH = CROP_W * DPR;

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
 * Element-Screenshot → WebP, auf einen Ausschnitt beschnitten.
 *
 * `rect` = {x, y} in CSS px, relativ zur Element-Oberkante. Breite und Höhe
 * des Ausschnitts sind fest (CROP_W × CROP_H).
 */
async function _shot(page, outDir, name, target, { rect = null } = {}) {
  const tmp = path.join(outDir, `.${name}.png`);
  const el = typeof target === 'string' ? await page.locator(target).first() : target;
  if (!el) throw new Error(`Shot ${name}: Ziel ${target} nicht gefunden`);
  await el.screenshot({ path: tmp, type: 'png' });
  const meta = await sharp(tmp).metadata();
  const file = path.join(outDir, `${name}.webp`);
  let img = sharp(tmp);
  if (rect) {
    const left = Math.round(rect.x * DPR);
    const top = Math.round(rect.y * DPR);
    const width = Math.min(CROP_W * DPR, meta.width - left);
    const height = Math.min(CROP_H * DPR, meta.height - top);
    if (width <= 0 || height <= 0) throw new Error(`Shot ${name}: Ausschnitt liegt ausserhalb des Bildes`);
    img = img.extract({ left, top, width, height });
  }
  await img
    .resize({ width: OUT_WIDTH, withoutEnlargement: true })
    .webp({ quality: 88 })
    .toFile(file);
  fs.unlinkSync(tmp);
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
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

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
  shots.push(await _shot(page, outDir, 'chat', '.chat-vorschlaege', { rect: { x: 0, y: 32 } }));

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
  if (shareToken) {
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
    await reader.goto(`${base}/share/${shareToken}`, { waitUntil: 'domcontentloaded' });
    await reader.waitForTimeout(3000);
    // Die Kommentar-Leiste rechts: verankerte Anmerkung mit Zitat + Antwort des
    // Autors. Aufgenommen wird die Leiste selbst — ihre Position hängt am
    // Anker der ersten Anmerkung, nicht an festen Pixeln.
    shots.push(await _shot(reader, outDir, 'testleser', '.share-comments', { rect: { x: 0, y: 186 } }));
    await reader.close();
    await readerCtx.close();
  }

  await browser.close();
  if (errors.length) {
    console.error('[landing-shots] Browser-Fehler:\n' + errors.slice(0, 20).join('\n'));
  }
  return shots;
}

module.exports = { captureAll };
