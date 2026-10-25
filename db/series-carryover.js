'use strict';
// «Aus Vorband übernehmen»: kopiert Figuren, Schauplätze und Welt-Fakten aus dem
// eigenen Katalog eines Vorbands als vom Autor gepflegte Einträge in den neuen Band.
// Die Kopie ist eigenständig (je Buch, je User), trägt aber ihre Herkunft
// (`origin_figure_id`/`origin_location_id`). Die Analyse respektiert sie:
// - Figuren: `ki_name` leer → fehlt die Figur im Text, wird sie nicht als
//   «nicht mehr im Text» markiert (figures/save.js#_reconcileFiguren).
// - Orte: `manually_created = 1` → dasselbe für Schauplätze (locations-write.js).
// - Fakten: `manually_edited = 1` → überleben den Full-Replace (world-facts.js).
// Nicht mitkopiert werden Bezüge auf Kapitel/Abschnitte des Vorbands (Vorkommen,
// erste Erwähnung, Schlüsselzitate, Bogen, Präsenz) — deren IDs gehören zum alten Buch.

const { db } = require('./connection');
require('./migrations');
const { NOW_ISO_SQL } = require('./now');
const { factKey } = require('./world-facts');

const FIG_COPY_COLS = [
  'name', 'kurzname', 'typ', 'geburtstag', 'geschlecht', 'beruf', 'beschreibung',
  'sozialschicht', 'rolle', 'motivation', 'konflikt', 'entwicklung', 'wohnadresse',
  'aeusseres', 'stimme', 'hintergrund', 'sort_order',
];
const LOC_COPY_COLS = [
  'name', 'typ', 'beschreibung', 'stimmung', 'sort_order', 'lat', 'lng', 'land', 'geo_query', 'geo_land',
];

const _norm = s => String(s || '').trim().toLocaleLowerCase('de');

function _targetState(targetBookId, email) {
  const figs = db.prepare('SELECT name, origin_figure_id FROM figures WHERE book_id = ? AND user_email IS ?')
    .all(targetBookId, email);
  const locs = db.prepare('SELECT name, origin_location_id FROM locations WHERE book_id = ? AND user_email IS ?')
    .all(targetBookId, email);
  const facts = db.prepare('SELECT subjekt, fakt FROM world_facts WHERE book_id = ? AND user_email IS ?')
    .all(targetBookId, email);
  return {
    figOrigin: new Set(figs.map(r => r.origin_figure_id).filter(v => v != null)),
    figName: new Set(figs.map(r => _norm(r.name))),
    locOrigin: new Set(locs.map(r => r.origin_location_id).filter(v => v != null)),
    locName: new Set(locs.map(r => _norm(r.name))),
    factKeys: new Set(facts.map(r => factKey(r.subjekt, r.fakt))),
  };
}

/** Übernehmbare Einträge des Vorbands (eigener Katalog, ohne «nicht mehr im Text»),
 *  je mit `vorhanden` = im Zielband schon da (gleiche Herkunft oder gleicher Name/Aussage). */
function listCarryoverCandidates(sourceBookId, targetBookId, userEmail) {
  const email = userEmail || null;
  const t = _targetState(targetBookId, email);
  const figuren = db.prepare(`
    SELECT id, name, typ, manually_edited FROM figures
     WHERE book_id = ? AND user_email IS ? AND stale = 0 ORDER BY sort_order, name`).all(sourceBookId, email)
    .map(r => ({ id: r.id, name: r.name, typ: r.typ || null, gepflegt: !!r.manually_edited,
      vorhanden: t.figOrigin.has(r.id) || t.figName.has(_norm(r.name)) }));
  const orte = db.prepare(`
    SELECT id, name, typ, manually_edited, manually_created FROM locations
     WHERE book_id = ? AND user_email IS ? AND stale = 0 ORDER BY sort_order, name`).all(sourceBookId, email)
    .map(r => ({ id: r.id, name: r.name, typ: r.typ || null, gepflegt: !!(r.manually_edited || r.manually_created),
      vorhanden: t.locOrigin.has(r.id) || t.locName.has(_norm(r.name)) }));
  const fakten = db.prepare(`
    SELECT id, kategorie, subjekt, fakt, manually_edited FROM world_facts
     WHERE book_id = ? AND user_email IS ? ORDER BY sort_order, id`).all(sourceBookId, email)
    .map(r => ({ id: r.id, kategorie: r.kategorie, subjekt: r.subjekt || null, fakt: r.fakt,
      gepflegt: !!r.manually_edited, vorhanden: t.factKeys.has(factKey(r.subjekt, r.fakt)) }));
  return { figuren, orte, fakten };
}

/** Ausgewählte Einträge kopieren. Schon vorhandene werden übersprungen.
 *  sel: { figuren: number[], orte: number[], fakten: number[] } (IDs im Vorband).
 *  @returns {{ figuren: number, orte: number, fakten: number, beziehungen: number, figureIds: number[], locationIds: number[] }} */
