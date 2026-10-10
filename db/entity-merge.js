'use strict';
// Manuelles Zusammenfuehren zweier Katalog-Eintraege (Figur / Schauplatz / Szene).
//
// Anlass: der Reconcile der Komplettanalyse (db/figures.js#saveFigurenToDb,
// db/schema.js#saveOrteToDb, lib/entity-match.js) loescht nicht mehr gefundene
// Eintraege NICHT, sondern markiert sie `stale = 1`. Fuer die gab es bisher nur
// «loeschen» — und damit den Verlust aller Verknuepfungen, die am verwaisten
// Eintrag hingen (Plot-Beats, Recherche-Links, manuell editierte Ereignisse).
// Hier ist der Gegenpart: Referenzen auf einen bestehenden Eintrag umhaengen,
// dann die Quelle loeschen.
//
// SSoT-Anspruch: das ist die EINZIGE Stelle, die zwei Katalog-Zeilen verschmilzt.
// Die Tabellenliste kommt aus `REFERENCES figures|locations|figure_scenes` im
// Schema; wer eine neue Bruecke auf eine dieser drei PKs anlegt, ergaenzt sie hier
// (sonst faellt sie beim Merge still per CASCADE weg).
//
// Drei Konfliktmuster, je nach Constraint der Bruecke:
//   Composite-PK       → INSERT OR IGNORE … SELECT + DELETE der Quell-Zeilen
//   Zaehl-Bruecke      → ON CONFLICT DO UPDATE SET haeufigkeit/count = Summe
//   UNIQUE-Index/Tupel → UPDATE OR IGNORE + DELETE der uebrig gebliebenen Reste
//
// BEWUSST NICHT umgehaengt, sondern fallen gelassen — abgeleitete Indexe, die ihr
// eigener Job per Full-Replace neu aufbaut; ein Remap erzeugte dort nur einen
// falschen Zwischenstand:
//   semantic_chunks        → CASCADE beim Loeschen der Quelle (FK figure_id/location_id/…;
//                            embed-index baut neu)
//   motif_occurrences      → CASCADE beim Loeschen der Quelle (motif-scan baut neu)
//   plot_beat_occurrences  → CASCADE beim Loeschen der Quelle (beat-anchor baut neu)
// `page_figure_mentions` wird trotzdem summiert umgehaengt (statt nur geloescht),
// damit der Stand auch ohne anschliessendes recomputeBookFigureMentions nie
// schlechter ist als vorher.
//
// Der FTS-Index bleibt Sache des Callers (searchIndex.remove/upsert) — genau wie
// bei den bestehenden Einzel-Delete-Handlern in routes/figures.js. Der Embedding-
// Index braucht keinen Caller-Schritt: seine Zeilen fallen per FK-CASCADE mit der
// Quelle. Dieses Modul haelt sich frei von lib/-Abhaengigkeiten.
//
// Figuren tragen einen persistenten Alias: Name und Kurzname der Quelle (samt deren
// eigenen Aliassen) landen in `figure_aliases` des Ziels (db/figures/aliases.js).
// Der Cross-Run-Abgleich der Komplettanalyse (planFigurenMatch) und die Namens-
// Aufloesung der Szenen/Ereignisse (buildFigNameLookup) lesen sie — steht der Name
// der Quelle noch im Buchtext, landet er beim naechsten Lauf auf dem Ziel statt als
// neuer Eintrag. Zusaetzlich wandert der Quell-Name als `kurzname` ans Ziel (falls
// dort leer), damit der Erwaehnungs-Scan (lib/page-index.js) ihn mitzaehlt.
// GRENZE: Schauplaetze und Szenen haben keinen Alias — dort kann ein Eintrag mit
// dem Namen der Quelle beim naechsten Lauf neu entstehen.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { normName } = require('../lib/name-normalize');
const { relationKey } = require('./figures/refs');
const { addFigureAliases } = require('./figures/aliases');

// Skalar-Felder, die aus der Quelle nachgefuellt werden — aber NUR, wenn sie beim
// Ziel leer sind. Bestandswerte des Ziels werden nie ueberschrieben (Muster
// `if (!canon[field] && other[field])` aus routes/jobs/komplett/figuren-merge.js).
const FIG_FILL = ['kurzname', 'typ', 'geburtstag', 'geschlecht', 'beruf', 'beschreibung',
  'sozialschicht', 'praesenz', 'rolle', 'motivation', 'konflikt', 'entwicklung',
  'erste_erwaehnung', 'erste_erwaehnung_page_id', 'schluesselzitate', 'wohnadresse',
  'aeusseres', 'stimme', 'hintergrund', 'arc'];
