'use strict';
// Änderungsvorschläge des Recherche-Chats an BESTEHENDEN Fundstücken übernehmen
// (`type` research_update / research_archive / research_merge, gesammelt von
// routes/jobs/research-chat-change.js).
//
// POST /research/chat-proposal/apply
//   Body: { message_id, index, edits?: { title?, body?, append?, urls?: [url] }, ignore_beleg? }
//   Schreibt die Änderung UND hält am Vorschlag fest, dass sie übernommen ist
//   (applied_at/applied_id), in einer Transaktion — anders als Plot-/Ideen-Chat,
//   die über die regulären Board-Routen schreiben und den Status danach setzen:
//   Ergänzen und Zusammenführen brauchen den aktuellen Stand des Eintrags, und
//   den kennt nur der Server im Moment des Schreibens.
//   `edits`: der User darf den vorgeschlagenen Text ändern (nur Felder, die der
//   Vorschlag trägt) und URLs weglassen (Teilmenge, nie neue).
//   200 { item, proposal, merged_id? }
//   409 PROPOSAL_ALREADY_APPLIED { proposal } · PROPOSAL_DISCARDED
//   409 PROPOSAL_STALE  — ein ersetzter Text wurde seit dem Vorschlag bearbeitet
//   409 BELEG_MISSING   — «eingearbeitet», das Zitat steht nicht mehr im
//                         Abschnitt; mit `ignore_beleg: true` trotzdem
//   404 ITEM_NOT_FOUND  — Eintrag (oder beim Zusammenführen einer der beiden) fehlt
//   400 BODY_TOO_LONG / TOO_MANY_URLS / TOO_MANY_TAGS / MERGE_MEDIA / MERGE_SELF
//
// PATCH /research/chat-proposal — Verwerfen/Wieder öffnen (geteilte Fabrik
// routes/chat-proposal-status.js), nur für diese drei Typen.
//
// Besitz über die Chat-Session (pro User), Buch-ACL `editor`.
// Deep-Doc: docs/recherche-chat.md („Änderungen an bestehenden Einträgen").

const express = require('express');
const { db } = require('../db/schema');
const { toIntId } = require('../lib/validate');
const { guardBook, sessionEmail } = require('../lib/acl');
const { getOwnedSession } = require('../db/chat-sessions');
const { emitItem } = require('../db/research-items');
const { CHANGE_TYPES, applyItemUpdate, archiveItem, mergeItems } = require('../db/research-changes');
const { TITLE_MAX, BODY_MAX, cleanStr } = require('../lib/research-validate');
const { normalizeUrl } = require('../lib/url-normalize');
const { belegFoundInPage } = require('./jobs/research-chat-change');
const { makeChatProposalStatusRouter } = require('./chat-proposal-status');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

const CLIENT_ERRORS = new Set(['BODY_TOO_LONG', 'TOO_MANY_URLS', 'TOO_MANY_TAGS', 'MERGE_MEDIA', 'MERGE_SELF']);

function _readProposals(messageId) {
  const row = db.prepare('SELECT context_info FROM chat_messages WHERE id = ?').get(messageId);
  let ci;
  try { ci = JSON.parse(row?.context_info || '{}') || {}; } catch { ci = {}; }
  return ci;
}

/** Vorgeschlagener Text nach den Bearbeitungen des Users: nur Felder, die der
 *  Vorschlag trägt; ein leerer Titel/Text ist keine Bearbeitung. */
function _editedFields(fields, edits) {
  const out = { ...fields };
  const e = edits && typeof edits === 'object' ? edits : {};
  const caps = { title: TITLE_MAX, body: BODY_MAX, append: BODY_MAX };
  for (const [k, max] of Object.entries(caps)) {
    if (fields[k] === undefined || typeof e[k] !== 'string') continue;
    const v = cleanStr(e[k], max);
    if (v) out[k] = v;
  }
  return out;
}

/** URLs des Vorschlags, die in `keep` stehen (normalisiert); `keep` kein Array → alle. */
function _keptUrls(urls, keep) {
  if (!Array.isArray(keep)) return urls || [];
  const wanted = new Set(keep.map(k => normalizeUrl(typeof k === 'string' ? k : k?.url)).filter(Boolean));
  return (urls || []).filter(u => wanted.has(normalizeUrl(u.url)));
}

