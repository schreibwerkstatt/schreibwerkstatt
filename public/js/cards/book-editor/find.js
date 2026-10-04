// Teil von bookEditorCard (Facade cards/book-editor-card.js): Find/Replace
// über den ganzen Manuskript-Stream via CSS Custom Highlights. Methoden in
// den Card-Scope gespreadet (gemeinsames `this`).
//
// Match-Suche, Offset-Rückmapping und Highlight-Registrierung kommen aus
// editor/shared/text-find.js (geteilt mit dem Notebook-Finder). Hier bleibt
// nur die Bucheditor-Eigenheit: N Block-Roots statt einem, Replace über
// Range-Mutation (statt execCommand) und die Anbindung an die Save-Queue.

import { collectMatches, collectTextNodes, createHighlightPair, rangeOf } from '../../editor/shared/text-find.js';
import { clearRenderedDiagrams } from '../../diagram/mermaid-view.js';
import { clearCaptionNumbers, XREF_NUM_SEL } from '../../xrefs/caption-preview.js';

const highlights = createHighlightPair('book-editor-find-match', 'book-editor-find-current');
export const clearHighlights = highlights.clear;

// Inaktive Blöcke tragen Anzeige-Artefakte im DOM: das gerenderte Mermaid-SVG
// und die Nummern-Badges der Beschriftungen. Beides ist nicht Manuskript —
// Treffer darin sind keine Treffer, und nichts davon darf über Replace in
// `block.html` landen. Bucheditor-lokal: der Notebook-Finder sucht nur im
// Edit-Modus, dort gibt es diese Artefakte nicht.
const ARTEFACT_SEL = `.mermaid-render, ${XREF_NUM_SEL}`;

export function isInRenderArtefact(node) {
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  return !!el?.closest?.(ARTEFACT_SEL);
}

// Treffer eines Blocks gegen die Artefakte abgleichen. Liefert den Treffer
// (ggf. mit verschobenem Start) oder null, wenn er Artefakt-Text abdeckt.
//
// Sonderfall Grenze: das Offset-Mapping des geteilten Kerns legt einen Treffer,
// der genau hinter einem Text-Node beginnt, an das ENDE dieses Nodes. Direkt
// hinter einem Nummern-Badge („Abb. 1: |Legende") hiesse das: Start im Badge.
// Ein solcher Start deckt kein Badge-Zeichen ab und wird auf den Anfang des
// nächsten Text-Nodes gezogen — sonst landete das eingefügte Replace-Wort im
// Badge und fiele mit ihm weg.
export function filterArtefactMatch(m, root) {
  if (!m?.startNode || !m?.endNode) return null;
  let { startNode, startOffset } = m;
  if (isInRenderArtefact(startNode) && startOffset >= (startNode.nodeValue || '').length) {
    const nodes = collectTextNodes(root);
    const next = nodes[nodes.indexOf(startNode) + 1];
    if (!next) return null;
    startNode = next;
    startOffset = 0;
  }
  if (isInRenderArtefact(startNode) || isInRenderArtefact(m.endNode)) return null;
  return startNode === m.startNode ? m : { ...m, startNode, startOffset };
}

// Manuskript-HTML eines Block-Containers ohne Anzeige-Artefakte. Liest aus
// einem Klon, damit das sichtbare Bild stehen bleibt.
export function cleanBlockHtml(container) {
  const clone = container.cloneNode(true);
  clearRenderedDiagrams(clone);
  clearCaptionNumbers(clone);
  return clone.innerHTML;
}

