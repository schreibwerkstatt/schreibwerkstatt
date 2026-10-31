// Teil von bookEditorCard (Facade cards/book-editor-card.js): Find/Replace
// über den ganzen Manuskript-Stream via CSS Custom Highlights. Methoden in
// den Card-Scope gespreadet (gemeinsames `this`).
//
// Match-Suche, Offset-Rückmapping und Highlight-Registrierung kommen aus
// editor/shared/text-find.js (geteilt mit dem Notebook-Finder). Hier bleibt
// nur die Bucheditor-Eigenheit: N Block-Roots statt einem, Replace über
// Range-Mutation (statt execCommand) und die Anbindung an die Save-Queue.

import { collectMatches, collectTextNodes, createHighlightPair, rangeOf, matchStillValid } from '../../editor/shared/text-find.js';
import { clearRenderedDiagrams, RENDERED_DIAGRAM_SEL } from '../../diagram/mermaid-view.js';
import { clearCaptionNumbers, XREF_NUM_SEL } from '../../xrefs/caption-preview.js';

const highlights = createHighlightPair('book-editor-find-match', 'book-editor-find-current');
export const clearHighlights = highlights.clear;

// Inaktive Blöcke tragen Anzeige-Artefakte im DOM: das gerenderte Mermaid-SVG
// und die Nummern-Badges der Beschriftungen. Beides ist nicht Manuskript —
// Treffer darin sind keine Treffer, und nichts davon darf über Replace in
// `block.html` landen. Dazu der Diagramm-Quelltext, solange sein Bild steht:
// er ist dann ausgeblendet, ein Treffer darin zählte mit, wäre aber weder zu
// sehen noch anzuspringen. Im aktiven Block steht der Quelltext offen und wird
// gefunden. Bucheditor-lokal: der Notebook-Finder sucht nur im Edit-Modus,
// dort gibt es diese Artefakte nicht.
const ARTEFACT_SEL = `${RENDERED_DIAGRAM_SEL}, ${XREF_NUM_SEL}`;

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
      // Caret merken, bevor das Suchfeld den Fokus nimmt: die Suche beginnt
      // dort, nicht am Buchanfang.
      this._captureFindAnchor();
      this.findOpen = true;
      this.$nextTick(() => {
        const inp = this.$root.querySelector('.book-editor-find-input');
        if (inp) { inp.focus(); inp.select(); }
        this.recomputeFindMatches();
        if (this.findMatches.length > 0) {
          this.findIndex = this._nearestMatchIndex();
          this._refreshFindHighlights();
        }
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
        if (this.findMatches.length > 0) this._selectMatch(this._nearestMatchIndex());
      }, 120);
    },

    _captureFindAnchor() {
      this._findAnchor = null;
      const el = this.activePageId != null ? this._blockEl(this.activePageId) : null;
      const sel = window.getSelection?.();
      if (el && sel?.rangeCount && el.contains(sel.anchorNode)) {
        this._findAnchor = { pageId: this.activePageId, range: sel.getRangeAt(0).cloneRange() };
      }
    },

    // Erster Treffer ab der Stelle, an der der User steht: Caret im aktiven
    // Block (beim Öffnen gemerkt), sonst der aktive bzw. sichtbare Abschnitt.
    // Dahinter nichts mehr → von vorn (wie findNext am Ende).
    _nearestMatchIndex() {
      const ms = this.findMatches;
      if (!ms.length) return -1;
      const order = new Map();
      let i = 0;
      for (const b of this.blocks) if (b.kind === 'page') order.set(b.pageId, i++);
      const a = this._findAnchor?.range?.startContainer?.isConnected ? this._findAnchor : null;
      const pageId = a ? a.pageId : (this.activePageId ?? this.visiblePageId);
      if (pageId == null) return 0;
      const at = order.get(pageId) ?? 0;
      for (let k = 0; k < ms.length; k++) {
        const o = order.get(ms[k].pageId) ?? 0;
        if (o < at) continue;
        if (o > at || !a) return k;
        try {
          if (rangeOf(ms[k]).compareBoundaryPoints(Range.START_TO_START, a.range) >= 0) return k;
        } catch { return k; }
      }
      return 0;
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
      // Eigener Undo-Schritt: im aktiven Block den Stand davor sichern, der
      // Stand danach kommt aus _commitReplaced.
      if (m.pageId === this.activePageId) this._historyPushNow(m.pageId);
      const container = this._doReplaceAt(m);
      if (container) this._commitReplaced(new Set([container]));
      this.$nextTick(() => {
        this.recomputeFindMatches();
        if (this.findMatches.length > 0) {
          this._selectMatch(Math.min(this.findIndex, this.findMatches.length - 1));
        }
      });
    },

    _matchStillValid(m) {
      return matchStillValid(m, this.findTerm, this.findCaseSensitive);
    },

    replaceAll() {
      if (!this._canEdit() || !this.findTerm) return;
      this.recomputeFindMatches();
      if (this.findMatches.length === 0) return;
      // Von hinten nach vorne: Ersetzungen weiter hinten lassen die Ranges der
      // früheren Treffer intakt (sonst verschieben sich deren Offsets).
      const matches = this.findMatches.slice().reverse();
      // EIN Undo-Schritt je Abschnitt, nicht je Treffer: sonst bräuchte das
      // Zurücknehmen so viele Strg+Z wie Treffer, und ein grosses Ersetzen
      // verdrängte den ganzen Verlauf (Deckel im Kern).
      if (matches.some(m => m.pageId === this.activePageId)) this._historyPushNow(this.activePageId);
      let count = 0;
      const touched = new Set();
      for (const m of matches) {
        const container = this._doReplaceAt(m);
        if (container) { touched.add(container); count++; }
      }
      this._commitReplaced(touched);
      const app = window.__app;
      app?.setStatus?.(app.t('bookEditor.find.replacedAll', { n: count }), false, 3000);
      this.$nextTick(() => this.recomputeFindMatches());
    },

    // Nur die DOM-Ersetzung; liefert den Block-Container oder null. Was daraus
    // folgt (block.html, dirty, Undo, Anzeige), erledigt _commitReplaced —
    // einmal je Abschnitt nach ALLEN Ersetzungen.
    _doReplaceAt(m) {
      if (!m.startNode || !m.endNode) return null;
      const container = m.container || m.startNode.parentElement?.closest('[data-book-editor-page]');
      if (!container) return null;
      try {
        const range = rangeOf(m);
        range.deleteContents();
        range.insertNode(document.createTextNode(this.findReplace));
        return container;
      } catch {
        return null;
      }
    },

    // Je betroffenem Abschnitt: `block.html` aus dem DOM (ohne Artefakte),
    // dirty + Autosave, ein Undo-Schritt (aktiv: Stand danach; inaktiv: aus
    // `block.html`, sein Stand davor ist die Spitze seines Verlaufs), dann Bild
    // und Nummern nachziehen — der Quelltext eines Diagramms oder eine
    // Beschriftung kann sich geändert haben. Erst nach allen Ersetzungen: das
    // Neu-Stempeln entfernt Badges und verschöbe die Ranges der übrigen Treffer.
    _commitReplaced(touched) {
      for (const el of touched) {
        const block = this._blockById(parseInt(el.dataset.bookEditorPage, 10));
        if (!block) continue;
        block.html = cleanBlockHtml(el);
        this._markBlockDirty(block);
        if (this.activePageId === block.pageId) this._historyPushNow(block.pageId);
        else this._historyRecordInactive(block);
        this._syncBlockDiagrams(el, block);
        this._syncBlockCaptionNumbers(el, block);
      }
    },
};
