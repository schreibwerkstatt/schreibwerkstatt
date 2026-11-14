// Teil von notebookEditMethods (siehe Facade edit.js): Auflösungs-Modal der
// Block-Kollision — Entscheidungen je Block, Übernehmen, Abbrechen. Geöffnet
// wird es in edit/conflict.js#_openConflictResolution; die Knöpfe erreichen
// diese Methoden über die Root-Trampoline (`conflictUi*`).
import { buildResolvedHtml, clearDraft, contentRepo, editorHost, isPageConflict, readConflictBody, readDraft, savePage, stripLektoratMarks, trackMerge, writeDraft } from './_shared.js';
import { classifySaveError } from '../save-errors.js';
import { claimSaveOwner, ownsSave } from '../save-owner.js';

// Läuft die Abbrechen-Rückfrage schon? Esc (window-Listener im Partial) und
// der Knopf dürfen keinen zweiten Dialog über den ersten legen.
let _cancelAsking = false;

export const conflictResolveMethods = {
  // Auflösungs-Entscheidung pro Block (UI). choice: 'local'|'remote'|'both'.
  resolveBlock(bid, choice) {
    const app = editorHost();
    if (!app.conflictResolution) return;
    app.conflictResolution.decisions[bid] = choice;
  },


  // Bulk: alle Konflikte auf eine Seite setzen.
  resolveAllConflicts(choice) {
    const app = editorHost();
    if (!app.conflictResolution) return;
    for (const c of app.conflictResolution.conflicts) {
      app.conflictResolution.decisions[c.bid] = choice;
    }
  },


  // Auflösung übernehmen: finales HTML aus merged + decisions bauen und mit
  // expected_updated_at = remoteUpdatedAt speichern.
  async submitConflictResolution() {
    const app = editorHost();
    const cr = app.conflictResolution;
    if (!cr || app.editSaving) return;
    const finalHtml = buildResolvedHtml(cr.merged, cr.decisions);
    const source = cr.source || (app.focusActive ? 'focus' : 'main');
    // Name beim Start festhalten (siehe _pinSaveTarget): nach einem `await`
    // kann `currentPage` schon die nächste Seite sein.
    const pageName = app.currentPage?.name;
    app.editSaving = true;
    // Besitz des Flags (../save-owner.js): läuft der Save über einen
    // Seitenwechsel, gehört `editSaving` danach dem Save der neuen Seite.
    const saveOwner = claimSaveOwner();
    app.setStatus(app.t('edit.saving'), true);
    try {
      const saved = await savePage(cr.pageId, {
        html: finalHtml,
        pageName,
        source,
        expectedUpdatedAt: cr.remoteUpdatedAt,
        reason: 'resolve',
      });
      // Auf dem Server ist die Auflösung; den State einer inzwischen geöffneten
      // anderen Seite fasst sie nicht an.
      if (!this._stillEditing(cr.pageId)) { this._releaseDraftAfterSave(cr.pageId, finalHtml, saved); return; }
      this._applySaveSuccess(saved, finalHtml, { pageId: cr.pageId, applyToEditor: true });
      trackMerge('conflict_resolved', { mix: this._resolutionMix(cr) });
      app.conflictResolution = null;
      app.setStatus('');
    } catch (e) {
      if (isPageConflict(e)) {
        // Dritter Schreibvorgang zwischen Konflikt-Anzeige und „Auflösung
        // übernehmen": der finale PUT (expected = cr.remoteUpdatedAt) trifft
        // erneut 409. Statt Sackgasse (User klickt immer in denselben 409) die
        // lokal aufgelöste Fassung gegen den jetzt frischen Remote-Stand neu
        // block-mergen — gemeinsamer Pfad mit saveEdit/quickSave, nur mit
        // finalHtml als lokaler Quelle (= die gerade getroffene Auflösung).
        // Seite gewechselt: der Draft vom Konflikt-Zeitpunkt liegt schon
        // (_attemptBlockMerge), Merge und Banner gehörten der alten Seite.
        if (!this._stillEditing(cr.pageId)) return;
        const retry = await this._retryAfterConflict({
          localHtml: finalHtml, source, pageId: cr.pageId,
          pageName, tag: 'submitConflictResolution', localBaseAt: cr.remoteUpdatedAt,
        });
        if (retry?.stale) return;
        // _openConflictResolution hat den conflictResolution-State auf den neuen
        // Remote-Stand ersetzt → User löst die neue Kollision auf.
        if (retry?.conflict) return;
        if (retry) {
          if (!this._stillEditing(cr.pageId)) { this._releaseDraftAfterSave(cr.pageId, retry.html, retry.saved); return; }
          this._applySaveSuccess(retry.saved, retry.html, { pageId: cr.pageId, applyToEditor: true });
          trackMerge('conflict_resolved', { mix: this._resolutionMix(cr) });
          app.conflictResolution = null;
          app.setStatus(app.t('edit.conflict.merged.silent'), false, 3000);
          return;
        }
        // Fallback (kein Merge: Flag off / leere Base / Read-Fehler): die
        // aufgelöste Arbeit als Draft sichern, Offline-/Konflikt-Banner zeigen.
        // conflictResolution bleibt offen — User kann erneut übernehmen/abbrechen.
        this._keepAsDraft({ pageId: cr.pageId, html: finalHtml, banner: readConflictBody(e) });
        return;
      }
      console.error('[submitConflictResolution]', e);
      app.setStatus(this._saveFailureText(classifySaveError(e), e), false, 8000);
    } finally {
      if (ownsSave(saveOwner)) app.editSaving = false;
    }
  },


  // Auflösungs-Mix (Meine/Andere/Beide) für Telemetrie aus dem
  // conflictResolution-State zählen.
  _resolutionMix(cr) {
    const mix = { local: 0, remote: 0, both: 0 };
    for (const c of cr.conflicts) {
      const choice = cr.decisions[c.bid] || 'local';
      if (mix[choice] != null) mix[choice]++;
    }
    return mix;
  },


  // Auflösung abbrechen = die eigene Fassung der kollidierenden Seite
  // verwerfen und den Server-Stand laden. Nur ausdrücklich (Abbrechen-Knopf,
  // Esc) und nur nach Rückfrage — ein Klick neben das Modal bricht nichts ab.
  // Die verworfene Fassung landet als Sicherung im Draft-Slot
  // `<pageId>:discarded` (draft-storage.js; Outbox und Pending-Zähler sehen
  // ihn nicht, weil die ID keine Zahl ist) — eine Revision entsteht dabei
  // nicht, es wird ja nichts gespeichert.
  async cancelConflictResolution() {
    const app = editorHost();
    const cr = app.conflictResolution;
    if (!cr || _cancelAsking) return;
    _cancelAsking = true;
    let ok = false;
    try {
      ok = await app.appConfirm({
        message: app.t('edit.conflict.cancelConfirm'),
        confirmLabel: app.t('edit.conflict.cancelDiscard'),
        danger: true,
      });
    } finally {
      _cancelAsking = false;
    }
    // Während der Rückfrage übernommen oder durch einen Folge-Konflikt ersetzt.
    if (!ok || app.conflictResolution !== cr) return;
    const el = this._stillEditing(cr.pageId) ? this._getEditEl() : null;
    const localHtml = el ? stripLektoratMarks(el.innerHTML) : readDraft(cr.pageId)?.html;
    if (localHtml) writeDraft(`${cr.pageId}:discarded`, localHtml, app.originalHtml, app.currentPage?.updated_at);
    app.conflictResolution = null;
    app.editConflict = null;
    if (!cr.pageId) return;
    try {
      const remote = await contentRepo.loadPage(cr.pageId, { fresh: true });
      if (!this._stillEditing(cr.pageId)) return;
      if (remote?.html != null) {
        this._applyMergedToEditor(remote.html);
        app.originalHtml = remote.html;
        if (remote.updated_at) app.currentPage.updated_at = remote.updated_at;
        app.editDirty = false;
        app.saveOffline = false;
        app.saveFailKind = null;
        clearDraft(cr.pageId);
        app.lastDraftSavedAt = null;
        app.updatePageView?.();
      }
    } catch (e) {
      // Editor behält die eigene Fassung (dirty, Draft liegt) — der nächste
      // Save läuft über den OCC-Guard wieder in den Merge.
      console.warn('[cancelConflictResolution] reload failed', e);
    }
  },
};
