'use strict';

// Werk-Block der Buch-Migration (.swbook, Extra-Datei `werk.json`): alles, was
// nicht Text, Analyse-Katalog, Lektorat, Chat oder Recherche ist — Publikation,
// Werkstätten (Plot, Motive, Figuren-Werkstatt), Abschnitts-Metadaten, Export-
// Profile, Share-Links samt Leser-Kommentaren, Entscheide des Autors, die
// KI-Ergebnisse aller Läufe und der Schreib-/Statistikverlauf.
// docs/book-migration.md#werk-block.
//
// GENERISCH: Spalten und Fremdschlüssel liest der Kopierer zur Laufzeit aus dem
// Schema (PRAGMA). Eine neue Spalte reist damit ohne Codeänderung mit; eine neue
// Tabelle braucht nur einen Eintrag in WERK_TABLES (an der richtigen Stelle der
// Abhängigkeitsfolge) — und einen Rundlauf-Fall im Test.
//
// Umschlüsseln je Fremdschlüssel-Ziel:
//   books → neues Buch · pages/chapters → Import-Maps · app_users → Importer
//   figures/locations/figure_scenes → Maps des Analyse-Blocks · research_items →
//   Recherche-Block · chat_sessions → Chat-Block · sources → Quellen-Abgleich
//   · eine Tabelle dieser Liste → ihre eigene Map aus diesem Lauf.
// Fehlt die Ziel-ID (Block nicht im Bundle, Zeile verworfen): nullbare Spalte →
// NULL, Pflichtspalte → Zeile fällt weg und wird gezählt.
//
// Pro User skopierte Zeilen (Spalte `user_email`) reisen nur für den Scope des
// Analyse-Blocks bzw. des Exportierenden — zwei Plot-Boards verschmölzen sonst
// beim Import (alle Zeilen bekommen die E-Mail des Importierenden) zu einem.

const crypto = require('crypto');
const { db } = require('../connection');

// Reihenfolge = Abhängigkeitsfolge (Eltern vor Kindern).
const WERK_TABLES = [
  // Publikation + Ausgabe
  'book_publication', 'docx_export_profile', 'pdf_export_profile',
  // Katalog-Ergänzungen
  'figure_aliases', 'location_aliases',
  // Figuren-Werkstatt, Plot, Motive
  'draft_figures', 'plot_threads', 'plot_acts', 'plot_beats', 'plot_beat_relations',
  'plot_beat_figures', 'plot_beat_locations', 'plot_beat_draft_figures',
  'themes', 'motifs', 'motif_relations', 'motif_figures', 'motif_draft_figures',
  'motif_beats', 'motif_chapters', 'motif_pages',
  // Abschnitts-Metadaten
  'page_editorial_status', 'page_textsorte', 'page_headline', 'page_headline_variants',
  // Quellen am Buch (die Quellen selbst: SOURCES, Abgleich in restoreSources)
  'book_source_links',
  // Share-Links mit neuen Tokens, Kommentare, Fazits
  'share_links', 'share_comments', 'share_feedback',
  // Entscheide und Einstellungen des Autors
  'redundancy_dismissals', 'name_guard_ignores', 'world_fact_verdicts',
  'user_dictionary', 'languagetool_disabled_rules',
  // KI-Ergebnisse
  'book_reviews', 'chapter_reviews', 'narrative_report', 'chapter_narrative_profile',
  'chapter_narrative_themes', 'book_exposes', 'figure_ages', 'figure_age_belege',
  'figure_age_scans', 'redundancy_runs', 'world_facts_scan', 'source_detect_runs',
  'page_structure_checks', 'werkstatt_runs', 'plot_brainstorm_runs', 'plot_consistency_runs',
  'motif_brainstorm_runs', 'motif_consistency_runs', 'tagebuch_rueckblicke',
  'research_item_findings', 'motif_occurrences', 'plot_beat_occurrences',
  'draft_figure_occurrences', 'finetune_exports', 'finetune_export_files',
  // Chat-Bilder (hängen am Chat-Block)
  'chat_images',
  // Schreib- und Statistikverlauf
  'writing_time', 'writing_session', 'writing_hour', 'book_stats_history',
];

// Spalten, die eine Person nennen, ohne FK auf app_users: am Ziel der Importer.
const PERSON_COLS = new Set(['user_email', 'owner_email', 'updated_by', 'created_by', 'author_email', 'added_by', 'changed_by']);

