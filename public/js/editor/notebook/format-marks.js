// Steuerzeichen-Overlay für den Notebook-Editor: zeichnet Soft-Break-Pfeile (↵)
// über jedes <br> sowie Absatzmarken (¶) für Blöcke mit direktem <br>. Reine
// Read-only-Dekoration in einer separaten Overlay-Schicht
// (.page-editor-marks-layer) — editierbarer DOM und gespeichertes HTML bleiben
// unberührt (gleiche Philosophie wie die Entity-Highlights). Die ¶ der übrigen
// Blöcke macht CSS allein (page-view.css). Begründung des JS-Pfads: ein <br>
// lässt sich von keinem Browser per CSS/Pseudo-Element dekorieren (kein
// Box-Modell), und die ¶-::after-Marke rutscht in einem Block mit <br> hinter
// den Umbruch auf eine Phantom-Zweitzeile → gemessene Platzierung nötig.
//
// Aktiv nur wenn editMode && !focusActive && pageEditorShowMarks. Recompute via
// rAF-Coalesce bei: Tippen (input), internem Scroll, Container-Scroll und
// Fenster-Resize (Vollbild, Band = Viewport) sowie Grössenänderung des Editors
// (ResizeObserver deckt Resize/Fit-Width/Vollbild und Fokus-Ein-/Austritt ab,
// da der Notebook-Editor im Fokus per x-show ausgeblendet wird). Reiner
// Font-Size-Zoom (--editor-zoom) ändert die Editor-Box nicht → die
// pageEditorZoom*-Methoden rufen _scheduleFormatMarks explizit.
//
// NUR SICHTBARES VERMESSEN (Band-Filter): Das Overlay liegt über dem Editor und
// clippt (overflow:hidden) alles ausserhalb von dessen Fenster. Vermessen wird
// deshalb nur, was das Sichtfenster (plus BAND_MARGIN_PX) schneidet. Why: die
// Vermessung läuft bei jedem Tastendruck; ohne Filter skaliert sie mit dem
// ganzen Abschnitt statt mit dem sichtbaren Ausschnitt. Granularität ist der
// Block: Blöcke ausserhalb des Bandes werden gar nicht angefasst. Ein einzelner
// Block, der das Band schneidet, wird dagegen ganz vermessen (jedes seiner
// <br>) — Marken ausserhalb des Bandes werden nach der Messung nur verworfen.
// Der Gewinn gilt also für viele Blöcke, nicht für einen Block mit sehr vielen
// Umbrüchen.

import { editorHost } from '../shared/editor-host.js';
import { NORMAL_SELECTOR } from '../shared/active-editor.js';

// Container-Selektor kommt aus shared/active-editor.js (SSoT) — eine zweite
// String-Kopie hier wäre genau die Drift, gegen die der Export dort existiert.
// Bewusst NICHT `getActiveEditorContainer()`: das Marks-Overlay ist
// notebook-only und darf nie auf den Focus-Container umschalten.
const NOTEBOOK_EDIT_SEL = NORMAL_SELECTOR;
const MARKS_LAYER_SEL = '.page-editor-marks-layer';

// Overlay-Layer des Notebook-Editors. Über den Editor-Wrapper gesucht, nicht
// global — sonst träfe ein zweiter Layer (z.B. künftig im Bucheditor) zuerst.
function marksLayer() {
  const editEl = document.querySelector(NOTEBOOK_EDIT_SEL);
  return editEl?.parentElement?.querySelector(MARKS_LAYER_SEL) || null;
}

// White-space-Modi, in denen ein `\n` im Text ein echter Zeilenumbruch ist.
const PRESERVING_WS = /^(pre|pre-wrap|pre-line|break-spaces)$/;
// Blöcke, die Newlines als Zeichen tragen statt als <br> (Gedichte, Code).
// Vorfilter für den Textknoten-Walk: ohne ihn liefe getComputedStyle pro
// Textknoten der ganzen Seite — bei jedem Tastendruck.
const PRESERVING_BLOCK_SEL = 'div.poem, pre';

// Toleranz um das Sichtfenster: eine Marke, die genau am Rand liegt, soll nicht
// erst beim nächsten Scroll-Ereignis auftauchen.
const BAND_MARGIN_PX = 24;

