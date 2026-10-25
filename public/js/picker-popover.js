// Picker-Popover: am Trigger verankertes Popover, in dem an EINEM Element
// etwas gewaehlt wird (verknuepfen, verschieben, zuordnen). Markup-Rahmen und
// Regeln: DESIGN.md „Picker-Popover", CSS components/picker-popover.css.
//
// Der Picker ist EINE Instanz ausserhalb der Liste, deren Zeilen ihn oeffnen
// (eine Combobox je x-for-Zeile initialisiert nicht sauber, und in einer
// SortableJS-Liste laege sie im Drag-Container). Damit er trotzdem dort
// erscheint, wo geklickt wurde, wird er teleportiert und am Trigger verankert —
// ein Block im Kartenkopf stuende bei einem Element weit unten ausserhalb des
// Sichtfelds, und der Klick saehe wirkungslos aus.
//
// Mehrere Picker einer Karte teilen sich Position und Schliess-Listener: offen
// ist hoechstens einer, das Oeffnen des naechsten bricht den vorigen ab.
//
//   ...pickerPopoverState(),            // in den Karten-State
//   ...pickerPopoverMethods,            // in die Karten-Methoden
//   openX(ev, item) { this.xId = item.id;
//     this._openPickerPopover(ev, 'xPopover', () => this.cancelX()); }
//   cancelX() { this.xId = null; this._releasePickerPopover(); }
//
// Im Markup: `:style="{ top: pickerPopoverPos.top + 'px', left: pickerPopoverPos.left + 'px' }"`
// — Objekt-Form Pflicht, die String-Form ueberschriebe das `display:none` von
// x-show, und geschlossene Geschwister-Picker wuerden sichtbar.
// `@keydown.escape.window` ruft den Abbruch. Klick daneben schliesst die
// Mechanik selbst (`mousedown` am Dokument, siehe _openPickerPopover) — kein
// `@click.outside` im Markup.

import { EVT } from './events.js';
import { computePopoverPos, refinePopoverPos } from './popover-anchor.js';
import { attachDismiss, detachDismiss } from './cards/dismiss.js';
import { mountInTopLayer } from './fullscreen.js';

// Schaetzung fuer den ersten Positions-Pass (gemessen wird danach, siehe
// popover-anchor.js). Breite = `--picker-popover-w` in picker-popover.css —
// beide zusammen halten, sonst springt das Popover beim Nachmessen sichtbar.
const PICKER_POPOVER_W = 320;
const PICKER_POPOVER_H = 210;

export function pickerPopoverState() {
  return {
    pickerPopoverPos: { top: 0, left: 0 },
    _pickerPopoverRect: null,
    _pickerPopoverCancel: null,
    _pickerPopoverRef: null,
    _pickerPopoverDismiss: null,
  };
}

export const pickerPopoverMethods = {
  // `anchor` = Klick-Event (verankert am `currentTarget`) oder direkt das
  // Anker-Element — Letzteres, wenn zwischen Klick und Oeffnen ein `await`
  // liegt (danach ist `currentTarget` null) oder der Klick aus einem Menue
  // kommt, das beim Oeffnen verschwindet (dann dessen Trigger nehmen).
  // `refName` = x-ref des Popover-Elements, `cancel` = Abbruch des Pickers
  // (setzt dessen Zustand zurueck und ruft `_releasePickerPopover`).
  // `w`/`h` = Schaetzung, falls der Konsument `--picker-popover-w` aendert.
  _openPickerPopover(anchor, refName, cancel, { w = PICKER_POPOVER_W, h = PICKER_POPOVER_H } = {}) {
    // Hover-Tooltip des Triggers wegblenden — er hinge sonst ueber dem Popover.
    window.dispatchEvent(new CustomEvent(EVT.TOOLTIP_HIDE));
    // Nur einen ANDEREN Picker abbrechen: der Konsument hat seinen Zustand vor
    // diesem Aufruf schon gesetzt, der eigene alte Abbruch wuerde ihn loeschen.
    // Verglichen wird per x-ref, nicht per `cancel` — das ist bei jedem Oeffnen
    // eine neue Arrow-Funktion.
    if (this._pickerPopoverCancel && this._pickerPopoverRef !== refName) this._pickerPopoverCancel();
    const trigger = anchor instanceof Element ? anchor : anchor?.currentTarget;
    // Im Native-Vollbild laege ein <body>-Kind hinter dem ::backdrop:
    // zur Anzeigezeit unter den sichtbaren Host haengen (sonst No-Op).
    mountInTopLayer(this.$refs[refName], trigger);
    this._pickerPopoverRect = trigger?.getBoundingClientRect?.() || null;
    if (this._pickerPopoverRect) {
      this.pickerPopoverPos = computePopoverPos(this._pickerPopoverRect, w, h);
    }
    this._pickerPopoverCancel = cancel;
    this._pickerPopoverRef = refName;
    // Nur `resize`, bewusst KEIN `scroll`: ein Capture-Scroll-Listener feuert
    // auch beim Rollen in der Options-Liste einer Combobox und schloesse den
    // Picker mitten in der Auswahl.
    if (!this._pickerPopoverDismiss) {
      this._pickerPopoverDismiss = attachDismiss(() => this._pickerPopoverCancel?.(), { scroll: false });
      // Klick daneben: `mousedown` in der Capture-Phase statt `@click.outside`.
      // Alpines Outside-Check verwirft Klicks auf Elemente, die der Klick
      // selbst aus dem DOM nimmt (per `x-if` getauschte Platzhalter-Trigger) —
      // der Picker bliebe offen. `mousedown` feuert vor jedem Tausch und vor
      // dem `click`, der einen Picker oeffnet; Capture, damit ein
      // `stopPropagation` im Ziel ihn nicht verschluckt. Wie die Combobox.
      document.addEventListener('mousedown', (e) => {
        const el = this.$refs[this._pickerPopoverRef];
        if (el && !el.contains(e.target)) this._pickerPopoverCancel?.();
      }, { capture: true, signal: this._pickerPopoverDismiss.signal });
    }
    this._refinePickerPopover(refName);
  },

  // Echte Groesse messen und neu verankern — nach dem Oeffnen und erneut, wenn
  // sich der Inhalt des offenen Pickers aendert (nachgeladene Optionen, Leer-
  // Hinweis statt Combobox): ein nach oben geklapptes Popover loeste sich sonst
  // vom Trigger, sobald es niedriger wird, oder wuechse ueber ihn hinweg.
  _refinePickerPopover(refName) {
    this.$nextTick(() => {
      if (!this._pickerPopoverCancel) return;
      const pos = refinePopoverPos(this.$refs[refName], this._pickerPopoverRect);
      if (pos) this.pickerPopoverPos = pos;
    });
  },

  _releasePickerPopover() {
    this._pickerPopoverCancel = null;
    this._pickerPopoverRef = null;
    this._pickerPopoverRect = null;
    detachDismiss(this, '_pickerPopoverDismiss');
  },
};
