'use strict';
// CRUD for blog_connections (WP-Verbindung pro Buch) + blog_page_links
// (WP-Post ↔ Page-Mapping). Passwort wird via lib/crypto.js verschluesselt
// in DB abgelegt; getConnection() liefert es ENTSCHLUESSELT zurueck. Routes
// duerfen das Klartext-PW nie an Clients leaken.

const { db } = require('./connection');
require('./migrations');
const { NOW_ISO_SQL } = require('./now');
const { encrypt, decrypt } = require('../lib/crypto');
const { clearCachedMedia } = require('./sync-media-cache');

const ALLOWED_STATUS = new Set(['draft', 'publish', 'private']);

// ── blog_connections ────────────────────────────────────────────────────────

const _stmtGetByBook = db.prepare(`
  SELECT id, book_id, base_url, username, password_enc, default_status,
         initial_import_done_at, last_pull_at, last_push_at,
         created_at, updated_at
    FROM blog_connections
   WHERE book_id = ?
`);

function _decryptRow(row) {
  if (!row) return null;
  const stored = row.password_enc;
  const asString = Buffer.isBuffer(stored) ? stored.toString('utf8') : String(stored || '');
  return {
    id: row.id,
    bookId: row.book_id,
    baseUrl: row.base_url,
    username: row.username,
    password: decrypt(asString),
    defaultStatus: row.default_status,
    initialImportDoneAt: row.initial_import_done_at,
    lastPullAt: row.last_pull_at,
    lastPushAt: row.last_push_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function _publicRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    bookId: row.book_id,
    baseUrl: row.base_url,
    username: row.username,
    defaultStatus: row.default_status,
    initialImportDoneAt: row.initial_import_done_at,
    lastPullAt: row.last_pull_at,
    lastPushAt: row.last_push_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getConnection(bookId) {
  const row = _stmtGetByBook.get(parseInt(bookId, 10));
  return _decryptRow(row);
}

function getConnectionPublic(bookId) {
  const row = _stmtGetByBook.get(parseInt(bookId, 10));
  return _publicRow(row);
}

const _stmtInsert = db.prepare(`
  INSERT INTO blog_connections
    (book_id, base_url, username, password_enc, default_status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
`);

const _stmtUpdate = db.prepare(`
  UPDATE blog_connections
     SET base_url = ?, username = ?, password_enc = ?, default_status = ?,
         updated_at = ${NOW_ISO_SQL}
   WHERE id = ?
`);

// Zielwechsel (andere Blog-URL): die bisherigen Links tragen Post-IDs des alten
// Blogs. Bleiben sie stehen, ueberschreibt der naechste Push auf dem NEUEN Blog
// einen fremden Post, der zufaellig dieselbe ID hat. Darum fallen sie mit dem
// Wechsel weg, und Import- und Pull-Stand beginnen neu. Ein anderer Benutzer auf
// demselben Blog ist kein Zielwechsel.
const _stmtResetTarget = db.prepare(`
  UPDATE blog_connections
     SET initial_import_done_at = NULL, last_pull_at = NULL, last_push_at = NULL
   WHERE id = ?
`);
const _stmtDeleteLinksForBlog = db.prepare('DELETE FROM blog_page_links WHERE blog_id = ?');

/** Speichert die Verbindung. Rueckgabe: Public-Meta plus `targetChanged`
 *  (true = Links und Import-/Pull-Stand wurden verworfen). */
function upsertConnection({ bookId, baseUrl, username, password, defaultStatus = 'draft' }) {
  const bid = parseInt(bookId, 10);
  if (!Number.isInteger(bid) || bid <= 0) throw new Error('blogs.upsert: invalid bookId');
  if (!baseUrl || typeof baseUrl !== 'string') throw new Error('blogs.upsert: baseUrl required');
  if (!username || typeof username !== 'string') throw new Error('blogs.upsert: username required');
  if (!password || typeof password !== 'string') throw new Error('blogs.upsert: password required');
  if (!ALLOWED_STATUS.has(defaultStatus)) throw new Error('blogs.upsert: invalid defaultStatus');

  const encPw = encrypt(password);
  let targetChanged = false;
  db.transaction(() => {
    const existing = _stmtGetByBook.get(bid);
    if (existing) {
      targetChanged = existing.base_url !== baseUrl;
      _stmtUpdate.run(baseUrl, username, encPw, defaultStatus, existing.id);
      if (targetChanged) {
        _stmtDeleteLinksForBlog.run(existing.id);
        _stmtResetTarget.run(existing.id);
        // Mediathek-Adressen des alten Blogs gelten auf dem neuen nicht.
        clearCachedMedia({ blogId: existing.id });
      }
    } else {
      _stmtInsert.run(bid, baseUrl, username, encPw, defaultStatus);
    }
  })();
  return { ...getConnectionPublic(bid), targetChanged };
}

const _stmtUpdateStatus = db.prepare(`
  UPDATE blog_connections SET default_status = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?
`);

function updateDefaultStatus(bookId, defaultStatus) {
  if (!ALLOWED_STATUS.has(defaultStatus)) throw new Error('blogs.updateDefaultStatus: invalid');
  const row = _stmtGetByBook.get(parseInt(bookId, 10));
  if (!row) return null;
  _stmtUpdateStatus.run(defaultStatus, row.id);
  return getConnectionPublic(bookId);
}

const _stmtMarkImported = db.prepare(`
  UPDATE blog_connections SET initial_import_done_at = ${NOW_ISO_SQL}, updated_at = ${NOW_ISO_SQL} WHERE id = ?
`);
function markInitialImportDone(connId) {
  _stmtMarkImported.run(parseInt(connId, 10));
}

const _stmtTouchPull = db.prepare(`
  UPDATE blog_connections SET last_pull_at = COALESCE(?, ${NOW_ISO_SQL}), updated_at = ${NOW_ISO_SQL} WHERE id = ?
`);
/** `at` = Start-Zeitpunkt des Pulls (ISO). Der naechste Delta-Pull fragt ab dort —
 *  ein Stempel vom ENDE liesse Posts aus, die WordPress waehrend des Laufs
 *  geaendert hat. Ohne `at`: jetzt. */
function touchPull(connId, at = null) {
  _stmtTouchPull.run(at || null, parseInt(connId, 10));
}

const _stmtTouchPush = db.prepare(`
  UPDATE blog_connections SET last_push_at = ${NOW_ISO_SQL}, updated_at = ${NOW_ISO_SQL} WHERE id = ?
`);
function touchPush(connId) {
  _stmtTouchPush.run(parseInt(connId, 10));
}

const _stmtDelete = db.prepare('DELETE FROM blog_connections WHERE book_id = ?');
function deleteConnection(bookId) {
  return _stmtDelete.run(parseInt(bookId, 10)).changes > 0;
}

// ── blog_page_links ─────────────────────────────────────────────────────────

const _stmtGetLinkByPage = db.prepare(`
  SELECT page_id, blog_id, wp_post_id, wp_modified_at, wp_status, wp_slug,
         last_pulled_at, last_pushed_at, conflict_state
    FROM blog_page_links WHERE page_id = ?
`);
function getLinkByPage(pageId) {
  return _stmtGetLinkByPage.get(parseInt(pageId, 10)) || null;
}

const _stmtGetLinkByPost = db.prepare(`
  SELECT page_id, blog_id, wp_post_id, wp_modified_at, wp_status, wp_slug,
         last_pulled_at, last_pushed_at, conflict_state
    FROM blog_page_links WHERE blog_id = ? AND wp_post_id = ?
`);
function getLinkByPost(blogId, wpPostId) {
  return _stmtGetLinkByPost.get(parseInt(blogId, 10), parseInt(wpPostId, 10)) || null;
}

// `headline_updated_at`: ein Titel-Werkstatt-Edit ist ein lokaler Edit des
// Beitrags (Titel/Lead/Teaser gehen mit dem Push raus), bewegt aber
// `pages.updated_at` nicht — der Badge braucht beide Stamps.
const _stmtListLinksForBlog = db.prepare(`
  SELECT l.page_id, l.blog_id, l.wp_post_id, l.wp_modified_at, l.wp_status, l.wp_slug,
         l.last_pulled_at, l.last_pushed_at, l.conflict_state, l.locked_blocks,
         h.updated_at AS headline_updated_at
    FROM blog_page_links l
    LEFT JOIN page_headline h ON h.page_id = l.page_id
   WHERE l.blog_id = ?
`);
function listLinksForBlog(blogId) {
  return _stmtListLinksForBlog.all(parseInt(blogId, 10));
}

const _stmtUpsertLink = db.prepare(`
  INSERT INTO blog_page_links
    (page_id, blog_id, wp_post_id, wp_modified_at, wp_status, wp_slug, last_pulled_at, last_pushed_at, conflict_state)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(page_id) DO UPDATE SET
    blog_id = excluded.blog_id,
    wp_post_id = excluded.wp_post_id,
    wp_modified_at = excluded.wp_modified_at,
    wp_status = excluded.wp_status,
    wp_slug = excluded.wp_slug,
    last_pulled_at = COALESCE(excluded.last_pulled_at, blog_page_links.last_pulled_at),
    last_pushed_at = COALESCE(excluded.last_pushed_at, blog_page_links.last_pushed_at),
    conflict_state = excluded.conflict_state
`);

function upsertLink({ pageId, blogId, wpPostId, wpModifiedAt, wpStatus = null, wpSlug = null,
                      lastPulledAt = null, lastPushedAt = null, conflictState = null }) {
  if (conflictState !== null && !['detected', 'resolved-app', 'resolved-wp'].includes(conflictState)) {
    throw new Error('blogs.upsertLink: invalid conflict_state');
  }
  _stmtUpsertLink.run(
    parseInt(pageId, 10),
    parseInt(blogId, 10),
    parseInt(wpPostId, 10),
    String(wpModifiedAt || ''),
    wpStatus,
    wpSlug,
    lastPulledAt,
    lastPushedAt,
    conflictState,
  );
  return getLinkByPage(pageId);
}

const _stmtMarkPulled = db.prepare(`
  UPDATE blog_page_links
     SET wp_modified_at = ?, wp_status = ?, wp_slug = ?,
         last_pulled_at = COALESCE(?, ${NOW_ISO_SQL}), conflict_state = NULL
   WHERE page_id = ?
`);
/** `pulledAt`: Stempel des eigenen Writes (Seite bzw. Titel-Werkstatt, der
 *  juengere). Ohne ihn „jetzt" — dann gaelte ein Save, der zwischen dem
 *  Schreiben der Seite und diesem Aufruf landet, als schon abgeglichen. */
function markLinkPulled(pageId, { wpModifiedAt, wpStatus = null, wpSlug = null, pulledAt = null }) {
  _stmtMarkPulled.run(String(wpModifiedAt || ''), wpStatus, wpSlug, pulledAt || null, parseInt(pageId, 10));
}


// Konflikt zugunsten der App geloest: der WP-Stand, den der User im Diff
// gesehen und verworfen hat, gilt als bekannt (`wp_modified_at`). Sonst saehe der
// naechste Pull denselben WP-Edit wieder als neu und meldete den Konflikt erneut;
// der Push-Pre-Check ebenso.
const _stmtResolveApp = db.prepare(`
  UPDATE blog_page_links SET wp_modified_at = ?, conflict_state = 'resolved-app' WHERE page_id = ?
`);
function markConflictResolvedApp(pageId, wpModifiedAt) {
  _stmtResolveApp.run(String(wpModifiedAt || ''), parseInt(pageId, 10));
}

const _stmtSetConflict = db.prepare(`
  UPDATE blog_page_links SET conflict_state = ? WHERE page_id = ?
`);
function setConflictState(pageId, state) {
  if (state !== null && !['detected', 'resolved-app', 'resolved-wp'].includes(state)) {
    throw new Error('blogs.setConflictState: invalid');
  }
  _stmtSetConflict.run(state, parseInt(pageId, 10));
}

// Abgleich: WordPress-Status nachziehen (z.B. drueben publiziert).
const _stmtRefreshMeta = db.prepare(`
  UPDATE blog_page_links SET wp_status = COALESCE(?, wp_status), wp_slug = COALESCE(?, wp_slug) WHERE page_id = ?
`);
function refreshLinkMeta(pageId, { wpStatus = null, wpSlug = null } = {}) {
  return _stmtRefreshMeta.run(wpStatus, wpSlug, parseInt(pageId, 10)).changes > 0;
}

// Push-Sperre merken (lib/wp-html.js#wpLossyBlocks): was der Beitrag in
// WordPress enthaelt und der Import nicht uebernimmt. Leere Liste = frei.
// Das Badge im Buchorganizer zeigt sie, bevor jemand in der App bearbeitet.
const _stmtSetLocked = db.prepare('UPDATE blog_page_links SET locked_blocks = ? WHERE page_id = ?');
function setLockedBlocks(pageId, blocks) {
  const list = Array.isArray(blocks) ? blocks.filter(Boolean) : [];
  _stmtSetLocked.run(list.length ? list.join(', ') : null, parseInt(pageId, 10));
}

const _stmtDeleteLink = db.prepare('DELETE FROM blog_page_links WHERE page_id = ?');
function deleteLink(pageId) {
  return _stmtDeleteLink.run(parseInt(pageId, 10)).changes > 0;
}

module.exports = {
  // Connection
  getConnection,
  getConnectionPublic,
  upsertConnection,
  updateDefaultStatus,
  markInitialImportDone,
  touchPull,
  touchPush,
  deleteConnection,
  // Links
  getLinkByPage,
  getLinkByPost,
  listLinksForBlog,
  upsertLink,
  markLinkPulled,
  markConflictResolvedApp,
  setConflictState,
  refreshLinkMeta,
  setLockedBlocks,
  deleteLink,
};
