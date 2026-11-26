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
// Aufgenommen werden die Bilder, die die öffentlichen Seiten zeigen: Landing-
// Kacheln, Themenseiten und je Bereich eines für die Funktionsübersicht
// /funktionen (FEATURE_GROUPS in routes/public-features.js).
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
  /* Stil-Heatmap: nur Kapitel, Passiv, Ø Satzlänge, Wiederholungen —
     die volle Tabelle ist mehr als doppelt so breit wie die Kachel. Gezählt
     wird mit dem <template> der Spalten-Schleife als drittem Kind. */
  .card--stil table :is(th, td):is(:nth-child(2), :nth-child(4), :nth-child(6), :nth-child(8), :nth-child(9), :nth-child(n+11)) { display: none; }
  .card--stil table { width: auto; }
  /* Headless-Linux setzt Inter sonst mit sichtbaren Lücken in Wörtern. */
  body { text-rendering: geometricPrecision; }
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
  // Erst aufnehmen, wenn die Schriften geladen und Ein-/Ausblend-Animationen
  // durch sind — sonst landet Fallback-Schrift oder ein halb transparenter
  // Zustand im Bild.
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().map(a => a.finished.catch(() => {})));
  });
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
  // Job-Toasts («Abschnitts-Lektorat fertig») und der Einstiegs-Hinweis über
  // dem Abschnitt («Abschnitt lektorieren») sind Bedienhinweise, keine
  // Produktabbildung — sie würden auf den Bildern kleben.
  await page.addStyleTag({ content: '.toast-live, .page-aha { display: none !important; }' });
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

  // ── 1a. Notebook-Editor: ein Abschnitt im Edit-Modus ──────────────────────
  // Werkzeugleiste oben links, darunter der Text — das Bild zur Themenseite
  // /schreiben. Das Blatt steht sonst mittig in der breiten Spalte, weit rechts
  // der Leiste: für die Aufnahme linksbündig unter die Leiste und auf
  // Kachelbreite. Abgebrochen wird ohne Speichern.
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector('.page-editor-toolbar', { state: 'visible', timeout: 20000 });
  {
    const css = await page.addStyleTag({ content: '.page-content-view--editing { max-width: 444px !important; margin-inline: 0 !important; }' });
    await page.waitForTimeout(1200);
    shots.push(await _shot(page, outDir, 'notebook', '.page-editor-toolbar', { rect: { x: -8, y: -8 } }));
    await css.evaluate(n => n.remove());
  }

  // ── 1b. Focus-Editor: Vollbild-Schreibmodus ───────────────────────────────
  // Der Absatz, an dem geschrieben wird, steht hell, der Rest gedimmt. Für die
  // Aufnahme rückt die Textspalte an den linken Rand und auf Kachelbreite. Am
  // Ende des ersten Absatzes wird ein Satz getippt (setzt den aktiven Absatz)
  // und nach der Aufnahme per Undo wieder entfernt — der Text der folgenden
  // Aufnahmen (Lektorat, Chat) bleibt unverändert.
  await page.evaluate(() => window.__app.enterFocusMode());
  await page.waitForSelector('.focus-editor.is-active .focus-editor__content p', { state: 'visible', timeout: 20000 });
  {
    const css = await page.addStyleTag({ content: `
      .focus-editor.is-active .focus-editor__content { padding-left: 24px !important; padding-right: calc(100% - 460px) !important; }
    ` });
    await page.waitForTimeout(800);
    const before = await page.locator('.focus-editor.is-active .focus-editor__content').evaluate(n => n.textContent);
    await page.evaluate(() => {
      const p = document.querySelector('.focus-editor.is-active .focus-editor__content p');
      const r = document.createRange();
      r.selectNodeContents(p);
      r.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    });
    await page.keyboard.type(' Draussen regnete es.', { delay: 20 });
    await page.waitForTimeout(1500);
    // Ausschnitt um die Schreibzeile: oben die letzten Zeilen des aktiven
    // Absatzes (hell), darunter der nächste (gedimmt). Wo die Zeile steht,
    // bestimmt der Typewriter-Scroll — darum gemessen, nicht fest.
    const caretY = await page.evaluate(() => {
      const r = window.getSelection().getRangeAt(0).getBoundingClientRect();
      return Math.round(r.bottom - document.querySelector('.focus-editor.is-active').getBoundingClientRect().top);
    });
    shots.push(await _shot(page, outDir, 'fokus', '.focus-editor.is-active', { rect: { x: 0, y: caretY - 156 } }));
    for (let i = 0; i < 30; i++) {
      const now = await page.locator('.focus-editor.is-active .focus-editor__content').evaluate(n => n.textContent);
      if (now === before) break;
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(150);
    }
    const after = await page.locator('.focus-editor.is-active .focus-editor__content').evaluate(n => n.textContent);
    if (after !== before) throw new Error('Shot fokus: Undo hat den getippten Satz nicht entfernt');
    await css.evaluate(n => n.remove());
  }
  await page.evaluate(() => window.__app.exitFocusMode());
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__app.cancelEdit());
  await page.waitForTimeout(1200);

  // ── 2a. Kommentare: die Leiste des Autors neben dem Text ──────────────────
  // Notebook-Leseansicht des geteilten Abschnitts: die Leser-Kommentare stehen
  // in der Randleiste rechts (vor dem Lektorat-Lauf — mit offenen Befunden
  // blendet die Leiste aus). Ausschnitt rechtsbündig an der Leiste, links
  // davon der Text mit den markierten Stellen.
  // Die Leiste startet je Abschnitt eingeklappt; der Knopf in den
  // Abschnitts-Aktionen schaltet sie per Window-Event.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('comments-rail:toggle')));
  await page.waitForSelector('.comments-split .comment-rail:visible', { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(1200);
  // Die Antwort des Besitzers trägt den Namen des Dev-Kontos («Dev (lokal)»);
  // die Leser-Ansicht zeigt dafür «Autor» — im Bild dieselbe Bezeichnung.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('.comment-rail *')) {
      if (el.children.length) continue;
      if (el.textContent.trim() === 'Dev (lokal)') el.textContent = 'Autor';
      else if (el.textContent.trim() === 'DL') el.textContent = 'A';
    }
  });
  {
    const railW = await page.locator('.comments-split .comment-rail:visible').first().evaluate(n => n.getBoundingClientRect().width);
    shots.push(await _shot(page, outDir, 'kommentare', '.comments-split .comment-rail:visible', { rect: { x: Math.round(railW) - CROP_W, y: 0 } }));
  }

  await page.evaluate(() => window.__app.runCheck());
  await _waitRoot(page, () => window.__app.checkDone === true && (window.__app.lektoratFindings || []).length > 0);
  // Die Befunde angehakt zeigen: abgewählte stehen abgeblendet (0.55) da und
  // sähen im Bild wie deaktiviert aus. Stilbefunde starten abgewählt.
  await page.evaluate(() => window.__app.selectAllFindings(true));
  await page.waitForTimeout(1200);
  shots.push(await _shot(page, outDir, 'lektorat', '.lektorat-split-findings', { rect: { x: 0, y: 0 } }));
  // Dieselben Befunde im Text: markierte Stellen in der Vorschau links.
  shots.push(await _shot(page, outDir, 'lektorat-text', '.lektorat-split-preview', { rect: { x: 0, y: 0 } }));

  // ── 3. Manuskript im Blick: Stil-Heatmap je Kapitel ──────────────────────
  // Regelbasiert (kein KI-Lauf): Satzlänge, Füllwörter, Passiv, Wiederholungen
  // je Kapitel als Farbtabelle — das Bild zur Kachel «Manuskript im Blick».
  await page.evaluate(async () => {
    window.__app._closeOtherMainCards?.(null);
    await window.__app.toggleStilCard();
  });
  await page.waitForSelector('.card--stil table', { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(1500);
  shots.push(await _shot(page, outDir, 'ueberblick', '.card--stil table', { rect: { x: 0, y: -8 } }));

  // ── 4. Sparrings-Chat: Textersetzung am Abschnitt ──────────────────────────
  // Der Abschnitts-Chat steht neben dem Editor — die Stil-Karte davor hat die
  // Abschnittsansicht geschlossen, also den Abschnitt erneut öffnen.
  await page.evaluate(async () => {
    window.__app._closeOtherMainCards?.(null);
    await window.__app.selectPage(window.Alpine.store('nav').pages[0]);
  });
  await page.waitForTimeout(1500);
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
  // Die Chat-Leiste (.aside-split) ist bei 1360 px Viewport rund 410 px breit —
  // schmaler als der Ausschnitt. Für diese Aufnahme über die Nutzerbreite der
  // Leisten (--aside-w-user, schlägt --aside-w) auf 520 px verbreitern, damit
  // der Ausschnitt ganz in der Karte liegt (kein Streifen Editor am Rand).
  await page.addStyleTag({ content: 'html { --aside-w-user: 520px; }' });
  await page.waitForTimeout(600);
  shots.push(await _shot(page, outDir, 'chat', '.chat-vorschlaege', { rect: { x: -12, y: 32 } }));

  // ── 5. Buchanalyse: Figuren ───────────────────────────────────────────────
  await page.evaluate(async () => {
    window.__app._closeOtherMainCards?.(null);
    await window.__app.toggleFiguresCard();
  });
  await page.waitForSelector('.card--figuren', { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(2000);
  // Die Hauptfigur aufklappen und den Block «Charakter» zeigen (Motivation,
  // Konflikt, Hintergrund, Entwicklungsbogen) — das, was die Analyse aus dem
  // Text herausliest. Die Liste auf Kachelbreite begrenzen, damit die Zeilen
  // im Ausschnitt umbrechen statt abgeschnitten zu werden. Der Graph taugt
  // nicht: das Beispielbuch hat fünf Figuren und kaum Kanten.
  await page.addStyleTag({ content: '.card--figuren .entity-list { max-width: 480px; }' });
  await page.locator('.card--figuren .entity-row').first().click();
  await page.waitForSelector('.card--figuren .figur-detail', { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(1500);
  shots.push(await _shot(page, outDir, 'buchanalyse', '.card--figuren .figur-detail .figur-group-title:has-text("Charakter")', { rect: { x: -10, y: -10 } }));

  // ── 6. Bewertung: Buch-Review ─────────────────────────────────────────────
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

  // ── 7. Plot-Werkstatt: Beat-Board ─────────────────────────────────────────
  await page.evaluate(async () => {
    window.__app._closeOtherMainCards?.(null);
    await window.__app.togglePlotCard();
  });
  await page.waitForSelector('.card--plot', { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(2000);
  shots.push(await _shot(page, outDir, 'plot', '.card--plot', { rect: { x: 10, y: 380 } }));

  // ── 8. Recherche: Wissensboard ────────────────────────────────────────────
  await page.evaluate(async () => {
    window.__app._closeOtherMainCards?.(null);
    await window.__app.toggleRechercheCard();
  });
  await page.waitForSelector('.card--recherche', { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(2000);
  shots.push(await _shot(page, outDir, 'recherche', '.card--recherche', { rect: { x: 0, y: 150 } }));

  // ── 9. Export ─────────────────────────────────────────────────────────────
  await page.evaluate(async () => {
    window.__app._closeOtherMainCards?.(null);
    await window.__app.toggleExportCard();
  });
  await page.waitForSelector('.card--export', { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(1500);
  shots.push(await _shot(page, outDir, 'export', '.card--export', { rect: { x: 0, y: 0 } }));

  // ── 9a. Teilen: die Karte «Geteilte Links» ─────────────────────────────────
  await page.evaluate(async () => {
    window.__app._closeOtherMainCards?.(null);
    await window.__app.toggleShareLinksCard();
  });
  await page.waitForSelector('.card--share', { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(1500);
  // Die Liste der bestehenden Links (Ziel, Aufrufe, Kommentare) erzählt
  // «geteilt, was fertig ist» — das Formular darüber wäre nur Bedienung. Auf
  // Kachelbreite begrenzt, sonst bricht die Zeile mitten im Wort ab. Die
  // Link-URL zeigte die Wegwerf-Adresse des Aufnahme-Servers.
  await page.addStyleTag({ content: '.card--share .share-list { max-width: 440px; } .card--share .share-row__url { display: none !important; }' });
  await page.waitForTimeout(400);
  shots.push(await _shot(page, outDir, 'teilen', '.card--share .share-list', { rect: { x: -12, y: -12 } }));

  // ── 10. Testleser: geteilter Abschnitt (ohne Session) ───────────────────────
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
    // Die «Antworten»-Knöpfe sind Bedienung, nicht Inhalt: ausgeblendet passen
    // beide Threads ganz ins Bild, statt dass der zweite mitten im Satz endet.
    await reader.addStyleTag({ content: '*:has(> .share-thread__reply-toggle) { display: none !important; }' });
    await reader.waitForTimeout(800);
    shots.push(await _shot(reader, outDir, 'testleser', '.share-comments__list > :first-child', { rect: { x: -12, y: -12 } }));
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
