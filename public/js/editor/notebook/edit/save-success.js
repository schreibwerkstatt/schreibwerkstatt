// Teil von notebookEditMethods (siehe Facade edit.js): Nachbereitung eines
// erfolgreichen Page-Saves — geteilt von saveEdit, quickSave,
// submitConflictResolution und «Abschnitt teilen».
import { editorHost, isEmptyManuscript, isNoChange, stripLektoratMarks } from './_shared.js';
import { noteSaveRecovered } from '../save-outage.js';
import { notePageSaved } from '../../../usage-sessions.js';

export const saveSuccessMethods = {
  // Gemeinsame Nachbereitung nach jedem erfolgreichen Page-Save. Aufrufer:
  // saveEdit + quickSave + submitConflictResolution, jeweils im Haupt- und im
  // 409-Re-Merge-Pfad. Übernimmt den frischen Server-Stand, spiegelt Findings/
  // Stats, räumt Draft + Dirty-/Offline-/Conflict-Flags. Kein Teardown (Editor
  // bleibt offen) und kein setStatus — Wortlaut/Übergang entscheidet der
  // Aufrufer je nach Pfad. `applyToEditor` spiegelt das gespeicherte HTML in
  // den Live-Editor (Konflikt-Auflösungs-Pfade, damit Folge-Edits auf dem
  // gemergten Stand aufbauen).
  //
  // Der Editor bleibt waehrend des PUT beschreibbar. Was in dieser Zeit
  // getippt wurde, liegt weder auf dem Server noch (nach dem Draft-Räumen unten)
  // im Draft — darum wird der Live-Stand gegen das Gespeicherte geprueft: weicht
  // er ab, bleibt die Session dirty, der Draft wird auf der neuen Basis neu
  // geschrieben und der Autosave neu geplant. Rueckgabe `true` = es gibt noch
  // Ungespeichertes (saveEdit baut die Session dann nicht ab).
  //
  // Neue Basis ist die Antwort des Servers (`saved.html`), nicht das gesendete
  // HTML: der Server vergibt beim Write Block-IDs (lib/html-clean.js#
  // ensureBlockIds), und der nächste Block-Merge braucht als gemeinsamen
  // Vorfahren genau die Fassung, die ein anderes Gerät jetzt lädt. Die IDs
  // wandern per Attribut auch ins Live-DOM (kein Remount: Caret, IME und
  // Undo-Stack bleiben unberührt).
  _applySaveSuccess(saved, html, { pageId = null, applyToEditor = false } = {}) {
    const app = editorHost();
    if (!app) return false;
    const serverHtml = typeof saved?.html === 'string' ? saved.html : html;
    if (applyToEditor) this._applyMergedToEditor(html);
    const liveEl = !applyToEditor && app.editMode ? this._getEditEl?.() : null;
    const typedDuringSave = !!liveEl && !isNoChange(stripLektoratMarks(liveEl.innerHTML), html);
    if (saved?.updated_at && app.currentPage) app.currentPage.updated_at = saved.updated_at;
    app.originalHtml = serverHtml;
    this._ensureLiveBlockIds(serverHtml);
    app.currentPageEmpty = isEmptyManuscript(serverHtml);
    this._filterFindingsAfterSave(serverHtml);
    app._flushLektoratLiveApplied?.(serverHtml);
    app._syncPageStatsAfterSave?.(app.currentPage, serverHtml);
    // Sidebar-Lektorat-Status flippt auf 'warn' (updated_at > checkedAt) — Server-Map nachladen.
    app.refreshPageAges?.();
    // Nur den gesendeten Stand räumen: ein anderer Tab kann inzwischen einen
    // neueren Draft geschrieben haben.
    this._clearDraftIfSent(pageId ?? app.currentPage?.id, html);
    // Lief davor ein Save-Ausfall, jetzt als eine Zeile melden (save-outage.js).
    noteSaveRecovered(pageId ?? app.currentPage?.id);
    // Abschnitts-Besuch (`page.view`) trägt «geändert».
    notePageSaved(pageId ?? app.currentPage?.id);
    // Autosave-Zyklus schliessen: der Max-Timer läuft ab dem ERSTEN Dirty-Mark
    // und wird von `_scheduleAutosave` nur neu gesetzt, wenn er null ist. Ohne
    // Reset hier würde der 120-s-Cap der nächsten Tipp-Serie noch von der
    // Baseline vor diesem Save gemessen.
    this._clearAutosaveTimers();
    this._clearSaveRetry();
    app.lastAutosaveAt = Date.now();
    app.lastDraftSavedAt = null;
    app.draftPersistFailed = false;
    app.editDirty = false;
    app.saveOffline = false;
    app.saveFailKind = null;
    app.editConflict = null;
    if (typedDuringSave) {
      app.editDirty = true;
      this._flushDraftSaveNow();
      this._scheduleAutosave();
    }
    app.updatePageView?.();
    return typedDuringSave;
  },
};
