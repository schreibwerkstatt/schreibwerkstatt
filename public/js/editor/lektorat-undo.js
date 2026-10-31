// Abschnitts-Lektorat: die gerade gespeicherten Korrekturen eines Laufs mit einem
// Klick zurücknehmen. In den Root gespreadet (app.js) neben lektoratMethods.
//
// Zurückgeschrieben wird der Stand, den `_loadApplyAndSave` vor dem Übernehmen
// frisch geladen hat — exakt, nicht die nächstältere Revision (die ist nach 24 h
// ausgedünnt). Optimistisch gegen den Stempel des Korrektur-Saves: hat seither
// jemand geschrieben (eigener Edit, Zweitgerät, Mitautor), antwortet der Server
// mit 409 und nichts wird überschrieben. Der Knopf erscheint nur, solange die
// Seite unverändert auf genau diesem Stand steht und nicht bearbeitet wird.
// Der Übernahme-Vermerk am Lauf (page_checks) geht auf den Stand davor zurück,
// sonst zählte die Fehler-Heatmap die zurückgenommenen Korrekturen als erledigt.

import { savePage, isPageConflict } from './shared/page-api.js';

export const lektoratUndoMethods = {
  // Von saveCorrections nach erfolgreichem Speichern gesetzt.
  _rememberLektoratUndo({ pageId, pageName, preHtml, updatedAt, checkId, prevApplied = null, prevSelected = null }) {
    this.lektoratUndo = preHtml && updatedAt
      ? { pageId, pageName, preHtml, updatedAt, checkId, prevApplied, prevSelected }
      : null;
  },

  canUndoLektorat() {
    const u = this.lektoratUndo;
    return !!u && this.currentPage?.id === u.pageId && this.currentPage?.updated_at === u.updatedAt
      && !this.editMode && this.saveApplying == null;
  },

  async undoLektoratCorrections() {
    if (!this.canUndoLektorat()) return;
    const u = this.lektoratUndo;
    this.saveApplying = 50;
    try {
      const saved = await savePage(u.pageId, {
        html: u.preHtml,
        pageName: u.pageName,
        source: 'lektorat-apply',
        expectedUpdatedAt: u.updatedAt,
      });
      this.lektoratUndo = null;
      if (u.checkId) {
        try {
          const r = await fetch('/history/check/' + u.checkId + '/saved', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ saved: false, applied_errors_json: u.prevApplied || [], selected_errors_json: u.prevSelected || [] }),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
        } catch (e) {
          console.error('[lektorat undo history]', e);
        }
      }
      this._syncPageStatsAfterSave?.({ id: u.pageId, updated_at: saved?.updated_at || null }, u.preHtml);
      if (this.currentPage?.id === u.pageId) {
        await this._refetchCurrentPage?.();
        this.refreshPageAges?.();
        await this.loadPageHistory?.(u.pageId);
      }
      this.setStatus(this.t('lektorat.undoDone'), false, 5000);
    } catch (e) {
      console.error('[undoLektoratCorrections]', e);
      if (isPageConflict(e)) this.lektoratUndo = null;
      this.setStatus(isPageConflict(e) ? this.t('lektorat.undoConflict') : this.t('common.errorColon') + e.message, false, 8000);
    } finally {
      this.saveApplying = null;
    }
  },
};