/** Änderung eines Vorschlags schreiben (Datenregeln in db/research-changes.js). */
function _apply(p, fields, { bookId, userEmail, keepUrls }) {
  if (p.type === 'research_archive') return archiveItem(bookId, p.item_id);
  if (p.type === 'research_merge') {
    return mergeItems({
      bookId, targetId: p.item_id, sourceId: p.merge_item_id,
      title: fields.title, body: fields.body, before: p.before || {},
    });
  }
  const urls = _keptUrls(p.urls, keepUrls);
  return applyItemUpdate({
    bookId, itemId: p.item_id, userEmail, before: p.before || {},
    change: { ...fields, ...(urls.length ? { urls } : {}) },
    // «eingearbeitet» mit Beleg: die Stelle wird zur Verknüpfung — auf dem
    // Board ist «eingearbeitet» ohne Stelle sonst ein Befund.
    linkPageId: fields.status === 'eingearbeitet' && p.beleg?.page_id ? p.beleg.page_id : null,
  });
}

router.post('/chat-proposal/apply', jsonBody, async (req, res) => {
  const userEmail = sessionEmail(req);
  const messageId = toIntId(req.body?.message_id);
  const index = Number.isInteger(req.body?.index) ? req.body.index : -1;
  if (!messageId || index < 0) return res.status(400).json({ error_code: 'INVALID_ID' });

  const msg = db.prepare("SELECT id, session_id FROM chat_messages WHERE id = ? AND role = 'assistant'").get(messageId);
  const session = msg ? getOwnedSession(msg.session_id, userEmail) : null;
  if (!session || session.kind !== 'research') return res.status(404).json({ error_code: 'PROPOSAL_NOT_FOUND' });
  const bookId = session.book_id;
  if (!guardBook(req, res, bookId, 'editor')) return;

  const p = _readProposals(messageId).proposals?.[index];
  if (!p || !CHANGE_TYPES.has(p.type)) return res.status(404).json({ error_code: 'PROPOSAL_NOT_FOUND' });
  if (p.applied_at) return res.status(409).json({ error_code: 'PROPOSAL_ALREADY_APPLIED', proposal: p });
  if (p.status === 'discarded') return res.status(409).json({ error_code: 'PROPOSAL_DISCARDED' });

  const fields = _editedFields(p.fields || {}, req.body?.edits);
  // Beleg erneut gegen den heutigen Text: zwischen Vorschlag und Klick kann die
  // Stelle umgeschrieben worden sein.
  if (p.type === 'research_update' && fields.status && p.beleg && req.body?.ignore_beleg !== true) {
    if (!(await belegFoundInPage(p.beleg.page_id, p.beleg.text, bookId))) {
      return res.status(409).json({ error_code: 'BELEG_MISSING' });
    }
  }

  // Prüfen, schreiben und «übernommen» festhalten in EINER Transaktion: ein
  // zweiter Klick, der die Prüfung oben schon passiert hat, sieht hier den
  // ersten und hängt nicht ein zweites Mal an.
  let result;
  let next = null;
  db.transaction(() => {
    const ci = _readProposals(messageId);
    const fresh = Array.isArray(ci.proposals) ? ci.proposals[index] : null;
    if (!fresh || fresh.applied_at) { result = { error_code: 'PROPOSAL_ALREADY_APPLIED', proposal: fresh }; return; }
    result = _apply(p, fields, { bookId, userEmail, keepUrls: req.body?.edits?.urls });
    if (!result.ok) return;
    next = { ...fresh, applied_at: new Date().toISOString(), applied_id: p.item_id };
    delete next.status;
    ci.proposals[index] = next;
    db.prepare('UPDATE chat_messages SET context_info = ? WHERE id = ?').run(JSON.stringify(ci), messageId);
  })();
  if (!result.ok) {
    const code = result.error_code;
    const status = code === 'ITEM_NOT_FOUND' ? 404 : (CLIENT_ERRORS.has(code) ? 400 : 409);
    return res.status(status).json({
      error_code: code,
      ...(result.params ? { params: result.params } : {}),
      ...(result.proposal ? { proposal: result.proposal } : {}),
    });
  }
  logger.info(`[research] chat-change msg=${messageId} idx=${index} ${p.type} item=${p.item_id}${result.merged_id ? ` ← ${result.merged_id} (gelöscht)` : ''}`);
  res.json({
    item: emitItem(p.item_id),
    proposal: next || p,
    ...(result.merged_id ? { merged_id: result.merged_id } : {}),
  });
});

// Verwerfen / Wieder öffnen — nur die Änderungsvorschläge; neue Fundstücke
// kennen kein Verwerfen, Ideen laufen über PATCH /ideen/chat-proposal.
router.use('/', makeChatProposalStatusRouter({
  kinds: ['research'],
  accepts: (p) => CHANGE_TYPES.has(p?.type),
}));

module.exports = { researchChatChangesRouter: router };
