// Verknuepfungen einer Idee: Picker und Entfernen (Anzeige + Sprung zur
// Gegenseite: x-entity-ref in partials/ideen-link-chips.html).
//
// Geteilt von der Ideen-Karte (Seite/Kapitel, neben dem Editor) und dem
// Ideen-Board — beide Oberflaechen zeigen dieselben Verknuepfungen an derselben
// Idee, und eine zweite Implementierung waere die klassische Drift-Stelle (eine Seite
// kennt die neue Ziel-Art, die andere nicht).
//
// Die Gegenrichtung (Ideen-Referenzen AN einem Fundstueck / Beat / Motiv) liegt
// bewusst NICHT hier, sondern in ideen-backlinks.js: dort ist die Idee das Ziel,
// nicht der Besitzer, und die drei Karten holen nur eine Map.

import { fetchJson } from '../utils.js';
import { EVT } from '../events.js';
import { IDEA_LINK_KINDS } from './ideen-shared.js';
import { computePopoverPos, refinePopoverPos } from '../popover-anchor.js';
import { attachDismiss, detachDismiss } from '../cards/dismiss.js';
import { mountInTopLayer } from '../fullscreen.js';

// Schaetzung fuer den ersten Positions-Pass (gemessen wird danach, siehe
// popover-anchor.js). Nah an der CSS-Breite von `.idee-link-popover`.
const LINK_POPOVER_W = 320;
const LINK_POPOVER_H = 210;

export const ideenLinkMethods = {
  linkKinds() { return IDEA_LINK_KINDS; },
  linkKindLabel(kind) { return window.__app.t(`ideen.link.kind.${kind}`); },
  linkKindOptions() {
    return IDEA_LINK_KINDS.map(k => ({ value: k, label: this.linkKindLabel(k) }));
  },

  // Ziel-Kataloge einmal pro Buch holen (Picker-Quelle fuer entityPicker
  // `entity: 'target'`). Der Guard auf `_linkTargetsBookId` haelt einen
  // Buchwechsel auseinander — ohne ihn boete der Picker die Beats des zuvor
  // geoeffneten Buches an.
  async ensureIdeaLinkTargets() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this._linkTargetsBookId === bookId) return;
    try {
      this.linkTargets = await fetchJson(`/ideen/link-targets?book_id=${bookId}`);
      this._linkTargetsBookId = bookId;
    } catch {
      this.linkTargets = {};
      this._linkTargetsBookId = null;
    }
  },

  // Der Picker ist EINE Instanz ausserhalb der Ideen-Liste (eine Combobox je
  // x-for-Zeile initialisiert nicht sauber, und im Board laege sie im
  // SortableJS-Container). Damit er trotzdem dort erscheint, wo geklickt wurde,
  // wird er nach <body> teleportiert und am Trigger verankert — sonst steht er
  // bei einer Idee weit unten im Brett ausserhalb des Sichtfelds, und der Klick
  // sieht wirkungslos aus.
  async openLinkPicker(ev, idee) {
    if (!idee) return;
    // Hover-Tooltip des Triggers wegblenden — er hinge sonst ueber dem Popover.
    window.dispatchEvent(new CustomEvent(EVT.TOOLTIP_HIDE));
    const trigger = ev?.currentTarget;
    // Im Vollbild des Ideen-Boards laege ein <body>-Kind hinter dem ::backdrop:
    // zur Anzeigezeit unter den sichtbaren Host haengen (sonst No-Op).
    mountInTopLayer(this.$refs.ideenLinkPopover, trigger);
    this._linkTriggerRect = trigger?.getBoundingClientRect?.() || null;
    if (this._linkTriggerRect) {
      this.linkPickerPos = computePopoverPos(this._linkTriggerRect, LINK_POPOVER_W, LINK_POPOVER_H);
    }
    this.linkPickerIdeeId = idee.id;
    this.linkPickerKind = IDEA_LINK_KINDS[0];
    this.linkPickerTargetId = '';
    this._attachLinkPickerListeners();
    this.$nextTick(() => {
      const pos = refinePopoverPos(this.$refs.ideenLinkPopover, this._linkTriggerRect);
      if (pos) this.linkPickerPos = pos;
    });
    // Erst danach die Ziel-Kataloge: das Popover soll sofort stehen, die
    // Optionen fliessen reaktiv nach (entityPicker liest `linkTargets`).
    await this.ensureIdeaLinkTargets();
  },

  cancelLinkPicker() {
    this.linkPickerIdeeId = null;
    this.linkPickerTargetId = '';
    this._linkTriggerRect = null;
    this._detachLinkPickerListeners();
  },

  // Die Idee, an der der Picker haengt — fuer die Kopfzeile des Popovers. Ohne
  // sie waere nach dem Scrollen nicht mehr zu sehen, was gerade verknuepft wird.
  linkPickerIdee() {
    if (this.linkPickerIdeeId == null) return null;
    return (this.ideen || []).find(i => i.id === this.linkPickerIdeeId) || null;
  },

  // Nur `resize`, bewusst KEIN `scroll`: ein Capture-Scroll-Listener feuert auch
  // beim Rollen in der Options-Liste der Combobox und schloesse den Picker
  // mitten in der Auswahl.
  _attachLinkPickerListeners() {
    this._linkPickerCloseHandler ??= attachDismiss(() => this.cancelLinkPicker(), { scroll: false });
  },

  _detachLinkPickerListeners() {
    detachDismiss(this, '_linkPickerCloseHandler');
  },

  async confirmLinkPicker() {
    const idee = this.linkPickerIdee();
    if (!idee || !this.linkPickerTargetId) return;
    await this.addIdeeLink(idee, this.linkPickerKind, this.linkPickerTargetId);
  },

  async addIdeeLink(idee, targetKind, targetId) {
    const app = window.__app;
    if (!targetKind || !targetId) return;
    this.busy = true;
    try {
      const row = await fetchJson(`/ideen/${idee.id}/links`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_kind: targetKind, target_id: parseInt(targetId, 10) }),
      });
      this._replaceIdee(row);
      this.cancelLinkPicker();
      this.errorMessage = '';
    } catch {
      this.errorMessage = app.t('ideen.error.link');
    } finally {
      this.busy = false;
    }
  },

  async removeIdeeLink(idee, link) {
    this.busy = true;
    try {
      this._replaceIdee(await fetchJson(`/ideen/${idee.id}/links/${link.link_id}`, { method: 'DELETE' }));
      this.errorMessage = '';
    } catch {
      this.errorMessage = window.__app.t('ideen.error.link');
    } finally {
      this.busy = false;
    }
  },
};
