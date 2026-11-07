const path = require('path');
const Database = require('better-sqlite3');
const { applyPendingRestore } = require('./apply-pending-restore');

// Unter `node --test` (NODE_TEST_CONTEXT gesetzt) ohne DB_PATH oeffnete ein Test die
// Dev-DB des Entwicklers — die Seed-Helper leeren dort `books`/`pages`. Darum hier
// auf eine Wegwerf-DB je Prozess umleiten (beim Exit geloescht). Tests, die die DB
// gezielt nutzen, nehmen weiterhin tests/unit/_helpers/tmp-db.js bzw.
// tests/integration/_helpers/setup.js.
let _testGuardDb = false;
if (!process.env.DB_PATH && process.env.NODE_TEST_CONTEXT) {
  _testGuardDb = true;
  const fs = require('fs');
  const os = require('os');
  let base = os.tmpdir();
  try { fs.accessSync('/dev/shm', fs.constants.W_OK); base = '/dev/shm'; } catch { /* tmpdir */ }
  const file = path.join(base, `sw-test-guard-${process.pid}-${Date.now()}.db`);
  process.env.DB_PATH = file;
  process.on('exit', () => {
    for (const s of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(file + s); } catch { /* weg */ } }
  });
}
const DB_FILE = process.env.DB_PATH || path.join(__dirname, '..', 'schreibwerkstatt.db');

// Admin-DB-Restore: liegt eine validierte Pending-Datei vor, wird die DB VOR dem
// Oeffnen geswappt (Sicherheitskopie inklusive). Schlaegt das fehl, brechen wir
// den Boot ab — lieber sichtbar als still auf einer halb-getauschten DB laufen.
try {
  applyPendingRestore(DB_FILE);
} catch (e) {
  console.error(`[db-restore] Pending-Restore FEHLGESCHLAGEN, Boot abgebrochen: ${e.message}`);
  throw e;
}

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
// Wegwerf-Test-DBs brauchen keine Crash-Durability. `synchronous = OFF` (DB_FSYNC=off,
// nur in den Test-Scripts gesetzt) eliminiert jeden fsync — auf langsamem CI-Storage
// (Ceph RBD) stallt ein einzelner Commit-fsync sonst zig Sekunden. In Prod nie gesetzt.
db.pragma(process.env.DB_FSYNC === 'off' ? 'synchronous = OFF' : 'synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('cache_size = -65536');
db.pragma('mmap_size = 268435456');
db.pragma('temp_store = MEMORY');
db.pragma('busy_timeout = 5000');
db.pragma('wal_autocheckpoint = 1000');
// Wegwerf-DB des Test-Schutzes: Module, die beim Laden Statements vorbereiten
// (Font-Cache, Quellen …), brauchen das Schema schon vor runMigrations().
if (_testGuardDb) db.exec(require('./squashed-schema').SQUASHED_SCHEMA);

module.exports = { db, DB_FILE };