// `figures.meta` fehlt hier bewusst: die Spalte wird nirgends gelesen oder
// geschrieben (Altlast) — ein unbekannter Blob soll nicht mitwandern.
const LOC_FILL = ['typ', 'beschreibung', 'erste_erwaehnung', 'erste_erwaehnung_page_id',
  'stimmung', 'lat', 'lng', 'land', 'geo_query', 'geo_land', 'parent_id'];

// true, wenn `ancestorId` der Ort `id` selbst oder einer seiner Vorfahren ist —
// entlang locations.parent_id, mit Deckel gegen Altlast-Zyklen.
function _isAncestorOrSelf(ancestorId, id) {
  const up = db.prepare('SELECT parent_id FROM locations WHERE id = ?');
  for (let cur = id, i = 0; cur != null && i < 64; i++) {
    if (cur === ancestorId) return true;
    cur = up.get(cur)?.parent_id ?? null;
  }
  return false;
}
const SCENE_FILL = ['wertung', 'kommentar', 'chapter_id', 'page_id'];

// Laedt Quelle + Ziel und stellt sicher, dass beide zu (bookId, userEmail) gehoeren.
// Wirft bei Verstoss — die user-sichtbare Validierung (404/409) macht die Route,
// dieser Guard faengt Programmierfehler und Cross-Book-Zugriffe ab.
function _loadPair(table, bookId, userEmail, sourceId, targetId) {
  if (!Number.isInteger(sourceId) || !Number.isInteger(targetId)) {
    throw new Error(`${table}-Merge: ungueltige ids (${sourceId} → ${targetId}).`);
  }
  if (sourceId === targetId) throw new Error(`${table}-Merge: Quelle und Ziel sind identisch (${sourceId}).`);
  const rows = db.prepare(
    `SELECT * FROM ${table} WHERE id IN (?, ?) AND book_id = ? AND user_email IS ?`
  ).all(sourceId, targetId, bookId, userEmail || null);
  const source = rows.find(r => r.id === sourceId);
  const target = rows.find(r => r.id === targetId);
  if (!source || !target) {
    throw new Error(`${table}-Merge: Quelle oder Ziel nicht in Buch ${bookId} des Users gefunden.`);
  }
  return { source, target };
}

// Fuellt leere Ziel-Spalten aus der Quelle. `extra` erlaubt zusaetzliche, vom
// Aufrufer berechnete Werte (z.B. den Quell-Namen als kurzname).
// Gibt die Liste der tatsaechlich gefuellten Spalten zurueck.
function _fillEmpty(table, fields, source, target, extra = {}) {
  const sets = [];
  const vals = [];
  const filled = [];
  for (const f of fields) {
    const cur = target[f];
    const next = Object.prototype.hasOwnProperty.call(extra, f) ? extra[f] : source[f];
    const curEmpty = cur === null || cur === undefined || cur === '';
    const nextHas = next !== null && next !== undefined && next !== '';
    if (curEmpty && nextHas) { sets.push(`${f} = ?`); vals.push(next); filled.push(f); }
  }
  if (!sets.length) {
    db.prepare(`UPDATE ${table} SET updated_at = ${NOW_ISO_SQL} WHERE id = ?`).run(target.id);
    return filled;
  }
  db.prepare(`UPDATE ${table} SET ${sets.join(', ')}, updated_at = ${NOW_ISO_SQL} WHERE id = ?`)
    .run(...vals, target.id);
  return filled;
}

