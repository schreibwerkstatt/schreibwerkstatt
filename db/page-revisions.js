'use strict';
// CRUD fuer page_revisions.
// Schreib-Pfad: content-store-Facade ruft `insert()` nach jedem erfolgreichen
//   Backend-Save und legt den gerade geschriebenen Stand als Snapshot ab (jede
//   Revision = Inhalt NACH ihrem Save, nicht der Vorzustand).
// Lese-Pfad: routes/content.js Revisions-Endpoints. Die Liste im Editor ist ein
//   FENSTER (Default 100 juengste, Deckel 500), nicht die ganze Historie —
//   Keyset-Nachladen ueber `listForPageKeyset`. Grund steht direkt in der
//   Retention darunter: das `raw`-Bucket haelt jeden Autosave der letzten 24 h,
//   ein Schreibtag fuellt das erste Fenster also allein und die getierte
//   Historie dahinter waere ohne Nachladen unerreichbar.
// Retention: lib/cache-cleanup.js POLICIES ruft `pruneTiered()` taeglich.
// Strategie: Grandfather-Father-Son (GFS).
//   <=1 Tag:  alle behalten
//   1-7 Tage:   1 pro Kalendertag  (aelteste)
//   7-60 Tage:  1 pro ISO-Woche    (aelteste; Schluessel = Donnerstag der Woche)
//   60-365 T:   1 pro Kalendermonat (aelteste)
//   >1 Jahr:    1 pro Jahr         (aelteste)
// Floor `app.page_revision_limit` haelt zusaetzlich die N jueng­sten Revisions
// pro Seite (Safety-Net gegen Schema-Bugs + macht Rollback einfach moeglich).
// Angeheftete Revisionen (`pinned = 1`, vom User benannt) faellt die Retention
// nie.
// Aelteste-pro-Bucket: User-Intuition "Stand vor ~1 Monat" trifft den
// Bucket-Rand naeher als die juengste Rev des Buckets.

const { db } = require('./connection');
require('./migrations');
const { CHARS_PER_TOKEN } = require('../lib/ai');
const { NOW_ISO_SQL } = require('./now');
const { htmlToPlainText } = require('../lib/html-text');

const VALID_SOURCES = new Set([
  'focus', 'main', 'book', 'chat-apply', 'lektorat-apply',
  'import', 'conflict', 'macapp', 'split', 'restore',
]);

// Deckel fuer den Namen einer angehefteten Revision.
const LABEL_MAX = 120;

// Spalten der Listen-/Meta-Antworten (ohne body_html).
const _META_COLS = `id, page_id, book_id, chars, words, tok,
         source, user_email, client, created_at, summary, pinned, label`;

// ── Kanonische Form fuer den Dedup ──────────────────────────────────────────
// Zwei Bodies gelten als gleich, wenn sie sich nur in Dingen unterscheiden, die
// weder sichtbar noch inhaltlich sind: Block-IDs (`data-bid`), Attribut- und
// Klassen-Reihenfolge, Anfuehrungszeichen, `<br/>` vs. `<br>`, NBSP vs. Space,
// Whitespace-Laeufe und Whitespace an Blockgrenzen. Alles andere — Formatierung,
// Ueberschriften-Ebene, Bilder, Link-Ziele, Todo-Haken, Absatzgrenzen,
// Diagramm-Quelltext — ist eine Aenderung und bekommt eine Revision.
// Why nicht der sichtbare Text: der verwarf genau diese Aenderungen, die
// juengste Revision war dann nicht der aktuelle Stand, und ein Restore nahm sie
// still zurueck. Diagramme fallen im Plain-Text ganz weg — sie hatten gar keine
// Geschichte.
const _TAG_RE = /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;
const _ATTR_RE = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const _BLOCK_EDGE_RE = /\s*(<\/?(?:p|h[1-6]|li|ul|ol|blockquote|pre|div|table|thead|tbody|tfoot|tr|td|th|caption|figure|figcaption|hr|br)\b[^>]*>)\s*/gi;

