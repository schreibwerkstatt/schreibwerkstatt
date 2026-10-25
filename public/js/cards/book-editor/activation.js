// Teil von bookEditorCard (Facade cards/book-editor-card.js): Render-Sync der
// Block-Container und Klick-aktiviert-Block (Aktivieren, Verlassen, Caret,
// Eingabe, Clipboard). Methoden in den Card-Scope gespreadet (gemeinsames
// `this`).
//
// Default: alle Blöcke contenteditable=false. Klick setzt die aktive pageId,
// Caret aus der Mousedown-Position. Verlassen (anderer Block, Fokus raus,
// Karte zu) speichert bei dirty. Invarianten 2/3/15/16 in docs/book-editor.md.

import { handleEditorPaste, handleEditorCopy, handleEditorCut } from '../../editor/shared/paste.js';
import { renderDiagramsIn, clearRenderedDiagrams } from '../../diagram/mermaid-view.js';
import { collectDiagrams } from '../../diagram/mermaid-html.js';
import { stampCaptionNumbers, clearCaptionNumbers } from '../../xrefs/caption-preview.js';

const CLIPBOARD_HANDLERS = { paste: handleEditorPaste, cut: handleEditorCut };

// Diagramme rendern erst, wenn ihr Block so nah am sichtbaren Bereich ist —
// beim Laden eines grossen Buchs liefen sonst alle Mermaid-Renderings auf
// einmal. Der Vorlauf ist gross genug, dass beim normalen Scrollen das Bild
// schon steht, wenn der Block ins Bild kommt.
const DIAGRAM_PRELOAD_MARGIN = '1500px 0px';