// ── Figuren ───────────────────────────────────────────────────────────────────
// Verschmilzt `sourceId` in `targetId` und loescht die Quelle. Eine Transaktion.
// Gibt { moved, filled, eventsDeduped, relationsDropped, draftsUnlinked,
// aliasesAdded } zurueck.
function mergeFigures(bookId, userEmail, sourceId, targetId) {
  const em = userEmail || null;
  return db.transaction(() => {
    const { source, target } = _loadPair('figures', bookId, em, sourceId, targetId);
    const moved = {};

    // Eigenschaften-Tags (PK figure_id+tag).
    moved.tags = db.prepare(
      'INSERT OR IGNORE INTO figure_tags (figure_id, tag) SELECT ?, tag FROM figure_tags WHERE figure_id = ?'
    ).run(targetId, sourceId).changes;
    db.prepare('DELETE FROM figure_tags WHERE figure_id = ?').run(sourceId);

    // Kapitel-Vorkommen: Haeufigkeiten addieren (beide Figuren koennen im selben
    // Kapitel auftreten). WHERE im SELECT ist bei INSERT..SELECT..ON CONFLICT
    // Pflicht, sonst ist `ON` fuer den Parser ein Join.
    moved.appearances = db.prepare(`
      INSERT INTO figure_appearances (figure_id, chapter_id, haeufigkeit)
        SELECT ?, chapter_id, haeufigkeit FROM figure_appearances WHERE figure_id = ?
      ON CONFLICT(figure_id, chapter_id) DO UPDATE SET haeufigkeit = haeufigkeit + excluded.haeufigkeit
    `).run(targetId, sourceId).changes;
    db.prepare('DELETE FROM figure_appearances WHERE figure_id = ?').run(sourceId);

    // Seiten-Nennungen (abgeleitet, Caller rechnet idealerweise neu — Summe haelt
    // den Stand bis dahin brauchbar).
    moved.mentions = db.prepare(`
      INSERT INTO page_figure_mentions (page_id, figure_id, count, first_offset)
        SELECT page_id, ?, count, first_offset FROM page_figure_mentions WHERE figure_id = ?
      ON CONFLICT(page_id, figure_id) DO UPDATE SET
        count = page_figure_mentions.count + excluded.count,
        first_offset = MIN(COALESCE(page_figure_mentions.first_offset, excluded.first_offset),
                           COALESCE(excluded.first_offset, page_figure_mentions.first_offset))
    `).run(targetId, sourceId).changes;
    db.prepare('DELETE FROM page_figure_mentions WHERE figure_id = ?').run(sourceId);

    // Lebensereignisse: alle umhaengen, danach Dubletten entfernen. Dedup-Schluessel
    // wie in routes/jobs/komplett/remap.js (Datum + Ereignis-Text); bei Gleichstand
    // gewinnt die manuell editierte Zeile — sie traegt die Arbeit des Autors.
    moved.events = db.prepare('UPDATE figure_events SET figure_id = ? WHERE figure_id = ?')
      .run(targetId, sourceId).changes;
    const evRows = db.prepare(
      'SELECT id, datum_year, datum_month, datum_day, ereignis, manually_edited FROM figure_events WHERE figure_id = ?'
    ).all(targetId);
    const evSeen = new Map();
    const evDrop = [];
    for (const ev of evRows.slice().sort((a, b) =>
      (b.manually_edited - a.manually_edited) || (a.id - b.id))) {
      const key = [ev.datum_year ?? '', ev.datum_month ?? '', ev.datum_day ?? '',
        String(ev.ereignis || '').trim().toLowerCase()].join('|');
      if (evSeen.has(key)) evDrop.push(ev.id);
      else evSeen.set(key, ev.id);
    }
    if (evDrop.length) {
      const delEv = db.prepare('DELETE FROM figure_events WHERE id = ?');
      for (const id of evDrop) delEv.run(id);
    }

    // Beziehungen: beide Richtungen umbiegen. `OR IGNORE` laesst Zeilen stehen, die
    // in UNIQUE(book_id, from, to, typ, user_email) laufen wuerden — die sind echte
    // Dubletten und werden danach geloescht. Selbstbezug (Quelle war mit dem Ziel
    // verbunden) entsteht erst durch das Remap und muss weg.
    const relFrom = db.prepare(
      'UPDATE OR IGNORE figure_relations SET from_fig_id = ? WHERE book_id = ? AND user_email IS ? AND from_fig_id = ?'
    ).run(targetId, bookId, em, sourceId).changes;
    const relTo = db.prepare(
      'UPDATE OR IGNORE figure_relations SET to_fig_id = ? WHERE book_id = ? AND user_email IS ? AND to_fig_id = ?'
    ).run(targetId, bookId, em, sourceId).changes;
    moved.relations = relFrom + relTo;
    // Eine vom Autor angelegte Beziehung der Quelle, die am Ziel auf eine gleiche
    // laeuft (Rest des OR IGNORE), vererbt ihre Herkunft: sonst baute die naechste
    // Komplettanalyse die ueberlebende 'ki'-Zeile neu auf und die Autorenarbeit fehlte.
    const promote = db.prepare(
      "UPDATE figure_relations SET origin = 'manual' WHERE book_id = ? AND user_email IS ? AND from_fig_id = ? AND to_fig_id = ? AND typ = ?"
    );
    for (const r of db.prepare(
      "SELECT from_fig_id, to_fig_id, typ FROM figure_relations WHERE origin = 'manual' AND (from_fig_id = ? OR to_fig_id = ?)"
    ).all(sourceId, sourceId)) {
      const from = r.from_fig_id === sourceId ? targetId : r.from_fig_id;
      const to   = r.to_fig_id   === sourceId ? targetId : r.to_fig_id;
      if (from !== to) promote.run(bookId, em, from, to, r.typ);
    }
    let relationsDropped = db.prepare(
      'DELETE FROM figure_relations WHERE from_fig_id = ? OR to_fig_id = ?'
    ).run(sourceId, sourceId).changes;
    relationsDropped += db.prepare(
      'DELETE FROM figure_relations WHERE from_fig_id = to_fig_id AND from_fig_id = ?'
    ).run(targetId).changes;
    // Paar-Dubletten, die nach dem Remap doppelt am Ziel haengen: gleicher Typ in
    // beiden Richtungen (A→B, B→A freund) ODER das inverse Paar eines gerichteten
    // Typs (A→B elternteil ≡ B→A kind). Schluessel ist derselbe `relationKey`, mit dem
    // der Analyse-Schreibpfad manuelle gegen KI-Beziehungen abgleicht — verschiedene
    // Typen auf einem Paar bleiben stehen. Die vom Autor angelegte Zeile
    // (origin='manual') gewinnt vor der der Analyse.
    const relRows = db.prepare(
      "SELECT id, from_fig_id, to_fig_id, typ, beschreibung FROM figure_relations WHERE book_id = ? AND user_email IS ? AND (from_fig_id = ? OR to_fig_id = ?) ORDER BY (origin = 'manual') DESC, id"
    ).all(bookId, em, targetId, targetId);
    const relSeen = new Set();
    for (const r of relRows) {
      const key = relationKey(r.from_fig_id, r.to_fig_id, r.typ);
      if (relSeen.has(key)) {
        db.prepare('DELETE FROM figure_relations WHERE id = ?').run(r.id);
        relationsDropped++;
      } else relSeen.add(key);
    }

    // Composite-PK-Bruecken. Kein Buch-Scope-Subselect noetig: die Quell-Figur ist
    // oben als zu diesem Buch gehoerend verifiziert, und die Bruecken haengen an ihr.
    moved.scenes = db.prepare(
      'INSERT OR IGNORE INTO scene_figures (scene_id, figure_id) SELECT scene_id, ? FROM scene_figures WHERE figure_id = ?'
    ).run(targetId, sourceId).changes;
    db.prepare('DELETE FROM scene_figures WHERE figure_id = ?').run(sourceId);

    moved.locations = db.prepare(
      'INSERT OR IGNORE INTO location_figures (location_id, figure_id) SELECT location_id, ? FROM location_figures WHERE figure_id = ?'
    ).run(targetId, sourceId).changes;
    db.prepare('DELETE FROM location_figures WHERE figure_id = ?').run(sourceId);

    moved.songs = db.prepare(
      'INSERT OR IGNORE INTO song_figures (song_id, figure_id, kontext_typ) SELECT song_id, ?, kontext_typ FROM song_figures WHERE figure_id = ?'
    ).run(targetId, sourceId).changes;
    db.prepare('DELETE FROM song_figures WHERE figure_id = ?').run(sourceId);

    moved.motifs = db.prepare(
      'INSERT OR IGNORE INTO motif_figures (motif_id, figure_id) SELECT motif_id, ? FROM motif_figures WHERE figure_id = ?'
    ).run(targetId, sourceId).changes;
    db.prepare('DELETE FROM motif_figures WHERE figure_id = ?').run(sourceId);

    moved.beats = db.prepare(
      'INSERT OR IGNORE INTO plot_beat_figures (beat_id, figure_id) SELECT beat_id, ? FROM plot_beat_figures WHERE figure_id = ?'
    ).run(targetId, sourceId).changes;
    db.prepare('DELETE FROM plot_beat_figures WHERE figure_id = ?').run(sourceId);

    // Recherche-Links: UNIQUE-Index ueber das COALESCE-Tupel → OR IGNORE + Reste weg.
    moved.research = db.prepare(
      'UPDATE OR IGNORE research_item_links SET figure_id = ? WHERE figure_id = ?'
    ).run(targetId, sourceId).changes;
    db.prepare('DELETE FROM research_item_links WHERE figure_id = ?').run(sourceId);

    // Figuren-Listen eines Zeitstrahl-Ereignisses bzw. Kontinuitaets-Befunds (eigene
    // id, kein UNIQUE): stehen Quelle UND Ziel am selben Ereignis/Befund, faellt die
    // Quell-Zeile weg — ein Umhaengen ergaebe dieselbe Figur zweimal in der Liste.
    db.prepare(`DELETE FROM zeitstrahl_event_figures WHERE figure_id = ?
      AND event_id IN (SELECT event_id FROM zeitstrahl_event_figures WHERE figure_id = ?)`).run(sourceId, targetId);
    moved.timeline = db.prepare('UPDATE zeitstrahl_event_figures SET figure_id = ? WHERE figure_id = ?')
      .run(targetId, sourceId).changes;
    db.prepare(`DELETE FROM continuity_issue_figures WHERE figure_id = ?
      AND issue_id IN (SELECT issue_id FROM continuity_issue_figures WHERE figure_id = ?)`).run(sourceId, targetId);
    moved.continuity = db.prepare('UPDATE continuity_issue_figures SET figure_id = ? WHERE figure_id = ?')
      .run(targetId, sourceId).changes;
    // Nullable Einzel-Referenzen (ON DELETE SET NULL) — schlichtes UPDATE.
    moved.profiles = db.prepare('UPDATE chapter_narrative_profile SET erzaehler_figur_id = ? WHERE erzaehler_figur_id = ?')
      .run(targetId, sourceId).changes;
    // Werkstatt-Figuren: hat derselbe User schon eine Werkstatt-Figur auf dem Ziel,
    // verliert die der Quelle ihre Import-Referenz (NULL) statt eine zweite
    // Werkstatt-Figur auf dieselbe Katalogfigur zu stellen (der Import verbietet
    // genau das, 409 ALREADY_IMPORTED). Die Mindmap bleibt; das Ergebnis nennt sie.
    const draftsUnlinked = [];
    moved.drafts = 0;
    const hasTargetDraft = db.prepare('SELECT 1 FROM draft_figures WHERE source_figure_id = ? AND user_email = ?');
    for (const d of db.prepare('SELECT id, name, user_email FROM draft_figures WHERE source_figure_id = ?').all(sourceId)) {
      if (hasTargetDraft.get(targetId, d.user_email)) {
        db.prepare('UPDATE draft_figures SET source_figure_id = NULL WHERE id = ?').run(d.id);
        draftsUnlinked.push({ id: d.id, name: d.name });
      } else {
        moved.drafts += db.prepare('UPDATE draft_figures SET source_figure_id = ? WHERE id = ?').run(targetId, d.id).changes;
      }
    }
    moved.threads = db.prepare('UPDATE plot_threads SET figure_id = ? WHERE figure_id = ?')
      .run(targetId, sourceId).changes;

    // Ignorierte Redundanz-Paare (kind='figure', normiert a < b): auf das Ziel
    // umschreiben. Ein Paar Quelle↔Ziel faellt weg (es gibt nur noch eine Figur),
    // ein Paar, das das Ziel schon hat, ebenfalls (OR IGNORE am partiellen UNIQUE).
    moved.dismissals = 0;
    const insDis = db.prepare(`INSERT OR IGNORE INTO redundancy_dismissals
      (book_id, user_email, kind, figure_a_id, figure_b_id, created_at) VALUES (?, ?, 'figure', ?, ?, ?)`);
    for (const r of db.prepare(`SELECT id, book_id, user_email, figure_a_id, figure_b_id, created_at
        FROM redundancy_dismissals WHERE kind = 'figure' AND (figure_a_id = ? OR figure_b_id = ?)`).all(sourceId, sourceId)) {
      const other = r.figure_a_id === sourceId ? r.figure_b_id : r.figure_a_id;
      db.prepare('DELETE FROM redundancy_dismissals WHERE id = ?').run(r.id);
      if (other === targetId) continue;
      moved.dismissals += insDis.run(r.book_id, r.user_email, Math.min(other, targetId), Math.max(other, targetId), r.created_at).changes;
    }

    // Abgeleitete 1:1-Zeilen aus Scans (Alters-Index samt Belegen, Idiolekt): das
    // Ziel hat Vorrang. Fehlt ihm die Zeile, uebernimmt es die der Quelle (sonst
    // stuende es bis zum naechsten Scan ohne Alter/Idiolekt da); hat es eine, faellt
    // die der Quelle per CASCADE.
    if (!db.prepare('SELECT 1 FROM figure_ages WHERE figure_id = ?').get(targetId)) {
      moved.ages = db.prepare('UPDATE figure_ages SET figure_id = ? WHERE figure_id = ?').run(targetId, sourceId).changes;
      if (moved.ages) {
        moved.ageBelege = db.prepare('UPDATE figure_age_belege SET figure_id = ? WHERE figure_id = ?')
          .run(targetId, sourceId).changes;
      }
    }
    if (!db.prepare('SELECT 1 FROM figure_idiolect WHERE figure_id = ?').get(targetId)) {
      moved.idiolect = db.prepare('UPDATE figure_idiolect SET figure_id = ? WHERE figure_id = ?').run(targetId, sourceId).changes;
    }

    // Persistente Aliasse: Name + Kurzname der Quelle und ihre eigenen Aliasse. VOR
    // dem Feld-Backfill, der den Quell-Namen sonst als kurzname des Ziels eintraegt
    // und ihn damit aus der Alias-Liste dedupliziert (ein Kurzname zaehlt im
    // Abgleich nur als Token, ein Alias als Name).
    const sourceAliases = db.prepare('SELECT alias FROM figure_aliases WHERE figure_id = ? ORDER BY id')
      .all(sourceId).map(r => r.alias);
    const aliasesAdded = addFigureAliases(targetId, bookId, [source.name, source.kurzname, ...sourceAliases]);

    // Quell-Name als kurzname des Ziels sichern (nur wenn dort leer UND der Name
    // sich wirklich unterscheidet — bei gleichnamigen Dubletten waere kurzname ==
    // name, und buildFigNameLookup ueberspringt diesen Fall ohnehin).
    // Bei gleichem Namen bleibt es beim Normalfall (source.kurzname), sonst hat der
    // Quell-Name Vorrang — er ist die Variante, die im Text steht.
    const aliasName = normName(source.name) === normName(target.name) ? null : source.name;
    const filled = _fillEmpty('figures', FIG_FILL, source, target,
      aliasName ? { kurzname: aliasName } : {});
    // Vom Autor gepflegte Stammdaten der Quelle (nachgefuellt oder nicht) bleiben
    // geschuetzt: das Ziel erbt den Schutz vor der Komplettanalyse.
    if (source.manually_edited && !target.manually_edited) {
      db.prepare('UPDATE figures SET manually_edited = 1 WHERE id = ?').run(targetId);
    }
    db.prepare('DELETE FROM figures WHERE id = ?').run(sourceId);

    return {
      kind: 'figure', sourceId, targetId,
      sourceName: source.name, targetName: target.name,
      moved, filled, eventsDeduped: evDrop.length, relationsDropped,
      draftsUnlinked, aliasesAdded,
    };
  })();
}

