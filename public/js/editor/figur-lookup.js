// Figuren-Lookup für den Editor (Edit- und Fokus-Modus).
// Ctrl/Cmd-Klick auf ein Wort, das gegen Figur-Namen matcht → Popover mit
// Geburt, Eigenschaften sowie optional Beruf/Rolle. Im Edit-Modus zusätzlich
// "Figur öffnen"-Link (nicht im Fokus-Modus, dort würde der Kontext-Wechsel
// den Fluss brechen).
//
// Zweigeteilt:
//   - `figurLookupMethods`: Root-Methoden (Index, Word-Lookup, Click-Handler,
//     `_tryOpenFigurLookupAt` für synchronen Hit-Test aus dem Synonym-Menü).
//     Dispatcht `editor:figur-lookup:open { fig, x, y }` und
//     `editor:figur-lookup:close` — die Sub-Komponente hört darauf.
//   - `figurLookupCardMethods`: Popup-Display (Position, Scroll, Schliessen)
//     in Alpine.data('editorFigurLookupCard').

import { normalizeName, attachReflow, positionPopupNearRect, rangeForWordAtClientPoint } from './utils.js';
import { getActiveEditorMode } from './shared/active-editor.js';
import { EVT } from '../events.js';

function extractYear(geburtstag) {
  if (!geburtstag) return null;
  const m = String(geburtstag).match(/\b(\d{4})\b/);
  return m ? m[1] : null;
}

function wordAtClientPoint(x, y) {
  const r = rangeForWordAtClientPoint(x, y);
  return r ? r.word : null;
}

// Namenspartikel und Artikel, die als Einzel-Token keine Figur bezeichnen
// („von" aus „Johann von Goethe", „Der" aus „Der Alte"). Der Vollname bleibt
// als Schluessel erhalten; nur der Token-Einzeltreffer faellt weg.
const NAME_PARTICLES = new Set([
  'von', 'vom', 'van', 'der', 'die', 'das', 'den', 'dem', 'des', 'zu', 'zum', 'zur',
  'und', 'auf', 'am', 'im', 'de', 'del', 'della', 'di', 'da', 'du', 'la', 'le', 'les',
  'ten', 'ter', 'the', 'of', 'and', 'el', 'al', 'bin', 'ibn',
]);

/** Pure: Lookup-Index normalisierter Name → Figur (null = mehrdeutig).
 *  Stale Figuren (nicht mehr im Text) bleiben draussen. */
export function buildFigurLookupIndex(figuren) {
  const map = new Map();
  for (const f of (figuren || [])) {
    if (!f || f.stale) continue;
    const keys = new Set();
    if (f.name) keys.add(normalizeName(f.name));
    if (f.kurzname) keys.add(normalizeName(f.kurzname));
    // Einzel-Tokens aus dem Vollnamen (für "Müller" aus "Anna Müller"),
    // aber nur wenn der Token eindeutig bleibt und kein Namenspartikel ist.
    if (f.name) {
      for (const tok of String(f.name).split(/\s+/)) {
        const n = normalizeName(tok);
        if (n.length >= 3 && !NAME_PARTICLES.has(n)) keys.add(n);
      }
    }
    for (const k of keys) {
      if (!k) continue;
      if (map.has(k)) {
        if (map.get(k) !== f) map.set(k, null); // mehrdeutig → nicht matchen
      } else {
        map.set(k, f);
      }
    }
  }
  return map;
}

// Index je Katalog-Array (Loader reassignen `catalog.figuren`, pushen nie):
// ein Buchwechsel, Reload oder Delete liefert ein neues Array und damit einen
// neuen Index — auch dann, wenn ein Ladefehler den Katalog leer laesst.
const _indexByCatalog = new WeakMap();
function _indexFor(figuren) {
  const src = figuren || [];
  let idx = _indexByCatalog.get(src);
  if (!idx) { idx = buildFigurLookupIndex(src); _indexByCatalog.set(src, idx); }
  return idx;
}

// ── Root-Methoden ──────────────────────────────────────────────────────────
// Lookup-Index + Word-Matching leben am Root, weil `_tryOpenFigurLookupAt`
// synchron ein Bool zurückgeben muss (Synonym-Menü nutzt das, um nicht zu
// öffnen, falls bereits ein Figur-Popover gezeigt wird). Der Display-Teil
// läuft als Sub-Komponente und wird über Events gesteuert.
export const figurLookupMethods = {
  // Index des aktuellen Katalogs (an dessen Array-Referenz gecacht). Das Feld
  // `_figurLookupIndex` spiegelt ihn fuer bestehende Leser; die Loader duerfen
  // es weiter nullen, die Wahrheit ist die Referenz des Katalogs.
  _buildFigurLookupIndex() {
    this._figurLookupIndex = _indexFor(this.$store.catalog.figuren);
    return this._figurLookupIndex;
  },

  _findFigurByWord(word) {
    if (!word) return null;
    const idx = this._buildFigurLookupIndex();
    const n = normalizeName(word);
    // Exakter Hit: value kann null sein (mehrdeutig → bewusst nicht matchen).
    if (idx.has(n)) return idx.get(n);
    // Genitiv-s abschneiden: "Samuels" → "Samuel", "Müllers" → "Müller".
    if (n.length > 2 && n.endsWith('s')) {
      const base = n.slice(0, -1);
      if (idx.has(base)) return idx.get(base);
    }
    return null;
  },

  _onEditClick(e) {
    if (!this.editMode) return;
    // Klick ins Edit-Feld = bewusst gesetzter Caret → STT-Diktat fuegt dort ein
    // statt ans Editorende (siehe _sttStart / sttCaretUserSet).
    this.$store.stt.caretUserSet = true;
    // Laeuft das Diktat schon, schreibt es ab jetzt an dieser Stelle weiter.
    this._sttReanchorFromUser?.();
    if (!(e.ctrlKey || e.metaKey)) return;
    this._tryOpenFigurLookupAt(e);
  },

  // Gemeinsamer Einstieg für Figuren-Popover an einer Click-Position.
  // Auf macOS feuert Ctrl+Click kein `click`-Event, nur `contextmenu` — daher
  // ruft auch der Synonym-Kontextmenü-Handler diese Methode auf.
  // Gibt true zurück, wenn ein Popover geöffnet wurde.
  _tryOpenFigurLookupAt(e) {
    if (!this.editMode) return false;
    const word = wordAtClientPoint(e.clientX, e.clientY);
    if (!word) return false;
    const fig = this._findFigurByWord(word);
    if (!fig) return false;
    e.preventDefault();
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent(EVT.EDITOR_FIGUR_LOOKUP_OPEN, {
      detail: { fig, x: e.clientX, y: e.clientY },
    }));
    return true;
  },

  // Trampolin — Legacy-Aufrufer (resetPage, cancelEdit, focus-mode,
  // synonyme-close) rufen `closeFigurLookup()` am Root. Dispatcht an die Sub.
  closeFigurLookup() {
    window.dispatchEvent(new CustomEvent(EVT.EDITOR_FIGUR_LOOKUP_CLOSE));
  },
};

