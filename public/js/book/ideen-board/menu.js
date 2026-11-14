// Aktionsmenü einer Idee im Ideen-Board — Rasterkarte UND Listenzeile teilen
// EINE teleportierte Instanz (partials/ideen-board-menu.html, Mechanik
// action-menu.js). Geöffnet per ⋯-Knopf, Rechtsklick und Long-Press; Ziel =
// { ctx: 'board'|'list', id }. Reihenfolge: Bearbeiten, Stufen, Verschieben/
// Zuordnen, Verknüpfen, Trenner, Löschen. Die Hover-Knöpfe der Rasterkarte
// bleiben als Abkürzung daneben.
// `this` = die ideenBoardCard-Instanz.

const STATUS_ICON = { offen: 'undo', in_arbeit: 'play', erledigt: 'check', verworfen: 'minus' };

export const ideenBoardMenu = {
  openIdeeMenu(ev, ctx, idee) {
    if (!idee || this.busy || this.editingId === idee.id) return;
    this.openActionMenu(ev, `${ctx}:${idee.id}`, { ctx, id: idee.id });
  },
  // Plain Methode statt Getter (Spread im Alpine.data-Factory).
  menuIdee() {
    const t = this.actionMenuTarget;
    return t ? this._findIdee(t.id) : null;
  },
  // Einelementige Liste fürs Menü-Markup: `x-for` mit `:key` baut die Einträge
  // neu, wenn das Menü an einer anderen Idee aufgeht.
  menuIdeen() {
    const idee = this.menuIdee();
    return idee ? [idee] : [];
  },
  menuStatusIcon(st) { return `/icons.svg#${STATUS_ICON[st] || 'circle'}`; },
};