// ── Schauplaetze ──────────────────────────────────────────────────────────────
function mergeLocations(bookId, userEmail, sourceId, targetId) {
  const em = userEmail || null;
  return db.transaction(() => {
    const { source, target } = _loadPair('locations', bookId, em, sourceId, targetId);
    const moved = {};

    // Kapitel-Vorkommen mit Haeufigkeits-Summe (PK location_id+chapter_id).
    moved.chapters = db.prepare(`
      INSERT INTO location_chapters (location_id, chapter_id, haeufigkeit)
        SELECT ?, chapter_id, haeufigkeit FROM location_chapters WHERE location_id = ?
      ON CONFLICT(location_id, chapter_id) DO UPDATE SET haeufigkeit = haeufigkeit + excluded.haeufigkeit
    `).run(targetId, sourceId).changes;
    db.prepare('DELETE FROM location_chapters WHERE location_id = ?').run(sourceId);

    moved.figures = db.prepare(
      'INSERT OR IGNORE INTO location_figures (location_id, figure_id) SELECT ?, figure_id FROM location_figures WHERE location_id = ?'
    ).run(targetId, sourceId).changes;
    db.prepare('DELETE FROM location_figures WHERE location_id = ?').run(sourceId);

    moved.scenes = db.prepare(
      'INSERT OR IGNORE INTO scene_locations (scene_id, location_id) SELECT scene_id, ? FROM scene_locations WHERE location_id = ?'
    ).run(targetId, sourceId).changes;
    db.prepare('DELETE FROM scene_locations WHERE location_id = ?').run(sourceId);

    moved.research = db.prepare(
      'UPDATE OR IGNORE research_item_links SET location_id = ? WHERE location_id = ?'
    ).run(targetId, sourceId).changes;
    db.prepare('DELETE FROM research_item_links WHERE location_id = ?').run(sourceId);

    moved.beats = db.prepare(
      'INSERT OR IGNORE INTO plot_beat_locations (beat_id, location_id) SELECT beat_id, ? FROM plot_beat_locations WHERE location_id = ?'
    ).run(targetId, sourceId).changes;
    db.prepare('DELETE FROM plot_beat_locations WHERE location_id = ?').run(sourceId);

    // Hierarchie (locations.parent_id): Kinder der Quelle wandern ans Ziel; hing das
    // Ziel selbst unter der Quelle, rückt es an deren Platz. Ohne das fielen die
    // Kinder per SET NULL auf die Wurzel zurück.
    moved.children = db.prepare('UPDATE locations SET parent_id = ? WHERE parent_id = ? AND id <> ?')
      .run(targetId, sourceId, targetId).changes;
    const parentExtra = {};
    if (target.parent_id === sourceId) {
      target.parent_id = null;
      db.prepare('UPDATE locations SET parent_id = NULL WHERE id = ?').run(targetId);
    }
    // Elternort der Quelle nur übernehmen, wenn er keinen Zyklus schliesst (er darf
    // weder das Ziel noch einer seiner Nachfahren sein).
    if (source.parent_id != null && _isAncestorOrSelf(targetId, source.parent_id)) parentExtra.parent_id = null;

    const filled = _fillEmpty('locations', LOC_FILL, source, target, parentExtra);
    db.prepare('DELETE FROM locations WHERE id = ?').run(sourceId);

    return {
      kind: 'location', sourceId, targetId,
      sourceName: source.name, targetName: target.name,
      moved, filled,
    };
  })();
}