function copyFromPrequel(sourceBookId, targetBookId, userEmail, sel = {}) {
  const email = userEmail || null;
  const ids = k => new Set((sel[k] || []).map(Number).filter(Number.isInteger));
  const want = { fig: ids('figuren'), loc: ids('orte'), fact: ids('fakten') };

  return db.transaction(() => {
    const t = _targetState(targetBookId, email);
    const out = { figuren: 0, orte: 0, fakten: 0, beziehungen: 0, figureIds: [], locationIds: [] };

    // Figuren + Aliasse + Eigenschaften.
    const srcFigs = db.prepare(`SELECT * FROM figures WHERE book_id = ? AND user_email IS ? AND stale = 0`)
      .all(sourceBookId, email).filter(r => want.fig.has(r.id));
    const insFig = db.prepare(`
      INSERT INTO figures (${FIG_COPY_COLS.join(', ')}, book_id, user_email, fig_id, manually_edited, ki_name,
        origin_figure_id, stale, updated_at)
      VALUES (${FIG_COPY_COLS.map(c => '@' + c).join(', ')}, @book_id, @user_email, @fig_id, 1, NULL,
        @origin, 0, ${NOW_ISO_SQL})`);
    const parkFig = db.prepare("UPDATE figures SET fig_id = 'man_' || id WHERE id = ?");
    const insAlias = db.prepare('INSERT OR IGNORE INTO figure_aliases (figure_id, book_id, alias) VALUES (?, ?, ?)');
    const insTag = db.prepare('INSERT OR IGNORE INTO figure_tags (figure_id, tag) VALUES (?, ?)');
    const selAlias = db.prepare('SELECT alias FROM figure_aliases WHERE figure_id = ?');
    const selTag = db.prepare('SELECT tag FROM figure_tags WHERE figure_id = ?');
    const figMap = new Map();
    for (const r of srcFigs) {
      if (t.figOrigin.has(r.id) || t.figName.has(_norm(r.name))) continue;
      const row = Object.fromEntries(FIG_COPY_COLS.map(c => [c, r[c] ?? null]));
      const id = insFig.run({ ...row, book_id: targetBookId, user_email: email, fig_id: `carry_${r.id}`, origin: r.id })
        .lastInsertRowid;
      parkFig.run(id);
      for (const a of selAlias.all(r.id)) insAlias.run(id, targetBookId, a.alias);
      for (const g of selTag.all(r.id)) insTag.run(id, g.tag);
      figMap.set(r.id, id);
      t.figName.add(_norm(r.name));
      out.figuren++;
      out.figureIds.push(id);
    }

    // Beziehungen zwischen übernommenen Figuren: vom Autor übernommen → origin 'manual',
    // damit die Analyse sie nicht als eigene KI-Kanten neu aufbaut. Belege bleiben weg
    // (Zitate aus dem Vorband).
    if (figMap.size) {
      const rels = db.prepare(`
        SELECT from_fig_id, to_fig_id, typ, beschreibung, machtverhaltnis FROM figure_relations
         WHERE book_id = ? AND user_email IS ?`).all(sourceBookId, email);
      const insRel = db.prepare(`
        INSERT OR IGNORE INTO figure_relations (book_id, from_fig_id, to_fig_id, typ, beschreibung, machtverhaltnis, user_email, origin)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')`);
      for (const r of rels) {
        const a = figMap.get(r.from_fig_id);
        const b = figMap.get(r.to_fig_id);
        if (a == null || b == null) continue;
        out.beziehungen += insRel.run(targetBookId, a, b, r.typ, r.beschreibung, r.machtverhaltnis, email).changes;
      }
    }

    // Schauplätze; Hierarchie nur, wenn der Elternort mitkommt.
    const srcLocs = db.prepare(`SELECT * FROM locations WHERE book_id = ? AND user_email IS ? AND stale = 0`)
      .all(sourceBookId, email).filter(r => want.loc.has(r.id));
    const insLoc = db.prepare(`
      INSERT INTO locations (${LOC_COPY_COLS.join(', ')}, book_id, user_email, loc_id, manually_edited,
        manually_created, ki_name, origin_location_id, stale, updated_at)
      VALUES (${LOC_COPY_COLS.map(c => '@' + c).join(', ')}, @book_id, @user_email, @loc_id, 1, 1, NULL,
        @origin, 0, ${NOW_ISO_SQL})`);
    const parkLoc = db.prepare("UPDATE locations SET loc_id = 'man_' || id WHERE id = ?");
    const locMap = new Map();
    for (const r of srcLocs) {
      if (t.locOrigin.has(r.id) || t.locName.has(_norm(r.name))) continue;
      const row = Object.fromEntries(LOC_COPY_COLS.map(c => [c, r[c] ?? null]));
      const id = insLoc.run({ ...row, book_id: targetBookId, user_email: email, loc_id: `carry_${r.id}`, origin: r.id })
        .lastInsertRowid;
      parkLoc.run(id);
      locMap.set(r.id, id);
      t.locName.add(_norm(r.name));
      out.orte++;
      out.locationIds.push(id);
    }
    const setParent = db.prepare('UPDATE locations SET parent_id = ? WHERE id = ?');
    for (const r of srcLocs) {
      const child = locMap.get(r.id);
      const parent = r.parent_id != null ? locMap.get(r.parent_id) : null;
      if (child != null && parent != null) setParent.run(parent, child);
    }

    // Welt-Fakten, ohne Kapitel-Brücke (die baut die nächste Analyse des Bandes).
    const srcFacts = db.prepare('SELECT id, kategorie, subjekt, fakt FROM world_facts WHERE book_id = ? AND user_email IS ? ORDER BY sort_order, id')
      .all(sourceBookId, email).filter(r => want.fact.has(r.id));
    const { m } = db.prepare('SELECT MIN(sort_order) AS m FROM world_facts WHERE book_id = ? AND user_email IS ?')
      .get(targetBookId, email);
    let order = (m ?? 0) - srcFacts.length;
    const insFact = db.prepare(`
      INSERT INTO world_facts (book_id, kategorie, subjekt, fakt, sort_order, user_email, manually_edited, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ${NOW_ISO_SQL})`);
    for (const r of srcFacts) {
      const key = factKey(r.subjekt, r.fakt);
      if (t.factKeys.has(key)) continue;
      insFact.run(targetBookId, r.kategorie, r.subjekt, r.fakt, order++, email);
      t.factKeys.add(key);
      out.fakten++;
    }
    return out;
  })();
}

module.exports = { listCarryoverCandidates, copyFromPrequel };
