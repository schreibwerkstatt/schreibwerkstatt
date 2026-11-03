// Mehrfachauswahl der Recherche-Liste: Auswahl-Modus, Auswahl und EINE Aktion auf
// alle Markierten (POST /research/bulk, routes/research-bulk.js). Nur in der
// Listen-Ansicht — im Status-Board ist das Ziehen schon die Sammel-Geste.

import { fetchJson } from '../../utils.js';
import { STATUSES } from './shared.js';

export function rechercheBulkState() {
  return {
    bulkMode: false,
    // Markierte Ids als Map id → true; Reassign statt In-Place-Mutate (x-for).
    bulkSelected: {},
    bulkStatus: '',
    bulkTag: '',
    bulkLinkKind: '',
    bulkLinkTargetId: '',
  };
}

export const rechercheBulkMethods = {
  toggleBulkMode() {
    this.bulkMode = !this.bulkMode;
    if (!this.bulkMode) this.bulkClear();
  },
  bulkClear() {
    Object.assign(this, rechercheBulkState(), { bulkMode: this.bulkMode });
  },
  isBulkSelected(item) { return !!this.bulkSelected[item.id]; },
  toggleBulkSelect(item) {
    const next = { ...this.bulkSelected };
    if (next[item.id]) delete next[item.id]; else next[item.id] = true;
    this.bulkSelected = next;
  },
  // Nur sichtbare Fundstuecke zaehlen: ein Filterwechsel darf keine unsichtbare
  // Auswahl mitschleppen, die dann still mitgeloescht wird.
  bulkIds() {
    const visible = new Set(this.items.map(i => i.id));
    return Object.keys(this.bulkSelected).map(Number).filter(id => visible.has(id));
  },
  bulkCount() { return this.bulkIds().length; },
  bulkAllSelected() { return this.items.length > 0 && this.bulkCount() === this.items.length; },
  bulkToggleAll() {
    this.bulkSelected = this.bulkAllSelected() ? {} : Object.fromEntries(this.items.map(i => [i.id, true]));
  },
  bulkStatusOptions() { return STATUSES.map(s => ({ value: s, label: this.statusLabel(s) })); },

  async bulkApply(action, extra = {}) {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    const ids = this.bulkIds();
    if (!bookId || !ids.length || this.busy) return;
    if (action === 'delete' && !await app.appConfirm({
      message: app.t('recherche.bulk.confirmDelete', { n: ids.length }),
      confirmLabel: app.t('common.delete'), danger: true,
    })) return;
    this.busy = true;
    try {
      await fetchJson('/research/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, ids, action, ...extra }),
      });
      this.errorMessage = '';
      if (action === 'delete' && ids.includes(this.detailItemId)) this.closeDetail();
      this.bulkSelected = {};
      this.bulkStatus = '';
      this.bulkTag = '';
      this.bulkLinkTargetId = '';
      await this.loadRecherche();
      // Seiten-/Kapitel-Indikatoren haengen an Verknuepfung + Archiv-Stand.
      this._refreshRechercheCounts('page');
      this._refreshRechercheCounts('chapter');
    } catch {
      this.errorMessage = app.t('recherche.bulk.error');
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
