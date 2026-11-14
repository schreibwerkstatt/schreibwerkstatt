// Mehrfachauswahl der Recherche-Liste: EINE Aktion auf alle Markierten
// (POST /research/bulk, routes/research-bulk.js); Markieren und Zaehlen kommen
// aus selection-bar.js. Die Haken stehen in jeder Listenzeile, die Leiste
// erscheint ab der ersten Markierung (wie in der Ideen-Liste). Nur in der
// Listen-Ansicht — im Status-Board ist das Ziehen schon die Sammel-Geste.
// Jede Sammelaktion ist EIN Undo-Schritt (recherche/history.js).

import { fetchJson } from '../../utils.js';
import { STATUSES } from './shared.js';
import { selectionState, selectionMethods } from '../../selection-bar.js';

export function rechercheBulkState() {
  return {
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
  bulkClear() {
    Object.assign(this, rechercheBulkState());
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
    // Stand VOR dem Request — das Undo dreht genau diese Fundstuecke zurueck.
    const rec = this._researchBulkRecord?.(action, ids, extra);
    this.busy = true;
    try {
      const r = await fetchJson('/research/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, ids, action, ...extra }),
      });
      this.errorMessage = '';
      if (rec) this._recordResearch?.(rec);
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
