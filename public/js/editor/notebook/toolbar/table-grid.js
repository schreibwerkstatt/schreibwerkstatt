// Gitter des Tabellen-Dialogs (Notebook-Editor): Struktur-Operationen,
// Zellen, Ausrichtung, Tastatur und Mehrfach-Einfuegen. Dialog-Lebenszyklus,
// Uebernehmen und Entfernen: table.js. Beide werden in editorToolbarCard
// gespreadet (toolbar.js).
//
// STABILE SCHLUESSEL. Zeilen und Spalten des Modells sind blosse Arrays; die
// `x-for`-Schluessel kommen aus zwei parallelen Listen (`tableRowIds`,
// `tableColIds`), die jede Operation im selben Schritt mitfuehrt. Ein Index als
// Schluessel liesse beim Loeschen/Verschieben einer Zeile in der Mitte die
// vorhandenen Eingabefelder neue Daten bekommen — Fokus, Auswahl und die
// LanguageTool-Huelle eines Feldes blieben an der falschen Zelle haengen.
// Die Listen stehen bewusst NICHT im Modell: der Dirty-Vergleich
// (panel-methods.js#_dialogStateOf) serialisiert das Modell.
//
// ZELL-ADRESSE im Template: `data-cell="r:c"`, die Kopfzeile ist r = -1.

import {
  TABLE_ALIGNS, TABLE_MAX_COLS, TABLE_MAX_ROWS,
} from '../../../table/table-html.js';
import { isImeComposing } from '../../../utils/keys.js';

let _seq = 0;
const nextId = () => `t${++_seq}`;

// Icon je Ausrichtung (icons.svg), ausgeschrieben — das Sprite-Gate prueft
// nur statische Namen.
const ALIGN_ICONS = { left: 'align-left', center: 'align-center', right: 'align-right' };

const blankCell = () => ({ html: '', text: '', align: null, rich: false });

/** Element `i` um `dir` (−1/+1) verschieben; false, wenn es am Rand steht. */
function moveIn(arr, i, dir) {
  const j = i + dir;
  if (!arr || i < 0 || j < 0 || i >= arr.length || j >= arr.length) return false;
  const [x] = arr.splice(i, 1);
  arr.splice(j, 0, x);
  return true;
}

/** Tabulator-getrennter Text (Excel, Sheets, Numbers) als Zeilen × Zellen.
 *  Versteht die Anfuehrungszeichen, mit denen Excel Zellen mit Zeilenumbruch
 *  oder Tab einschliesst (`""` = ein Anfuehrungszeichen). Ein Umbruch IN einer
 *  Zelle wird zum Leerzeichen — das Feld ist einzeilig. Eine abschliessende
 *  Leerzeile (Excel haengt eine an) faellt weg. */
export function parseTsv(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let atCellStart = true;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; continue; }
      if (ch === '"') { quoted = false; continue; }
      cell += ch === '\n' || ch === '\t' ? ' ' : ch;
      continue;
    }
    if (ch === '"' && atCellStart) { quoted = true; atCellStart = false; continue; }
    if (ch === '\t') { row.push(cell); cell = ''; atCellStart = true; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; atCellStart = true; continue; }
    cell += ch;
    atCellStart = false;
  }
  row.push(cell);
  rows.push(row);
  while (rows.length && rows[rows.length - 1].every(c => c === '')) rows.pop();
  return rows.map(r => r.map(c => c.replace(/\s+/g, ' ').trim()));
}