// ── Sub-Komponenten-Methoden ──────────────────────────────────────────────
// `this` zeigt auf die Alpine.data('editorFigurLookupCard')-Instanz.
export const figurLookupCardMethods = {
  _openFigurLookup(fig, clientX, clientY) {
    this.figurLookupData = fig;
    this.showFigurLookup = true;
    // Root-Flag, damit editor-focus-onKey (Escape) weiss, dass ein Popover
    // offen ist, ohne in die Sub greifen zu müssen.
    if (window.__app) window.__app._figurLookupOpen = true;
    this._figurLookupAnchor = { x: clientX, y: clientY };
    this._attachFigurLookupScroll();
    this._attachFigurLookupEscape();
    this.$nextTick(() => this._positionFigurLookup());
    // Erstpositionierung bereits vor nextTick, damit kein Flash oben links.
    this._positionFigurLookup();
  },

  closeFigurLookup() {
    if (!this.showFigurLookup) return;
    this.showFigurLookup = false;
    this.figurLookupData = null;
    this._figurLookupAnchor = null;
    if (window.__app) window.__app._figurLookupOpen = false;
    this._detachFigurLookupScroll();
    this._detachFigurLookupEscape();
  },

  // Escape schliesst NUR das Popover. Darum nur solange es offen ist, und in
  // der Capture-Phase am window (vor jedem anderen keydown-Listener) samt
  // stopPropagation: ein window-Bubble-Listener (frueher `@keydown.escape.window`)
  // lief VOR dem spaeter registrierten Fokusmodus-Handler, setzte
  // `_figurLookupOpen` schon zurueck — und der Fokusmodus wertete dasselbe
  // Escape dann als „verlassen". Ebenso schliesst Escape im Notebook nicht
  // zusaetzlich das Editor-Vollbild.
  _attachFigurLookupEscape() {
    if (this._figurLookupEscAbort) return;
    const ctrl = new AbortController();
    this._figurLookupEscAbort = ctrl;
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.showFigurLookup) return;
      e.preventDefault();
      e.stopPropagation();
      this.closeFigurLookup();
    }, { capture: true, signal: ctrl.signal });
  },

  _detachFigurLookupEscape() {
    this._figurLookupEscAbort?.abort();
    this._figurLookupEscAbort = null;
  },

  _positionFigurLookup() {
    const a = this._figurLookupAnchor;
    if (!a) return;
    const el = document.querySelector('.figur-lookup');
    // Punkt-Anker: Rect mit width/height = 0; gap=8 trennt Popover sichtbar
    // vom Wort, sonst klebt es am Cursor.
    const rect = { left: a.x, right: a.x, top: a.y, bottom: a.y, width: 0, height: 0 };
    const { x, y } = positionPopupNearRect(rect, el, { gap: 8, fallbackWidth: 280, fallbackHeight: 200 });
    this.figurLookupX = x;
    this.figurLookupY = y;
  },

  _attachFigurLookupScroll() {
    if (this._figurLookupReflowDetach) return;
    this._figurLookupReflowDetach = attachReflow(() => {
      // Im Fokus-Modus driftet das Popover vom darunterliegenden Wort weg,
      // sobald der Text scrollt (typewriter-Recenter). Statt mitzuwandern:
      // schliessen, damit der User einen klaren Zustand sieht.
      if (getActiveEditorMode() === 'focus') { this.closeFigurLookup(); return; }
      this._positionFigurLookup();
    });
  },

  _detachFigurLookupScroll() {
    if (!this._figurLookupReflowDetach) return;
    this._figurLookupReflowDetach();
    this._figurLookupReflowDetach = null;
  },

  // Anzeigewert für das Geburtsfeld: wenn `geburtstag` eine Jahreszahl
  // enthält, diese zurückgeben – sonst den Rohwert (z.B. "Frühling 1850").
  figurLookupGeburt() {
    const g = this.figurLookupData?.geburtstag;
    if (!g) return '';
    return extractYear(g) || String(g);
  },

  async openFigurLookupTarget() {
    const fig = this.figurLookupData;
    this.closeFigurLookup();
    if (!fig?.id) return;
    await window.__app?.openFigurById?.(fig.id);
  },
};
