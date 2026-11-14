// editorToolbarCard: was die Panels und Block-Dialoge des Notebook-Editors
// gemeinsam haben und dafür `this` braucht. Die reinen Helfer (Anker-Rechteck,
// Caret zurück, Block einsetzen, Picker-Tastatur) liegen in caret-panel.js.
//
//   • Position der caret-verankerten Panels (Link-Bar, Beleg-, Querverweis-
//     Picker) gegen das sichtbare Band (`visualViewport`), mit Flip, Klemmen und
//     `max-height` aus dem verbleibenden Platz; Nachziehen bei Scroll/Tastatur;
//     Schliessen, wenn der Anker aus dem Band scrollt (wie das Slash-Menü).
//   • `closeAllEditorPanels` — Edit-Modus verlassen oder Abschnitt gewechselt:
//     kein Panel überlebt mit einer Range in einem Dokument, das es nicht mehr gibt.
//   • Einfügen aus der Seiten-Toolbar (`insertFromPageToolbar`) an der letzten
//     Caret-Position im Editor.
//   • Block-Dialoge (Tabelle, Diagramm, Bild): Caret merken/zurück, Caret hinter
//     den eingefügten Block, Backdrop-Klick nur bei Druck UND Loslassen auf dem
//     Backdrop, Rückfrage vor dem Verwerfen ungespeicherter Eingaben.
//   • Slash-Menü: Gruppen für die Listbox-Semantik + Ansage des aktiven Eintrags.
//
// Nur Notebook (harte Regel „Editor-Spezifikation").

import { getEditEl, caretRangeIn, rangeAtEnd } from './_shared.js';
import { blockInsertTarget, panelAnchorRect, placeCaretInSlotAfter, restoreEditorRange } from './caret-panel.js';
import { computePopoverPos, viewportBand } from '../../../popover-anchor.js';

// Abstand Panel ↔ Bandrand für die Höhenrechnung und Untergrenze, unter der die
// Liste unbrauchbar wird (dann darf das Panel den Anker überlappen und scrollt).
const PANEL_EDGE = 12;
const PANEL_MIN_H = 160;
// Schätzung für den ersten Frame, solange das Panel noch `display:none` ist.
const PANEL_EST_W = 320;
const PANEL_EST_H = 240;

// Feldnamen je Panel — die drei teilen dieselbe Mechanik, nicht denselben State.
const CARET_PANELS = {
  link: { show: 'linkShow', range: '_linkRange', ref: 'linkPanel', x: 'linkX', y: 'linkY', maxH: 'linkMaxH', close: '_closeLink' },
  cite: { show: 'citeShow', range: '_citeRange', ref: 'citePanel', x: 'citeX', y: 'citeY', maxH: 'citeMaxH', close: '_closeCite' },
  xref: { show: 'xrefShow', range: '_xrefRange', ref: 'xrefPanel', x: 'xrefX', y: 'xrefY', maxH: 'xrefMaxH', close: '_closeXref' },
};

const DIALOG_REFS = { table: 'tableDlg', diagram: 'diagramDlg', image: 'imageDlg' };

