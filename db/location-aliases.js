'use strict';
// Dauerhafte Namens-Aliasse eines Schauplatzes (`location_aliases`, Migration 360).
//
// Ein Alias ist ein vom Autor bestätigter Name, unter dem der Ort im Text ebenfalls
// steht — er entsteht beim manuellen Zusammenführen (Name/ki_name der weggemergten
// Quelle, db/entity-merge.js#mergeLocations). Gelesen wird er vom Cross-Run-Abgleich
// (locations-write.js#planOrteMatch → lib/entity-match.js#matchLocations), damit der
// weggemergte Ort bei der nächsten Komplettanalyse nicht als eigener Eintrag
// wiederkehrt. Muster db/figures/aliases.js: Anzeigeform speichern, über
// normLocName vergleichen.

const { db } = require('./connection');
require('./migrations');
const { normLocName } = require('../lib/entity-match');

const MAX_ALIAS_LEN = 200;

/** Aliasse aller Orte eines Buchs/Users: Map(locations.id → [alias]). */
function listLocationAliasesByLocation(bookId, userEmail) {
  const rows = db.prepare(`
    SELECT a.location_id, a.alias FROM location_aliases a
    JOIN locations l ON l.id = a.location_id
    WHERE l.book_id = ? AND l.user_email IS ?
    ORDER BY a.id`).all(bookId, userEmail || null);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.location_id)) out.set(r.location_id, []);
    out.get(r.location_id).push(r.alias);
  }
  return out;
}

/** Hängt `names` als Aliasse an den Ort `locationId` (Buch `bookId`). Übergeht leere
 *  Namen, Namen mit derselben Normalform wie Name/ki_name des Orts und vorhandene
 *  Aliasse. Liefert die tatsächlich angelegten. Läuft im Transaktions-Kontext des
 *  Aufrufers (Merge). */
function addLocationAliases(locationId, bookId, names) {
  const loc = db.prepare('SELECT name, ki_name FROM locations WHERE id = ? AND book_id = ?').get(locationId, bookId);
  if (!loc) return [];
  const seen = new Set([normLocName(loc.name), normLocName(loc.ki_name)].filter(Boolean));
  for (const r of db.prepare('SELECT alias FROM location_aliases WHERE location_id = ?').all(locationId)) {
    seen.add(normLocName(r.alias));
  }
  const ins = db.prepare('INSERT OR IGNORE INTO location_aliases (location_id, book_id, alias) VALUES (?, ?, ?)');
  const added = [];
  for (const raw of names || []) {
    const alias = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, MAX_ALIAS_LEN);
    const key = normLocName(alias);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (ins.run(locationId, bookId, alias).changes) added.push(alias);
  }
  return added;
}

/** Liefert ein Lauf neben dem Namen eines Bestandsorts auch einen seiner Aliasse, sind
 *  das zwei Einträge für denselben Ort — der Abgleich könnte nur einen davon zuordnen,
 *  der andere würde eine neue Zeile. Faltet solche Alias-Einträge in den Eintrag mit
 *  dem Namen (Kapitel, Figuren vereinigt, leere Texte gefüllt). Pur bis auf das Lesen
 *  der Aliasse; `orte` bleibt unverändert. Liefert { orte, foldedNames: [[Name]] je
 *  Index } — die gefalteten Namen braucht die Szenen-Auflösung als Alias. */
function foldIncomingAliases(bookId, userEmail, orte) {
  const aliasMap = listLocationAliasesByLocation(bookId, userEmail);
  const foldedNames = (orte || []).map(() => []);
  if (!aliasMap.size || !orte?.length) return { orte: orte || [], foldedNames };
  const names = new Map(db.prepare(
    'SELECT id, COALESCE(ki_name, name) AS n FROM locations WHERE book_id = ? AND user_email IS ?',
  ).all(bookId, userEmail || null).map(r => [r.id, normLocName(r.n)]));
  const idxByNorm = new Map();
  orte.forEach((o, i) => { const k = normLocName(o?.name); if (k && !idxByNorm.has(k)) idxByNorm.set(k, i); });
  const out = orte.map(o => ({ ...o }));
  const drop = new Set();
  for (const [locId, aliases] of aliasMap) {
    const j = idxByNorm.get(names.get(locId));
    if (j == null) continue;
    for (const a of aliases) {
      const k = idxByNorm.get(normLocName(a));
      if (k == null || k === j || drop.has(k)) continue;
      _foldInto(out[j], out[k]);
      foldedNames[j].push(out[k].name);
      drop.add(k);
    }
  }
  if (!drop.size) return { orte, foldedNames };
  const keep = out.map((_, i) => i).filter(i => !drop.has(i));
  return { orte: keep.map(i => out[i]), foldedNames: keep.map(i => foldedNames[i]) };
}

function _foldInto(target, src) {
  const kapName = k => (typeof k === 'object' && k ? k.name : k);
  const kap = [...(target.kapitel || [])];
  for (const k of (src.kapitel || [])) if (!kap.some(x => kapName(x) === kapName(k))) kap.push(k);
  target.kapitel = kap;
  for (const f of ['figuren', 'figuren_namen']) {
    if (target[f] || src[f]) target[f] = [...new Set([...(target[f] || []), ...(src[f] || [])])];
  }
  for (const f of ['typ', 'beschreibung', 'stimmung', 'land', 'erste_erwaehnung']) {
    if (!target[f] && src[f]) target[f] = src[f];
  }
}

module.exports = { listLocationAliasesByLocation, addLocationAliases, foldIncomingAliases };
