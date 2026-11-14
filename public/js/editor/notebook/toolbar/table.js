// Tabellen-Dialog des Notebook-Editors: ein Gitter aus Zellenfeldern plus
// Beschriftung und Spaltenausrichtung.
//
// Warum ein Dialog und keine bearbeitbare Tabelle im Manuskript: Chromium baeckt
// beim Verschmelzen von Zellen die berechneten CSS-Werte als Inline-`style` ein
// (dieselbe Ursache wie bei den Blockgrenzen von figure/blockquote/pre, siehe
// harte Regel „Loeschen an Blockgrenzen"), und `style` darf nach der Regel
// „Styles nur in public/css" nicht in die Persistenz. Dazu kaeme die
// Zell-Selektion, das Loeschen ueber Zellgrenzen und ein eigener Undo-Pfad. Der
// persistierte Block ist deshalb atomar (`contenteditable="false"`,
// markTablesAtomic) und wird ausschliesslich hier bearbeitet.
//
// Der Dialog gehoert zum Karten-Scope (editorToolbarCard), also `x-ref` +
// showModal() statt des `modal()`-Primitivs, und `@close` ist der EINZIGE
// Aufraeumpunkt — ESC, Backdrop und Abbrechen laufen alle durch `dlg.close()`.
// Caret merken/zurueck, Backdrop- und Esc-Rueckfrage: panel-methods.js
// (`_beginDialog`/`_endDialog`, `requestDialogClose`).
//
// EINGABE IST NOTEBOOK-ONLY (wie beim Diagramm). Focus-Editor und Bucheditor
// stellen Tabellen nur dar.

import { getEditEl } from '../../utils.js';
import {
  replaceBlockOutsideList, ensureSlotAfter, caretRangeIn, topLevelBlock,
  caretAtBlockStart, caretAtBlockEnd,
} from './_shared.js';
import { htmlToElement, placeBlockNode } from './caret-panel.js';
import { buildTableHtml, tableModel, emptyTableModel, isTableEl } from '../../../table/table-html.js';

// Startgroesse einer neuen Tabelle. Drei Spalten, weil zwei nach Liste aussehen
// und vier auf dem Handy nicht mehr lesbar sind; zwei Datenzeilen, damit die
// Kopfzeile als solche erkennbar ist.
const NEW_COLS = 3;
const NEW_ROWS = 2;