export const tableGridMethods = {
  // ── Schluessel ────────────────────────────────────────────────────────────

  /** Schluessel-Listen neu aufsetzen, passend zum aktuellen Modell. */
  _tableResetIds() {
    const m = this.tableModelState;
    this.tableRowIds = (m?.rows || []).map(nextId);
    this.tableColIds = (m?.align || []).map(nextId);
  },

  // ── Struktur ──────────────────────────────────────────────────────────────

  tableCols() {
    return this.tableModelState?.align?.length || 0;
  },

  tableCanAddCol() { return this.tableCols() < TABLE_MAX_COLS; },
  tableCanAddRow() { return (this.tableModelState?.rows?.length || 0) < TABLE_MAX_ROWS; },
  tableCanRemoveCol() { return this.tableCols() > 1; },
  tableCanRemoveRow() { return (this.tableModelState?.rows?.length || 0) > 1; },

  _blankCell() {
    return blankCell();
  },

  /** Leere Spalte an Position `at` (Default: rechts anhaengen). */
  tableInsertCol(at = this.tableCols()) {
    const m = this.tableModelState;
    if (!m || !this.tableCanAddCol()) return;
    const i = Math.max(0, Math.min(at, this.tableCols()));
    m.align.splice(i, 0, 'left');
    if (m.header) m.header.splice(i, 0, blankCell());
    if (this._tableHeaderStash) this._tableHeaderStash.splice(i, 0, blankCell());
    for (const r of m.rows) r.splice(i, 0, blankCell());
    this.tableColIds.splice(i, 0, nextId());
  },

  tableAddCol() { this.tableInsertCol(); },

  tableRemoveCol(i) {
    const m = this.tableModelState;
    if (!m || !this.tableCanRemoveCol()) return;
    m.align.splice(i, 1);
    if (m.header) m.header.splice(i, 1);
    if (this._tableHeaderStash) this._tableHeaderStash.splice(i, 1);
    for (const r of m.rows) r.splice(i, 1);
    this.tableColIds.splice(i, 1);
  },

  /** Spalte `i` nach links (−1) oder rechts (+1). Ausrichtung, Kopf, Stash und
   *  jede Zeile wandern mit — sonst stuende der Kopf ueber fremden Daten. */
  tableMoveCol(i, dir) {
    const m = this.tableModelState;
    if (!m || !moveIn(m.align, i, dir)) return;
    if (m.header) moveIn(m.header, i, dir);
    if (this._tableHeaderStash) moveIn(this._tableHeaderStash, i, dir);
    for (const r of m.rows) moveIn(r, i, dir);
    moveIn(this.tableColIds, i, dir);
  },

  /** Leere Zeile an Position `at` (Default: unten anhaengen). */
  tableInsertRow(at = this.tableModelState?.rows?.length || 0) {
    const m = this.tableModelState;
    if (!m || !this.tableCanAddRow()) return;
    const i = Math.max(0, Math.min(at, m.rows.length));
    m.rows.splice(i, 0, Array.from({ length: this.tableCols() }, blankCell));
    this.tableRowIds.splice(i, 0, nextId());
  },

  tableAddRow() { this.tableInsertRow(); },

  tableRemoveRow(i) {
    const m = this.tableModelState;
    if (!m || !this.tableCanRemoveRow()) return;
    m.rows.splice(i, 1);
    this.tableRowIds.splice(i, 1);
  },

  tableMoveRow(i, dir) {
    const m = this.tableModelState;
    if (!m || !moveIn(m.rows, i, dir)) return;
    moveIn(this.tableRowIds, i, dir);
  },

  /** Kopfzeile an-/abschalten. Beim Abschalten wandert sie NICHT in die Daten —
   *  wer den Kopf entfernt, will ihn weg; ihn als Datenzeile weiterzuschleppen
   *  waere eine Ueberraschung. Bis zum Schliessen des Dialogs liegt sie aber
   *  im Stash: wer sie wieder einschaltet, bekommt seinen Inhalt zurueck.
   *  Spalten-Operationen halten den Stash mit dem Gitter in Takt. */
  tableToggleHeader() {
    const m = this.tableModelState;
    if (!m) return;
    if (m.header) {
      this._tableHeaderStash = m.header;
      m.header = null;
      return;
    }
    const stash = this._tableHeaderStash;
    this._tableHeaderStash = null;
    m.header = stash && stash.length === this.tableCols()
      ? stash
      : Array.from({ length: this.tableCols() }, blankCell);
  },

  tableHasHeader() {
    return !!this.tableModelState?.header;
  },

  // ── Zellen + Ausrichtung ──────────────────────────────────────────────────

  /** Zelltext setzen. `rich` faellt dabei auf false: wer den Text aendert,
   *  ersetzt die Auszeichnung der Zelle (SSoT-Regel in table-html.js). Eine
   *  unangetastete Zelle behaelt ihr `html`. */
  tableSetCell(cell, value) {
    if (!cell) return;
    const next = String(value ?? '');
    if (next === cell.text) return;
    cell.text = next;
    cell.rich = false;
    cell.html = '';
  },

  tableSetAlign(i, align) {
    const m = this.tableModelState;
    if (!m || !TABLE_ALIGNS.includes(align)) return;
    m.align[i] = align;
  },

  /** Beschriftung traegt noch ihre Auszeichnung (Beleg, Querverweis, kursiv …)
   *  — gleiche Regel wie `buildTableHtml`: solange der Text unveraendert ist. */
  tableCaptionRich() {
    const m = this.tableModelState;
    if (!m?.captionHtml) return false;
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    return !!norm(m.caption) && norm(m.caption) === norm(m.captionText);
  },

  /** Traegt irgendeine Zelle oder die Beschriftung Auszeichnung, die eine
   *  Textaenderung ersetzen wuerde? Steuert den Hinweis im Dialog. */
  tableHasRichCells() {
    const m = this.tableModelState;
    if (!m) return false;
    return this.tableCaptionRich()
      || [...(m.header || []), ...m.rows.flat()].some(c => c?.rich && c?.html);
  },

  /** Ausrichtungs-Optionen mit Icon (ALIGN_ICONS). */
  tableAlignOptions() {
    const app = window.__app;
    return TABLE_ALIGNS.map(a => ({ value: a, icon: ALIGN_ICONS[a], label: app?.t?.('editor.table.align.' + a) || a }));
  },

  // ── Fokus + Tastatur ──────────────────────────────────────────────────────

  _tableCellInput(r, c) {
    return this.$refs?.tableDlg?.querySelector(`[data-cell="${r}:${c}"]`) || null;
  },

  /** Zelle fokussieren. `now`: die Zelle steht schon im DOM (reiner
   *  Zellwechsel) — sofort, denn Alpines `$nextTick` laeuft ueber `setTimeout`,
   *  und ein schnelles zweites Enter kaeme sonst noch im alten Feld an. Nach
   *  einer Strukturaenderung erst nach dem Render. */
  tableFocusCell(r, c, { now = false } = {}) {
    const focus = () => this._tableCellInput(r, c)?.focus();
    if (now) focus();
    else this.$nextTick(focus);
  },

  /** Erste Zelle: Kopf, wenn es einen gibt, sonst die erste Datenzeile. */
  tableFocusFirstCell() {
    this.tableFocusCell(this.tableHasHeader() ? -1 : 0, 0);
  },

  /** Tastatur im Gitter (delegiert am Gitter-Container):
   *    Enter / Umschalt+Enter → gleiche Spalte, naechste / vorige Zeile;
   *      Enter in der letzten Zeile legt eine neue an.
   *    Tab in der letzten Zelle → neue Zeile, Fokus in ihre erste Zelle.
   *    ↑ / ↓ → Zeile wechseln; ← / → am Feldrand → Nachbarzelle.
   *  Waehrend einer IME-Komposition gehoert jede Taste dem Feld. */
  onTableGridKeydown(e) {
    const input = e.target;
    const addr = input?.dataset?.cell;
    if (!addr || isImeComposing(e)) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const [r, c] = addr.split(':').map(Number);
    const rows = this.tableModelState?.rows?.length || 0;
    const cols = this.tableCols();
    const top = this.tableHasHeader() ? -1 : 0;
    const go = (nr, nc) => { e.preventDefault(); this.tableFocusCell(nr, nc, { now: true }); };

    if (e.key === 'Enter') {
      if (e.shiftKey) { if (r > top) go(r - 1, c); else e.preventDefault(); return; }
      if (r < rows - 1) { go(r + 1, c); return; }
      e.preventDefault();
      if (!this.tableCanAddRow()) return;
      this.tableInsertRow();
      this.tableFocusCell(r + 1, c);
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey && r === rows - 1 && c === cols - 1) {
      if (!this.tableCanAddRow()) return;
      e.preventDefault();
      this.tableInsertRow();
      this.tableFocusCell(r + 1, 0);
      return;
    }
    if (e.shiftKey) return;
    if (e.key === 'ArrowUp' && r > top) { go(r - 1, c); return; }
    if (e.key === 'ArrowDown' && r < rows - 1) { go(r + 1, c); return; }
    const collapsed = input.selectionStart === input.selectionEnd;
    if (e.key === 'ArrowLeft' && collapsed && input.selectionStart === 0 && c > 0) {
      go(r, c - 1);
      return;
    }
    if (e.key === 'ArrowRight' && collapsed && input.selectionEnd === input.value.length && c < cols - 1) {
      go(r, c + 1);
    }
  },

  /** Einfuegen in eine Zelle: Text mit Tab oder Zeilenumbruch (aus einer
   *  Tabellenkalkulation kopiert) verteilt sich ab dieser Zelle ueber das
   *  Gitter; fehlende Zeilen und Spalten kommen dazu, bis zum Deckel. Eine
   *  einzelne Zeile ohne Tab bleibt das normale Einfuegen ins Feld. */
  onTableGridPaste(e) {
    const addr = e.target?.dataset?.cell;
    if (!addr) return;
    const text = e.clipboardData?.getData('text/plain') || '';
    if (!/[\t\n]/.test(text.replace(/\r?\n$/, ''))) return;
    const grid = parseTsv(text);
    if (!grid.length) return;
    e.preventDefault();
    const m = this.tableModelState;
    const [r0, c0] = addr.split(':').map(Number);
    const widest = Math.max(...grid.map(row => row.length));
    while (this.tableCols() < c0 + widest && this.tableCanAddCol()) this.tableInsertCol();
    const lastRow = r0 + grid.length - 1;
    while (m.rows.length - 1 < lastRow && this.tableCanAddRow()) this.tableInsertRow();
    grid.forEach((line, i) => {
      const r = r0 + i;
      const target = r === -1 ? m.header : m.rows[r];
      if (!target) return;
      line.forEach((val, j) => this.tableSetCell(target[c0 + j], val));
    });
    // Eingabefelder binden `:value` — das Feld mit dem Fokus zeigt den neuen
    // Wert erst nach dem Render.
    this.tableFocusCell(r0, c0);
  },

  // ── Aktionsmenue an Zeilen-/Spaltenkopf ───────────────────────────────────

  /** `actionMenuTarget` des Gitters: `{ kind: 'row'|'col', id }`. Der Index
   *  wird beim Klick aus der Schluessel-Liste gelesen — das Menue bleibt
   *  richtig, auch wenn sich das Gitter zwischen Oeffnen und Klick aendert. */
  tableMenuIndex() {
    const t = this.actionMenuTarget;
    if (!t) return -1;
    return (t.kind === 'row' ? this.tableRowIds : this.tableColIds).indexOf(t.id);
  },

  tableMenuKind() {
    return this.actionMenuTarget?.kind || null;
  },

  tableMenuCanMove(dir) {
    const i = this.tableMenuIndex();
    if (i < 0) return false;
    const n = this.tableMenuKind() === 'row' ? (this.tableModelState?.rows?.length || 0) : this.tableCols();
    return i + dir >= 0 && i + dir < n;
  },

  /** Ein Menue-Eintrag: `op` ∈ insertBefore, insertAfter, moveBack, moveFwd, remove. */
  tableMenuRun(op) {
    const i = this.tableMenuIndex();
    if (i < 0) return;
    const row = this.tableMenuKind() === 'row';
    const ops = row
      ? { insertBefore: () => this.tableInsertRow(i), insertAfter: () => this.tableInsertRow(i + 1),
          moveBack: () => this.tableMoveRow(i, -1), moveFwd: () => this.tableMoveRow(i, 1),
          remove: () => this.tableRemoveRow(i) }
      : { insertBefore: () => this.tableInsertCol(i), insertAfter: () => this.tableInsertCol(i + 1),
          moveBack: () => this.tableMoveCol(i, -1), moveFwd: () => this.tableMoveCol(i, 1),
          remove: () => this.tableRemoveCol(i) };
    ops[op]?.();
  },
};