function _canonTag(_m, name, attrs) {
  const out = [];
  for (const a of String(attrs || '').matchAll(_ATTR_RE)) {
    const key = a[1].toLowerCase();
    if (key === 'data-bid') continue;
    let val = a[2] ?? a[3] ?? a[4];
    if (key === 'class' && val != null) {
      val = val.split(/\s+/).filter(Boolean).sort().join(' ');
      if (!val) continue;
    }
    out.push(val == null ? key : `${key}="${val.replace(/"/g, '&quot;')}"`);
  }
  out.sort();
  return `<${name.toLowerCase()}${out.length ? ' ' + out.join(' ') : ''}>`;
}

function canonicalHtml(html) {
  // <pre> (Code, Mermaid) behaelt seinen Whitespace: Zeilenumbrueche tragen
  // dort Bedeutung. Nur das Tag selbst wird normalisiert.
  const pres = [];
  let out = String(html || '').replace(/<pre\b[\s\S]*?<\/pre>/gi, (m) => {
    pres.push(m.replace(_TAG_RE, _canonTag));
    return `\u0000${pres.length - 1}\u0000`;
  });
  out = out.replace(_TAG_RE, _canonTag)
    .replace(/&nbsp;|&#160;|&#x0*a0;|\u00a0/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(_BLOCK_EDGE_RE, '$1')
    .trim();
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => pres[Number(i)]);
}

function _statsFromHtml(html) {
  const text = htmlToPlainText(html);
  const chars = text.length;
  const words = text === '' ? 0 : text.split(/\s+/).length;
  const tok = Math.round(chars / CHARS_PER_TOKEN);
  return { chars, words, tok };
}

const _insertStmt = db.prepare(`
  INSERT INTO page_revisions
    (page_id, book_id, body_html, chars, words, tok,
     source, user_email, client, summary, created_at)
  VALUES
    (@page_id, @book_id, @body_html, @chars, @words, @tok,
     @source, @user_email, @client, @summary, COALESCE(@created_at, ${NOW_ISO_SQL}))
`);

const _lastBodyStmt = db.prepare(`
  SELECT body_html
    FROM page_revisions
   WHERE page_id = ?
   ORDER BY created_at DESC, id DESC
   LIMIT 1
`);

// Dedup: gleiche kanonische Form wie die juengste Revision derselben Seite →
// skip (siehe `canonicalHtml`). Faengt Autosave-Bursts und Phantom-Revs aus
// nicht-inhaltlichen HTML-Aenderungen (trailing NBSP, Attribut-Reorder,
// nachgezogene Block-IDs), ohne echte Formatierungs-Aenderungen zu schlucken.
// `createdAt` (optional, ISO): Zeitpunkt des Stands statt «jetzt» — nur fuer
// den Ausgangsstand (content-store#_ensureBaselineRevision), der den Text vom
// letzten Write VOR der Revisions-Geschichte traegt.
function insert({ pageId, bookId, bodyHtml, source, userEmail = null, client = null, summary = null, createdAt = null }) {
  if (!Number.isInteger(pageId) || pageId <= 0) throw new Error('page-revisions.insert: pageId required');
  if (!Number.isInteger(bookId) || bookId <= 0) throw new Error('page-revisions.insert: bookId required');
  if (typeof bodyHtml !== 'string') throw new Error('page-revisions.insert: bodyHtml required');
  if (!VALID_SOURCES.has(source)) throw new Error(`page-revisions.insert: invalid source "${source}"`);
  const last = _lastBodyStmt.get(pageId);
  if (last) {
    if (last.body_html === bodyHtml) return null;
    if (canonicalHtml(last.body_html) === canonicalHtml(bodyHtml)) return null;
  }
  const { chars, words, tok } = _statsFromHtml(bodyHtml);
  const result = _insertStmt.run({
    page_id: pageId,
    book_id: bookId,
    body_html: bodyHtml,
    chars, words, tok,
    source,
    user_email: userEmail,
    client: typeof client === 'string' && client ? client.slice(0, 160) : null,
    summary,
    created_at: typeof createdAt === 'string' && createdAt ? createdAt : null,
  });
  return result.lastInsertRowid;
}

