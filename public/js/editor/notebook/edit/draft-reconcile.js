// Teil von notebookEditMethods (siehe Facade edit.js): Draft-Wiederaufnahme
// gegen den Server-Stand beim Eintritt in den Edit-Modus (lifecycle.js#startEdit).
import { FEATURE_BLOCK_MERGE, editorHost, isOwnSentSave, isOwnServerSave, mergeBlocks, mergedToHtml, NOTEBOOK_WRITER, remoteAuthorFrom, trackMerge } from './_shared.js';
import { reportConflictShown } from '../conflict-report.js';

export const draftReconcileMethods = {

  // Draft-Wiederaufnahme in startEdit: ein Draft trägt seine eigene Basis
  // (`originalHtml` + `originalUpdatedAt` beim Schreiben). Ist die Seite seither
  // weitergeschrieben worden (anderes Gerät, anderer User), steht der Server-
  // Stand von heute als Base und Stempel im Editor — `draft.html` direkt
  // einzusetzen hiesse: der nächste Save läuft ohne 409 durch und nimmt die
  // Remote-Änderung still zurück. Darum 3-Way gegen den Server-Stand, mit der
  // Draft-Basis als gemeinsamem Vorfahren:
  //   { html }            — Basis aktuell, oder kollisionsfrei gemergt
  //   { html, conflict }  — echte Kollision; Aufrufer öffnet die Auflösung
  //   { html, rebase }    — Ansicht älter als die Draft-Basis; Aufrufer setzt
  //                          `rebase` als Basis + Stempel und zieht frisch nach
  // Ohne Draft-Basis (Alt-Draft) oder ohne Merge bleibt es beim Draft.
  _reconcileDraftWithServer(draft) {
    const app = editorHost();
    const serverHtml = app.originalHtml || '';
    const serverAt = app.currentPage?.updated_at || null;
    if (!FEATURE_BLOCK_MERGE || !draft.originalUpdatedAt || !serverAt
        || draft.originalUpdatedAt === serverAt || !draft.originalHtml) {
      return { html: draft.html };
    }
    // Die Leseansicht kann aus dem SW-Cache stammen (Stale-While-Revalidate)
    // und älter sein als der Stand, auf dem der Draft aufbaut. Ein Merge gegen
    // sie liefe rückwärts: was seither geschrieben wurde, sähe aus, als hätte
    // «die andere Seite» es gelöscht. Die Draft-Basis ist dann der jüngste
    // bekannte Server-Stand — sie wird Basis, der nächste Save (bzw. der
    // Nachzug in startEdit) merged gegen den echten Server-Stand.
    if (Date.parse(serverAt) < Date.parse(draft.originalUpdatedAt)) {
      return { html: draft.html, rebase: { html: draft.originalHtml, updatedAt: draft.originalUpdatedAt } };
    }
    // Server-Stand ist ein Zwischenstand, den dieser Tab selbst gegen die
    // Draft-Basis geschickt hat (Antwort verloren, danach neu geladen): der
    // Draft ist sein Nachfahre.
    const author = remoteAuthorFrom(app.currentPage);
    const ownFp = isOwnSentSave(app.currentPage.id, serverHtml, [draft.originalUpdatedAt]) || isOwnServerSave(NOTEBOOK_WRITER, app.currentPage.id, author.remoteSaveId, draft.ownSaveIds);
    if (ownFp) return { html: draft.html };
    let m;
    try { m = mergeBlocks(draft.originalHtml, draft.html, serverHtml); }
    catch (e) {
      console.warn('[draftRestore] merge failed, restore draft as-is', e);
      return { html: draft.html };
    }
    if (m.conflicts.length === 0) {
      trackMerge('silent_success');
      return { html: mergedToHtml(m.merged), merged: true };
    }
    reportConflictShown({
      pageId: app.currentPage.id, via: 'draft', baseAt: draft.originalUpdatedAt, remoteAt: serverAt, author, ownFp,
      baseHtml: draft.originalHtml, localHtml: draft.html, remoteHtml: serverHtml, conflicts: m.conflicts,
    });
    return { html: draft.html, conflict: { merged: m.merged, conflicts: m.conflicts, remoteUpdatedAt: serverAt, author } };
  },
};
