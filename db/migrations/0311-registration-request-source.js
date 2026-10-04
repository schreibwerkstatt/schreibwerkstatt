'use strict';
// Herkunft einer Zugangsanfrage.
//
// source:      automatisch erfasst — Kampagnen-Parameter (utm_*/ref) des Einstiegslinks
//              oder die externe Seite, von der der Besucher kam (lib/register-source.js).
// source_note: Selbstauskunft aus dem Formular („Wie hast du von uns erfahren?").
//
// Beides ist Freitext ohne Bezug auf andere Tabellen; die Zeile faellt mit der
// Anfrage (Konto-Loeschung fegt registration_requests per email).
module.exports = {
  version: 311,
  up(db) {
    const cols = new Set(db.prepare('PRAGMA table_info(registration_requests)').all().map(c => c.name));
    if (!cols.has('source')) db.exec('ALTER TABLE registration_requests ADD COLUMN source TEXT');
    if (!cols.has('source_note')) db.exec('ALTER TABLE registration_requests ADD COLUMN source_note TEXT');
  },
};