const _listForPageStmt = db.prepare(`
  SELECT ${_META_COLS}
    FROM page_revisions
   WHERE page_id = ?
   ORDER BY created_at DESC, id DESC
   LIMIT ?
`);

function listForPage(pageId, limit = 100) {
  return _listForPageStmt.all(pageId, Math.min(Math.max(limit, 1), 500));
}

const _listBeforeStmt = db.prepare(`
  SELECT ${_META_COLS}
    FROM page_revisions
   WHERE page_id = @page_id
     AND (created_at < @before
          OR (created_at = @before AND id < @before_id))
   ORDER BY created_at DESC, id DESC
   LIMIT @limit
`);

// Keyset-Seite fuer die Revisionsliste im Editor. `before`/`beforeId` zeigen auf
// die letzte bereits gelieferte Revision, `hasMore` sagt, ob dahinter noch etwas
// liegt (ohne zweites COUNT: es wird limit+1 geholt und die Zusatzzeile
// verworfen). Die Zusatzzeile geht als `older` mit: sie ist die Vorgaengerin
// der aeltesten gelieferten Revision, die Liste braucht sie fuer Zeichen-Delta,
// Vergleich und «Stand davor» am Fensterrand.
// Keyset statt OFFSET: das `raw`-Bucket der Retention (pruneTiered) haelt jeden
// Autosave der letzten 24 h, und die Liste ist DESC. Zwischen zwei Klicks fuegt
// ein Autosave also vorne ein bzw. der naechtliche Prune loescht hinten — ein
// OFFSET wuerde dann Revisionen doppelt liefern bzw. ueberspringen. Der Cursor
// haengt am Datenpunkt, nicht an der Position.
// `id` als zweites Cursor-Feld, weil `created_at` bei Autosave-Bursts kollidieren
// kann (Millisekunden-Aufloesung) — sonst blieben kollidierende Revisionen
// unerreichbar.
function listForPageKeyset(pageId, { limit = 100, before = null, beforeId = null } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const rows = (typeof before === 'string' && before && Number.isInteger(beforeId))
    ? _listBeforeStmt.all({ page_id: pageId, before, before_id: beforeId, limit: n + 1 })
    : _listForPageStmt.all(pageId, n + 1);
  const hasMore = rows.length > n;
  return { revisions: hasMore ? rows.slice(0, n) : rows, hasMore, older: hasMore ? rows[n] : null };
}

const _getStmt = db.prepare(`
  SELECT ${_META_COLS}, body_html
    FROM page_revisions
   WHERE id = ?
`);

function get(id) {
  return _getStmt.get(id) || null;
}

const _prevStmt = db.prepare(`
  SELECT ${_META_COLS}
    FROM page_revisions
   WHERE page_id = @page_id
     AND (created_at < @created_at
          OR (created_at = @created_at AND id < @id))
   ORDER BY created_at DESC, id DESC
   LIMIT 1
`);

// Unmittelbare Vorgaengerin (Meta, ohne Body) — fuer den Vergleich einer
// Revision, deren Vorgaengerin der Client nicht geladen hat (Fensterrand,
// angeheftete Revision ausserhalb des Fensters).
function prevOf(rev) {
  if (!rev?.id || !rev.created_at) return null;
  return _prevStmt.get({ page_id: rev.page_id, created_at: rev.created_at, id: rev.id }) || null;
}

const _countStmt = db.prepare('SELECT COUNT(*) AS n FROM page_revisions WHERE page_id = ?');
function countForPage(pageId) {
  return _countStmt.get(pageId)?.n || 0;
}

