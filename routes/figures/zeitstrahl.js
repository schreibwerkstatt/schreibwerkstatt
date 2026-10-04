// Konsolidierter Zeitstrahl eines Buchs: GET /figures/zeitstrahl/:book_id.
//
// Eigenes Modul, weil der Zeitstrahl kein Figuren-Thema ist — er liest
// `zeitstrahl_events` (+ die drei Bruecken-Tabellen) und leitet daraus die
// Buch-Chronologie ab; mit `figures` teilt er nur den Router-Prefix und dessen
// ACL-Guard. Registriert wird er wie die History-Submodule ueber `register(router)`
// vom Facade-Router (../figures.js) — auf DEMSELBEN Router, damit `router.param`
// (ACL + Log-Kontext) und die Reihenfolge vor `/:book_id` erhalten bleiben.
const { getBookSettings } = require('../../db/schema');
const { listZeitstrahlEvents, listZeitstrahlEventRefs } = require('../../db/zeitstrahl');
const { ensureTree } = require('../../db/book-order');
const { sessionEmail } = require('../../lib/acl');
const { parseDatum } = require('../../lib/datum-parse');

// Lese-Reihenfolge: globaler Ordinalwert je Kapitel/Seite aus dem book_order-Tree
// (Depth-First). Brücke, um zu einer Event-Referenz (chapter_id/page_id) die
// Position im Manuskript zu bestimmen.
function _readingOrdinalMap(bookId) {
  const order = ensureTree(bookId);
  const map = new Map();
  let i = 0;
  (function walk(nodes) {
    for (const n of (nodes || [])) {
      if (n.type === 'chapter') { map.set('c' + n.id, i++); walk(n.children); }
      else if (n.type === 'page') { map.set('p' + n.id, i++); }
    }
  })(order?.tree || []);
  return map;
}

// "In welchem Jahr spielt der Roman?" — abgeleitet aus den sicher datierten
// Zeitstrahl-Events (datum_unsicher === false, datum_year gesetzt).
//   minYear/maxYear  → Jahres-Spektrum des Romans (Start inkl. Spannen-Ende)
//   endYear          → spätestes Story-Jahr des Romans (= maxYear)
//   chapters         → Story-Jahr je Kapitel in Lese-Reihenfolge:
//                      [{ chapter_id, name, minYear, maxYear }]. Ein Kapitel
//                      bündelt die sicher datierten Events, die es verlinken.
// null, wenn es keine sicher datierten Events gibt. Abgeleitete Jahre
// (datum_unsicher) fliessen bewusst NICHT ein.
function _computeChronology(bookId, events) {
  const secure = (events || []).filter(e => !e.datum_unsicher && e.datum_year != null);
  if (!secure.length) return null;
  let minYear = Infinity, maxYear = -Infinity;
  for (const e of secure) {
    if (e.datum_year < minYear) minYear = e.datum_year;
    const end = e.datum_ende_year != null ? e.datum_ende_year : e.datum_year;
    if (end > maxYear) maxYear = end;
  }
  // Pro-Kapitel: Story-Jahr(e), in denen das Kapitel spielt. kapitel[i] gehört
  // zu chapter_ids[i] (gleiche Push-Reihenfolge in der /zeitstrahl-Route).
  const byChapter = new Map(); // chapter_id → { chapter_id, name, min, max }
  for (const e of secure) {
    const end = e.datum_ende_year != null ? e.datum_ende_year : e.datum_year;
    const ids = e.chapter_ids || [], names = e.kapitel || [];
    ids.forEach((cid, i) => {
      if (cid == null) return;
      const c = byChapter.get(cid);
      if (!c) { byChapter.set(cid, { chapter_id: cid, name: names[i] || null, min: e.datum_year, max: end }); }
      else {
        if (e.datum_year < c.min) c.min = e.datum_year;
        if (end > c.max) c.max = end;
        if (!c.name && names[i]) c.name = names[i];
      }
    });
  }
  const ordinal = _readingOrdinalMap(bookId);
  const chapters = [...byChapter.values()]
    .filter(c => c.name) // ohne Namen nicht anzeigbar (z.B. gelöschtes Kapitel)
    .sort((a, b) => (ordinal.get('c' + a.chapter_id) ?? Infinity) - (ordinal.get('c' + b.chapter_id) ?? Infinity))
    .map(c => ({ chapter_id: c.chapter_id, name: c.name, minYear: c.min, maxYear: c.max }));
  return { minYear, maxYear, endYear: maxYear, chapters };
}


