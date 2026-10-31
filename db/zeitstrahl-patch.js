'use strict';
// Ereignis-granulare Pflege (`PATCH /figures/zeitstrahl/:book_id/:event_id`): der
// Autor korrigiert ein Ereignis des konsolidierten Zeitstrahls in der
// Ereignisse-Karte. Muster: db/figures/patch.js (Steckbrief).
//
// Nur die uebergebenen Felder; Kapitel-, Abschnitts- und Figurenanker bleiben
// unberuehrt. Eine tatsaechliche Aenderung setzt `manually_edited = 1` — die
// Komplettanalyse ersetzt die Zeile danach nicht mehr (db/zeitstrahl.js
// #saveZeitstrahlEvents). Beim ersten Bearbeiten sichert der Pfad `ki_key`, den
// Vergleichsschluessel des bisherigen (= KI-)Stands: an ihm erkennt die naechste
// Analyse ihr eigenes Ereignis wieder und legt kein Doppel neben die gepflegte
// Zeile.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { parseDatum } = require('../lib/datum-parse');
const { structuredDatum } = require('./event-datum');
const { EVENT_SUBTYP_WL } = require('./event-subtyp');
require('./migrations');

// Feld → Maximallaenge (Text) bzw. erlaubte Werte (Schluessel).
const TEXT_FIELDS = { ereignis: 1000, datum_label: 100, bedeutung: 2000 };
const KEY_FIELDS = { typ: new Set(['persoenlich', 'extern']), subtyp: EVENT_SUBTYP_WL };

/** Prueft den PATCH-Body. Liefert `{ fields }` (getrimmt, '' → null) oder
 *  `{ error: { error_code, field?, reason? } }`. */
function validateEventPatch(body) {
  const src = body && typeof body === 'object' && body.fields && typeof body.fields === 'object'
    ? body.fields : null;
  if (!src || Array.isArray(src)) return { error: { error_code: 'INVALID_VALUE', field: 'fields' } };
  const fields = {};
  for (const [k, v] of Object.entries(src)) {
    if (v != null && typeof v !== 'string') return { error: { error_code: 'INVALID_VALUE', field: k } };
    const t = v == null ? '' : v.trim();
    if (TEXT_FIELDS[k]) {
      if (t.length > TEXT_FIELDS[k]) return { error: { error_code: 'INVALID_VALUE', field: k, reason: 'tooLong' } };
      fields[k] = t || null;
    } else if (KEY_FIELDS[k]) {
      if (!KEY_FIELDS[k].has(t)) return { error: { error_code: 'INVALID_VALUE', field: k } };
      fields[k] = t;
    } else {
      return { error: { error_code: 'INVALID_VALUE', field: k, reason: 'unknown' } };
    }
  }
  if (!Object.keys(fields).length) return { error: { error_code: 'INVALID_VALUE', field: 'fields', reason: 'empty' } };
  if ('ereignis' in fields && !fields.ereignis) return { error: { error_code: 'EVENT_TEXT_REQUIRED' } };
  return { fields };
}

const _txt = (x) => (x == null || x === '' ? null : String(x));

// Neues Datums-Label → alle Datums-Spalten. Derselbe Schreibpfad wie die Analyse
// (event-datum.js), damit «ca. 1985» hier wie dort zu Jahr + «unsicher» wird.
function _datumColumns(label) {
  if (!label) {
    return {
      datum: '', datum_label: null, datum_year: null, datum_month: null, datum_day: null,
      datum_ende_year: null, datum_ende_month: null, datum_ende_day: null,
      story_tag: null, datum_unsicher: 0,
    };
  }
  const sd = structuredDatum({ datum_label: label, datum_unsicher: !!parseDatum(label).unsicher });
  return {
    datum: label, datum_label: sd.datum_label,
    datum_year: sd.datum_year, datum_month: sd.datum_month, datum_day: sd.datum_day,
    datum_ende_year: sd.datum_ende_year, datum_ende_month: sd.datum_ende_month, datum_ende_day: sd.datum_ende_day,
    story_tag: sd.story_tag, datum_unsicher: sd.datum_unsicher,
  };
}

/** Schreibt die validierten `fields` auf das Ereignis (Buch, User).
 *  `groupKey` = cards/ereignisse/model.js#eventGroupKey (vom Aufrufer ueber die
 *  ESM-Bruecke geladen). Rueckgabe: null (nicht gefunden) oder `{ id, changed }`. */
function patchZeitstrahlEvent(bookId, userEmail, eventId, fields, groupKey) {
  return db.transaction(() => {
    const prev = db.prepare(
      'SELECT * FROM zeitstrahl_events WHERE id = ? AND book_id = ? AND user_email = ?'
    ).get(eventId, bookId, userEmail || '');
    if (!prev) return null;
    const changed = Object.keys(fields).filter(k =>
      k === 'datum_label' ? _txt(prev.datum_label || prev.datum) !== _txt(fields[k]) : _txt(prev[k]) !== _txt(fields[k]));
    if (!changed.length) return { id: prev.id, changed };
    const cols = {};
    for (const k of changed) {
      if (k === 'datum_label') Object.assign(cols, _datumColumns(fields[k]));
      else if (k === 'bedeutung') cols.bedeutung = fields[k];
      else cols[k] = fields[k];
    }
    // ki_key nur beim ersten Bearbeiten: solange die Zeile ungepflegt war, IST sie
    // der KI-Stand. Danach bleibt der Schluessel, auch wenn der Autor weiter aendert.
    if (!prev.manually_edited && prev.ki_key == null) cols.ki_key = groupKey(prev);
    const sets = Object.keys(cols).map(k => `${k} = @${k}`);
    db.prepare(`UPDATE zeitstrahl_events SET ${sets.join(', ')},
        manually_edited = 1, updated_at = ${NOW_ISO_SQL}
      WHERE id = @id`).run({ ...cols, id: prev.id });
    return { id: prev.id, changed };
  })();
}

module.exports = { validateEventPatch, patchZeitstrahlEvent };
