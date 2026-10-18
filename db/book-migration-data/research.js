'use strict';

// Recherche-Block der Buch-Migration (.swbook, Extra-Datei `research.json`).
// Ausgelagert aus db/book-migration-data.js (Facade), das ihn sammelt und im
// selben Restore-Lauf nach dem Analyse-Block einspielt.

const { db } = require('../connection');
const { RESEARCH_STATUS_SET, LIST_FILTER_KINDS } = require('../../lib/research-validate');

function _now() { return new Date().toISOString(); }
function _all(sql, ...args) { return db.prepare(sql).all(...args); }

// Recherche-Board: buchweit GETEILT (kein Analyse-Scope — `user_email` ist nur
// Ersteller-Attribution). BLOBs (Bild, PDF, Interview-Audio) reisen base64 in
// derselben JSON-Datei mit, wie die Manuskript-Bilder in book.json.
function _b64(buf) { return buf ? Buffer.from(buf).toString('base64') : null; }

function collectResearch(bookId) {
  const items = _all('SELECT * FROM research_items WHERE book_id = ? ORDER BY id', bookId).map(r => ({
    ...r, image: _b64(r.image), doc: _b64(r.doc),
  }));
  const viaItem = (sql) => _all(sql, bookId);
  return {
    items,
    urls:  viaItem('SELECT u.* FROM research_item_urls u JOIN research_items ri ON ri.id = u.item_id WHERE ri.book_id = ?'),
    tags:  viaItem('SELECT t.* FROM research_item_tags t JOIN research_items ri ON ri.id = t.item_id WHERE ri.book_id = ?'),
    links: viaItem('SELECT l.* FROM research_item_links l JOIN research_items ri ON ri.id = l.item_id WHERE ri.book_id = ?'),
    transcripts: _all('SELECT * FROM interview_transcripts WHERE book_id = ?', bookId)
      .map(r => ({ ...r, audio: _b64(r.audio) })),
    segments: _all('SELECT * FROM interview_segments WHERE book_id = ? ORDER BY item_id, idx', bookId),
    speakers: viaItem('SELECT s.* FROM interview_speakers s JOIN research_items ri ON ri.id = s.item_id WHERE ri.book_id = ?'),
  };
}

// Recherche-Board einspielen. Verknuepfungen auf Seiten/Kapitel laufen ueber die
// Import-Maps, auf Figuren/Orte/Szenen ueber die Maps des Analyse-Blocks (nur
// wenn er mitkam); Plot-Beats/-Straenge stehen nicht im Bundle und fallen weg —
// gezaehlt als `linksDropped`, damit die Import-Meldung es sagen kann.
// Sprecher-Zuordnungen verlieren ihre `source_id` (Quellen reisen nicht mit).
function _unb64(s) { return typeof s === 'string' && s ? Buffer.from(s, 'base64') : null; }

// MIME-Typen aus dem Bundle sind User-Eingabe: nur die Typen, die auch der
// Upload erzeugt, sonst null (Auslieferung faellt dann auf einen harmlosen Typ).
function _mime(check, v) { return v == null ? null : require('../../lib/media-mime')[check](v); }

