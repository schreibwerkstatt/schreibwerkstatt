'use strict';
// POST /research/bulk — Mehrfachauswahl im Recherche-Board: eine Aktion auf
// viele Fundstuecke in EINER Transaktion (Status setzen, Tag ergaenzen,
// archivieren/zurueckholen, mit einer Stelle oder Entitaet verknuepfen bzw. die
// Verknuepfung loesen, loeschen). `unlink` ist das Gegenstueck zu `link` — das
// Rueckgaengig der Karte (public/js/book/recherche/history.js) loest damit eine
// Verknuepfung ueber ihr Ziel, ohne die link_id je Fundstueck zu kennen.
//
// Body: { book_id, ids: [..], action, status?, tag?, target_kind?, target_id? }
//
// Die Ids werden auf das Buch eingeschraenkt (fremde und unbekannte fallen still
// weg; `count` sagt, wie viele wirklich betroffen waren) — die ACL haengt allein
// am Buch, wie bei den Einzel-Routen (routes/research-acl.js). Jede Aktion nutzt
// den Schreibweg der Einzel-Route (setItemsStatus, addItemLink, Suchindex), damit
// „viele auf einmal" nicht anders schreibt als „eins".

const express = require('express');
const { db } = require('../db/schema');
const { toIntId } = require('../lib/validate');
const { guardBook, sessionEmail } = require('../lib/acl');
const { NOW_ISO_SQL } = require('../db/now');
const searchIndex = require('../lib/search');
const { RESEARCH_STATUS_SET, MAX_TAGS, normalizeTags } = require('../lib/research-validate');
const { linkTarget, setItemsStatus, addItemLink } = require('../db/research-items');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

const BULK_MAX = 500;
const ACTIONS = new Set(['status', 'add_tag', 'archive', 'unarchive', 'link', 'unlink', 'delete']);

function _bookItemIds(bookId, rawIds) {
  const ids = [...new Set((Array.isArray(rawIds) ? rawIds : []).map(toIntId).filter(Boolean))].slice(0, BULK_MAX);
  if (!ids.length) return [];
  return db.prepare(
    `SELECT id FROM research_items WHERE book_id = ? AND id IN (${ids.map(() => '?').join(',')})`
  ).all(bookId, ...ids).map(r => r.id);
}

router.post('/bulk', jsonBody, (req, res) => {
  const b = req.body || {};
  const bookId = toIntId(b.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  // guardBook setzt den Log-Kontext `book` selbst.
  if (!guardBook(req, res, bookId, 'editor')) return;

  const action = String(b.action || '');
  if (!ACTIONS.has(action)) return res.status(400).json({ error_code: 'INVALID_ACTION' });
  if (action === 'status' && !RESEARCH_STATUS_SET.has(b.status)) return res.status(400).json({ error_code: 'INVALID_STATUS' });
  const tag = action === 'add_tag' ? normalizeTags([b.tag])[0] : null;
  if (action === 'add_tag' && !tag) return res.status(400).json({ error_code: 'INVALID_TAG' });
  if ((action === 'link' || action === 'unlink') && (!linkTarget(b.target_kind) || !toIntId(b.target_id))) {
    return res.status(400).json({ error_code: 'INVALID_TARGET' });
  }

  const ids = _bookItemIds(bookId, b.ids);
  if (!ids.length) return res.json({ ok: true, count: 0 });
  const ph = ids.map(() => '?').join(',');

  let linkError = null;
  // add_tag: ein Fundstueck traegt hoechstens MAX_TAGS Tags (wie replaceTags beim
  // Einzel-Edit). Am Deckel wird es uebersprungen und in `skipped` gezaehlt;
  // traegt es den Tag schon (gleich bis auf Gross-/Kleinschreibung), ist das kein
  // Ueberspringen, sondern schon erledigt.
  let skipped = 0;
  const run = db.transaction(() => {
    if (action === 'status') {
      setItemsStatus(ids, b.status, sessionEmail(req));
    } else if (action === 'add_tag') {
      const tagsOf = db.prepare('SELECT tag FROM research_item_tags WHERE item_id = ?');
      const ins = db.prepare('INSERT OR IGNORE INTO research_item_tags (item_id, tag) VALUES (?, ?)');
      for (const id of ids) {
        const have = tagsOf.all(id).map(r => r.tag.toLowerCase());
        if (have.includes(tag.toLowerCase())) continue;
        if (have.length >= MAX_TAGS) { skipped += 1; continue; }
        ins.run(id, tag);
      }
    } else if (action === 'archive' || action === 'unarchive') {
      db.prepare(`UPDATE research_items SET archived = ?, updated_at = ${NOW_ISO_SQL} WHERE id IN (${ph})`)
        .run(action === 'archive' ? 1 : 0, ...ids);
    } else if (action === 'link') {
      for (const id of ids) {
        linkError = addItemLink(id, bookId, b.target_kind, b.target_id);
        // Das Ziel ist fuer alle dasselbe — scheitert es einmal (fremdes Buch),
        // scheitert es fuer alle: ganze Transaktion zurueck.
        if (linkError) throw new Error(linkError);
      }
    } else if (action === 'unlink') {
      // Spalte aus dem Deskriptor (feste Whitelist, nie aus dem Body).
      const col = linkTarget(b.target_kind).col;
      db.prepare(`DELETE FROM research_item_links WHERE target_kind = ? AND ${col} = ? AND item_id IN (${ph})`)
        .run(b.target_kind, toIntId(b.target_id), ...ids);
    } else if (action === 'delete') {
      db.prepare(`DELETE FROM research_items WHERE id IN (${ph})`).run(...ids);
    }
  });
  try {
    run();
  } catch (e) {
    if (!linkError) throw e;
    return res.status(400).json({ error_code: linkError });
  }

  // Suchindex ausserhalb der Transaktion (wie die Einzel-Routen nach dem
  // Schreiben). Nur Loeschen beruehrt ihn: Tags, Status und Archiv-Schalter
  // stehen nicht im Volltext (lib/search.js#_upsertResearch).
  if (action === 'delete') {
    for (const id of ids) {
      try { searchIndex.remove('research', id); }
      catch (e) { logger.warn(`[research] Suchindex nach Bulk delete id=${id}: ${e.message}`); }
    }
  }
  logger.info(`[research] bulk ${action} count=${ids.length}${skipped ? ` skipped=${skipped}` : ''}`);
  res.json({ ok: true, count: ids.length - skipped, ...(action === 'add_tag' ? { skipped } : {}) });
});

module.exports = { researchBulkRouter: router };
