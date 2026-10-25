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
import { IDEA_LINK_KINDS } from './ideen-shared.js';

export const ideenLinkMethods = {
  // Idee der Karte per ID — Kopfzeile der Picker-Popover (Verknuepfen,
  // Verschieben, Zuordnen).
  _findIdee(id) {
    if (id == null) return null;
    return (this.ideen || []).find(i => i.id === id) || null;
  },

  linkKinds() { return IDEA_LINK_KINDS; },
  linkKindLabel(kind) { return window.__app.t(`ideen.link.kind.${kind}`); },
  linkKindOptions() {
    return IDEA_LINK_KINDS.map(k => ({ value: k, label: this.linkKindLabel(k) }));
  },

  // Ziel-Kataloge holen (Picker-Quelle fuer entityPicker `entity: 'target'`) —
  // bei JEDEM Oeffnen des Pickers: ein Motiv oder Beat, das inzwischen in einer
  // anderen Werkstatt entstand, muss sofort waehlbar sein. Der Stand desselben
  // Buches bleibt bis zur Antwort stehen (und bei einem Fehler); ein anderes
  // Buch wird erst geleert — sonst boete der Picker die Beats des zuvor
  // geoeffneten Buches an.
  async ensureIdeaLinkTargets() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    if (this._linkTargetsBookId !== bookId) { this.linkTargets = {}; this._linkTargetsBookId = null; }
    try {
      const data = await fetchJson(`/ideen/link-targets?book_id=${bookId}`);
      if (Alpine.store('nav').selectedBookId !== bookId) return;
      this.linkTargets = data;
      this._linkTargetsBookId = bookId;
    } catch {
      if (this._linkTargetsBookId !== bookId) this.linkTargets = {};
    }
  },

  // Picker-Popover: public/js/picker-popover.js.
  async openLinkPicker(anchor, idee) {
    if (!idee) return;
    this._openPickerPopover(anchor, 'ideenLinkPopover', () => this.cancelLinkPicker());
    this.linkPickerIdeeId = idee.id;
    this.linkPickerKind = IDEA_LINK_KINDS[0];
    this.linkPickerTargetId = '';
    // Erst danach die Ziel-Kataloge: das Popover soll sofort stehen, die
    // Optionen fliessen reaktiv nach (entityPicker liest `linkTargets`).
    await this.ensureIdeaLinkTargets();
  },

  cancelLinkPicker() {
    this.linkPickerIdeeId = null;
    this.linkPickerTargetId = '';
    this._releasePickerPopover();
  },

  // Die Idee, an der der Picker haengt — fuer die Kopfzeile des Popovers. Ohne
  // sie waere nach dem Scrollen nicht mehr zu sehen, was gerade verknuepft wird.
  linkPickerIdee() { return this._findIdee(this.linkPickerIdeeId); },

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