export const tableMethods = {
  /** Einfuegen: `block` ist der (leere) Trigger-Block aus dem Slash-Menue, der
   *  beim Bestaetigen ersetzt wird; `after` der Top-Level-Block, hinter dem die
   *  Tabelle landet (Seiten-Toolbar am Caret in einem nicht leeren Absatz). */
  openTableDialog(block, { after = null } = {}) {
    this._tableBlock = block || null;
    this._tableAfter = after || null;
    this._tableEditEl = null;
    this.tableEditing = false;
    this.tableLossyReasons = [];
    this._tableHeaderStash = null;
    this.tableModelState = emptyTableModel(NEW_COLS, NEW_ROWS);
    this._tableResetIds();
    this._openTableDlg();
  },

  /** Bearbeiten: `el` ist eine bestehende `<table>` im Manuskript. */
  openTableForEl(el) {
    if (!el) return;
    this._tableBlock = null;
    this._tableAfter = null;
    this._tableEditEl = el;
    this.tableEditing = true;
    this._tableHeaderStash = null;
    const m = tableModel(el);
    if (!m.header && !m.rows.length) {
      // Kein einziges `<tr>`: nichts zu zeigen, also das Startgitter.
      this.tableModelState = { ...emptyTableModel(NEW_COLS, NEW_ROWS), caption: m.caption };
    } else {
      // Eine Tabelle, die nur aus der Kopfzeile besteht, bekommt eine leere
      // Datenzeile dazu — der Dialog braucht mindestens eine, und ein
      // Startgitter an ihrer Stelle wuerde den Kopf beim Speichern ueberschreiben.
      if (!m.rows.length) m.rows.push(Array.from({ length: m.align.length }, () => this._blankCell()));
      // Eine Tabelle ohne Kopfzeile (Import-Markup) bekommt keine aufgezwungen —
      // sonst wuerde die erste Datenzeile zur Ueberschrift.
      this.tableModelState = m;
    }
    // Verlustbehaftete Faelle VOR dem Speichern ansagen, mit Grund. Der Dialog
    // kann sie nicht darstellen; wer hier uebernimmt, planiert sie. Das soll
    // eine Entscheidung sein, keine Ueberraschung.
    this.tableLossyReasons = m.lossyReasons || [];
    this._tableResetIds();
    this._openTableDlg();
  },

  _openTableDlg() {
    const dlg = this.$refs?.tableDlg;
    if (!dlg) return;
    this._beginDialog('table');
    if (!dlg.open) dlg.showModal();
    // Fokus in die erste Zelle: der Inhalt ist das, was man hier tippt; die
    // Beschriftung ist optional und steht ein Tab davor.
    this.tableFocusFirstCell();
  },

  closeTableDialog() {
    this.$refs?.tableDlg?.close();
  },

  /** Einziger Aufraeumpunkt (siehe Modulkopf). */
  onTableDialogClose() {
    this._tableBlock = null;
    this._tableAfter = null;
    this._tableEditEl = null;
    this.tableEditing = false;
    this.tableLossyReasons = [];
    this._tableHeaderStash = null;
    this.tableModelState = emptyTableModel(NEW_COLS, NEW_ROWS);
    this._tableResetIds();
    this.closeActionMenu?.();
    this._endDialog();
  },

  /** Klartext-Gruende fuer die Verlust-Warnung. */
  tableLossyLabels() {
    const app = window.__app;
    return (this.tableLossyReasons || []).map(r => app?.t?.('editor.table.lossyReason.' + r) || r);
  },

  /** Ist die Tabelle leer? Beschriftung allein zaehlt nicht — eine Beschriftung
   *  ohne Tabelle ist keine Tabelle. */
  tableIsEmpty() {
    const m = this.tableModelState;
    if (!m) return true;
    const cells = [...(m.header || []), ...m.rows.flat()];
    return !cells.some(c => String(c?.text || '').trim() || (c?.rich && c?.html));
  },

  // ── Uebernehmen / Entfernen ───────────────────────────────────────────────

  /** Uebernehmen. Eine leere Tabelle wird verworfen statt eingefuegt — sie
   *  waere im Manuskript ein Rahmen ohne Inhalt, und der Weg zurueck fuehrt
   *  wieder durch diesen Dialog. */
  applyTable() {
    if (this.tableIsEmpty()) { this.closeTableDialog(); return; }
    // Nichts geaendert: nichts schreiben. Neu gebaut wuerde eine importierte
    // Tabelle planiert (verbundene Zellen, Zeilenkoepfe, Absaetze in Zellen —
    // `tableLossyReasons`), nur weil jemand den Dialog per Klick geoeffnet
    // und mit «Speichern» wieder geschlossen hat.
    if (this.tableEditing && !this._dialogDirty('table')) { this.closeTableDialog(); return; }

    const editEl = getEditEl();
    if (!editEl) { this.closeTableDialog(); return; }

    const node = htmlToElement(buildTableHtml(this.tableModelState));
    if (!node) { this.closeTableDialog(); return; }
    node.setAttribute('contenteditable', 'false');
    // Block-ID mitnehmen: an ihr haengen Querverweise (`data-xref="table"`)
    // und der Block-Merge. `buildTableHtml` vergibt bewusst keine — ohne
    // Uebernahme vergaebe ensureBlockIds beim Speichern eine neue, und jeder
    // Verweis auf diese Tabelle liefe ins Leere.
    const bid = this._tableEditEl?.getAttribute?.('data-bid');
    if (bid) node.setAttribute('data-bid', bid);

    const edited = this._tableEditEl;
    if (edited && edited.isConnected && edited.parentNode && editEl.contains(edited)) {
      replaceBlockOutsideList(editEl, edited, node);
    } else {
      placeBlockNode(editEl, node, { replace: this._tableBlock, after: this._tableAfter });
    }
    ensureSlotAfter(node);
    // Caret beim Schliessen in den Absatz dahinter (`_endDialog`).
    this._dialogInserted = node;
    window.__app?._markEditDirty?.();
    this.closeTableDialog();
  },

  /** Tabelle loeschen (nur im Bearbeiten-Modus sichtbar). Der Block ist atomar,
   *  ohne diesen Weg gaebe es keinen verlaesslichen. Mit Rueckfrage: eine
   *  Datentabelle ist teurer als ein Diagramm oder Bild, und der Knopf steht
   *  im selben Fuss wie «Speichern». Undo bleibt zusaetzlich. */
  async removeTable() {
    const app = window.__app;
    const ok = await app?.appConfirm?.({
      message: app.t('editor.table.removeConfirm'),
      confirmLabel: app.t('editor.table.remove'),
      danger: true,
    });
    if (!ok) return;
    const el = this._tableEditEl;
    if (el?.isConnected) {
      el.remove();
      window.__app?._markEditDirty?.();
    }
    this.closeTableDialog();
  },

  // ── Tastatur-Zugang ───────────────────────────────────────────────────────

  /** Alt+Enter neben einer Tabelle oeffnet ihren Dialog. Die Tabelle ist
   *  atomar und nimmt nie den Caret auf; ohne diesen Griff kaeme man nur per
   *  Maus hinein. «Neben» heisst: Caret am Anfang des Absatzes direkt dahinter
   *  oder am Ende des Absatzes direkt davor; ein leerer Absatz zwischen zwei
   *  Tabellen meint die davor. Nur Notebook (Dispatcher prueft focusActive). */
  _kbTableEdit(e) {
    if (e.key !== 'Enter' || !e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return false;
    const editEl = getEditEl();
    const range = editEl ? caretRangeIn(editEl) : null;
    if (!range?.collapsed) return false;
    const block = topLevelBlock(range.startContainer, editEl);
    if (!block || block === editEl || block.parentNode !== editEl) return false;
    const prev = block.previousElementSibling;
    const next = block.nextElementSibling;
    let table = null;
    if (isTableEl(prev) && caretAtBlockStart(range, block)) table = prev;
    else if (isTableEl(next) && caretAtBlockEnd(range, block)) table = next;
    if (!table) return false;
    e.preventDefault();
    this.openTableForEl(table);
    return true;
  },
};
