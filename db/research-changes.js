'use strict';
// Änderungen an BESTEHENDEN Fundstücken, wie sie der Recherche-Chat vorschlägt
// (propose_research_item mit `item_id`) und der User einzeln übernimmt:
//   applyItemUpdate — Text umschreiben/anhängen, URLs + Tags ergänzen, Status
//   archiveItem     — aus dem Board räumen
//   mergeItems      — Fundstück B geht in A auf; B wird danach gelöscht
//
// Jede Schreibfolge läuft über die Schreibwege des Boards (replaceUrls,
// replaceTags, setItemsStatus, addItemLink in ./research-items.js) — «aus dem
// Chat» darf nicht anders schreiben als die Karte. Prüfung von Rechten und
// Vorschlag macht der Aufrufer (routes/research-chat-changes.js); hier stehen
// nur die Datenregeln, die beide Seiten (Vorschlag + Übernehmen) teilen.
// Deep-Doc: docs/recherche-chat.md („Änderungen an bestehenden Einträgen").

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const searchIndex = require('../lib/search');
const { normalizeUrl } = require('../lib/url-normalize');
const { BODY_MAX, MAX_URLS, MAX_TAGS, normalizeUrls, normalizeTags } = require('../lib/research-validate');
const { replaceUrls, replaceTags, setItemsStatus, addItemLink } = require('./research-items');

// Nur Text-Fundstücke gehen in einem anderen auf: Bild, PDF und Transkript
// trügen ihre Datei mit ins Löschen.
const MERGEABLE_KINDS = new Set(['note', 'link', 'quote', 'fact']);

// `type` der Änderungsvorschläge in context_info.proposals des Recherche-Chats.
const CHANGE_TYPES = new Set(['research_update', 'research_archive', 'research_merge']);

/** Fundstück samt URLs und Tags, wie Vorschlag und Übernehmen es vergleichen —
 *  null, wenn es nicht (mehr) zu `bookId` gehört. */
function changeTarget(bookId, id) {
  const row = db.prepare(
    `SELECT id, book_id, kind, title, body, source, status, archived, pinned
       FROM research_items WHERE id = ? AND book_id = ?`
  ).get(id, bookId);
  if (!row) return null;
  row.urls = db.prepare(
    'SELECT url, label FROM research_item_urls WHERE item_id = ? ORDER BY position, id'
  ).all(id).map(u => ({ url: u.url, label: u.label || '' }));
  row.tags = db.prepare('SELECT tag FROM research_item_tags WHERE item_id = ? ORDER BY tag').all(id).map(r => r.tag);
  return row;
}

/** URLs aus `add`, die `have` noch nicht trägt (normalisiert verglichen). */
function newUrls(have, add) {
  const seen = new Set((have || []).map(u => normalizeUrl(u.url)).filter(Boolean));
  const out = [];
  for (const u of normalizeUrls(add, { max: Infinity }).urls) {
    const n = normalizeUrl(u.url);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(u);
  }
  return out;
}

/** Tags aus `add`, die `have` noch nicht trägt (ohne Gross/Klein). */
function newTags(have, add) {
  const seen = new Set((have || []).map(t => t.toLowerCase()));
  return normalizeTags(add, { max: Infinity }).filter(t => !seen.has(t.toLowerCase()));
}

/** Inhalt mit angehängtem Absatz; null, wenn er BODY_MAX sprengte. */
function appendedBody(current, append) {
  const cur = String(current || '').trimEnd();
  const add = String(append || '').trim();
  if (!add) return cur || null;
  const next = cur ? `${cur}\n\n${add}` : add;
  return next.length > BODY_MAX ? null : next;
}

/** Inhalt von A nach dem Zusammenführen ohne vorgegebenen Text: B darunter,
 *  ausser A enthält ihn schon wörtlich. null = BODY_MAX gesprengt. */
function mergedBody(a, b) {
  const bb = String(b || '').trim();
  if (!bb || String(a || '').includes(bb)) return String(a || '').trim() || null;
  return appendedBody(a, bb);
}

// Ausgang für den Aufrufer: { ok: true } oder { error_code } (400/409-Wahl dort).
const STALE = { error_code: 'PROPOSAL_STALE' };

/**
 * Änderung an einem Fundstück übernehmen. `change` = Felder des Vorschlags nach
 * den Bearbeitungen des Users: { title?, body?, append?, source?, tags?, status?,
 * urls? } — title/body/source ersetzen, append/urls/tags kommen dazu. `before`
 * hält den Stand beim Vorschlagen: steht ein ersetzter Text inzwischen anders
 * da, hat ihn jemand bearbeitet → PROPOSAL_STALE, nichts wird geschrieben.
 * `linkPageId`: bei «eingearbeitet» mit Beleg die Stelle als Verknüpfung.
 */
