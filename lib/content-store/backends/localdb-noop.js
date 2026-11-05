'use strict';
// No-op-Save-Erkennung: der Client schickt exakt den Stand, der schon
// gespeichert ist (Editor ohne Aenderung, Autosave, Outbox-Wiederholung).
// Dann gibt es nichts zu schreiben — sonst bummt jeder No-op-Save den
// Zeitstempel, schreibt eine Revision, reindiziert FTS/Belege/Verweise und
// loest ein Change-Event aus (andere Tabs laden den Abschnitt neu), obwohl
// sich nichts geaendert hat.
//
// Vergleich ueber den BEREINIGTEN Body: gespeichert ist ebenfalls der
// bereinigte Body, beide liefen durch dieselbe Bereinigung. Die Bestaetigung
// laeuft atomar ueber die WHERE-Bedingung — aenderte die Row zwischen SELECT
// und UPDATE, gilt der Save NICHT als No-op (der normale Pfad mit seiner
// Konfliktpruefung greift). Die Save-Kennung wird dabei gesetzt: eine
// Wiederholung mit derselben Kennung bleibt so als solche erkennbar.

const { db } = require('../../../db/connection');

// true, wenn der Save als No-op bestaetigt wurde (nichts geschrieben).
function claimNoOpSave(pageId, cleanHtml, saveId) {
  const cur = db.prepare('SELECT updated_at, body_html FROM pages WHERE page_id = ?').get(pageId);
  if (!cur || cur.body_html !== cleanHtml) return false;
  const noop = db.prepare(
    'UPDATE pages SET last_save_id = ? WHERE page_id = ? AND updated_at = ? AND body_html = ?',
  ).run(saveId, pageId, cur.updated_at, cleanHtml);
  return noop.changes > 0;
}

module.exports = { claimNoOpSave };