// Container-Tags, in denen ein Soft-Break stehen kann. Als Tag-Menge und nicht
// als CSS-Selektor: auf dem heissen Pfad (jeder <br> sucht seinen Container)
// ist ein Set-Lookup um Grössenordnungen billiger als `matches()`/`closest()`
// mit langer Selektorliste.
const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'PRE',
  'TD', 'TH', 'FIGCAPTION', 'BLOCKQUOTE', 'DIV',
]);

// Nächster Block-Container eines Knotens, bis `root`. Für ein <br> ist das der
// Absatz, in dem es steht; ohne Treffer (z.B. ein <br> direkt im Editor) der
// Editor selbst. Nur für den Sichtbarkeits-Filter — die Marken selbst werden
// weiterhin am <br> bzw. am Absatz gemessen.
function blockOf(el, root) {
  let n = el;
  while (n && n !== root) {
    if (BLOCK_TAGS.has(n.tagName)) return n;
    n = n.parentElement;
  }
  return root;
}

// Auto-Slot-<br> als einziges Kind eines leeren Text-Blocks ist strukturell
// (Caret-Slot, vgl. ensureTrailingParagraph) — kein echter Zeilenumbruch, keine
// Marke.
function isCaretFiller(br) {
  const p = br.parentElement;
  return !!p && p.childNodes.length === 1 && /^(P|H[1-6]|LI)$/.test(p.tagName);
}

// Nachgestelltes <br> als letztes (sichtbares) Kind eines Text-Blocks: der
// Browser rendert es inert — keine sichtbare Folgezeile, das Rect kollabiert ans
// Zeilenende. Kein ↵; die ¶ des Blocks (Schritt 3) markiert dort bereits das
// Absatzende. Ohne dieses Skip lägen ↵ und ¶ übereinander (ein einziges,
// verschmolzenes Glyph). Mitten im Block (<p>…<br>…</p>) bleibt das <br> ein
// echter Umbruch und behält sein ↵.
function isTrailingBr(br) {
  for (let n = br.nextSibling; n; n = n.nextSibling) {
    if (n.nodeType === 3 && !n.nodeValue.trim()) continue; // nur Whitespace folgt
    return false;
  }
  const p = br.parentElement;
  return !!p && /^(P|H[1-6]|LI|PRE)$/.test(p.tagName);
}