export const panelMethods = {
  // ── Caret-Panels: Position ────────────────────────────────────────────────

  /** Panel an seiner (live) Range verankern. Ohne gerendertes Panel (erster
   *  Frame nach dem Öffnen) mit Schätzung; `_schedCaretPanelPosition` misst nach.
   *  `opening` (Öffnen und Neumessen nach Inhaltswechsel): der Anker darf
   *  ausserhalb des Bandes liegen (Seiten-Toolbar ohne Caret → Ende des
   *  Abschnitts); das Panel wird dann ins Band geklemmt statt sofort wieder
   *  geschlossen. Nur Scroll/Tastatur schliessen es. */
  _positionCaretPanel(kind, { opening = false } = {}) {
    const p = CARET_PANELS[kind];
    if (!p || !this[p.show]) return;
    const editEl = getEditEl();
    const range = this[p.range];
    if (!editEl || !range) return;
    const rect = panelAnchorRect(range, editEl);
    const band = viewportBand();
    // Anker ausserhalb des sichtbaren Bandes → schliessen statt am Rand parken.
    if (!opening && (rect.bottom < band.top || rect.top > band.top + band.height)) {
      this[p.close]();
      return;
    }
    const room = Math.max(rect.top - band.top, band.top + band.height - rect.bottom) - 2 * PANEL_EDGE;
    const maxH = Math.max(Math.min(PANEL_MIN_H, band.height - 2 * PANEL_EDGE), room);
    this[p.maxH] = maxH;
    const el = this.$refs?.[p.ref];
    // `max-height` vor dem Messen anwenden (Alpine schreibt denselben Wert im
    // nächsten Tick via `:style`).
    if (el) el.style.maxHeight = maxH + 'px';
    const measured = !!el?.offsetHeight;
    const w = measured ? el.offsetWidth : PANEL_EST_W;
    const h = measured ? el.offsetHeight : Math.min(PANEL_EST_H, maxH);
    const { top, left } = computePopoverPos(rect, w, h, { align: 'center', prefer: 'above', band });
    this[p.x] = left;
    this[p.y] = top;
  },

  /** Nachmessen, sobald der DOM den neuen Inhalt zeigt — per rAF, nicht
   *  `$nextTick` (verschachtelte x-for/x-show-Effekte, siehe slash.js). */
  _schedCaretPanelPosition(kind, opts) {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => this._positionCaretPanel(kind, opts));
    } else {
      this._positionCaretPanel(kind, opts);
    }
  },

  /** Öffnen: Schätzung sofort (kein Frame an alter Stelle), Messung danach. */
  _openCaretPanelAt(kind) {
    this._positionCaretPanel(kind, { opening: true });
    this._schedCaretPanelPosition(kind, { opening: true });
  },

  /** Scroll / visualViewport: alle offenen Panels nachziehen. */
  _repositionCaretPanels() {
    for (const kind of Object.keys(CARET_PANELS)) {
      if (this[CARET_PANELS[kind].show]) this._positionCaretPanel(kind);
    }
  },

  // ── Alles zu ──────────────────────────────────────────────────────────────

  /** Edit-Modus verlassen oder Abschnitt gewechselt. Schliesst ohne den Caret
   *  zurückzusetzen (es gibt keinen Editor mehr, in den er gehörte) und verwirft
   *  die gesicherten Ranges. Block-Dialoge gehen mit zu. */
  closeAllEditorPanels() {
    this.bubbleShow = false;
    this.msgBarShow = false;
    this.slashShow = false;
    this.slashQuery = '';
    this._slashBlock = null;
    this._slashLabels = null;
    this._slashFilterCache = null;
    if (this.linkShow || this._linkRange) this._closeLink({ restore: false });
    if (this.citeShow || this._citeRange) this._closeCite({ restore: false });
    if (this.xrefShow || this._xrefRange) this._closeXref({ restore: false });
    this._lastEditRange = null;
    this._dialogRange = null;
    this._dialogInserted = null;
    for (const ref of Object.values(DIALOG_REFS)) {
      const dlg = this.$refs?.[ref];
      if (dlg?.open) dlg.close();
    }
  },

  // ── Einfügen aus der Seiten-Toolbar ───────────────────────────────────────

  /** Range am Caret — oder, wenn die Selektion inzwischen woanders liegt (Klick
   *  in die Seitenleiste), an der zuletzt im Editor gesehenen Stelle; ohne beides
   *  am Ende. Fokussiert den Editor und setzt die Selektion dorthin, damit
   *  Pfade, die die Selektion lesen (Trennlinie), dieselbe Stelle treffen.
   *  Erst lesen, dann fokussieren: `focus()` auf ein contenteditable ohne
   *  Selektion darin setzt den Caret an den Anfang, und die gemerkte Stelle
   *  käme nie zum Zug. Eine gemerkte Range, deren Knoten inzwischen ersetzt
   *  wurde (Undo, Remote-Update), kollabiert auf den Editor-Container selbst —
   *  sie zählt nur, solange sie in einem Element darunter steht. */
  _editRangeForInsert(editEl) {
    const live = caretRangeIn(editEl);
    const last = this._lastEditRange;
    const usable = (r) => r?.startContainer?.isConnected && r.startContainer !== editEl
      && editEl.contains(r.startContainer);
    const range = live ? live.cloneRange()
      : usable(last) ? last.cloneRange()
        : rangeAtEnd(editEl);
    editEl.focus({ preventScroll: true });
    if (range) {
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range.cloneRange());
    }
    return range;
  },

  /** Einstieg der «Einfügen»-Gruppe der Seiten-Toolbar (Root-Scope →
   *  EVT.EDITOR_INSERT). Dieselben Wege wie das Slash-Menü, aber am Caret statt
   *  an einem leeren Trigger-Block. */
  insertFromPageToolbar(kind) {
    const app = window.__app;
    if (!app?.editMode || app.focusActive) return;
    const editEl = getEditEl();
    if (!editEl) return;
    if (kind === 'cite') { this.openCiteInput(); return; }
    if (kind === 'xref') { this.openXrefInput(); return; }
    const range = this._editRangeForInsert(editEl);
    if (kind === 'hr') { app.insertHorizontalRule?.(); return; }
    const target = blockInsertTarget(editEl, range);
    if (kind === 'table') this.openTableDialog(target.replace, { after: target.after });
    else if (kind === 'diagram') this.openDiagramDialog(target.replace, { after: target.after });
    else if (kind === 'image') this.insertImageAtCaret(target);
  },

  // ── Block-Dialoge ─────────────────────────────────────────────────────────

  /** Beim Öffnen: Caret merken und den Ausgangsstand für die Verwerfen-Rückfrage. */
  _beginDialog(kind) {
    const editEl = getEditEl();
    const live = editEl ? caretRangeIn(editEl) : null;
    this._dialogRange = live ? live.cloneRange() : this._lastEditRange;
    this._dialogInserted = null;
    this._dialogSnapshot = this._dialogStateOf(kind);
  },

  /** Beim Schliessen (aus dem `@close` des Dialogs): nach dem Einfügen in den
   *  Absatz hinter dem Block, sonst dorthin, wo der Caret vorher stand. */
  _endDialog() {
    const inserted = this._dialogInserted;
    const range = this._dialogRange;
    this._dialogInserted = null;
    this._dialogRange = null;
    this._dialogSnapshot = null;
    const app = window.__app;
    if (!app?.editMode || app.focusActive) return;
    if (inserted?.isConnected) placeCaretInSlotAfter(inserted);
    else restoreEditorRange(range, { force: true });
  },

  _dialogStateOf(kind) {
    if (kind === 'table') return JSON.stringify(this.tableModelState);
    if (kind === 'diagram') return this.diagramSource || '';
    if (kind === 'image') return JSON.stringify([this.imageAlt, this.imageCredit]);
    return '';
  },

  _dialogDirty(kind) {
    return this._dialogSnapshot != null && this._dialogStateOf(kind) !== this._dialogSnapshot;
  },

  /** Schliessen mit Rückfrage, wenn etwas eingegeben wurde. Für Backdrop und
   *  Esc — × und «Abbrechen» verwerfen ausdrücklich und fragen nicht. */
  async requestDialogClose(kind) {
    if (this._dialogDirty(kind)) {
      const app = window.__app;
      const ok = await app?.appConfirm?.({
        message: app.t('editor.dialog.discardConfirm'),
        confirmLabel: app.t('editor.dialog.discard'),
        danger: true,
      });
      if (!ok) return;
    }
    this.$refs?.[DIALOG_REFS[kind]]?.close();
  },

  // Backdrop: nur ein Klick, der auf dem Backdrop BEGANN und dort endete. Eine
  // Textauswahl im Dialog, die neben dem Dialog losgelassen wird, erzeugt ein
  // `click` mit dem Dialog als Ziel — das darf die Eingabe nicht verwerfen.
  onDialogBackdropDown(e) {
    this._dialogBackdropDown = e.target === e.currentTarget;
  },

  onDialogBackdropClick(e, kind) {
    const startedOnBackdrop = this._dialogBackdropDown;
    this._dialogBackdropDown = false;
    if (!startedOnBackdrop || e.target !== e.currentTarget) return;
    this.requestDialogClose(kind);
  },

  /** Esc im Dialog (`cancel`): mit Eingabe erst fragen. */
  onDialogCancel(e, kind) {
    if (!this._dialogDirty(kind)) return;
    e.preventDefault();
    this.requestDialogClose(kind);
  },

  // ── Slash-Menü: Semantik ──────────────────────────────────────────────────

  /** Treffer nach Gruppen — die Listbox enthält nur `role="group"` mit
   *  Optionen, keine losen Überschriften. `idx` ist der flache Index (slashIdx). */
  slashGroups() {
    const items = this.slashItems();
    if (this._slashGroupsCache?.src === items) return this._slashGroupsCache.groups;
    const groups = [];
    items.forEach((it, idx) => {
      if (it.showGroup || !groups.length) {
        groups.push({ key: it.group + ':' + idx, label: it.groupLabel, items: [] });
      }
      groups[groups.length - 1].items.push({ ...it, idx });
    });
    this._slashGroupsCache = { src: items, groups };
    return groups;
  },

  /** Ansage des aktiven Eintrags (aria-live). Der Fokus bleibt im
   *  contenteditable, ein `aria-activedescendant` am teleportierten Menü
   *  erreicht den Screenreader nicht. */
  slashActiveLabel() {
    if (!this.slashShow) return '';
    return this.slashItems()[this.slashIdx]?.label || '';
  },
};
