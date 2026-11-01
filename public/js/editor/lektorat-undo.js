// Abschnitts-Lektorat: die gerade gespeicherten Korrekturen eines Laufs mit einem
// Klick zurücknehmen. In den Root gespreadet (app.js) neben lektoratMethods.
//
// Zurückgeschrieben wird der Stand, den `_loadApplyAndSave` vor dem Übernehmen
// frisch geladen hat — exakt, nicht die nächstältere Revision (die ist nach 24 h
// ausgedünnt). Optimistisch gegen den Stempel des Korrektur-Saves: hat seither
// jemand geschrieben (eigener Edit, Zweitgerät, Mitautor), antwortet der Server
// mit 409 und nichts wird überschrieben. Der Knopf steht in der Zeile der
// Save-Bestätigung und läuft mit ihr nach UNDO_WINDOW_MS ab; davor nur, solange
// die Seite unverändert auf genau diesem Stand steht und nicht bearbeitet wird.
// Am Lauf (page_checks) werden die Befunde ausgetragen, die dieser Save neu
// gebucht hat — sonst zählte die Fehler-Heatmap die zurückgenommenen
// Korrekturen als erledigt. Was davor schon gebucht war (frühere Übernahme,
// Edit-Modus), bleibt stehen; gelesen wird dafür der frische Serverstand
// (lektorat-booking.js).

import { savePage, isPageConflict } from './shared/page-api.js';
import { patchBookedLists, withoutOriginals } from './lektorat-booking.js';

// Auch Anzeigedauer der Save-Bestätigung, wenn Rückgängig angeboten wird.
export const UNDO_WINDOW_MS = 15000;

export const lektoratUndoMethods = {
  // Von saveCorrections nach erfolgreichem Speichern gesetzt.
  // `bookedApplied`/`bookedSelected`: Originale, die dieser Save neu gebucht hat.
  // `appliedOriginals`: was dieser Save in den Text gebracht hat — die stehen
  // gebliebene Befundliste öffnet sie beim Rückgängig wieder.
  _rememberLektoratUndo({ pageId, pageName, preHtml, updatedAt, checkId, bookedApplied = [], bookedSelected = [], appliedOriginals = [] }) {
    clearTimeout(this._lektoratUndoTimer);
    this.lektoratUndo = preHtml && updatedAt
      ? { pageId, pageName, preHtml, updatedAt, checkId, bookedApplied, bookedSelected, appliedOriginals }
      : null;
    if (!this.lektoratUndo) return;
    const u = this.lektoratUndo;
    this._lektoratUndoTimer = setTimeout(() => {
      if (this.lektoratUndo === u && this.saveApplying == null) this.lektoratUndo = null;
    }, UNDO_WINDOW_MS);
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
      if (u.checkId && (u.bookedApplied.length || u.bookedSelected.length)) {
        try {
          const applied = new Set(u.bookedApplied), selected = new Set(u.bookedSelected);
          await patchBookedLists(u.checkId, prev => {
            const next = withoutOriginals(prev.applied, applied);
            return { applied: next, selected: withoutOriginals(prev.selected, selected), saved: next.length > 0 };
          });
        } catch (e) {
          console.error('[lektorat undo history]', e);
        }
      }
      this._syncPageStatsAfterSave?.({ id: u.pageId, updated_at: saved?.updated_at || null }, u.preHtml);
      if (this.currentPage?.id === u.pageId) {
        // Vor dem Refetch: dessen Abgleich (_filterFindingsAfterSave) öffnet die
        // Befunde, deren Stelle wieder dasteht, und nimmt „erledigt" zurück.
        if (this.lastCheckId === u.checkId && u.appliedOriginals.length) {
          const reopened = new Set(u.appliedOriginals);
          this.appliedOriginals = this.appliedOriginals.filter(o => !reopened.has(o));
        }
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
