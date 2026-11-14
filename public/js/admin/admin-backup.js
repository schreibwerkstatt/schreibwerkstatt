// AdminBackupCard-Methods. Wird im adminBackupCard-Alpine-Scope gespreaded.
// Root-Zugriffe via window.__app. Kontoweites DB-Backup (Download eines
// konsistenten SQLite-Snapshots) + Restore (Upload → Validierung → Vormerkung
// → Neustart, beim Boot wird die DB geswappt). Backend: routes/admin-backup.js.
//
// Eine Vormerkung (`info.pending`) gilt fuer JEDEN naechsten Start, auch einen
// ungeplanten. Darum zeigt die Karte sie, solange sie liegt, und «Abbrechen»
// verwirft sie auf dem Server — nicht nur den Zustand der Karte.

import { fetchJson, sendJson, downloadHref } from '../utils.js';
import { tFetchError } from '../i18n.js';
import { adminLoaderMethods, assignIfChanged } from './admin-loader.js';
import { adminFormatMethods } from './admin-format.js';

// Neustart-Erkennung: erster Blick nach dem Exit, danach im Takt; nach der
// Frist gilt der Neustart als haengengeblieben.
const BOOT_FIRST_PROBE_MS = 2000;
const BOOT_PROBE_MS = 2000;
const BOOT_TIMEOUT_MS = 180000;

// Roher GET ohne den globalen fetch-Wrapper (app/boot/fetch-guard.js): nach dem
// Swap ist die Sitzung meist weg, und das erwartete 401 ist hier die Meldung
// «neuer Prozess antwortet» — kein Sitzungsablauf, den der Banner melden soll.
// Liefert { status, body } bzw. { status: 0 } ohne Antwort.
function probe(url) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.timeout = 5000;
    xhr.setRequestHeader('Cache-Control', 'no-store');
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* kein JSON */ }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = xhr.ontimeout = () => resolve({ status: 0, body: null });
    xhr.send();
  });
}

/** Antwortet der neue Prozess? `bootId` = Kennung des Prozesses vor dem Neustart. */
export function isNewProcess({ status, body }, bootId) {
  if (status === 0 || status === 503) return false;      // weg bzw. faehrt herunter
  if (status === 200) return !!body?.bootId && body.bootId !== bootId;
  return true;                                            // 401/403 …: neuer Prozess, Sitzung weg
}

export const adminBackupMethods = {
  // ── Lifecycle: backupEnter / backupRefresh / _backupLoad ─────────────────
  ...adminLoaderMethods('backup', {
    request: () => fetchJson('/admin/backup/info', { cache: 'no-store' }),
    apply(info, { silent }) { assignIfChanged(this, 'backupInfoData', info, silent); },
  }),

  // ── Download ───────────────────────────────────────────────────────────────
  // Zweistufig: der Snapshot entsteht per POST (ein Fehler kommt als JSON und
  // steht in der Karte), die fertige Datei holt der Browser per Einmal-Token
  // als Download ab — kein Buffern grosser Dateien im JS-Heap.
  async backupDownload() {
    if (this.backupDownloading) return;
    this.backupDownloading = true;
    this.backupDownloadError = '';
    try {
      const { token } = await fetchJson('/admin/backup/snapshot', { method: 'POST' });
      downloadHref('/admin/backup/download?token=' + encodeURIComponent(token));
    } catch (e) {
      this.backupDownloadError = this._backupErrText(e);
    } finally {
      this.backupDownloading = false;
    }
  },

  // ── Restore ─────────────────────────────────────────────────────────────────
  backupPickFile(e) {
    this.backupFile = e.target.files?.[0] || null;
    this.backupRestoreResult = null;
    this.backupRestoreError = '';
  },

  // Laedt die Datei hoch; der Server prueft sie und merkt sie vor. Die Datei
  // geht als Body direkt raus — kein Kopieren der ganzen DB in den JS-Heap.
  async backupUploadRestore() {
    if (!this.backupFile || this.backupRestoring) return;
    this.backupRestoring = true;
    this.backupRestoreError = '';
    this.backupRestoreResult = null;
    try {
      this.backupRestoreResult = await fetchJson('/admin/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: this.backupFile,
      });
    } catch (e) {
      this.backupRestoreError = this._backupErrText(e);
    } finally {
      this.backupRestoring = false;
      // Vormerkung (oder ihr Ausbleiben) aus Server-Sicht nachziehen.
      this._backupLoad({ silent: true });
    }
  },

  // «Abbrechen» nach dem Hochladen und «Verwerfen» im Hinweis: die Vormerkung
  // auf dem Server loeschen, sonst spielte der naechste Start sie ein.
  async backupDiscardPending() {
    if (this.backupDiscarding) return;
    this.backupDiscarding = true;
    this.backupRestoreError = '';
    try {
      await sendJson('/admin/backup/pending', 'DELETE');
      this._backupResetUpload();
      await this._backupLoad({ silent: true });
    } catch (e) {
      this.backupRestoreError = this._backupErrText(e);
    } finally {
      this.backupDiscarding = false;
    }
  },

  _backupResetUpload() {
    this.backupFile = null;
    this.backupRestoreResult = null;
    this.backupRestoreError = '';
    const el = this.$refs?.backupFileInput;
    if (el) el.value = '';
  },

  async backupConfirmRestart() {
    if (this.backupRestarting) return;
    const ok = await window.__app.appConfirm({
      message: window.__app.t('admin.backup.restartWarn'),
      confirmLabel: window.__app.t('admin.backup.restoreConfirmBtn'),
      danger: true,
    });
    if (!ok) return;
    const bootId = this.backupInfoData?.bootId || null;
    this.backupRestarting = true;
    this.backupRestartTimedOut = false;
    this.backupRestoreError = '';
    try {
      await fetchJson('/admin/backup/restart', { method: 'POST' });
    } catch (e) {
      // Ohne Antwort: der Server beendet sich womoeglich schon — weiter warten.
      // Mit Antwort (409 ohne Vormerkung, 403): nichts startet neu.
      if (e.status) {
        this.backupRestarting = false;
        this.backupRestoreError = this._backupErrText(e);
        this._backupLoad({ silent: true });
        return;
      }
    }
    this._backupWaitForBoot(bootId);
  },

  // Wartet, bis der neue Prozess antwortet, dann Reload (frische DB laden). Ob
  // der neue antwortet, entscheidet `isNewProcess`: jede Antwort ausser 503
  // (Herunterfahren) zaehlt, ein 200 nur mit gewechselter Boot-ID.
  _backupWaitForBoot(bootId) {
    const start = Date.now();
    const tick = async () => {
      if (isNewProcess(await probe('/admin/backup/info'), bootId)) {
        window.location.reload();
        return;
      }
      if (Date.now() - start > BOOT_TIMEOUT_MS) { this.backupRestartTimedOut = true; return; }
      setTimeout(tick, BOOT_PROBE_MS);
    };
    setTimeout(tick, BOOT_FIRST_PROBE_MS);
  },

  // ── Format / Labels ──────────────────────────────────────────────────────
  ...adminFormatMethods,

  _backupErrText(e) {
    return this._backupErrLabel(e?.code) || tFetchError(e);
  },

  _backupErrLabel(code) {
    if (!code) return '';
    const key = `admin.backup.err.${code}`;
    const t = window.__app.t(key);
    return t === key ? '' : t;
  },
};