export const bookEditorActivationMethods = {
  // ── Rendering-Sync ────────────────────────────────────────────────────
  // Initialer Mount-Hook (x-init). Setzt rev-Marker + Initial-Body imperativ.
  _mountBlockEl(el, block) {
    if (!el) return;
    el.innerHTML = block.html;
    el.dataset.rev = String(block._rev || 0);
    this._syncBlockDiagrams(el, block);
    this._syncBlockCaptionNumbers(el, block);
  },

  // Diagramme im Stream: inaktive Blöcke zeigen das Bild, der aktive den
  // Quelltext.
  //
  // Warum der aktive Block das SVG NICHT behalten darf: `_onBlockInput` liest
  // `el.innerHTML` in `block.html` — ein gerenderter Fremdknoten im aktiven
  // Block landete beim ersten Tastendruck im Manuskript. Der Quelltext ist die
  // Wahrheit, das Bild ein Artefakt (siehe public/js/diagram/mermaid-html.js).
  //
  // Bearbeitet wird der Code hier nur als Text — die geführte Eingabe mit
  // Vorschau ist notebook-only (harte Regel „Editor-Spezifikation").
  _syncBlockDiagrams(el, block) {
    if (!el) return;
    if (this.activePageId === block.pageId) {
      this._diagramObserver?.unobserve(el);
      clearRenderedDiagrams(el);
      return;
    }
    if (!collectDiagrams(el).length) return;
    const io = this._ensureDiagramObserver();
    if (!io) { this._renderBlockDiagrams(el); return; }
    // Neu beobachten: `observe` meldet einen schon sichtbaren Block sofort.
    io.unobserve(el);
    io.observe(el);
  },

  _renderBlockDiagrams(el) {
    renderDiagramsIn(el, { errorLabel: window.__app?.t?.('editor.diagram.invalid') })
      .catch(() => {});
  },

  _ensureDiagramObserver() {
    if (this._diagramObserver) return this._diagramObserver;
    if (typeof IntersectionObserver === 'undefined') return null;
    this._diagramObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this._diagramObserver?.unobserve(entry.target);
        // Inzwischen aktiviert: der aktive Block zeigt den Quelltext.
        if (parseInt(entry.target.dataset.bookEditorPage, 10) === this.activePageId) continue;
        this._renderBlockDiagrams(entry.target);
      }
    }, { rootMargin: DIAGRAM_PRELOAD_MARGIN });
    return this._diagramObserver;
  },

  _teardownDiagramObserver() {
    this._diagramObserver?.disconnect();
    this._diagramObserver = null;
  },

  // Nummern in Abbildungslegenden und Tabellenbeschriftungen („Abb. 3.2: ").
  // Dieselbe Mechanik wie beim Diagramm und aus demselben Grund: das Badge ist
  // ein Fremdknoten im Block-DOM, und sobald der Block aktiv wird, gehört
  // dieses DOM dem User und läuft durch den Save-Pfad. Der aktive Block
  // bekommt deshalb seinen nackten Legendentext zurück, alle übrigen zeigen
  // die Nummer.
  //
  // Dass ein Badge auch bei einem Fehlgriff nicht in `pages.content` landen
  // kann, sichern zwei Bereinigungsschichten (editor/shared/html-clean.js für
  // den Dirty-Vergleich, lib/html-clean.js am Schreib-Chokepoint) — hier geht
  // es darum, dass der User im aktiven Block keinen Text vor sich hat, den er
  // nicht geschrieben hat.
  _syncBlockCaptionNumbers(el, block) {
    if (!el) return;
    if (this.activePageId === block.pageId) {
      clearCaptionNumbers(el);
      return;
    }
    stampCaptionNumbers(el, window.Alpine?.store('nav')?.selectedBookId).catch(() => {});
  },

  // Schreibt block.html in DOM-Container; läuft NICHT auf dem aktiven Block
  // (DOM gehört dort dem User). Per-Block-_rev triggert Re-Hydrate bei
  // externen Mutationen (Find/Replace, Reload).
  _maybeRehydrate(el, block) {
    if (!el) return;
    if (this.activePageId === block.pageId) return;
    const seen = parseInt(el.dataset.rev || '-1', 10);
    if (seen === block._rev) return;
    // Trusted Source: HTML kommt vom Content-Store (server-cleant).
    el.innerHTML = block.html;
    el.dataset.rev = String(block._rev);
    this._syncBlockDiagrams(el, block);
    this._syncBlockCaptionNumbers(el, block);
  },

  // ── Klick-aktiviert-Block ─────────────────────────────────────────────
  // Alle Block-Handler hängen im Template unter x-if="block.kind === 'page'"
  // — kein kind-Guard nötig (Invariante 2 in docs/book-editor.md).
  _onBlockMousedown(block, event) {
    if (this.activePageId === block.pageId) return;
    this._pendingMousedown = { x: event.clientX, y: event.clientY, pageId: block.pageId };
  },

  // Schreibrecht am Buch (editor/owner; unbekannte Rolle = Legacy-Fallback
  // erlaubt). Lektor und Viewer lesen und suchen im Stream, aktivieren aber
  // keinen Block — sonst tippen sie in einen Block, dessen Save der Server mit
  // 403 abweist. Nur UX: der PUT-Pfad prüft selbst.
  // Während eines Buch-/Ansichtswechsels (_resetSession) ist nichts bearbeitbar.
  _canEdit() {
    return !this._switching && window.__app?.canEdit?.() !== false;
  },

  // Aktiven Block verlassen, ohne einen neuen zu aktivieren: Undo-Debounce
  // einlösen, Ungespeichertes in die Queue, Bild und Nummern zurück.
  _deactivateBlock() {
    const prevId = this.activePageId;
    if (prevId == null) return;
    this._historyOnDeactivate(prevId);
    const prev = this._blockById(prevId);
    if (prev?.dirty) this._enqueueSave(prevId);
    this.activePageId = null;
    this.$nextTick(() => {
      const el = this._blockEl(prevId);
      if (el && prev) {
        this._syncBlockDiagrams(el, prev);
        this._syncBlockCaptionNumbers(el, prev);
      }
    });
  },

  // Alle ungespeicherten Blöcke jetzt in die Queue (Karte geschlossen).
  _saveDirtyNow() {
    for (const b of this.blocks) {
      if (b.kind === 'page' && b.dirty) this._enqueueSave(b.pageId);
    }
  },

  // Fokus verlässt den aktiven Block (Klick in Gliederung, Leiste, Suchleiste,
  // anderes Fenster): speichern, ohne das Autosave-Fenster abzuwarten. Der
  // Block bleibt aktiv — wer zurückklickt, schreibt an derselben Stelle weiter.
  // Ein Wechsel innerhalb des Blocks (Kind-Element) ist kein Verlassen.
  onBlockFocusout(block, event) {
    if (this.activePageId !== block.pageId) return;
    const to = event.relatedTarget;
    if (to && event.currentTarget.contains(to)) return;
    this._historyPushNow(block.pageId);
    if (block.dirty) this._enqueueSave(block.pageId);
  },

  async activateBlock(block) {
    if (this.activePageId === block.pageId) return;
    if (!this._canEdit()) return;
    const prevId = this.activePageId;
    if (prevId != null) {
      this._historyOnDeactivate(prevId);
      const prev = this._blockById(prevId);
      if (prev?.dirty) this._enqueueSave(prevId);
    }
    this.activePageId = block.pageId;
    this.$nextTick(() => {
      // Verlassener Block bekommt sein Bild zurück, der neue seinen Quelltext.
      // Reihenfolge: erst räumen, dann Caret setzen — das Entfernen des SVG
      // verschiebt die Höhe.
      if (prevId != null) {
        const prevEl = this.$root.querySelector(`[data-book-editor-page="${prevId}"]`);
        const prevBlock = this._blockById(prevId);
        if (prevEl && prevBlock) {
          this._syncBlockDiagrams(prevEl, prevBlock);
          this._syncBlockCaptionNumbers(prevEl, prevBlock);
        }
      }
      // $root, nicht $el: in einer aus @click gerufenen Methode zeigt $el auf
      // das auslösende Element (den Block-Body), $root auf die Karten-Wurzel.
      const el = this.$root.querySelector(`[data-book-editor-page="${block.pageId}"]`);
      if (!el) return;
      clearRenderedDiagrams(el);
      clearCaptionNumbers(el);
      this._historyOnActivate(block.pageId, el);
      el.focus({ preventScroll: true });
      const md = this._pendingMousedown?.pageId === block.pageId ? this._pendingMousedown : null;
      this._pendingMousedown = null;
      this._placeCaret(el, md);
    });
  },

  // Caret nach der Aktivierung setzen. Beim Mousedown war der Block noch
  // nicht editierbar — der Browser platziert also weder Fokus noch Caret
  // selbst, beides muss hier nachgeholt werden.
  //
  // Fallback ist Pflicht, nicht Kür: ohne Caret ist der Block zwar fokussiert,
  // aber Tastatureingaben laufen ins Leere (der User klickt, tippt, nichts
  // passiert). Das trifft jeden Klick, der kein Textnode erwischt — Padding,
  // Zeilenabstand, Rand — und Browser ohne caretRangeFromPoint.
  _placeCaret(el, md) {
    const sel = window.getSelection();
    if (!sel) return;
    try {
      const range = md && document.caretRangeFromPoint
        ? document.caretRangeFromPoint(md.x, md.y)
        : null;
      if (range && el.contains(range.startContainer)) {
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
    } catch { /* fällt unten auf den Blockanfang zurück */ }
    // Kein Treffer → Caret an den Anfang des ersten Kindblocks.
    try {
      const fallback = document.createRange();
      fallback.selectNodeContents(el.firstElementChild || el);
      fallback.collapse(true);
      sel.removeAllRanges();
      sel.addRange(fallback);
    } catch { /* noop */ }
  },

  // Nur der aktive Block: sein DOM gehört dem User. Ein inaktiver trägt
  // Anzeige-Artefakte (Mermaid-SVG, Nummern-Badges) — ein `input` dort (z.B.
  // natives Undo, das Chromium/WebKit auf eine verlassene Seite anwenden)
  // trüge sie sonst ins Manuskript.
  _onBlockInput(block, event) {
    if (this.activePageId !== block.pageId) return;
    block.html = event.currentTarget.innerHTML;
    this._markBlockDirty(block);
    // Restore-`input` des Verlaufs pusht nicht (Kern-Flag `applying`).
    this._historyPushSoon(block.pageId);
  },

  // Copy/Cut/Paste über einen Pfad — die drei unterscheiden sich nur im
  // Handler und darin, ob sie den Block-Inhalt verändern.
  onBlockClipboard(block, e, kind) {
    if (kind === 'copy') { handleEditorCopy(e); return; }
    if (this.activePageId !== block.pageId) return;
    // Eigener Undo-Schritt: Stand vor dem Einfügen/Ausschneiden sichern.
    this._historyPushNow(block.pageId);
    // execCommand triggert kein input-Event in allen Browsern → manuell.
    if (!CLIPBOARD_HANDLERS[kind](e)) return;
    block.html = e.currentTarget.innerHTML;
    this._markBlockDirty(block);
    this._historyPushNow(block.pageId);
  },

  // Shift+Enter = weicher Zeilenumbruch (<br>). Safari/WebKit splittet sonst
  // den Absatz in zwei <p>. execCommand('insertLineBreak') setzt cross-browser
  // konsistent ein <br> — gleicher Pfad wie Notebook-Editor.
  onBlockKeydown(block, event) {
    if (this._historyKeydown(event)) return;
    if (event.key === 'Enter' && event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      document.execCommand('insertLineBreak');
      // Wie beim Clipboard: nicht jeder Browser feuert danach `input`.
      block.html = event.currentTarget.innerHTML;
      this._markBlockDirty(block);
    }
  },
};
