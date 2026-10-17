'use strict';
// Neues Buch MIT Eigentuemer anlegen — der eine Weg fuer alle Anlage-Pfade
// (Buch-Karte, .swbook-Import, Ordner-Import, Manuskript-Import).
//
// Ein Buch ohne `book_access`-Owner-Zeile ist fuer niemanden sichtbar und laesst
// sich auch nicht loeschen (die Buchliste filtert strikt ueber book_access).
// Darum gilt: entweder Buch + Owner + Grant, oder gar kein Buch. Der Owner
// steht schon im INSERT (`owner_email`), der Grant folgt direkt danach;
// scheitert er, wird das Buch wieder entfernt und der Aufrufer bekommt einen
// Fehler statt eines scheinbar erfolgreichen Buchs. Eine echte Transaktion geht
// nicht: die Facade ist async, better-sqlite3-Transaktionen sind synchron.

const contentStore = require('./content-store');
const bookAccess = require('../db/book-access');
const logger = require('../logger');

const BOOK_NAME_MAX = 255;

/** null = gueltig; sonst `NAME_REQUIRED` | `NAME_TOO_LONG`. Erwartet getrimmten Namen. */
function bookNameError(name) {
  const s = typeof name === 'string' ? name : '';
  if (!s) return 'NAME_REQUIRED';
  if (s.length > BOOK_NAME_MAX) return 'NAME_TOO_LONG';
  return null;
}

/**
 * @param {{ name: string, description?: string }} body
 * @param {string} email  kuenftiger Owner
 * @param {object} ctx    Facade-Kontext (req bzw. { session: { user: { email } } })
 * @returns {Promise<object>} das angelegte Buch
 */
async function createOwnedBook({ name, description = '' }, email, ctx) {
  if (!email) throw new Error('createOwnedBook: email required');
  const created = await contentStore.createBook({ name, description, owner_email: email }, ctx);
  try {
    bookAccess.grantAccess(created.id, email, 'owner', email);
  } catch (err) {
    logger.error(`Owner-Grant fuer book=${created.id} fehlgeschlagen, Buch wird zurueckgenommen: ${err.message}`);
    try {
      await contentStore.deleteBook(created.id, ctx);
    } catch (dErr) {
      logger.error(`Ruecknahme von book=${created.id} fehlgeschlagen: ${dErr.message}`);
    }
    const e = new Error('job.error.bookCreateFailed');
    e.code = 'BOOK_OWNER_GRANT_FAILED';
    e.cause = err;
    throw e;
  }
  return created;
}

module.exports = { createOwnedBook, bookNameError, BOOK_NAME_MAX };
