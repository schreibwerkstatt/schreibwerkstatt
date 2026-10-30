'use strict';
// Speichern eines Recherche-Chat-Vorschlags (`propose_research_item`) ins Board.
//
// Eigener Weg statt `POST /research` aus dem Browser, weil drei Dinge in EINEM
// Schritt passieren müssen, sonst driftet der Zustand:
//   1. Fundstück anlegen (dieselbe Schreibsequenz wie POST /research: createItem)
//   2. optional mit der Seite/dem Kapitel verknüpfen (Kontext-Chip im Chat)
//   3. den Gespeichert-Status am Vorschlag persistieren
//      (`context_info.proposals[i].saved_item_id` der Assistant-Nachricht) —
//      sonst zeigt die Session nach einem Reload wieder „Speichern" und ein
//      zweiter Klick legt eine Dublette an.
// Der User darf Titel/Typ/Tags/Inhalt vor dem Speichern ändern und einzelne Links
// weglassen (`edits`) — Links nur entfernen, nie hinzufügen: die URLs eines
// Vorschlags sind die, die der Job geprüft und markiert hat (`verified`).
//
// Deep-Doc: docs/recherche-chat.md („Speicher-Vorschläge").

const express = require('express');
const { db } = require('../db/schema');
const { toIntId } = require('../lib/validate');
const { guardBook, sessionEmail } = require('../lib/acl');
const { getOwnedSession } = require('../db/chat-sessions');
const {
  createItem, emitItem, findDuplicateItem, addItemLink,
} = require('../db/research-items');
const {
  PROPOSAL_KINDS, TITLE_MAX, BODY_MAX, SOURCE_MAX, cleanStr, normalizeUrls, normalizeTags,
} = require('../lib/research-validate');
const { normalizeUrl } = require('../lib/url-normalize');
const logger = require('../logger');
const { setContext } = require('../lib/log-context');

const router = express.Router();
const jsonBody = express.json();

// Nur diese beiden Kontexte bietet der Chip an; andere Ziele verknüpft der User im Board.
const CONTEXT_KINDS = new Set(['page', 'chapter']);

/** URLs des Vorschlags, die in `keep` stehen (Vergleich normalisiert); `keep` kein
 *  Array → alle. Eine URL, die der Vorschlag nicht hat, fällt weg. */
function _keptUrls(own, keep) {
  if (!Array.isArray(keep)) return own;
  const wanted = new Set(keep.map(k => normalizeUrl(typeof k === 'string' ? k : k?.url)).filter(Boolean));
  return own.filter(u => wanted.has(normalizeUrl(u.url)));
}

/** Vorschlag + Bearbeitungen → Felder für createItem. Pure (unit-getestet über die Route).
 *  `edits.urls`: Teilmenge der Vorschlags-URLs (Strings oder { url }) — neue URLs
 *  werden ignoriert, die Labels bleiben die des Vorschlags. */
function mergeProposal(p, edits = {}) {
  const e = edits && typeof edits === 'object' ? edits : {};
  const pick = (k) => (typeof e[k] === 'string' ? e[k] : p[k]);
  return {
    kind: PROPOSAL_KINDS.has(e.kind) ? e.kind : (PROPOSAL_KINDS.has(p.kind) ? p.kind : 'note'),
    title: cleanStr(pick('title'), TITLE_MAX) || '',
    body: cleanStr(pick('body'), BODY_MAX) || '',
    source: cleanStr(p.source, SOURCE_MAX) || '',
    urls: _keptUrls(normalizeUrls(p.urls).urls, e.urls),
    tags: normalizeTags(Array.isArray(e.tags) ? e.tags : p.tags),
  };
}

