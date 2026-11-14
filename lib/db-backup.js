'use strict';
// Server-Logik fuer das kontoweite DB-Backup (Admin-Console). Die gesamte
// App-State liegt in einer einzigen SQLite-Datei (Buecher/Seiten/User/ACLs/
// Figuren/Chats/Reviews/Caches/Settings + alle BLOBs: Cover, Chat-/Seiten-Bilder,
// Fonts). Ein physischer Snapshot ist damit ein vollstaendiges Backup — kein
// Tabellen-fuer-Tabelle-Serialisieren noetig.
//
// - createSnapshotFile(): konsistenter `VACUUM INTO`-Snapshot der Live-DB in eine
//   Temp-Datei NEBEN der DB (gleiches Filesystem → kein EXDEV beim spaeteren
//   Streamen); der Aufrufer gzippt + streamt + loescht.
// - stageRestore(buffer): validiert einen Upload (gzip ODER rohes SQLite),
//   prueft integrity_check/foreign_key_check/schema_version und legt ihn als
//   `<DB_FILE>.restore-pending` ab. Der eigentliche Swap passiert beim naechsten
//   Boot (db/apply-pending-restore.js) nach einem App-Neustart.
// - discardPendingRestore(): verwirft einen vorgemerkten Restore wieder — sonst
//   spielte der naechste Neustart (auch ein ungeplanter) das Backup ein.
// - prepareSnapshot()/takeSnapshot(): zweistufiger Download. Der Snapshot
//   entsteht in einem POST, dessen Fehler die Karte als JSON zeigen kann; der
//   eigentliche Download holt die fertige Datei per Einmal-Token ab und muss
//   nichts mehr pruefen, was scheitern koennte.

const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { db, DB_FILE } = require('../db/connection');
const { PENDING_SUFFIX } = require('../db/apply-pending-restore');

const GZIP_MAGIC = [0x1f, 0x8b];

// Kennung dieses Prozesses. Die Karte merkt sie sich vor dem Neustart und
// erkennt am Wechsel, dass der neue Prozess antwortet (die Sitzung ist nach dem
// Swap meist weg — ein 200 allein sagt nichts).
const BOOT_ID = `${process.pid}-${Date.now().toString(36)}`;
const SQLITE_HEADER = 'SQLite format 3';

function currentSchemaVersion() {
  try { return db.prepare('SELECT version FROM schema_version').get()?.version ?? null; }
  catch { return null; }
}

// Groessen-/Versions-Info fuer die Karte (inkl. -wal fuer eine realistische Zahl).
function backupInfo() {
  let bytes = 0;
  try { bytes += fs.statSync(DB_FILE).size; } catch { /* neue Installation */ }
  try { bytes += fs.statSync(DB_FILE + '-wal').size; } catch { /* kein WAL */ }
  const pending = pendingRestoreInfo();
  return {
    bytes,
    schemaVersion: currentSchemaVersion(),
    hasPending: !!pending,
    pending,
    bootId: BOOT_ID,
  };
}

function hasPendingRestore() {
  try { return fs.existsSync(DB_FILE + PENDING_SUFFIX); } catch { return false; }
}

// Groesse + Zeitpunkt des vorgemerkten Restores, `null` ohne Vormerkung.
function pendingRestoreInfo() {
  try {
    const st = fs.statSync(DB_FILE + PENDING_SUFFIX);
    return { bytes: st.size, stagedAt: st.mtime.toISOString() };
  } catch { return null; }
}

// Verwirft einen vorgemerkten Restore (samt halbfertiger Staging-Datei).
// Rueckgabe: true, wenn eine Vormerkung da war.
function discardPendingRestore() {
  const had = hasPendingRestore();
  fs.rmSync(DB_FILE + PENDING_SUFFIX, { force: true });
  fs.rmSync(`${DB_FILE}.restore-staging`, { force: true });
  return had;
}

// Konsistenter Snapshot der Live-DB. Temp-Datei liegt neben der DB (gleiches FS).
// Rueckgabe: Pfad der Snapshot-Datei; Aufrufer ist fuer das Loeschen zustaendig.
function createSnapshotFile() {
  const tmp = `${DB_FILE}.backup-tmp-${process.pid}-${Date.now()}`;
  fs.rmSync(tmp, { force: true });
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  return tmp;
}

