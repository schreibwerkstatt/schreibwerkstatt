// Mehrfachauswahl mit Sammelaktionen: markieren, „alle sichtbaren", Zähler und
// das Zuschneiden auf das, was gerade zu sehen ist. Markup-Rahmen und Regeln:
// DESIGN.md „Auswahl-Leiste", CSS components/selection-bar.css.
//
//   ...selectionState(),          // in den Karten-State
//   ...selectionMethods,          // in die Karten-Methoden
//   selectionVisibleIds() { return this.rows().map(r => r.id); }   // Pflicht
//
// Die Karte liefert nur `selectionVisibleIds()`: die Ids der Zeilen, die der
// aktuelle Filter zeigt. Alles andere — auch das Zählen — geht über diese
// Methoden, damit eine Sammelaktion nie trifft, was gerade ausgeblendet ist.
// Wie die Auswahl beginnt, bleibt der Karte: ein Modus-Knopf, wenn ein Klick
// auf die Zeile sonst etwas öffnet (Recherche), oder Haken, die immer stehen
// (Tabellen).

export function selectionState() {
  return {
    // Immer eine NEUE Liste schreiben: Alpine reagiert in x-for-Zeilen über die
    // Identität, ein push() käme dort nicht an.
    selectedIds: [],
  };
}

export const selectionMethods = {
  isSelected(id) { return this.selectedIds.includes(id); },
  toggleSelect(id) {
    this.selectedIds = this.isSelected(id)
      ? this.selectedIds.filter(x => x !== id)
      : [...this.selectedIds, id];
  },
  clearSelection() { if (this.selectedIds.length) this.selectedIds = []; },
  // Die Ids, auf die eine Sammelaktion wirkt: markiert UND sichtbar.
  selectedVisibleIds() {
    const visible = new Set(this.selectionVisibleIds());
    return this.selectedIds.filter(id => visible.has(id));
  },
  selectionCount() { return this.selectedVisibleIds().length; },
  allVisibleSelected() {
    const ids = this.selectionVisibleIds();
    return ids.length > 0 && ids.every(id => this.isSelected(id));
  },
  toggleSelectAllVisible() {
    this.selectedIds = this.allVisibleSelected() ? [] : [...this.selectionVisibleIds()];
  },
  // Nach Neuladen/Filterwechsel: Ids, die nicht mehr zu sehen sind, fallen
  // heraus — sonst stünde im Zähler eine Auswahl, die keiner mehr sieht.
  _pruneSelection() {
    const next = this.selectedVisibleIds();
    if (next.length !== this.selectedIds.length) this.selectedIds = next;
  },
};