const _schema = new Map();
function _info(table) {
  if (!_schema.has(table)) {
    const cols = db.prepare(`PRAGMA table_info("${table}")`).all();
    const fks = db.prepare(`PRAGMA foreign_key_list("${table}")`).all();
    const fkByCol = new Map(fks.map(f => [f.from, f]));
    const pk = cols.filter(c => c.pk > 0);
    // Eigene Ganzzahl-ID (rowid): am Ziel neu vergeben. Ein PK, der selbst
    // Fremdschlüssel ist (book_publication.book_id, figure_ages.figure_id), ist
    // keine eigene ID — er wird umgeschlüsselt.
    const autoId = pk.length === 1 && /INT/i.test(pk[0].type) && !fkByCol.has(pk[0].name) ? pk[0].name : null;
    const textId = pk.length === 1 && !/INT/i.test(pk[0].type) && !fkByCol.has(pk[0].name) ? pk[0].name : null;
    _schema.set(table, { cols, fkByCol, autoId, textId, oneToOne: pk.length === 1 && fkByCol.has(pk[0].name) });
  }
  return _schema.get(table);
}

// ── Sammeln ──────────────────────────────────────────────────────────────────

function _b64Row(r) {
  const out = {};
  for (const [k, v] of Object.entries(r)) out[k] = Buffer.isBuffer(v) ? { __b64: v.toString('base64') } : v;
  return out;
}

/** SELECT für eine Tabelle: direkt über book_id oder über einen Elternteil mit book_id. */
function _selectSql(table) {
  const { cols, fkByCol } = _info(table);
  const has = (t, c) => _info(t).cols.some(x => x.name === c);
  const userFilter = (alias, t) => (has(t, 'user_email') ? ` AND (${alias}.user_email IS @email OR ${alias}.user_email IS NULL)` : '');
  const order = _info(table).autoId ? ` ORDER BY t.${_info(table).autoId}` : '';
  if (cols.some(c => c.name === 'book_id')) {
    return `SELECT t.* FROM ${table} t WHERE t.book_id = @book${userFilter('t', table)}${order}`;
  }
  if (table === 'chat_images') {
    return `SELECT t.* FROM chat_images t JOIN chat_sessions p ON p.id = t.session_id WHERE p.book_id = @book${order}`;
  }
  for (const fk of fkByCol.values()) {
    if (WERK_TABLES.includes(fk.table) && has(fk.table, 'book_id')) {
      return `SELECT t.* FROM ${table} t JOIN ${fk.table} p ON p.${fk.to} = t.${fk.from} WHERE p.book_id = @book${userFilter('p', fk.table)}${order}`;
    }
  }
  throw new Error(`werk: kein Buch-Bezug für ${table}`);
}

/** Quellen, die das Buch nutzt: am Buch verknüpft oder im Text zitiert. */
function _collectSources(bookId) {
  return db.prepare(`
    SELECT s.* FROM sources s WHERE s.id IN (
      SELECT source_id FROM book_source_links WHERE book_id = ?
      UNION SELECT sc.source_id FROM source_citations sc JOIN pages p ON p.page_id = sc.page_id WHERE p.book_id = ?)
    ORDER BY s.id`).all(bookId, bookId).map(_b64Row);
}

function collectWerk(bookId, scopeEmail = null) {
  const tables = {};
  for (const t of WERK_TABLES) {
    tables[t] = db.prepare(_selectSql(t)).all({ book: bookId, email: scopeEmail ?? null }).map(_b64Row);
  }
  return { tables, sources: _collectSources(bookId) };
}

// ── Einspielen ───────────────────────────────────────────────────────────────

const _unb64 = (v) => (v && typeof v === 'object' && typeof v.__b64 === 'string' ? Buffer.from(v.__b64, 'base64') : v);
const _norm = (s) => String(s ?? '').trim().toLowerCase();

/** Quellen in die Bibliothek des Importierenden: vorhandene wiederverwenden
 *  (gleiche DOI, ISBN, Zitierschlüssel oder Titel+Jahr), sonst neu anlegen.
 *  Liefert Map alte source_id → neue. Läuft VOR dem Anlegen der Abschnitte,
 *  damit `data-src` im Text gleich auf die neuen IDs zeigt (remapCitations). */