// ── Szenen ────────────────────────────────────────────────────────────────────
function mergeScenes(bookId, userEmail, sourceId, targetId) {
  const em = userEmail || null;
  return db.transaction(() => {
    const { source, target } = _loadPair('figure_scenes', bookId, em, sourceId, targetId);
    const moved = {};

    moved.figures = db.prepare(
      'INSERT OR IGNORE INTO scene_figures (scene_id, figure_id) SELECT ?, figure_id FROM scene_figures WHERE scene_id = ?'
    ).run(targetId, sourceId).changes;
    db.prepare('DELETE FROM scene_figures WHERE scene_id = ?').run(sourceId);

    moved.locations = db.prepare(
      'INSERT OR IGNORE INTO scene_locations (scene_id, location_id) SELECT ?, location_id FROM scene_locations WHERE scene_id = ?'
    ).run(targetId, sourceId).changes;
    db.prepare('DELETE FROM scene_locations WHERE scene_id = ?').run(sourceId);

    moved.research = db.prepare(
      'UPDATE OR IGNORE research_item_links SET scene_id = ? WHERE scene_id = ?'
    ).run(targetId, sourceId).changes;
    db.prepare('DELETE FROM research_item_links WHERE scene_id = ?').run(sourceId);

    const filled = _fillEmpty('figure_scenes', SCENE_FILL, source, target);
    db.prepare('DELETE FROM figure_scenes WHERE id = ?').run(sourceId);

    return {
      kind: 'scene', sourceId, targetId,
      sourceName: source.titel, targetName: target.titel,
      moved, filled,
    };
  })();
}

module.exports = { mergeFigures, mergeLocations, mergeScenes };
