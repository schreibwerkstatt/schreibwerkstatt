'use strict';
// Sichtbarkeitsregel fuer die Anzeige fremder Konten (Email → Anzeigename),
// Quelle von `GET /me/users-light`.
//
// Wer sieht wen: der eigene Account und die Co-Mitglieder der Bücher, an denen
// der User beteiligt ist — in beide Richtungen (mit wem er geteilt hat und wer
// mit ihm teilt). Das sind genau die Personen, deren E-Mail er ohnehin ueber
// `GET /books/:book_id/access` sieht; die Anzeigename kommen nur zusaetzlich dazu,
// damit Revisions- und Toast-Listen statt einer nackten E-Mail einen Namen zeigen.
//
// `global_role` wird bewusst nicht geliefert: wer die Instanz-Verwaltung sieht,
// nutzt `GET /admin/users` (requireAdmin). Ein Konto, das niemandem etwas geteilt
// hat und in keinem Buch Mitarbeiter ist, sieht damit exakt eine Zeile — die eigene.
//
// Dies ist die einzige Stelle, die den Sichtkreis bestimmt; die Route delegiert nur.

const { db } = require('./connection');

function _normEmail(e) {
  return (e || '').toString().trim().toLowerCase();
}

// Status-Filter wie beim Teilen: gesperrte und geloeschte Kontona sind keine
// Adressen, die eine andere Rolle als 'inhaber' sehen sollte. `display_name`
// darf NULL sein (Konto ohne Anzeigename) — der Client faellt dann auf die E-Mail.
const _stmtVisibleUsers = db.prepare(`
  SELECT u.email, u.display_name
    FROM app_users u
   WHERE (u.email = :self COLLATE NOCASE
          OR EXISTS (SELECT 1
                       FROM book_access ba
                       JOIN book_access mine ON mine.book_id = ba.book_id
                      WHERE ba.user_email = u.email COLLATE NOCASE
                        AND mine.user_email = :self COLLATE NOCASE))
     AND u.status IN ('active', 'invited')
   ORDER BY u.email
`);

/**
 * Konten, die `email` in fremden Anzeigen benennen darf — inkl. des eigenen.
 * @returns {{email: string, display_name: string|null}[]}
 */
function visibleUserDirectory(email) {
  const self = _normEmail(email);
  if (!self) return [];
  return _stmtVisibleUsers.all({ self });
}

module.exports = { visibleUserDirectory };