const _hasAnyStmt = db.prepare('SELECT 1 AS x FROM page_revisions WHERE page_id = ? LIMIT 1');
function hasAny(pageId) {
  return !!_hasAnyStmt.get(pageId);
}

const _listPinnedStmt = db.prepare(`
  SELECT ${_META_COLS}
    FROM page_revisions
   WHERE page_id = ? AND pinned = 1
   ORDER BY created_at DESC, id DESC
`);

// Alle angehefteten Revisionen einer Seite, unabhaengig vom Listen-Fenster:
// genau die, die jemand bewusst wiederfinden will, liegen oft weit hinten.
function listPinned(pageId) {
  return _listPinnedStmt.all(pageId);
}

const _setPinStmt = db.prepare('UPDATE page_revisions SET pinned = @pinned, label = @label WHERE id = @id');

// Anheften/Loesen + Name. Loesen verwirft den Namen: ein Name ohne Anheften
// waere ein Etikett an etwas, das die naechste Retention loeschen darf.
function setPin(id, { pinned, label = null }) {
  const p = pinned ? 1 : 0;
  const l = p && typeof label === 'string' && label.trim() ? label.trim().slice(0, LABEL_MAX) : null;
  _setPinStmt.run({ id, pinned: p, label: l });
  return get(id);
}

// Tiered Retention (GFS) + Floor. Single-Statement via CTE.
// `floor`: Mindestanzahl jueng­ste Revisions pro page_id, die zusaetzlich zum
// Bucket-Schema garantiert behalten werden.
// `now` (optional): ISO-Timestamp-Override; Default = SQLite 'now'. Nur fuer
// Tests; Produktion ruft ohne Argument auf.
function pruneTiered({ floor, now = null } = {}) {
  const n = parseInt(floor, 10);
  if (!Number.isInteger(n) || n <= 0) throw new Error('pruneTiered: floor must be positive int');
  const nowExpr = now ? '@now' : "'now'";
  const sql = `
    WITH classified AS (
      SELECT
        id, page_id, created_at,
        CASE
          WHEN julianday(${nowExpr}) - julianday(created_at) <= 1   THEN 'raw'
          WHEN julianday(${nowExpr}) - julianday(created_at) <= 7   THEN 'd:' || date(created_at)
          WHEN julianday(${nowExpr}) - julianday(created_at) <= 60  THEN 'w:' || date(created_at, '-3 days', 'weekday 4')
          WHEN julianday(${nowExpr}) - julianday(created_at) <= 365 THEN 'm:' || strftime('%Y-%m', created_at)
          ELSE                                                            'y:' || strftime('%Y', created_at)
        END AS bucket
        FROM page_revisions
    ),
    keep_buckets AS (
      SELECT id FROM classified WHERE bucket = 'raw'
      UNION
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
                     PARTITION BY page_id, bucket
                     ORDER BY created_at ASC, id ASC
                   ) AS rn
          FROM classified
         WHERE bucket <> 'raw'
      ) WHERE rn = 1
    ),
    keep_floor AS (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
                     PARTITION BY page_id
                     ORDER BY created_at DESC, id DESC
                   ) AS rn
          FROM page_revisions
      ) WHERE rn <= @floor
    )
    DELETE FROM page_revisions
     WHERE pinned = 0
       AND id NOT IN (SELECT id FROM keep_buckets)
       AND id NOT IN (SELECT id FROM keep_floor)
  `;
  const params = now ? { floor: n, now } : { floor: n };
  return db.prepare(sql).run(params).changes;
}

module.exports = {
  insert,
  listForPage,
  listForPageKeyset,
  get,
  prevOf,
  countForPage,
  hasAny,
  listPinned,
  setPin,
  pruneTiered,
  canonicalHtml,
  VALID_SOURCES,
  LABEL_MAX,
};
