// AdminBackupCard-Methods. Wird im adminBackupCard-Alpine-Scope gespreaded.
// Root-Zugriffe via window.__app. Kontoweites DB-Backup (Download eines
// konsistenten SQLite-Snapshots) + Restore (Upload → Validierung → Neustart,
// beim Boot wird die DB geswappt). Backend: routes/admin-backup.js.

import { fmtBytes, fetchJson } from '../utils.js';
import { sameData } from '../utils/same-data.js';
import { tFetchErrorRaw } from '../i18n.js';

export const adminBackupMethods = {
  // ── Lifecycle ────────────────────────────────────────────────────────────
  async backupEnter() {
    if (this.backupInitialized) return;
    this.backupInitialized = true;
    await this._backupLoadInfo();
  },

  /** `silent`: Tab-Rueckkehr — Abschnitte bleiben stehen, gleiche Daten werden
   *  verworfen, ein Fehler aendert nichts. */
  async _backupLoadInfo({ silent = false } = {}) {
    if (!silent) {
      this.backupLoading = true;
      this.backupError = '';
    }
    try {
      const info = await fetchJson('/admin/backup/info', { cache: 'no-store' });
      if (!silent || !sameData(info, this.backupInfoData)) this.backupInfoData = info;
    } catch (e) {
      if (!silent) this.backupError = tFetchErrorRaw(e);
    } finally {
      if (!silent) this.backupLoading = false;
    }
  },

  backupRefresh() {
    this.backupInitialized = false;
    return this.backupEnter();
  },

  // ── Download ───────────────────────────────────────────────────────────────
  // Über Browser-Navigation (Auth-Cookie wird mitgeschickt, kein Buffern grosser
  // Dateien im JS-Heap). Der Server streamt gzip direkt in den Download.
  backupDownload() {
    this.backupDownloading = true;
    window.location.assign('/admin/backup/download');
    setTimeout(() => { this.backupDownloading = false; }, 4000);
  },

  // ── Restore ─────────────────────────────────────────────────────────────────
  backupPickFile(e) {
    this.backupFile = e.target.files?.[0] || null;
    this.backupRestoreResult = null;
    this.backupRestoreError = '';
  },

  async backupUploadRestore() {
    if (!this.backupFile || this.backupRestoring) return;
    this.backupRestoring = true;
    this.backupRestoreError = '';
    this.backupRestoreResult = null;
    try {
      const buf = await this.backupFile.arrayBuffer();
      this.backupRestoreResult = await fetchJson('/admin/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
      });
    } catch (e) {
      this.backupRestoreError = this._backupErrLabel(e.code) || e.body?.message || tFetchErrorRaw(e);
    } finally {
      this.backupRestoring = false;
    }
  },

  backupCancelRestore() {
    this.backupFile = null;
    this.backupRestoreResult = null;
    this.backupRestoreError = '';
    const el = this.$refs?.backupFileInput;
    if (el) el.value = '';
  },

  async backupConfirmRestart() {
    if (this.backupRestarting) return;
    this.backupRestarting = true;
    this.backupRestartTimedOut = false;
    try {
      // Roher fetch: der Server beendet sich, eine Antwort ist nicht garantiert.
      await fetch('/admin/backup/restart', { method: 'POST', credentials: 'same-origin' });
    } catch { /* Server beendet sich — Fehler erwartet */ }
    this._backupWaitForBoot();
  },

  // Pollt /info bis der Server wieder antwortet, dann Reload (frische DB laden).
  _backupWaitForBoot() {
    const start = Date.now();
    const tick = async () => {
      try {
        const r = await fetch('/admin/backup/info', { credentials: 'same-origin', cache: 'no-store' });
        if (r.ok) { window.location.reload(); return; }
      } catch { /* noch nicht oben */ }
      if (Date.now() - start > 180000) { this.backupRestartTimedOut = true; return; }
      setTimeout(tick, 2500);
    };
    setTimeout(tick, 4000);
  },

  // ── Format / Labels ──────────────────────────────────────────────────────
  backupFmtBytes(n) {
    return fmtBytes(n, Alpine.store('shell').uiLocale);
  },

  _backupErrLabel(code) {
    if (!code) return '';
    const key = `admin.backup.err.${code}`;
    const t = window.__app.t(key);
    return t === key ? '' : t;
  },
};
