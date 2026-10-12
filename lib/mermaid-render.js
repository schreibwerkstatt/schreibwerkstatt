'use strict';

// Serverseitiges Diagramm-Rendering.
//
// Warum ueberhaupt serverseitig: `pages.content` haelt nur den Quelltext (siehe
// public/js/diagram/mermaid-html.js). PDF, DOCX, EPUB und der HTML-Export
// entstehen im Job — dort gibt es kein DOM. mermaid braucht eines (es misst
// Textbreiten), also faehrt hier ein Headless-Chromium ueber Playwright.
//
// ZWEITER KONSUMENT: die LESENDEN Bildschirm-Oberflaechen (Notebook-Leseansicht,
// Bucheditor, Share-Reader) holen ihr SVG ebenfalls hier — ueber den Cache in
// lib/diagram-cache.js. Der 3,4-MB-Client-Bundle laedt nur noch dort, wo er
// unersetzlich ist (Live-Vorschau im Diagramm-Dialog) oder als Rueckfall, wenn
// dieser Renderer nicht verfuegbar ist. Siehe docs/diagramme.md.
//
// NON-FATAL, IMMER. Faellt das Rendering aus (kein Chromium installiert,
// Timeout, ungueltiger Quelltext), liefert dieses Modul `null` und der Exporter
// setzt den Quelltext als Codeblock. Muster wie veraPDF/Ghostscript: ein
// fehlendes Werkzeug darf keinen Export verlieren. Ein Buch ohne Diagrammbild
// ist aergerlich, ein fehlgeschlagener Export ist schlimmer.
//
// ZWEI AUSGABEFORMEN aus EINEM Lauf:
//   svg — HTML- und EPUB-Export (skaliert, klein, textbasiert)
//   png — PDF und DOCX (pdfkit und docx koennen kein SVG einbetten)
// Beide entstehen im selben Browser-Kontext, weil das Aufsetzen der Seite die
// teure Operation ist, nicht das Rendern.
//
// `htmlLabels: false` ist Pflicht: mit HTML-Labels steckt mermaid
// `<foreignObject>` ins SVG. Das rendert der Browser, aber kein EPUB-Reader.
// Dieselbe Einstellung wie im Frontend (public/js/diagram/mermaid-view.js) —
// sonst saehe das Diagramm im Export anders aus als auf dem Bildschirm.

const path = require('path');
const crypto = require('crypto');
const logger = require('../logger');
const { mermaidTheme } = require('./esm-bridge');

// Version der Render-Kette. Aendert sich die mermaid-Version oder eine
// Render-Option, muss der Cache fallen — sonst zeigt der Export auf Jahre das
// Bild vom ersten Lauf.
const RENDER_VERSION = '2:mermaid-11.16.0:app-palette';
const VENDOR_FILE = path.join(__dirname, '..', 'public', 'vendor', 'mermaid-11.16.0.min.js');

// Ein Diagramm, das laenger braucht, ist entweder pathologisch oder ein
// Endlos-Layout. Der Export wartet nicht darauf.
const RENDER_TIMEOUT_MS = 15000;
// Skalierung fuer die PNG-Variante. 2 ist der Kompromiss aus Druckaufloesung
// und Dateigroesse; bei 300 dpi entspricht das brauchbaren Kantenlaengen fuer
// Diagramme in Buchbreite.
const PNG_SCALE = 2;
// Der Browser wird nach Leerlauf geschlossen. Ein Export-Job rendert alle
// Diagramme kurz hintereinander; danach soll kein Chromium im Container stehen
// bleiben.
const IDLE_SHUTDOWN_MS = 60000;

let _browser = null;
let _launching = null;
let _idleTimer = null;
// „Chromium fehlt" ist eine Eigenschaft der Installation, nicht des einzelnen
// Diagramms. Das Flag traegt beides: die einmalige Log-Diagnose (statt einer
// Zeile pro Diagramm) und die Auskunft nach aussen (`rendererUnavailable`).
// Ein spaeter erfolgreicher Lauf setzt es zurueck — wer Chromium im laufenden
// Betrieb nachinstalliert, muss den Dienst nicht neu starten.
let _unavailable = false;

/** Not-Aus fuer Ops und Tests. Muster wie VERAPDF_DISABLED/GS_DISABLED: das
 *  Werkzeug bleibt abschaltbar, ohne es zu deinstallieren. Lazy gelesen, damit
 *  ein Test die Variable nach dem Import setzen kann. */
function _disabled() {
  return /^(1|true)$/i.test(process.env.MERMAID_RENDER_DISABLED || '');
}

/** Ist bekannt, dass ueberhaupt nicht gerendert werden kann?
 *
 *  Trennt die zwei Fehlerlagen, die `renderDiagram` beide als `null` meldet:
 *  „dieses Diagramm ist kaputt" (Aufrufer zeigt den Quelltext) gegen „hier
 *  rendert gar nichts" (Aufrufer faellt auf einen anderen Weg zurueck — im
 *  Browser auf die mitgelieferte Lib). Ohne die Unterscheidung zoege ein
 *  einzelnes ungueltiges Diagramm den 3,4-MB-Bundle nach. */
function rendererUnavailable() {
  return _disabled() || _unavailable;
}

function _touchIdle() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => { closeRenderer().catch(() => {}); }, IDLE_SHUTDOWN_MS);
  _idleTimer.unref?.();
}