function restoreResearch(bookId, data, ctx) {
  if (!data || typeof data !== 'object') return { items: 0 };
  const { pageOf, chapterOf, email } = ctx;
  const em = ctx.entityMaps || {};
  const arr = (k) => (Array.isArray(data[k]) ? data[k] : []);
  const itemMap = new Map();

  const insItem = db.prepare(`INSERT INTO research_items
    (book_id,user_email,kind,title,body,source,image,image_mime,doc,doc_mime,doc_name,doc_text,doc_pages,doc_chars,
     pinned,archived,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of arr('items')) {
    const kind = LIST_FILTER_KINDS.has(r.kind) ? r.kind : 'note';
    const status = RESEARCH_STATUS_SET.has(r.status) ? r.status : 'offen';
    const res = insItem.run(bookId, email, kind, r.title ?? null, r.body ?? null, r.source ?? null,
      _unb64(r.image), _mime('safeImageMime', r.image_mime), _unb64(r.doc), _mime('safeDocMime', r.doc_mime), r.doc_name ?? null,
      r.doc_text ?? null, r.doc_pages ?? null, r.doc_chars ?? null, r.pinned ? 1 : 0, r.archived ? 1 : 0,
      status, r.created_at || _now(), r.updated_at || _now());
    itemMap.set(r.id, res.lastInsertRowid);
  }

  const insUrl = db.prepare('INSERT INTO research_item_urls (item_id,url,label,position,created_at) VALUES (?,?,?,?,?)');
  for (const r of arr('urls')) {
    const iid = itemMap.get(r.item_id);
    if (iid && /^https?:\/\//i.test(String(r.url || ''))) insUrl.run(iid, r.url, r.label ?? null, r.position ?? 0, r.created_at || _now());
  }
  const insTag = db.prepare('INSERT OR IGNORE INTO research_item_tags (item_id,tag) VALUES (?,?)');
  for (const r of arr('tags')) {
    const iid = itemMap.get(r.item_id);
    if (iid && r.tag) insTag.run(iid, r.tag);
  }

  // target_kind kommt aus der Import-Datei: Lookup nur ueber eigene Keys einer
  // prototypfreien Map — `constructor`/`toString` liefen sonst in den Prototyp,
  // die Spalte waere `undefined` (SQL-Syntaxfehler, ganzer Restore rollt zurueck).
  // Unbekannte Arten fallen weg wie ein nicht aufloesbares Ziel.
  const targetOf = Object.assign(Object.create(null), {
    chapter:  (r) => chapterOf(r.chapter_id),
    page:     (r) => pageOf(r.page_id),
    figure:   (r) => em.figure?.get(r.figure_id) ?? null,
    location: (r) => em.location?.get(r.location_id) ?? null,
    scene:    (r) => em.scene?.get(r.scene_id) ?? null,
  });
  const COL = Object.assign(Object.create(null),
    { chapter: 'chapter_id', page: 'page_id', figure: 'figure_id', location: 'location_id', scene: 'scene_id' });
  let linksDropped = 0;
  let links = 0;
  for (const r of arr('links')) {
    const iid = itemMap.get(r.item_id);
    const kind = typeof r.target_kind === 'string' && Object.hasOwn(COL, r.target_kind) ? r.target_kind : null;
    const tid = iid && kind ? targetOf[kind](r) : null;
    if (!tid) { if (iid) linksDropped += 1; continue; }
    db.prepare(`INSERT INTO research_item_links (item_id,target_kind,${COL[kind]},created_at) VALUES (?,?,?,?)`)
      .run(iid, kind, tid, r.created_at || _now());
    links += 1;
  }

  const insTr = db.prepare(`INSERT INTO interview_transcripts
    (item_id,book_id,audio,audio_mime,audio_name,audio_bytes,duration_s,status,fehler,sprache,modell,diarisiert,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of arr('transcripts')) {
    const iid = itemMap.get(r.item_id);
    if (!iid) continue;
    // Ein beim Export laufender Transkript-Job ist auf der Zielinstanz tot.
    const status = r.status === 'ready' ? 'ready' : 'error';
    insTr.run(iid, bookId, _unb64(r.audio), _mime('safeAudioMime', r.audio_mime), r.audio_name ?? null, r.audio_bytes ?? null,
      r.duration_s ?? null, status, status === 'ready' ? (r.fehler ?? null) : (r.fehler || 'import'), r.sprache ?? null,
      r.modell ?? null, r.diarisiert ? 1 : 0, r.created_at || _now(), r.updated_at || _now());
  }
  const insSeg = db.prepare('INSERT INTO interview_segments (item_id,book_id,idx,start_s,end_s,speaker,text) VALUES (?,?,?,?,?,?,?)');
  for (const r of arr('segments')) {
    const iid = itemMap.get(r.item_id);
    if (iid) insSeg.run(iid, bookId, r.idx ?? 0, r.start_s ?? null, r.end_s ?? null, r.speaker ?? null, r.text ?? '');
  }
  const insSp = db.prepare('INSERT OR IGNORE INTO interview_speakers (item_id,speaker,label,rolle,updated_at) VALUES (?,?,?,?,?)');
  for (const r of arr('speakers')) {
    const iid = itemMap.get(r.item_id);
    if (iid && r.speaker) insSp.run(iid, r.speaker, r.label ?? null, r.rolle ?? null, r.updated_at || _now());
  }

  ctx.researchIds = [...itemMap.values()];
  return { items: itemMap.size, links, linksDropped };
}

module.exports = { collectResearch, restoreResearch };