function applyItemUpdate({ bookId, itemId, change, before = {}, userEmail, linkPageId = null }) {
  let out = { ok: true };
  db.transaction(() => {
    const cur = changeTarget(bookId, itemId);
    if (!cur) { out = { error_code: 'ITEM_NOT_FOUND' }; return; }
    for (const f of ['title', 'body', 'source']) {
      if (change[f] !== undefined && (cur[f] || '') !== (before[f] || '')) { out = STALE; return; }
    }
    const sets = [];
    const vals = [];
    for (const f of ['title', 'body', 'source']) {
      if (change[f] === undefined) continue;
      sets.push(`${f} = ?`);
      vals.push(change[f] || null);
    }
    if (change.append) {
      const body = appendedBody(change.body !== undefined ? change.body : cur.body, change.append);
      if (body === null) { out = { error_code: 'BODY_TOO_LONG' }; return; }
      const i = sets.indexOf('body = ?');
      if (i >= 0) vals[i] = body; else { sets.push('body = ?'); vals.push(body); }
    }
    const urls = change.urls?.length ? newUrls(cur.urls, change.urls) : [];
    const tags = change.tags?.length ? newTags(cur.tags, change.tags) : [];
    if (cur.urls.length + urls.length > MAX_URLS) { out = { error_code: 'TOO_MANY_URLS', params: { max: MAX_URLS } }; return; }
    if (cur.tags.length + tags.length > MAX_TAGS) { out = { error_code: 'TOO_MANY_TAGS', params: { max: MAX_TAGS } }; return; }
    if (sets.length || urls.length) {
      sets.push(`updated_at = ${NOW_ISO_SQL}`);
      db.prepare(`UPDATE research_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals, itemId);
    }
    if (urls.length) replaceUrls(itemId, [...cur.urls, ...urls]);
    if (tags.length) replaceTags(itemId, [...cur.tags, ...tags]);
    if (change.status && change.status !== cur.status) setItemsStatus([itemId], change.status, userEmail);
    if (linkPageId) addItemLink(itemId, bookId, 'page', linkPageId);
    out = { ok: true, reindex: sets.length > 0 };
  })();
  if (out.reindex) searchIndex.upsertResearch(itemId);
  return out;
}

/** Fundstück archivieren (dieselbe Spalte wie der Board-Schalter). */
function archiveItem(bookId, itemId) {
  const r = db.prepare(
    `UPDATE research_items SET archived = 1, updated_at = ${NOW_ISO_SQL} WHERE id = ? AND book_id = ?`
  ).run(itemId, bookId);
  return r.changes ? { ok: true } : { error_code: 'ITEM_NOT_FOUND' };
}

/** Darf `b` in `a` aufgehen? null = ja, sonst der Fehlercode. */
function mergeBlocker(a, b) {
  if (!a || !b) return 'ITEM_NOT_FOUND';
  if (a.id === b.id) return 'MERGE_SELF';
  if (!MERGEABLE_KINDS.has(b.kind)) return 'MERGE_MEDIA';
  return null;
}

/**
 * B geht in A auf: URLs und Tags vereinigt (A zuerst), Verknüpfungen mit Stellen
 * und Entitäten, Ideen-Bezüge und Abgleich-Befunde ziehen auf A um (doppelte
 * bleiben einmal), Quelle und Anheften übernimmt A, wenn es selbst keine hat;
 * Status bleibt der von A. Text: vorgegebener `title`/`body` des Vorschlags,
 * sonst A mit dem Inhalt von B darunter. Danach wird B gelöscht. `before` wie
 * bei applyItemUpdate (nur bei vorgegebenem Text geprüft).
 */
function mergeItems({ bookId, targetId, sourceId, title, body, before = {} }) {
  let out = { ok: true };
  db.transaction(() => {
    const a = changeTarget(bookId, targetId);
    const b = changeTarget(bookId, sourceId);
    const blocker = mergeBlocker(a, b);
    if (blocker) { out = { error_code: blocker }; return; }
    if (title !== undefined && (a.title || '') !== (before.title || '')) { out = STALE; return; }
    if (body !== undefined && (a.body || '') !== (before.body || '')) { out = STALE; return; }
    const nextBody = body !== undefined ? (body || null) : mergedBody(a.body, b.body);
    if (body === undefined && nextBody === null && (a.body || b.body)) { out = { error_code: 'BODY_TOO_LONG' }; return; }
    const urls = [...a.urls, ...newUrls(a.urls, b.urls)];
    const tags = [...a.tags, ...newTags(a.tags, b.tags)];
    db.prepare(
      `UPDATE research_items
          SET title = ?, body = ?, source = ?, pinned = ?, updated_at = ${NOW_ISO_SQL}
        WHERE id = ?`
    ).run(
      (title !== undefined ? title : (a.title || b.title)) || null,
      nextBody,
      a.source || b.source || null,
      a.pinned || b.pinned ? 1 : 0,
      a.id,
    );
    // Gedeckelt wie jede Eingabe: was über MAX_URLS/MAX_TAGS hinausgeht, fällt
    // weg (normalizeUrls/normalizeTags in replaceUrls/replaceTags).
    replaceUrls(a.id, urls);
    replaceTags(a.id, tags);
    // OR IGNORE: eine Verknüpfung, die A schon hat, bleibt an B und fällt mit ihm.
    db.prepare('UPDATE OR IGNORE research_item_links SET item_id = ? WHERE item_id = ?').run(a.id, b.id);
    db.prepare('UPDATE OR IGNORE idea_links SET research_id = ? WHERE research_id = ?').run(a.id, b.id);
    db.prepare('UPDATE research_item_findings SET item_id = ? WHERE item_id = ?').run(a.id, b.id);
    db.prepare('DELETE FROM research_items WHERE id = ?').run(b.id);
    out = { ok: true, merged_id: b.id };
  })();
  if (out.ok) {
    searchIndex.remove('research', sourceId);
    searchIndex.upsertResearch(targetId);
  }
  return out;
}

module.exports = {
  MERGEABLE_KINDS, CHANGE_TYPES, changeTarget, newUrls, newTags, appendedBody, mergeBlocker,
  applyItemUpdate, archiveItem, mergeItems,
};
