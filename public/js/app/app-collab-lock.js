// Soft-Edit-Lock: die Absicherung, mit der der Editor eine offene Seite gegen
// gleichzeitiges Schreiben schützt.
//
// Warum es einen Lock braucht, obwohl der Save selbst eine OCC-Prüfung trägt:
// der Server meldet einen fremden Lektorat-Lock mit 423 (der Schreibweg hängt
// sich daran nicht auf — `getBlockingLockFor` meldet nur 'lektorat'), und ein
// fremder 'edit'-Lock muss als Banner sichtbar werden, nicht als Fehler.
//
// Getrennt von app-collab.js: dort liegt der Collab-Feed (wer hat geschrieben),
// hier der Lock (wer darf gerade schreiben). Beides sind Root-Methoden.

export const appCollabLockMethods = {
  // Beim Editor-Start: POST /books/pages/:id/lock mit reason='edit'. Heartbeat
  // alle 5 Minuten (TTL 30min serverseitig). Bei 423 (fremder lektorat-Lock)
  // verweigern wir den Edit gar nicht — der PUT haengt sich daran nicht auf,
  // weil getBlockingLockFor nur 'lektorat' meldet (Phase 2 OCC reicht).
  // Fremder 'edit'-Lock landet als foreignEditLock im Banner.
  async _acquireEditLock(pageId) {
    if (!pageId) return null;
    try {
      const r = await fetch('/books/pages/' + pageId + '/lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'edit' }),
      });
      // Späte Antwort (anderer Abschnitt offen): Banner + globaler Lock-State gehören der neuen Session.
      if (r.status === 423) {
        if (!this.editMode || this.currentPage?.id !== pageId) return null;
        const body = await r.json().catch(() => ({}));
        this.$store.collab.foreignEditLock = {
          user_email: body.locked_by_email || null,
          user_display_name: this.userDisplayName?.(body.locked_by_email) || body.locked_by_email,
          expires_at: body.expires_at || null,
          reason: body.reason || 'lektorat',
        };
        return null;
      }
      if (!r.ok) return null;
      const data = await r.json();
      // startEdit wartet nicht hierauf: Session beendet → nur DIESEN Lock löschen, Heartbeat der neuen bleibt.
      if (!this.editMode || this.currentPage?.id !== pageId) { this._deleteEditLock(pageId); return null; }
      this.$store.collab._currentEditLock = data?.lock || null;
      this.$store.collab.foreignEditLock = null;
      this._startLockHeartbeat(pageId);
      return this.$store.collab._currentEditLock;
    } catch { return null; }
  },

  _startLockHeartbeat(pageId) {
    if (this.$store.collab._lockHeartbeatTimer) clearInterval(this.$store.collab._lockHeartbeatTimer);
    // 5min-Tick — Server-TTL ist 30min, doppelt-sicher gegen verlorene Pings.
    this.$store.collab._lockHeartbeatTimer = setInterval(() => {
      if (!this.$store.collab._currentEditLock || !pageId) return;
      this._sendLockHeartbeat(pageId);
    }, 5 * 60 * 1000);
  },

  async _sendLockHeartbeat(pageId) {
    try {
      const r = await fetch('/books/pages/' + pageId + '/lock/heartbeat', { method: 'POST' });
      if (r.status === 423) {
        // Anderer User hat in der Zwischenzeit (Hard-Pfad: 'lektorat') uebernommen.
        const body = await r.json().catch(() => ({}));
        this.$store.collab.foreignEditLock = {
          user_email: body.locked_by_email || null,
          user_display_name: this.userDisplayName?.(body.locked_by_email) || body.locked_by_email,
          expires_at: body.expires_at || null,
          reason: body.reason || 'lektorat',
        };
        this.$store.collab._currentEditLock = null;
        if (this.$store.collab._lockHeartbeatTimer) clearInterval(this.$store.collab._lockHeartbeatTimer);
        this.$store.collab._lockHeartbeatTimer = null;
        return;
      }
      if (!r.ok) return;
      const data = await r.json();
      this.$store.collab._currentEditLock = data?.lock || this.$store.collab._currentEditLock;
    } catch {}
  },

  _releaseEditLock(pageId) {
    if (this.$store.collab._lockHeartbeatTimer) {
      clearInterval(this.$store.collab._lockHeartbeatTimer);
      this.$store.collab._lockHeartbeatTimer = null;
    }
    this.$store.collab._currentEditLock = null;
    this._deleteEditLock(pageId);
  },

  // Nur der Server-DELETE, ohne globalen State — für verspätete Lock-Antworten.
  _deleteEditLock(pageId) {
    if (!pageId) return;
    try {
      fetch('/books/pages/' + pageId + '/lock', { method: 'DELETE' }).catch(() => {});
    } catch {}
  },

  // Best-Effort-Release beim Tab-Close. `navigator.sendBeacon` kann nur POST,
  // die Lock-Route braucht DELETE — darum `fetch` mit `keepalive: true`: der
  // Browser laesst den Request auch waehrend `beforeunload`/`pagehide` zu Ende
  // laufen, ein normales fetch bricht er dort oft ab.
  _beaconReleaseEditLock(pageId) {
    if (!pageId) return;
    try {
      fetch('/books/pages/' + pageId + '/lock', { method: 'DELETE', keepalive: true }).catch(() => {});
    } catch {}
  },
};