async function _getBrowser() {
  if (_browser?.isConnected?.()) { _touchIdle(); return _browser; }
  if (!_launching) {
    _launching = (async () => {
      const { chromium } = require('playwright');
      const b = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      _browser = b;
      return b;
    })().catch(err => { _launching = null; throw err; });
  }
  const b = await _launching;
  _launching = null;
  _touchIdle();
  return b;
}

/** Browser beenden. Von den Tests und vom Idle-Timer gerufen. */
async function closeRenderer() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  const b = _browser;
  _browser = null;
  _launching = null;
  if (b) { try { await b.close(); } catch { /* schon zu */ } }
}

/** Cache-Schluessel: Quelltext + Theme + Render-Version. */
function renderKey(code, theme) {
  return crypto.createHash('sha1')
    .update(`${RENDER_VERSION}\0${theme}\0${code}`, 'utf8')
    .digest('hex');
}

/** Ein Diagramm rendern.
 *
 *  Liefert `{ svg, png, width, height }` oder `null`, wenn nicht gerendert
 *  werden konnte. `null` ist ein regulaeres Ergebnis, kein Fehlerfall —
 *  Aufrufer faellt auf den Quelltext zurueck. */
async function renderDiagram(code, opts = {}) {
  const src = String(code || '').trim();
  if (!src) return null;
  if (_disabled()) return null;
  const theme = opts.theme === 'dark' ? 'dark' : 'default';

  // Wurzel-ID des SVG. Mermaid schreibt eine <style>-Sektion ins SVG, die genau
  // diese ID als Praefix nutzt (`#id .node { … }`) — eine feste ID fuer alle
  // Diagramme kollidierte im HTML-Export (mehrfach dieselbe id im Dokument) und
  // liesse den EPUB-Builder beim Deduplizieren die Wurzel umbenennen, waehrend
  // das Stylesheet auf die alte ID zeigte. Inhaltsabgeleitet ist die ID
  // eindeutig pro Diagramm und ueber Laeufe hinweg stabil.
  const domId = 'd' + renderKey(src, theme).slice(0, 12);

  let page;
  try {
    const browser = await _getBrowser();
    page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
      // Der Screenshot soll druckbar sein, nicht bildschirmscharf.
      deviceScaleFactor: PNG_SCALE,
    });
    page.setDefaultTimeout(RENDER_TIMEOUT_MS);
    // Kein Netzzugriff: die Lib kommt von der Platte, der Quelltext aus der DB.
    // Ein Diagramm, das eine externe URL zieht, waere ein SSRF-Pfad.
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith('about:') || url.startsWith('data:')) return route.continue();
      return route.abort();
    });
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ path: VENDOR_FILE });

    // Farben aus der App-Palette — dieselbe Quelle wie Dialog-Vorschau und
    // Share-Reader-Rueckfall (public/js/diagram/mermaid-theme.js).
    const { mermaidThemeConfig } = await mermaidTheme();
    const themeCfg = mermaidThemeConfig(theme);

    const out = await page.evaluate(async ({ code: c, themeCfg: tc, id }) => {
      // eslint-disable-next-line no-undef
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        htmlLabels: false,
        flowchart: { htmlLabels: false, useMaxWidth: false },
        ...tc,
        fontFamily: 'Inter, system-ui, sans-serif',
      });
      // eslint-disable-next-line no-undef
      const { svg } = await window.mermaid.render(id, c);
      const host = document.createElement('div');
      host.id = 'host';
      host.style.display = 'inline-block';
      host.innerHTML = svg;
      document.body.style.margin = '0';
      document.body.style.background = '#ffffff';
      document.body.appendChild(host);
      const el = host.querySelector('svg');
      // `useMaxWidth: false` laesst mermaid feste Masse setzen; die viewBox ist
      // trotzdem die verlaesslichere Quelle (bei manchen Diagrammtypen fehlt
      // width/height).
      const vb = el?.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
      const rect = host.getBoundingClientRect();
      return {
        svg: host.innerHTML,
        width: Math.max(1, Math.round(vb && vb.length === 4 ? vb[2] : rect.width)),
        height: Math.max(1, Math.round(vb && vb.length === 4 ? vb[3] : rect.height)),
      };
    }, { code: src, themeCfg, id: domId });

    const host = await page.$('#host');
    const png = host
      ? await host.screenshot({ type: 'png', scale: 'device', omitBackground: false, timeout: RENDER_TIMEOUT_MS })
      : null;

    _unavailable = false; // Es geht ja — ein frueher Fehlschlag war nicht die Installation.
    return { svg: out.svg, png, width: out.width, height: out.height, scale: PNG_SCALE };
  } catch (err) {
    const msg = String(err?.message || err).split('\n')[0];
    if (/Executable doesn't exist|browserType.launch/i.test(msg)) {
      if (!_unavailable) {
        _unavailable = true;
        logger.warn(`Diagramm-Rendering nicht verfuegbar (Chromium fehlt): ${msg}. `
          + 'Exporte zeigen stattdessen den Diagramm-Quelltext. Behebung: npx playwright install chromium');
      }
    } else {
      logger.warn(`Diagramm-Rendering fehlgeschlagen: ${msg}`);
    }
    return null;
  } finally {
    if (page) { try { await page.close(); } catch { /* egal */ } }
  }
}

module.exports = {
  renderDiagram,
  renderKey,
  rendererUnavailable,
  closeRenderer,
  RENDER_VERSION,
  RENDER_TIMEOUT_MS,
  PNG_SCALE,
};
