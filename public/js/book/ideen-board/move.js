// Zuordnen / Verschieben einer Idee im Ideen-Board: Picker-Popover und das
// Pruef-Praedikat fuer den Drag quer zur Bahn. Gespreadet in ideenBoardActions
// (actions.js); `this` = die ideenBoardCard-Instanz.

import { IDEE_OPEN_STATUSES, ideeStatus, ideeLaneKey, isOpenIdee, isBookIdee, LANE_BOOK } from '../ideen-shared.js';

export const ideenBoardMove = {
  // ── Zuordnen / Verschieben (Idee → Kapitel/Abschnitt/Buch) ───────────────
  // Nur solange offen (der Server lehnt den Move einer abgeschlossenen Idee ab,
  // IDEE_CLOSED). Drei Wege, ein Schreibpfad (`_reanchorIdee`): der Picker hier,
  // der Drag in eine andere Bahn des Boards (auch die Buch-Bahn) und der Drop
  // auf einen Eintrag im Inhaltsverzeichnis der Sidebar (dort stehen auch die
  // Anker, die noch keine Bahn haben, weil an ihnen keine Idee haengt). Eine
  // Buch-Idee heisst dabei ZUGEORDNET, eine verankerte VERSCHOBEN.
  canMove(idee) { return isOpenIdee(idee); },
  // Knopf- und Popover-Beschriftung: Zuordnen fuer die Buch-Idee, Verschieben
  // fuer die verankerte.
  moveTip(idee) { return window.__app.t(!idee || isBookIdee(idee) ? 'ideenBoard.assign' : 'ideen.move'); },
  dragTip(idee) {
    return window.__app.t(this.canMove(idee) ? 'ideenBoard.dragMove' : 'ideenBoard.drag');
  },
  // Popover am Trigger (Picker-Popover: public/js/picker-popover.js).
  startAssign(ev, idee) {
    if (!idee) return;
    this._openPickerPopover(ev, 'ideenAssignPopover', () => this.cancelAssign());
    this.assigningId = idee.id;
    this.assignLaneKey = '';
  },
  cancelAssign() {
    this.assigningId = null;
    this.assignLaneKey = '';
    this._releasePickerPopover();
  },
  assigningIdee() { return this._findIdee(this.assigningId); },
  assigningBookIdee() { return isBookIdee(this.assigningIdee()); },
  // Ziele des Pickers: alle Anker ausser dem, an dem die Idee schon haengt —
  // fuer eine verankerte Idee zuerst das ganze Buch (Anker loesen).
  assignTargetOptions() {
    const idee = this.assigningIdee();
    const cur = idee ? ideeLaneKey(idee) : '';
    return cur === LANE_BOOK
      ? this.anchorLaneOptions()
      : this.newLaneOptions().filter(o => o.value !== cur);
  },
  async confirmAssign() {
    const idee = this.assigningIdee();
    if (!idee) return;
    if (await this._reanchorIdee(idee, this.assignLaneKey)) this.cancelAssign();
  },

  // Idee an den Anker hinter `laneKey` (`chapter:<id>` / `page:<id>`) haengen
  // oder mit LANE_BOOK vom Anker loesen, optional zugleich die Stufe setzen
  // (Drop in eine andere Spalte) — ein PATCH, damit die Idee nie halb
  // umgezogen dasteht. Der Server leert den alten Anker.
  async _reanchorIdee(idee, laneKey, status = null) {
    if (!this.canMove(idee) || !laneKey || laneKey === ideeLaneKey(idee)) return null;
    let body;
    if (laneKey === LANE_BOOK) {
      body = { page_id: null, chapter_id: null };
    } else {
      const [kind, rawId] = String(laneKey).split(':');
      const anchorId = parseInt(rawId, 10);
      if (!anchorId || (kind !== 'chapter' && kind !== 'page')) return null;
      body = { [kind === 'chapter' ? 'chapter_id' : 'page_id']: anchorId };
    }
    if (status && status !== ideeStatus(idee) && this.isStageActive(status)) body.status = status;
    const row = await this._patchIdee(idee, body);
    if (row) await this._ensureBoardSortables();
    return row;
  },

  // Darf die gezogene Karte aus `fromLane` in die Zelle `toLane` × `toStatus`?
  // Quer zur Bahn nur eine offene Idee, nur in eine Kapitel-/Abschnitts- oder
  // die Buch-Bahn (nicht in die Sammelbahn LANE_UNKNOWN) und nur in eine offene
  // Stufe — eine Idee, die beim Umzug gleich abgeschlossen wuerde, haette an
  // ihrem neuen Ort nie offen gestanden.
  _canDropMove(fromLane, toLane, toStatus, dragEl) {
    if (fromLane === toLane || !(toLane === LANE_BOOK || /^(chapter|page):\d+$/.test(toLane || ''))) return false;
    if (!IDEE_OPEN_STATUSES.includes(toStatus)) return false;
    const id = parseInt(dragEl?.dataset?.ideeCardId, 10);
    return this.canMove((this.ideen || []).find(i => i.id === id));
  },

};
