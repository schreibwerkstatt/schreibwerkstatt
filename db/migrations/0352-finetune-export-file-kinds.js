'use strict';
// finetune_export_files.kind-CHECK um 'val-persona' und 'val-editor'
// erweitern: Val hat je Aufgabenfamilie eine eigene Datei, zusammen ergeben
// sie genau `val` (routes/jobs/finetune-export/finalize.js). SQLite kann einen
// CHECK nicht per ALTER ändern → Recreate.

module.exports = {
  version: 352,
  fkOff: true,
  up(db) {
    db.exec(`
      DROP TABLE IF EXISTS finetune_export_files_new;
      CREATE TABLE finetune_export_files_new (
        export_id INTEGER NOT NULL REFERENCES finetune_exports(id) ON DELETE CASCADE,
        kind      TEXT    NOT NULL CHECK (kind IN ('train','val','all','eval','val-facts','val-writing','val-persona','val-refusal','val-editor')),
        data_gz   BLOB    NOT NULL,
        bytes     INTEGER NOT NULL,
        PRIMARY KEY (export_id, kind)
      );
      INSERT INTO finetune_export_files_new (export_id, kind, data_gz, bytes)
        SELECT export_id, kind, data_gz, bytes FROM finetune_export_files;
      DROP TABLE finetune_export_files;
      ALTER TABLE finetune_export_files_new RENAME TO finetune_export_files;
      CREATE INDEX IF NOT EXISTS idx_finetune_export_files_export_id ON finetune_export_files(export_id);
    `);
  },
};