// Konsolidierten Zeitstrahl eines Buchs laden (vor /:book_id definiert um Konflikte zu vermeiden)

function register(router) {
  router.get('/zeitstrahl/:book_id', (req, res) => {
    const bookId = req.bookId;
    const userEmail = sessionEmail(req);
    const rows = listZeitstrahlEvents(bookId, userEmail);
    if (!rows.length) return res.json({ ereignisse: null });

    // Lazy-Parser-Fallback: Events mit Label aber ohne strukturierte Felder
    // (z.B. nachträglich verbesserter Parser oder manuelle Legacy-Strings)
    // beim Read erneut durchschleusen — füllt nur In-Memory, kein DB-Write.
    for (const r of rows) {
      if (r.datum_label && r.datum_year == null && r.datum_month == null
          && r.datum_day == null && r.story_tag == null) {
        const p = parseDatum(r.datum_label);
        if (p.year  != null) r.datum_year  = p.year;
        if (p.month != null) r.datum_month = p.month;
        if (p.day   != null) r.datum_day   = p.day;
        if (p.story_tag != null) r.story_tag = p.story_tag;
      }
    }

    const { chRows, pgRows, fgRows } = listZeitstrahlEventRefs(rows.map(r => r.id));

    const chByEvt = new Map();
    for (const r of chRows) {
      if (!chByEvt.has(r.event_id)) chByEvt.set(r.event_id, { kapitel: [], chapter_ids: [] });
      const b = chByEvt.get(r.event_id);
      if (r.chapter_name) b.kapitel.push(r.chapter_name);
      if (r.chapter_id != null) b.chapter_ids.push(r.chapter_id);
    }
    const pgByEvt = new Map();
    for (const r of pgRows) {
      if (!pgByEvt.has(r.event_id)) pgByEvt.set(r.event_id, { seiten: [], page_ids: [] });
      const b = pgByEvt.get(r.event_id);
      if (r.page_name) b.seiten.push(r.page_name);
      if (r.page_id != null) b.page_ids.push(r.page_id);
    }
    const fgByEvt = new Map();
    for (const r of fgRows) {
      if (!fgByEvt.has(r.event_id)) fgByEvt.set(r.event_id, []);
      if (!r.name) continue;
      const out = { name: r.name };
      if (r.fig_id) out.id = r.fig_id;
      if (r.typ) out.typ = r.typ;
      fgByEvt.get(r.event_id).push(out);
    }

    const ereignisse = rows.map(r => ({
      id:               r.id,
      datum:            r.datum,
      datum_label:      r.datum_label || r.datum || '',
      datum_year:       r.datum_year,
      datum_month:      r.datum_month,
      datum_day:        r.datum_day,
      datum_ende_year:  r.datum_ende_year,
      datum_ende_month: r.datum_ende_month,
      datum_ende_day:   r.datum_ende_day,
      story_tag:        r.story_tag,
      datum_unsicher:   !!r.datum_unsicher,
      ereignis:         r.ereignis,
      typ:              r.typ || 'persoenlich',
      subtyp:           r.subtyp || 'sonstiges',
      bedeutung:        r.bedeutung || '',
      storyline_id:     r.storyline_id,
      manually_edited:  !!r.manually_edited,
      sort_order:       r.sort_order ?? 0,
      kapitel:          chByEvt.get(r.id)?.kapitel     || [],
      chapter_ids:      chByEvt.get(r.id)?.chapter_ids || [],
      seiten:           pgByEvt.get(r.id)?.seiten      || [],
      page_ids:         pgByEvt.get(r.id)?.page_ids    || [],
      figuren:          fgByEvt.get(r.id) || [],
    }));

    // Jahres-Anzeige nur bei Romanen mit "echter Zeitlinie" (book_settings.zeitlinie_real).
    const { zeitlinie_real } = getBookSettings(bookId, userEmail);
    const chronology = zeitlinie_real ? _computeChronology(bookId, ereignisse) : null;
    res.json({ ereignisse, chronology });
  });
}

module.exports = { register };