export const formatMarksMethods = {
  _renderFormatMarks() {
    const app = editorHost();
    const editEl = document.querySelector(NOTEBOOK_EDIT_SEL);
    if (!editEl) return;
    const layer = editEl.parentElement?.querySelector(MARKS_LAYER_SEL);
    if (!layer) return;

    const active = !!(app?.pageEditorShowMarks && app?.editMode && !app?.focusActive);
    if (!active) { layer.replaceChildren(); layer.hidden = true; return; }

    const editRect = editEl.getBoundingClientRect();
    // Overlay exakt über die Border-Box des Editors legen (offsetParent =
    // .page-editor-wrap, position:relative). overflow:hidden clippt Pfeile, die
    // durch den internen Scroll aus dem Sichtfenster laufen.
    layer.style.left = editEl.offsetLeft + 'px';
    layer.style.top = editEl.offsetTop + 'px';
    layer.style.width = editEl.offsetWidth + 'px';
    layer.style.height = editEl.offsetHeight + 'px';
    layer.style.fontSize = getComputedStyle(editEl).fontSize;
    layer.hidden = false;

    const range = document.createRange();
    const frag = document.createDocumentFragment();

    // ── Sichtbarkeits-Filter ──────────────────────────────────────────────
    // Der Layer clippt (overflow:hidden) auf das Editor-Fenster. Was ausserhalb
    // liegt, ist unsichtbar — es zu vermessen ist reine Rechenzeit.
    //
    // Zwei Fälle, weil die Marken unterschiedlich mit dem Inhalt wandern:
    //  - Scrollt der Editor selbst (Normalfall), ist sein eigenes Fenster das
    //    Sichtfenster: der Layer wandert NICHT mit dem Text, der Editor-Scroll
    //    loest ohnehin ein Neuzeichnen aus. Der Rest des Inhalts ist vom Layer
    //    geclippt und bleibt es.
    //  - Scrollt der Editor nicht selbst (Vollbild: die Karte scrollt, der
    //    Editor waechst ueber den Viewport hinaus), wandert der Layer MIT dem
    //    Text. Sichtbar ist dann nur, was im Viewport liegt — und weil der
    //    Layer mitwandert, muss beim Scrollen des Containers und bei
    //    Fenster-Resize neu vermessen werden (Listener in _installFormatMarks).
    const scrolls = editEl.scrollHeight > editEl.clientHeight + 1;
    const winTop = scrolls ? editRect.top : Math.max(editRect.top, 0);
    const winBottom = scrolls ? editRect.bottom : Math.min(editRect.bottom, window.innerHeight);
    // Filter nur, wenn ein Teil des Inhalts ausserhalb des Fensters liegt.
    const filter = scrolls || winTop > editRect.top + 1 || winBottom < editRect.bottom - 1;
    // Toleranz um das Fenster: eine Marke am Rand soll nicht erst beim
    // naechsten Scroll auftauchen.
    const bandTop = winTop - BAND_MARGIN_PX;
    const bandBottom = winBottom + BAND_MARGIN_PX;
    // Rect je Block einmal — viele <br> teilen sich den Container.
    const rects = new Map();
    const visible = (el) => {
      if (!filter) return true;
      const block = blockOf(el, editEl);
      let r = rects.get(block);
      if (!r) {
        r = block.getBoundingClientRect();
        rects.set(block, r);
      }
      return r.bottom >= bandTop && r.top <= bandBottom;
    };

    // Marke an einer gemessenen Position platzieren. height = Zeilenhöhe, damit
    // die CSS-Mittelzentrierung (.format-mark) das Glyph vertikal auf Textmitte
    // legt statt an den oberen Rand der Zeile.
    const mark = (cls, char, left, top, height) => {
      const m = document.createElement('span');
      m.className = 'format-mark ' + cls;
      m.textContent = char;
      m.style.left = (left - editRect.left) + 'px';
      m.style.top = (top - editRect.top) + 'px';
      m.style.height = height + 'px';
      frag.appendChild(m);
    };
    // Innerhalb eines Blocks, der das Band nur schneidet, liegen einzelne
    // Marken ausserhalb — die Messung ist gelaufen, die Marke wäre geclippt.
    const inBand = (r) => !filter || (r.bottom >= bandTop && r.top <= bandBottom);
    const place = (r) => {
      if (!r || !r.height) return; // degenerierte Messung überspringen
      if (!inBand(r)) return;
      mark('format-mark--br', '↵', r.left, r.top, r.height);
    };

    // 1) Echte <br>-Elemente (Soft-Break via Shift+Enter).
    editEl.querySelectorAll('br').forEach((br) => {
      if (!visible(br)) return;
      if (isCaretFiller(br) || isTrailingBr(br)) return;
      range.selectNode(br);
      place(range.getBoundingClientRect());
    });

    // 2) \n-Zeilenumbrüche in Blöcken, die Newlines erhalten (white-space:
    //    pre-line/pre/pre-wrap) — Gedichte (div.poem) und <pre> haben kein
    //    <br>, der Umbruch steckt als Zeichen im Text. Nur diese Blöcke werden
    //    durchlaufen (statt aller Textknoten des Editors), und getComputedStyle
    //    läuft einmal pro Block statt einmal pro Textknoten.
    editEl.querySelectorAll(PRESERVING_BLOCK_SEL).forEach((blk) => {
      if (!visible(blk)) return;
      if (!PRESERVING_WS.test(getComputedStyle(blk).whiteSpace)) return;
      const walker = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.nodeValue;
        if (!text || text.indexOf('\n') === -1) continue;
        for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          place(range.getClientRects()[0]);
        }
      }
    });

    // 3) Absatzmarken (¶) für Blöcke mit direktem <br>. CSS lässt die bewusst
    //    aus (`:not(:has(> br))`), weil ::after hinter dem <br> auf eine
    //    Phantom-Zweitzeile rutscht → verdoppelt die Blockhöhe und entkoppelt
    //    die sichtbare Marke vom Caret-Slot. Hier gemessen platziert: leerer
    //    Caret-Slot-Block (<p><br></p>) → ¶ auf der Slot-Zeile am Block-Anfang;
    //    Soft-Break-Absatz (<p>…<br>…</p>) → ¶ am Ende der letzten Zeile.
    editEl.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, pre').forEach((b) => {
      if (!visible(b)) return;
      let hasDirectBr = false;
      for (const c of b.children) { if (c.tagName === 'BR') { hasDirectBr = true; break; } }
      if (!hasDirectBr) return; // Rest macht CSS ::after
      let r;
      let atEnd = true;
      if (b.childNodes.length === 1) {
        // Leerer Caret-Slot-Block: ¶ am Slot (Zeilenanfang), einzeilig.
        range.selectNode(b.firstChild);
        r = range.getBoundingClientRect();
        atEnd = false;
      } else {
        range.selectNodeContents(b);
        const rects = range.getClientRects();
        r = rects[rects.length - 1];
      }
      if (!r || !r.height || !inBand(r)) return;
      // Kleiner Abstand wie das CSS-`margin-inline-start: 0.15em` am Zeilenende;
      // am leeren Slot direkt auf die Caret-Position (kein Versatz).
      mark('format-mark--pilcrow', '¶', (atEnd ? r.right + 2 : r.left), r.top, r.height);
    });

    layer.replaceChildren(frag);
  },

  _scheduleFormatMarks() {
    if (this._formatMarksRaf) return;
    this._formatMarksRaf = requestAnimationFrame(() => {
      this._formatMarksRaf = null;
      this._renderFormatMarks();
    });
  },

  _installFormatMarks() {
    const editEl = document.querySelector(NOTEBOOK_EDIT_SEL);
    if (!editEl) return;
    this._uninstallFormatMarks();
    const abort = new AbortController();
    this._formatMarksAbort = abort;
    const onChange = () => this._scheduleFormatMarks();
    editEl.addEventListener('input', onChange, { signal: abort.signal });
    editEl.addEventListener('scroll', onChange, { signal: abort.signal, passive: true });
    // Container-Scroll: scrollt der Editor nicht selbst (Vollbild: die Karte
    // scrollt, der Editor waechst ueber den Viewport hinaus), wandert der Layer
    // MIT dem Inhalt — die Marken bleiben am Text, aber das Sichtfenster des
    // Overlays verschiebt sich. Dann muss neu vermessen werden, sonst fehlen
    // die Marken des neu sichtbaren Bereichs. Capture-Phase: der Scroll-Event
    // eines beliebigen Vorfahren erreicht window so (bubbled nicht).
    // Scrollt der Editor selbst, deckt der Listener oben das ab — und der
    // Layer wandert dort nicht mit, die Marken blieben sonst am Text kleben.
    const onContainerScroll = () => {
      const el = document.querySelector(NOTEBOOK_EDIT_SEL);
      if (!el) return;
      if (el.scrollHeight > el.clientHeight + 1) return; // Editor scrollt selbst
      this._scheduleFormatMarks();
    };
    window.addEventListener('scroll', onContainerScroll, { capture: true, passive: true, signal: abort.signal });
    // Fenster-Höhe: scrollt der Editor nicht selbst, ist das Band der Viewport
    // (window.innerHeight) — ändert er sich, ohne dass sich die Editor-Box
    // ändert (Fenster höher ziehen, Mobile-Tastatur), sieht der ResizeObserver
    // nichts und die Marken des neu sichtbaren Bereichs fehlten.
    window.addEventListener('resize', onChange, { passive: true, signal: abort.signal });
    window.visualViewport?.addEventListener('resize', onChange, { passive: true, signal: abort.signal });
    try {
      this._formatMarksRO = new ResizeObserver(() => this._scheduleFormatMarks());
      this._formatMarksRO.observe(editEl);
    } catch { this._formatMarksRO = null; }
    this._scheduleFormatMarks();
  },

  _uninstallFormatMarks() {
    if (this._formatMarksRaf) { cancelAnimationFrame(this._formatMarksRaf); this._formatMarksRaf = null; }
    this._formatMarksRO?.disconnect?.();
    this._formatMarksRO = null;
    this._formatMarksAbort?.abort?.();
    this._formatMarksAbort = null;
    const layer = marksLayer();
    if (layer) { layer.replaceChildren(); layer.hidden = true; }
  },
};