function restoreSources(sources, email) {
  const map = new Map();
  if (!Array.isArray(sources) || !sources.length || !email) return map;
  const mine = db.prepare('SELECT id, doi, isbn, citekey, title, year FROM sources WHERE owner_email = ?').all(email);
  const find = (s) => mine.find(m =>
    (s.doi && _norm(m.doi) === _norm(s.doi))
    || (s.isbn && _norm(m.isbn) === _norm(s.isbn))
    || (s.citekey && m.citekey === s.citekey)
    || (s.title && _norm(m.title) === _norm(s.title) && _norm(m.year) === _norm(s.year)));
  const { cols } = _info('sources');
  const names = cols.map(c => c.name).filter(n => n !== 'id');
  const keyTaken = db.prepare('SELECT 1 FROM sources WHERE owner_email = ? AND citekey = ?');
  db.transaction(() => {
    for (const s of sources) {
      const hit = find(s);
      if (hit) { map.set(s.id, hit.id); continue; }
      const row = {};
      for (const n of names) row[n] = n in s ? _unb64(s[n]) : null;
      row.owner_email = email;
      if (row.citekey) {
        let k = row.citekey, i = 2;
        while (keyTaken.get(email, k)) k = `${row.citekey}-${i++}`;
        row.citekey = k;
      }
      for (const c of cols) if (c.notnull && row[c.name] == null && c.dflt_value != null) delete row[c.name];
      const fields = names.filter(n => n in row);
      const id = db.prepare(`INSERT INTO sources (${fields.join(',')}) VALUES (${fields.map(n => '@' + n).join(',')})`)
        .run(row).lastInsertRowid;
      map.set(s.id, id);
      mine.push({ id, doi: row.doi, isbn: row.isbn, citekey: row.citekey, title: row.title, year: row.year });
    }
  })();
  return map;
}

const _ENTITY = { figures: 'figure', locations: 'location', figure_scenes: 'scene' };

function restoreWerk(bookId, data, ctx) {
  const counts = {};
  if (!data || typeof data !== 'object' || !data.tables) return counts;
  const maps = new Map();     // table → Map(alt → neu)
  const ent = ctx.entityMaps || {};
  const resolve = (fk, v) => {
    if (v == null) return null;
    switch (fk.table) {
      case 'books': return bookId;
      case 'pages': return ctx.pageOf(v);
      case 'chapters': return ctx.chapterOf(v);
      case 'app_users': return ctx.email;
      case 'research_items': return ctx.researchItemMap?.get(v) ?? null;
      case 'chat_sessions': return ctx.sessionMap?.get(v) ?? null;
      case 'sources': return ctx.sourceMap?.get(v) ?? null;
      default:
        if (_ENTITY[fk.table]) return ent[_ENTITY[fk.table]]?.get(v) ?? null;
        return maps.get(fk.table)?.get(v) ?? null;
    }
  };

  for (const table of WERK_TABLES) {
    const rows = Array.isArray(data.tables[table]) ? data.tables[table] : [];
    const { cols, fkByCol, autoId, textId, oneToOne } = _info(table);
    const own = new Map();
    maps.set(table, own);
    let n = 0, dropped = 0;
    for (const r of rows) {
      const row = {};
      let drop = false;
      for (const c of cols) {
        if (c.name === autoId || !(c.name in r)) continue;
        let v = _unb64(r[c.name]);
        const fk = fkByCol.get(c.name);
        if (c.name === textId) v = crypto.randomBytes(16).toString('base64url');
        else if (fk) {
          const to = resolve(fk, v);
          if (v != null && to == null && (c.notnull || c.pk)) { drop = true; break; }
          v = to;
        } else if (PERSON_COLS.has(c.name) && v != null) v = ctx.email;
        row[c.name] = v;
      }
      if (drop) { dropped++; continue; }
      if (table === 'share_links') { row.view_count = 0; row.owner_last_seen_at = null; }
      const fields = Object.keys(row);
      const verb = oneToOne ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE';
      const info = db.prepare(`${verb} INTO ${table} (${fields.join(',')}) VALUES (${fields.map(f => '@' + f).join(',')})`).run(row);
      if (!info.changes) { dropped++; continue; }
      if (autoId) own.set(r[autoId], Number(info.lastInsertRowid));
      if (textId) own.set(r[textId], row[textId]);
      n++;
    }
    if (n || dropped) counts[table] = dropped ? { n, dropped } : n;
  }

  // Chat-Bilder hängen über context_info.images[].image_id an Assistant-Nachrichten.
  const imgMap = maps.get('chat_images');
  if (imgMap?.size && ctx.sessionMap?.size) {
    const sel = db.prepare(`SELECT id, context_info FROM chat_messages WHERE session_id = ? AND context_info LIKE '%image_id%'`);
    const upd = db.prepare('UPDATE chat_messages SET context_info = ? WHERE id = ?');
    for (const sid of ctx.sessionMap.values()) {
      for (const m of sel.all(sid)) {
        try {
          const ci = JSON.parse(m.context_info);
          if (!Array.isArray(ci?.images)) continue;
          ci.images = ci.images.map(x => ({ ...x, image_id: imgMap.get(x.image_id) ?? null })).filter(x => x.image_id != null);
          upd.run(JSON.stringify(ci), m.id);
        } catch { /* kaputtes JSON bleibt, wie es ist */ }
      }
    }
  }
  return counts;
}

module.exports = { WERK_TABLES, collectWerk, restoreWerk, restoreSources };
