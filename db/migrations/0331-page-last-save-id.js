'use strict';
// pages.last_save_id: Kennung (UUID vom Client) des Saves, der den aktuellen
// body_html geschrieben hat. Ein Client, dessen Save-Antwort unterwegs verloren
// ging (Zug, Funkloch), schickt beim nächsten Save die Kennungen seiner
// unbestätigten Saves mit; steht eine davon hier, ist der Server-Stand sein
// eigener und der Save läuft trotz abweichendem Stempel durch (lib/content-store
// /backends/localdb.js#savePage). Jeder Body-Write ohne Kennung setzt NULL —
// danach erkennt sich niemand mehr als Urheber. Keine FK: die Kennung zeigt auf
// keine Tabelle, sie ist ein Idempotenz-Schlüssel.
module.exports = {
  version: 331,
  up(db) {
    const cols = db.prepare('PRAGMA table_info(pages)').all().map((c) => c.name);
    if (!cols.includes('last_save_id')) {
      db.exec('ALTER TABLE pages ADD COLUMN last_save_id TEXT');
    }
  },
};
