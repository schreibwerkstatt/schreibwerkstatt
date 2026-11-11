// Mehrfachauswahl der Recherche-Liste: Auswahl-Modus und EINE Aktion auf alle
// Markierten (POST /research/bulk, routes/research-bulk.js); Markieren und
// Zaehlen kommen aus selection-bar.js. Nur in der Listen-Ansicht — im
// Status-Board ist das Ziehen schon die Sammel-Geste.

import { fetchJson } from '../../utils.js';
import { STATUSES } from './shared.js';
import { selectionState, selectionMethods } from '../../selection-bar.js';

export function rechercheBulkState() {
  return {
    bulkMode: false,
    ...selectionState(),
    bulkStatus: '',
    bulkTag: '',
    bulkLinkKind: '',
    bulkLinkTargetId: '',
  };
}

export const rechercheBulkMethods = {
  ...selectionMethods,
  // Gezaehlt und geschrieben wird nur, was die Liste gerade zeigt (`items` ist
  // schon gefiltert): ein Filterwechsel darf keine unsichtbare Auswahl
  // mitschleppen, die dann still mitgeloescht wird.
  selectionVisibleIds() { return this.items.map(i => i.id); },
  // Beim Einstieg ein offenes Bearbeiten speichern und die Zeile zuklappen:
  // im Auswahl-Modus markiert ein Klick, eine offene Zeile daneben ist nur im Weg.
  async toggleBulkMode() {
    if (!this.bulkMode && this.detailItemId != null) {
      if (this.detailEditing) {
        const prev = (this.items || []).find(i => i.id === this.detailItemId);
        if (prev && !(await this.commitEdit(prev))) return;
      }
      this.closeDetail();
    }
    this.bulkMode = !this.bulkMode;
    if (!this.bulkMode) this.bulkClear();
  },
  bulkClear() {
    Object.assign(this, rechercheBulkState(), { bulkMode: this.bulkMode });
  },
  bulkStatusOptions() { return STATUSES.map(s => ({ value: s, label: this.statusLabel(s) })); },

  async bulkApply(action, extra = {}) {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    const ids = this.selectedVisibleIds();
    if (!bookId || !ids.length || this.busy) return;
    if (action === 'delete' && !await app.appConfirm({
      message: app.tn('recherche.bulk.confirmDelete', ids.length),
      confirmLabel: app.t('common.delete'), danger: true,
    })) return;
    this.busy = true;
    try {
      const r = await fetchJson('/research/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, ids, action, ...extra }),
      });
      this.errorMessage = '';
      if (action === 'delete' && ids.includes(this.detailItemId)) this.closeDetail();
      this.selectedIds = [];
      this.bulkStatus = '';
      this.bulkTag = '';
      this.bulkLinkTargetId = '';
      await this.loadRecherche();
      // add_tag: Fundstuecke am Tag-Deckel ueberspringt der Server und zaehlt sie
      // in `skipped`. Nach dem Reload melden — loadRecherche leert errorMessage.
      if (r?.skipped) this.errorMessage = app.tn('recherche.bulk.tagSkipped', r.skipped);
      // Seiten-/Kapitel-Indikatoren haengen an Verknuepfung + Archiv-Stand.
      this._refreshRechercheCounts('page');
      this._refreshRechercheCounts('chapter');
    } catch (e) {
      this.errorMessage = this._rechercheErrorText(e, 'recherche.bulk.error');
    } finally {
      this.busy = false;
    }
  },
  // Wert aus $event.detail: x-modelable synct `bulkStatus` erst nach dem Event.
  bulkSetStatus(status) { if (status) this.bulkApply('status', { status }); },
  bulkAddTag() {
    const tag = (this.bulkTag || '').trim();
    if (tag) this.bulkApply('add_tag', { tag });
  },
  bulkLink() {
    const id = parseInt(this.bulkLinkTargetId, 10);
    if (this.bulkLinkKind && id) this.bulkApply('link', { target_kind: this.bulkLinkKind, target_id: id });
  },
};
