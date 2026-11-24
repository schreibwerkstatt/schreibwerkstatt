'use strict';
// Review ueber den Share-Link: Reviewer eines Review-Links und die
// Entscheidung ueber Aenderungsvorschlaege. Link + Kommentare selbst:
// ./share-links.js. Fachlich: docs/share-link.md → „Review-Modus".
//
// Reviewer sind Namen, keine Konten. Ein Browser beansprucht einen Namen ueber
// sein reader_token (dasselbe Token wie die Kommentar-Identitaet); ein zweiter
// Browser darf den Namen uebernehmen (Laptop → Telefon) — unter Kollegen ist das
// gewollt, und ohne Anmeldung gaebe es keinen besseren Beweis.
// Die Liste kann der Autor vorgeben; wer ueber den Link kommt (z. B. im Team-
// Chat geteilt), traegt sich auch selbst ein (`claimReviewerByName`).

const { db } = require('./connection');
require('./migrations');
const { NOW_ISO_SQL } = require('./now');

const REVIEWER_NAME_MAX = 80;
// Ein Deckel fuer vorgegebene und selbst eingetragene Reviewer zusammen: der
// Link ist oeffentlich, Selbsteintragen darf die Liste nicht beliebig fuellen.
const REVIEWERS_MAX = 30;
const DONE_NOTE_MAX = 4000;
const SUGGESTION_STATES = ['open', 'accepted', 'rejected'];

const _list = db.prepare(`
  SELECT id, name, position, reader_token, done_at, done_note
    FROM share_link_reviewers WHERE share_token = ? ORDER BY position, id
`);

/** Reviewer eines Links. Fuer Leser ohne reader_token/done_note (Owner-Sicht: `withPrivate`). */
function listReviewers(token, { withPrivate = false, readerToken = null } = {}) {
  return _list.all(String(token)).map(r => ({
    id: r.id,
    name: r.name,
    done: !!r.done_at,
    done_at: r.done_at || null,
    claimed: !!r.reader_token,
    mine: !!readerToken && r.reader_token === readerToken,
    ...(withPrivate ? { done_note: r.done_note || null } : {}),
  }));
}

/** Namensliste normalisieren: getrimmt, gekappt, ohne Dubletten (ohne Gross-/Kleinschreibung). */
function normalizeReviewerNames(names) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(names) ? names : []) {
    const n = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, REVIEWER_NAME_MAX);
    const k = n.toLocaleLowerCase();
    if (!n || seen.has(k)) continue;
    seen.add(k);
    out.push(n);
    if (out.length >= REVIEWERS_MAX) break;
  }
  return out;
}

const _byName = db.prepare('SELECT id FROM share_link_reviewers WHERE share_token = ? AND name = ? COLLATE NOCASE');
const _insert = db.prepare(`
  INSERT INTO share_link_reviewers (share_token, name, position, created_at) VALUES (?, ?, ?, ${NOW_ISO_SQL})
`);
const _setPos = db.prepare('UPDATE share_link_reviewers SET position = ?, name = ? WHERE id = ?');

/** Reviewer-Liste ersetzen. Bestehende Namen behalten Anspruch und Abschluss —
 *  ein Umsortieren oder Ergaenzen setzt niemanden zurueck. */
const replaceReviewers = db.transaction((token, names) => {
  const list = normalizeReviewerNames(names);
  const keep = [];
  list.forEach((name, i) => {
    const row = _byName.get(String(token), name);
    if (row) { _setPos.run(i, name, row.id); keep.push(row.id); }
    else keep.push(Number(_insert.run(String(token), name, i).lastInsertRowid));
  });
  const placeholders = keep.map(() => '?').join(',');
  db.prepare(`DELETE FROM share_link_reviewers WHERE share_token = ?${keep.length ? ` AND id NOT IN (${placeholders})` : ''}`)
    .run(String(token), ...keep);
  return list;
});

const _clearClaim = db.prepare('UPDATE share_link_reviewers SET reader_token = NULL WHERE share_token = ? AND reader_token = ? AND id <> ?');
const _claim = db.prepare('UPDATE share_link_reviewers SET reader_token = ? WHERE id = ? AND share_token = ?');
const _get = db.prepare('SELECT id, name, reader_token, done_at FROM share_link_reviewers WHERE id = ? AND share_token = ?');

/** Ein Browser beansprucht einen Reviewer-Namen. Ein Browser = ein Reviewer:
 *  ein frueherer Anspruch desselben Browsers faellt. Liefert die Zeile oder null. */
const claimReviewer = db.transaction((token, reviewerId, readerToken) => {
  const row = _get.get(reviewerId, String(token));
  if (!row) return null;
  _clearClaim.run(String(token), readerToken, reviewerId);
  _claim.run(readerToken, reviewerId, String(token));
  return _get.get(reviewerId, String(token));
});

const _count = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS maxPos FROM share_link_reviewers WHERE share_token = ?');

