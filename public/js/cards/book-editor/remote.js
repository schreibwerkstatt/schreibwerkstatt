// Bucheditor: fremde Saves live übernehmen (anderer User, anderes Gerät,
// anderer Tab dieses Browsers). Meldung: EVT.PAGE_REMOTE_CHANGED aus der
// Collab-Schicht (app-collab.js#_applyCollabChanges, tree/catchup.js).
//
// Nur ein Block OHNE eigene Änderung zieht nach — dirty, laufender Save oder
// offener Konflikt bleiben, wie sie sind; dort greift beim nächsten Save der
// Block-Merge (book-editor/conflict.js). Der aktive Block wird über
// `_applyBlockHtml` geschrieben (Caret bleibt in seinem Block), sein Undo-
// Verlauf fällt wie bei jeder externen Übernahme — sonst holte Cmd+Z den alten
// Stand zurück und speicherte ihn über den fremden.
// Methoden werden in bookEditorCard gespreadet.

import { contentRepo } from '../../repo/content.js';

// Laufende Nachlade-Reads je Seite (Modul statt Karten-State: nichts davon ist
// Anzeige, und ein Set im Alpine-Proxy brauchte es nicht).
const inflight = new Set();

function busy(block) {
  return !block || block.dirty || block.saving || !!block.conflict;
}

export const bookEditorRemoteMethods = {
  async _pullRemoteBlock(pageId) {
    if (this.loading) return;
    const id = Number(pageId);
    if (busy(this._blockById(id))) return;
    // Mehrfach-Meldungen (Stream + Drift-Probe) für dieselbe Seite bündeln.
    if (inflight.has(id)) return;
    inflight.add(id);
    let remote;
    try { remote = await contentRepo.loadPage(id, { fresh: true }); }
    catch { return; }
    finally { inflight.delete(id); }
    const block = this._blockById(id);
    if (busy(block) || !remote?.updated_at) return;
    if (remote.updated_at === block.originalUpdatedAt) return;
    const html = remote.html || '';
    this._applyBlockHtml(block, html);
    block.originalHtml = html;
    block.originalUpdatedAt = remote.updated_at;
    this._writeBlockDraft?.(block);
    this._scheduleCommentRecompute?.();
  },
};