// POST /research/chat-proposal
// Body: { message_id, index, edits?: { title, body, kind, tags[], urls[] },
//         link?: { target_kind: 'page'|'chapter', target_id }, allow_duplicate? }
// 200 { item, proposal } · 409 DUPLICATE_URL { existing_id } · 409 ALREADY_SAVED { item_id }
router.post('/chat-proposal', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  const messageId = toIntId(req.body?.message_id);
  const index = Number.isInteger(req.body?.index) ? req.body.index : -1;
  if (!messageId || index < 0) return res.status(400).json({ error_code: 'INVALID_ID' });

  const msg = db.prepare(
    "SELECT id, session_id, context_info FROM chat_messages WHERE id = ? AND role = 'assistant'"
  ).get(messageId);
  // Besitz über die Session: Chat-Sessions sind pro User (der Login selbst ist
  // vom globalen Auth-Guard schon geprüft). Fremde Nachricht = 404, kein 403 —
  // die Existenz fremder Nachrichten wird nicht bestätigt.
  const session = msg ? getOwnedSession(msg.session_id, userEmail) : null;
  if (!session || session.kind !== 'research') return res.status(404).json({ error_code: 'PROPOSAL_NOT_FOUND' });
  const bookId = session.book_id;
  if (!guardBook(req, res, bookId, 'editor')) return;
  setContext({ book: bookId });

  let ci;
  try { ci = JSON.parse(msg.context_info || '{}') || {}; } catch { ci = {}; }
  const proposals = Array.isArray(ci.proposals) ? ci.proposals : [];
  const p = proposals[index];
  if (!p) return res.status(404).json({ error_code: 'PROPOSAL_NOT_FOUND' });
  if (p.saved_item_id && db.prepare('SELECT 1 FROM research_items WHERE id = ? AND book_id = ?').get(p.saved_item_id, bookId)) {
    return res.status(409).json({ error_code: 'ALREADY_SAVED', item_id: p.saved_item_id, params: { item_id: p.saved_item_id } });
  }

  const fields = mergeProposal(p, req.body?.edits);
  if (!fields.title && !fields.body && !fields.urls.length) return res.status(400).json({ error_code: 'EMPTY' });

  const link = req.body?.link;
  const linkKind = link && CONTEXT_KINDS.has(link.target_kind) ? link.target_kind : null;
  const linkId = linkKind ? toIntId(link.target_id) : null;
  if (link && (!linkKind || !linkId)) return res.status(400).json({ error_code: 'INVALID_TARGET' });

  if (fields.urls.length && req.body?.allow_duplicate !== true) {
    const dup = findDuplicateItem(bookId, { urls: fields.urls });
    if (dup && dup.match === 'url') {
      return res.status(409).json({
        error_code: 'DUPLICATE_URL',
        existing_id: dup.id,
        params: { existing_id: dup.id, title: dup.title || dup.url || '' },
      });
    }
  }

  let itemId;
  let linkError = null;
  db.transaction(() => {
    itemId = createItem({ bookId, userEmail, ...fields });
    if (linkKind) linkError = addItemLink(itemId, bookId, linkKind, linkId);
    // Gespeichert-Status am Vorschlag persistieren (frisch gelesen in derselben
    // Transaktion, damit ein paralleler Speichern-Klick eines anderen Index nicht
    // überschrieben wird).
    const fresh = db.prepare('SELECT context_info FROM chat_messages WHERE id = ?').get(messageId);
    let ci2;
    try { ci2 = JSON.parse(fresh?.context_info || '{}') || {}; } catch { ci2 = {}; }
    if (Array.isArray(ci2.proposals) && ci2.proposals[index]) {
      ci2.proposals[index] = { ...ci2.proposals[index], saved_item_id: itemId };
      db.prepare('UPDATE chat_messages SET context_info = ? WHERE id = ?').run(JSON.stringify(ci2), messageId);
    }
  })();
  // Ein Seiten-/Kapitel-Ziel ausserhalb des Buchs ist ein Client-Fehler, aber kein
  // Grund, das schon gespeicherte Fundstück zu verwerfen — die Antwort meldet es.
  logger.info(`[research] chat-proposal msg=${messageId} idx=${index} → item=${itemId}${linkKind ? ` link=${linkKind}:${linkId}${linkError ? ` (${linkError})` : ''}` : ''}`);
  res.json({
    item: emitItem(itemId),
    proposal: { ...p, saved_item_id: itemId },
    ...(linkError ? { link_error: linkError } : {}),
  });
});

module.exports = { researchChatProposalsRouter: router, mergeProposal };