/** Ein Browser traegt sich mit freiem Namen ein. Gleicher Name (ohne Gross-/
 *  Kleinschreibung) beansprucht den bestehenden Reviewer, sonst entsteht ein
 *  neuer am Ende der Liste. Liefert die Zeile, `{ full: true }` beim Deckel
 *  oder null bei leerem Namen. */
const claimReviewerByName = db.transaction((token, rawName, readerToken) => {
  const [name] = normalizeReviewerNames([rawName]);
  if (!name) return null;
  const hit = _byName.get(String(token), name);
  let id = hit?.id;
  if (!id) {
    const { n, maxPos } = _count.get(String(token));
    if (n >= REVIEWERS_MAX) return { full: true };
    id = Number(_insert.run(String(token), name, maxPos + 1).lastInsertRowid);
  }
  return claimReviewer(token, id, readerToken);
});

const _byReader = db.prepare('SELECT id, name, done_at FROM share_link_reviewers WHERE share_token = ? AND reader_token = ?');
function reviewerForReader(token, readerToken) {
  if (!readerToken) return null;
  return _byReader.get(String(token), readerToken) || null;
}

const _done = db.prepare(`
  UPDATE share_link_reviewers SET done_at = ${NOW_ISO_SQL}, done_note = ? WHERE share_token = ? AND reader_token = ?
`);
const _undone = db.prepare('UPDATE share_link_reviewers SET done_at = NULL WHERE share_token = ? AND reader_token = ?');
/** Review des beanspruchten Reviewers abschliessen bzw. wieder oeffnen. */
function setReviewerDone(token, readerToken, done, note = null) {
  const n = note == null ? null : String(note).trim().slice(0, DONE_NOTE_MAX) || null;
  const r = done ? _done.run(n, String(token), readerToken) : _undone.run(String(token), readerToken);
  return r.changes > 0;
}

const _rename = db.prepare(`
  UPDATE share_comments SET reader_name = ? WHERE share_token = ? AND reader_token = ? AND author_email IS NULL
`);
/** Nach dem Beanspruchen: bisherige Kommentare dieses Browsers tragen den Reviewer-Namen. */
function renameReaderComments(token, readerToken, name) {
  return _rename.run(name, String(token), readerToken).changes;
}

// ── Aenderungsvorschlaege ────────────────────────────────────────────────────

/** Entscheidung des Owners: 'accepted' erledigt den Thread mit, 'rejected' laesst
 *  ihn offen (der Owner antwortet meist, warum), 'open' nimmt sie zurueck. */
function setSuggestionState(commentId, ownerEmail, state) {
  if (!SUGGESTION_STATES.includes(state)) throw new Error('share-review.setSuggestionState: invalid');
  const decided = state === 'open' ? 'NULL' : NOW_ISO_SQL;
  const resolved = state === 'accepted' ? `COALESCE(resolved_at, ${NOW_ISO_SQL})` : 'resolved_at';
  const r = db.prepare(`
    UPDATE share_comments
       SET suggestion_state = ?, suggestion_decided_at = ${decided}, resolved_at = ${resolved}
     WHERE id = ? AND parent_id IS NULL AND suggestion_text IS NOT NULL
       AND share_token IN (SELECT token FROM share_links WHERE owner_email = ?)
  `).run(state, commentId, ownerEmail);
  return r.changes > 0;
}

// ── Stand eines Review-Links (Owner-Karte, Status-Kopplung) ──────────────────

const _openThreads = db.prepare(`
  SELECT COUNT(*) AS n FROM share_comments
   WHERE share_token = ? AND parent_id IS NULL AND author_email IS NULL AND resolved_at IS NULL
`);
const _openSuggestions = db.prepare(`
  SELECT COUNT(*) AS n FROM share_comments
   WHERE share_token = ? AND parent_id IS NULL AND suggestion_state = 'open'
`);

/**
 * `{ reviewers, done, total, openThreads, openSuggestions, complete }`.
 * `complete`: alle Reviewer fertig (mindestens einer) und nichts mehr offen —
 * Voraussetzung, damit die App «gegengelesen» anbietet (gesetzt wird nie
 * automatisch, docs/bearbeitungsstand.md).
 */
function reviewState(token) {
  const reviewers = listReviewers(token, { withPrivate: true });
  const done = reviewers.filter(r => r.done).length;
  const openThreads = _openThreads.get(String(token)).n;
  const openSuggestions = _openSuggestions.get(String(token)).n;
  return {
    reviewers, done, total: reviewers.length, openThreads, openSuggestions,
    complete: reviewers.length > 0 && done === reviewers.length && openThreads === 0 && openSuggestions === 0,
  };
}

module.exports = {
  listReviewers, normalizeReviewerNames, replaceReviewers, claimReviewer, claimReviewerByName, reviewerForReader, renameReaderComments,
  setReviewerDone, setSuggestionState, reviewState,
  REVIEWER_NAME_MAX, REVIEWERS_MAX, DONE_NOTE_MAX, SUGGESTION_STATES,
};
