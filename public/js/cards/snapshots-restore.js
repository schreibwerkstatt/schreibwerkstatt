// Restore der Fassungen-Karte: ganzes Buch (Liste) und einzelne Seite/Kapitel
// (Reader). In snapshotsCard gespreadet (LOC-Split, analog snapshots-drift.js).
// Kein Getter — nur Methoden; State (restoringId/restoringNodeKey) lebt im
// Karten-Initializer.
//
// Server: POST /snapshots/:bookId/:id/restore bzw. …/restore-node. Beide schreiben
// an Ort und Stelle — bestehende Seiten behalten ihre ID (docs/fassungen.md).

// Fehlerantworten → anzeigbarer Text. RESTORE_RUNNING kommt, wenn fuer dieses
// Buch gerade ein anderer Restore laeuft (zweiter Tab, Mitautor).
function _restoreErrorMsg(app, code) {
  if (code === 'RESTORE_RUNNING') return app.t('snapshots.restoreRunning');
  return app.t('snapshots.restoreFailed') + ' ' + (code || '');
}

export const snapshotsRestoreMethods = {
  // 409 BOOK_BUSY: staerkere Bestaetigung mit den Namen der aktiven Mitautoren.
  _confirmBusy(body) {
    const app = window.__app;
    const who = Array.isArray(body?.editors) && body.editors.length
      ? body.editors.join(', ') : app.t('snapshots.busyOthers');
    return app.appConfirm({
      message: app.t('snapshots.busyConfirm', { who }),
      confirmLabel: app.t('snapshots.restore'),
      danger: true,
    });
  },

  // ── Ganzes Buch ──────────────────────────────────────────────────────────────
  async restoreSnapshot(snap, force = false) {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!snap?.id || !bookId || this.restoringId || this.deletingId) return;
    if (!force) {
      const ok = await app.appConfirm({
        message: app.t('snapshots.restoreConfirm', { n: snap.seq }),
        confirmLabel: app.t('snapshots.restore'),
        danger: true,
      });
      if (!ok) return;
    }
    this.restoringId = snap.id;
    try {
      const url = `/snapshots/${bookId}/${snap.id}/restore${force ? '?force=1' : ''}`;
      const r = await fetch(url, { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (r.status === 409 && body?.error_code === 'BOOK_BUSY') {
        // Buch wird gerade von anderen editiert → staerkere Bestaetigung mit den
        // aktiven Namen, dann mit force erneut (deren ungespeicherte Writes kollidieren).
        this.restoringId = null;
        if (await this._confirmBusy(body)) return this.restoreSnapshot(snap, true);
        return;
      }
      if (!r.ok) throw new Error(body?.error_code || `HTTP ${r.status}`);
      // Buchinhalt wurde serverseitig umgeschrieben → Tree neu laden und die
      // Fassungs-Liste auffrischen (Auto-Sicherung ist neu dazugekommen).
      await app.loadPages?.();
      await this.loadSnapshots(bookId, { fresh: true });
      if (body.failed) {
        app.setStatus?.(app.t('snapshots.restoredPartial', { n: snap.seq, failed: body.failed }), true, 8000);
      } else {
        app.setStatus?.(app.t('snapshots.restored', { n: snap.seq }), false, 5000);
      }
    } catch (e) {
      console.error('[snapshots:restore]', e);
      app.setStatus?.(_restoreErrorMsg(app, e.message), true, 6000);
    } finally {
      this.restoringId = null;
    }
  },

  // ── Einzelne Seite / einzelnes Kapitel (aus dem Reader) ───────────────────────
  // Reader-Sektion: kind 'page' (id = srcId) oder 'chapter' (chapterId = srcId).
  canRestoreNode(s) {
    return !!s && (s.kind === 'page' ? s.id != null : s.chapterId != null);
  },

  restoreNodeLabel(s) {
    const app = window.__app;
    if (this.restoringNodeKey === s.key) return app.t('snapshots.restoring');
    return app.t(s.kind === 'page' ? 'snapshots.restorePage' : 'snapshots.restoreChapter');
  },

  async restoreNode(s, force = false) {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    const snap = this.readerSnap;
    if (!snap?.id || !bookId || !this.canRestoreNode(s) || this.restoringNodeKey) return;
    const name = s.name || app.t('snapshots.untitled');
    if (!force) {
      const ok = await app.appConfirm({
        message: app.t(s.kind === 'page' ? 'snapshots.restorePageConfirm' : 'snapshots.restoreChapterConfirm',
          { name, n: snap.seq }),
        confirmLabel: app.t('snapshots.restore'),
        danger: true,
      });
      if (!ok) return;
    }
    this.restoringNodeKey = s.key;
    try {
      const url = `/snapshots/${bookId}/${snap.id}/restore-node${force ? '?force=1' : ''}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: s.kind, srcId: s.kind === 'page' ? s.id : s.chapterId }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.status === 409 && body?.error_code === 'BOOK_BUSY') {
        // Wie beim ganzen Buch: andere editieren gerade → staerkere Bestaetigung.
        this.restoringNodeKey = null;
        if (await this._confirmBusy(body)) return this.restoreNode(s, true);
        return;
      }
      if (!r.ok) throw new Error(body?.error_code || `HTTP ${r.status}`);
      await app.loadPages?.();
      if (body.failed) {
        app.setStatus?.(app.t('snapshots.restoredNodePartial', { name, failed: body.failed }), true, 8000);
      } else {
        app.setStatus?.(app.t('snapshots.restoredNode', { name }), false, 5000);
      }
      // Reader-Diff gegen den neuen Stand auffrischen + Drift nachziehen.
      this.restoringNodeKey = null;
      await this.openSnapshot(snap);
      this.loadDrift(bookId);
    } catch (e) {
      console.error('[snapshots:restoreNode]', e);
      app.setStatus?.(_restoreErrorMsg(app, e.message), true, 6000);
    } finally {
      this.restoringNodeKey = null;
    }
  },
};
