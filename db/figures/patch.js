// Figur-granulare Katalog-Pflege (`PATCH /figures/:book_id/:fig_id`): der Autor
// korrigiert einzelne Stammdaten einer Figur in der Figurenkarte (Steckbrief).
//
// Anders als der Katalog-PUT (`saveFigurenToDb`, Modus figId) ersetzt der PATCH
// nicht den ganzen Katalog — er schreibt nur die uebergebenen Felder dieser einen
// Figur. Beziehungen, Eigenschaften, Kapitel-Auftritte und alle Referenzen bleiben
// unberuehrt; ein zweiter Tab mit einem aelteren Katalogstand kann so nichts
// zuruecksetzen.
//
// Eine tatsaechliche Aenderung setzt `manually_edited = 1` (Autorenpflege schlaegt
// Analyse, docs/komplett.md). Vor dem Umschalten werden die `ki_*`-Vergleichswerte
// aus dem bisherigen Stand gesichert, falls sie fehlen: solange die Figur
// ungepflegt war, IST ihr Katalogwert der Analysewert — nach dem Umschalten misst
// der Cross-Run-Abgleich gegen genau diesen Wert, nicht gegen die Korrektur.

const { db } = require('../connection');
const { NOW_ISO_SQL } = require('../now');
require('../migrations');

// Feld → Maximallaenge. Bewusst nur Stammdaten des Steckbriefs (Teilmenge von
// save.js#CURATED_FIELDS); der strukturierte Bogen (`arc`) und die Eigenschaften
// laufen weiter ueber den Katalog-PUT.
const PATCHABLE_FIELDS = {
  name: 200, kurzname: 200, typ: 40, geschlecht: 60, geburtstag: 100, beruf: 200,
  rolle: 400, wohnadresse: 400, praesenz: 40, sozialschicht: 40,
  aeusseres: 4000, stimme: 4000, hintergrund: 4000, beschreibung: 4000,
  motivation: 4000, konflikt: 4000, entwicklung: 4000,
};
// Schluessel-Felder: das Frontend waehlt aus einer festen Liste (Combobox);
// serverseitig nur die Form pruefen — die Listen sind SSoT im Browser-Bundle
// (figur-typen.js, i18n figuren.praesenz.* / figuren.schicht.*).
const KEY_FIELDS = new Set(['typ', 'praesenz', 'sozialschicht']);
const KEY_RE = /^[a-z_]*$/;

/** Prueft den PATCH-Body. Liefert `{ fields }` (normalisiert: getrimmt, '' → null)
 *  oder `{ error: { error_code, field? } }`. */
function validateFigurePatch(body) {
  const src = body && typeof body === 'object' && body.fields && typeof body.fields === 'object'
    ? body.fields : null;
  if (!src || Array.isArray(src)) return { error: { error_code: 'INVALID_VALUE', field: 'fields' } };
  const fields = {};
  for (const [k, v] of Object.entries(src)) {
    const max = PATCHABLE_FIELDS[k];
    if (!max) return { error: { error_code: 'INVALID_VALUE', field: k, reason: 'unknown' } };
    if (v != null && typeof v !== 'string') return { error: { error_code: 'INVALID_VALUE', field: k } };
    const t = v == null ? '' : v.trim();
    if (t.length > max) return { error: { error_code: 'INVALID_VALUE', field: k, reason: 'tooLong' } };
    if (KEY_FIELDS.has(k) && !KEY_RE.test(t)) return { error: { error_code: 'INVALID_VALUE', field: k } };
    fields[k] = t || null;
  }
  if (!Object.keys(fields).length) return { error: { error_code: 'INVALID_VALUE', field: 'fields', reason: 'empty' } };
  if ('name' in fields && !fields.name) return { error: { error_code: 'NAME_REQUIRED' } };
  return { fields };
}

const _txt = (x) => (x == null || x === '' ? null : String(x));

/** Schreibt die validierten `fields` auf die Figur (fig_id, Buch, User).
 *  Rueckgabe: null (nicht gefunden) oder `{ id, changed: [feld], nameChanged }`. */
function patchFigure(bookId, userEmail, figId, fields) {
  return db.transaction(() => {
    const prev = db.prepare(
      'SELECT * FROM figures WHERE fig_id = ? AND book_id = ? AND user_email IS ?'
    ).get(figId, bookId, userEmail || null);
    if (!prev) return null;
    const changed = Object.keys(fields).filter(k => _txt(prev[k]) !== _txt(fields[k]));
    if (!changed.length) return { id: prev.id, changed, nameChanged: false };
    const sets = changed.map(k => `${k} = @${k}`);
    // RHS-Spalten lesen den Stand VOR dem Update: die ki_*-Sicherung nimmt also den
    // bisherigen (= Analyse-)Wert, nicht die Korrektur.
    db.prepare(`
      UPDATE figures SET ${sets.join(', ')},
        ki_name       = CASE WHEN manually_edited = 0 THEN COALESCE(ki_name, name) ELSE ki_name END,
        ki_geschlecht = CASE WHEN manually_edited = 0 THEN COALESCE(ki_geschlecht, geschlecht) ELSE ki_geschlecht END,
        ki_geburtstag = CASE WHEN manually_edited = 0 THEN COALESCE(ki_geburtstag, geburtstag) ELSE ki_geburtstag END,
        manually_edited = 1,
        updated_at = ${NOW_ISO_SQL}
      WHERE id = @id`).run({ ...Object.fromEntries(changed.map(k => [k, fields[k]])), id: prev.id });
    return { id: prev.id, changed, nameChanged: changed.includes('name') || changed.includes('kurzname') };
  })();
}

module.exports = { PATCHABLE_FIELDS, validateFigurePatch, patchFigure };
