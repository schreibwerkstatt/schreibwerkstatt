'use strict';
// Admin-Tab „Backup": kontoweites DB-Backup + Restore. Weil die gesamte
// App-State in einer SQLite-Datei liegt, ist ein physischer Snapshot ein
// vollstaendiges Backup (siehe lib/db-backup.js).
//
//   GET  /admin/backup/info      → Groesse + Schema-Version + Pending-Flag
//   GET  /admin/backup/download  → gzip-Stream eines konsistenten Snapshots
//   POST /admin/backup/restore   → Upload validieren + als Pending ablegen
//   POST /admin/backup/restart   → App beenden (Prozess-Manager startet neu,
//                                  beim Boot wird der Pending-Restore geswappt)
//
// Restore ist zweistufig: /restore staged + validiert (kein Live-Swap moeglich,
// die App haelt die DB im WAL-Mode offen), /restart wendet ihn per Neustart an.
// Der Exit-Code ist bewusst != 0, damit die deployte systemd-Unit (Restart=
// on-failure) den Neustart ausloest — deckt auch Restart=always ab.

const express = require('express');
const fs = require('fs');
const zlib = require('zlib');
const { requireAdmin } = require('../lib/admin-mw');
const dbBackup = require('../lib/db-backup');
const logger = require('../logger');
const { sessionEmail } = require('../lib/acl');

const router = express.Router();
router.use(requireAdmin);

// Ganze DBs koennen gross sein — grosszuegiges Limit fuer den Restore-Upload.
const MAX_RESTORE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const rawBackupBody = express.raw({
  type: ['application/octet-stream', 'application/gzip', 'application/x-sqlite3'],
  limit: MAX_RESTORE_BYTES,
});

router.get('/info', (req, res) => {
  try {
    res.json(dbBackup.backupInfo());
  } catch (e) {
    logger.error(`admin-backup info failed: ${e.message}`);
    res.status(500).json({ error_code: 'INFO_FAILED', message: e.message });
  }
});

router.get('/download', (req, res) => {
  let snap;
  try {
    snap = dbBackup.createSnapshotFile();
  } catch (e) {
    logger.error(`admin-backup snapshot failed: ${e.message}`);
    return res.status(500).json({ error_code: 'SNAPSHOT_FAILED', message: e.message });
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="schreibwerkstatt-backup-${stamp}.sqlite.gz"`);

  let cleaned = false;
  const cleanup = () => { if (cleaned) return; cleaned = true; try { fs.rmSync(snap, { force: true }); } catch { /* ignore */ } };

  const read = fs.createReadStream(snap);
  const gz = zlib.createGzip();
  read.on('error', (e) => { logger.error(`admin-backup read: ${e.message}`); cleanup(); if (!res.headersSent) res.status(500).end(); else res.destroy(); });
  gz.on('error', (e) => { logger.error(`admin-backup gzip: ${e.message}`); cleanup(); res.destroy(); });
  res.on('close', cleanup);
  read.pipe(gz).pipe(res);
  logger.info(`[admin-backup] Download durch ${sessionEmail(req)}`);
});

router.post('/restore', rawBackupBody, (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error_code: 'EMPTY_UPLOAD' });
  }
  try {
    const info = dbBackup.stageRestore(req.body);
    logger.warn(`[admin-backup] Restore vorbereitet durch ${sessionEmail(req)} (Schema ${info.schemaVersion}, ${info.bytes} Bytes)`);
    res.json({ ok: true, ...info });
  } catch (e) {
    logger.error(`[admin-backup] Restore-Staging fehlgeschlagen: ${e.code || ''} ${e.message}`);
    res.status(400).json({ error_code: e.code || 'RESTORE_FAILED', message: e.message });
  }
});

router.post('/restart', (req, res) => {
  if (!dbBackup.hasPendingRestore()) {
    return res.status(409).json({ error_code: 'NO_PENDING_RESTORE' });
  }
  logger.warn(`[admin-backup] Neustart angefordert durch ${sessionEmail(req)} — beende Prozess zum Anwenden des Restores.`);
  res.json({ ok: true });
  // Kurze Verzoegerung, damit die Antwort raus ist. Gewollter Exit → 0 nach
  // sauberem DB-Close; Restart=always der Unit startet neu und swappt die
  // Pending-DB beim Boot ein.
  setTimeout(() => require('../lib/shutdown').requestShutdown('Admin-Restore'), 400);
});

module.exports = router;