export const bookEditorFindMethods = {
    // ── Find / Replace ────────────────────────────────────────────────────
    openFind() {
      this.findOpen = true;
      this.$nextTick(() => {
        const inp = this.$root.querySelector('.book-editor-find-input');
        if (inp) { inp.focus(); inp.select(); }
        this.recomputeFindMatches();
      });
    },

    closeFind() {
      this.findOpen = false;
      this.findMatches = [];
      this.findIndex = -1;
      clearHighlights();
      if (this._findRecomputeTimer) { clearTimeout(this._findRecomputeTimer); this._findRecomputeTimer = null; }
    },

    onFindInput() {
      if (this._findRecomputeTimer) clearTimeout(this._findRecomputeTimer);
      this._findRecomputeTimer = setTimeout(() => {
        this._findRecomputeTimer = null;
        this.recomputeFindMatches();
        if (this.findMatches.length > 0) this._selectMatch(0);
      }, 120);
    },

    _allBlockEls() {
      return Array.from(this.$root.querySelectorAll('[data-book-editor-page]'));
    },

    // Treffer aller Blöcke in Stream-Reihenfolge; jeder Match trägt seine
    // Herkunft (pageId + Container) mit, damit Replace den Block wiederfindet.
    recomputeFindMatches() {
      const opts = { caseSensitive: this.findCaseSensitive, wholeWord: this.findWholeWord };
      const matches = [];
      if (this.findTerm) {
        for (const el of this._allBlockEls()) {
          const pageId = parseInt(el.dataset.bookEditorPage, 10);
          for (const raw of collectMatches(el, this.findTerm, opts)) {
            const m = filterArtefactMatch(raw, el);
            if (!m) continue;
            matches.push({ ...m, pageId, container: el });
          }
        }
      }
      this.findMatches = matches;
      this.findIndex = matches.length > 0 ? 0 : -1;
      this._refreshFindHighlights();
    },

    _refreshFindHighlights() {
      highlights.paint(this.findMatches, this.findIndex);
    },

    findNext() {
      if (this.findMatches.length === 0) this.recomputeFindMatches();
      if (this.findMatches.length === 0) return;
      this._selectMatch((this.findIndex + 1) % this.findMatches.length);
    },

    findPrev() {
      if (this.findMatches.length === 0) this.recomputeFindMatches();
      if (this.findMatches.length === 0) return;
      this._selectMatch((this.findIndex - 1 + this.findMatches.length) % this.findMatches.length);
    },

    _selectMatch(i) {
      this.findIndex = i;
      this._refreshFindHighlights();
      const m = this.findMatches[i];
      if (!m?.startNode) return;
      try {
        const rect = rangeOf(m).getBoundingClientRect();
        if (rect && (rect.top < 120 || rect.bottom > window.innerHeight - 120)) {
          (m.startNode.parentElement || m.container)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        }
      } catch { /* noop */ }
    },

    replaceCurrent() {
      if (!this._canEdit() || this.findMatches.length === 0) return;
      const m = this.findMatches[this.findIndex];
      if (!m?.startNode || !m?.endNode) return;
      // Treffer veraltet (seit der Suche im aktiven Block getippt): die Offsets
      // zeigen dann auf anderen Text, und Ersetzen träfe die falsche Stelle.
      // Neu suchen und den Klick nicht ausführen — der User sieht den
      // aktualisierten Treffer und bestätigt erneut.
      if (!this._matchStillValid(m)) {
        const at = this.findIndex;
        this.recomputeFindMatches();
        if (this.findMatches.length > 0) this._selectMatch(Math.min(at, this.findMatches.length - 1));
        return;
      }
      const touched = new Set();
      this._doReplaceAt(m, touched);
      this._resyncReplacedBlocks(touched);
      this.$nextTick(() => {
        this.recomputeFindMatches();
        if (this.findMatches.length > 0) {
          this._selectMatch(Math.min(this.findIndex, this.findMatches.length - 1));
        }
      });
    },

    _matchStillValid(m) {
      if (!m.startNode?.isConnected || !m.endNode?.isConnected) return false;
      try {
        const text = rangeOf(m).toString();
        return this.findCaseSensitive
          ? text === this.findTerm
          : text.toLowerCase() === this.findTerm.toLowerCase();
      } catch {
        return false;
      }
    },

    replaceAll() {
      if (!this._canEdit() || !this.findTerm) return;
      this.recomputeFindMatches();
      if (this.findMatches.length === 0) return;
      // Von hinten nach vorne: Ersetzungen weiter hinten lassen die Ranges der
      // früheren Treffer intakt (sonst verschieben sich deren Offsets).
      const matches = this.findMatches.slice().reverse();
      let count = 0;
      const touched = new Set();
      for (const m of matches) {
        if (this._doReplaceAt(m, touched)) count++;
      }
      this._resyncReplacedBlocks(touched);
      const app = window.__app;
      app?.setStatus?.(app.t('bookEditor.find.replacedAll', { n: count }), false, 3000);
      this.$nextTick(() => this.recomputeFindMatches());
    },

    _doReplaceAt(m, touched) {
      if (!m.startNode || !m.endNode) return false;
      const container = m.container || m.startNode.parentElement?.closest('[data-book-editor-page]');
      if (!container) return false;
      try {
        const block = this._blockById(parseInt(container.dataset.bookEditorPage, 10));
        const active = block && this.activePageId === block.pageId;
        // Replace ist ein eigener Undo-Schritt (cards/book-editor/history.js):
        // im aktiven Block Stand davor + danach, im inaktiven nur danach — sein
        // Stand davor ist die Spitze seines Verlaufs.
        if (active) this._historyPushNow(block.pageId);
        const range = rangeOf(m);
        range.deleteContents();
        range.insertNode(document.createTextNode(this.findReplace));
        if (block) {
          block.html = cleanBlockHtml(container);
          this._markBlockDirty(block);
          touched?.add(container);
          if (active) this._historyPushNow(block.pageId);
          else this._historyRecordInactive(block);
        }
        return true;
      } catch {
        return false;
      }
    },

    // Nach dem Replace Bild und Nummern der betroffenen Blöcke nachziehen —
    // der Quelltext eines Diagramms oder eine Beschriftung kann sich geändert
    // haben. Erst nach ALLEN Ersetzungen: das Neu-Stempeln entfernt Badges und
    // würde die Ranges der übrigen Treffer im selben Block verschieben.
    _resyncReplacedBlocks(touched) {
      for (const el of touched) {
        const block = this._blockById(parseInt(el.dataset.bookEditorPage, 10));
        if (!block) continue;
        this._syncBlockDiagrams(el, block);
        this._syncBlockCaptionNumbers(el, block);
      }
    },
};