// ── Zweistufiger Download ────────────────────────────────────────────────────
// Vorbereitete Snapshots: Token → { file, email, at }. Ein Token gilt einmal und
// SNAPSHOT_TTL_MS lang; nicht abgeholte Dateien raeumt der Sweep weg.
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const _prepared = new Map();

function _sweepPrepared(now = Date.now()) {
  for (const [token, p] of _prepared) {
    if (now - p.at < SNAPSHOT_TTL_MS) continue;
    _prepared.delete(token);
    try { fs.rmSync(p.file, { force: true }); } catch { /* ignore */ }
  }
}

function prepareSnapshot(email) {
  _sweepPrepared();
  const file = createSnapshotFile();
  const token = crypto.randomBytes(18).toString('base64url');
  _prepared.set(token, { file, email: email || null, at: Date.now() });
  const sweep = setTimeout(() => _sweepPrepared(), SNAPSHOT_TTL_MS + 1000);
  sweep.unref?.();
  return { token, bytes: fs.statSync(file).size };
}

// Liefert den Pfad des vorbereiteten Snapshots und verbraucht das Token. Nur
// derselbe Admin, der ihn angelegt hat, darf ihn abholen.
function takeSnapshot(token, email) {
  _sweepPrepared();
  const p = _prepared.get(String(token || ''));
  if (!p || (p.email && p.email !== (email || null))) return null;
  _prepared.delete(token);
  return fs.existsSync(p.file) ? p.file : null;
}

class RestoreError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Validiert + staged einen Upload. `buffer` = rohe Bytes (gzip oder SQLite).
// Wirft RestoreError (mit .code) bei ungueltigem Upload. Bei Erfolg:
// { schemaVersion, bytes }.
function stageRestore(buffer) {
  let raw = buffer;
  if (buffer.length >= 2 && buffer[0] === GZIP_MAGIC[0] && buffer[1] === GZIP_MAGIC[1]) {
    try { raw = zlib.gunzipSync(buffer); }
    catch (e) { throw new RestoreError('BAD_GZIP', `Gzip-Entpacken fehlgeschlagen: ${e.message}`); }
  }
  if (raw.length < 16 || raw.toString('latin1', 0, SQLITE_HEADER.length) !== SQLITE_HEADER) {
    throw new RestoreError('NOT_SQLITE', 'Datei ist keine SQLite-Datenbank.');
  }

  // Staging neben der DB (gleiches FS → atomarer rename spaeter).
  const staging = `${DB_FILE}.restore-staging`;
  fs.rmSync(staging, { force: true });
  fs.writeFileSync(staging, raw);

  let uploadedVersion = null;
  try {
    const check = new Database(staging, { readonly: true });
    try {
      const integ = check.pragma('integrity_check', { simple: true });
      if (integ !== 'ok') throw new RestoreError('INTEGRITY', `integrity_check: ${integ}`);
      const fk = check.pragma('foreign_key_check');
      if (fk.length) throw new RestoreError('FK', `foreign_key_check meldet ${fk.length} Verstoesse.`);
      uploadedVersion = check.prepare('SELECT version FROM schema_version').get()?.version ?? null;
      if (uploadedVersion == null) throw new RestoreError('NO_SCHEMA', 'Keine schema_version in der Datei.');
    } finally {
      check.close();
    }
  } catch (e) {
    fs.rmSync(staging, { force: true });
    if (e instanceof RestoreError) throw e;
    throw new RestoreError('OPEN_FAILED', `Datei nicht lesbar: ${e.message}`);
  }

  // Downgrade-Schutz: eine neuere Schema-Version laesst sich nicht auf aeltere
  // App-Version zurueckspielen (Migrationen sind nur vorwaerts).
  const running = currentSchemaVersion();
  if (running != null && uploadedVersion > running) {
    fs.rmSync(staging, { force: true });
    throw new RestoreError('SCHEMA_TOO_NEW',
      `Backup-Schema ${uploadedVersion} ist neuer als die laufende App (${running}). Zuerst App aktualisieren.`);
  }

  const pending = DB_FILE + PENDING_SUFFIX;
  fs.rmSync(pending, { force: true });
  fs.renameSync(staging, pending);
  return { schemaVersion: uploadedVersion, bytes: raw.length };
}

module.exports = {
  backupInfo,
  hasPendingRestore,
  discardPendingRestore,
  createSnapshotFile,
  prepareSnapshot,
  takeSnapshot,
  stageRestore,
  RestoreError,
};
