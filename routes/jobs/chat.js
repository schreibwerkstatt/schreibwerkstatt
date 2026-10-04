'use strict';
// Chat-Job-Router — Facade über routes/jobs/chat/. Fünf Chats teilen den
// gemeinsamen POST-Handler + das Storage-Modell, laufen aber als getrennte
// Job-Typen (siehe docs/chats.md).
//
//   chat/shared.js    — Antwort-Parsing, _handleChatPost, Buch-Chat-Seiten-Cache.
//   chat/page-chat.js — Seiten-Chat (kind='page', vorschlaege-Envelope).
//   chat/book-chat.js — Buch-Chat (kind='book', klassisch + agentisch + Dispatch).
//   ../research-chat  — Recherche-Chat (kind='research', Claude-only, Web-Suche).
//   ../plot-chat      — Plot-Chat (kind='plot', Panel der Plot-Werkstatt, Vorschläge ans Board).
//   ../ideen-chat     — Ideen-Chat (kind='ideen', Panel im Ideen-Board, Vorschläge an die Ideen).

const express = require('express');
const { toIntId } = require('../../lib/validate');
const { jsonBody } = require('./shared');
const { _handleChatPost, bookPageCache, invalidateBookPageCache } = require('./chat/shared');
const { runChatJob } = require('./chat/page-chat');
const { runBookChatJobDispatch } = require('./chat/book-chat');
const { runResearchChatJob } = require('./research-chat');
const { runPlotChatJobDispatch } = require('./plot-chat');
const { runIdeenChatJobDispatch } = require('./ideen-chat');
const { guardBook, sessionEmail } = require('../../lib/acl');
const { getBookSettings } = require('../../db/schema');
const { setContext } = require('../../lib/log-context');
const { researchChatGate } = require('../../lib/research-chat-gate');
const { researchMessageContext } = require('./research-chat-helpers');

const chatRouter = express.Router();

chatRouter.post('/chat', jsonBody, (req, res) => _handleChatPost(req, res, {
  jobType: 'chat',
  kind: 'page',
  labelFn: s => s.page_name
    ? { key: 'job.label.chatPage', params: { name: s.page_name } }
    : { key: 'job.label.chat', params: null },
  runFn: runChatJob,
}));

chatRouter.post('/book-chat', jsonBody, (req, res) => _handleChatPost(req, res, {
  jobType: 'book-chat',
  kind: 'book',
  labelFn: s => s.book_name
    ? { key: 'job.label.bookChatBook', params: { name: s.book_name } }
    : { key: 'job.label.bookChat', params: null },
  runFn: runBookChatJobDispatch,
}));

chatRouter.post('/research-chat', jsonBody, (req, res) => _handleChatPost(req, res, {
  jobType: 'research-chat',
  kind: 'research',
  labelFn: s => s.book_name
    ? { key: 'job.label.researchChatBook', params: { name: s.book_name } }
    : { key: 'job.label.researchChat', params: null },
  runFn: runResearchChatJob,
  // Kontext-Chip (Seite/Kapitel) → context_info.research_context der Frage.
  contextFn: (req2, session) => researchMessageContext(req2.body?.context, session.book_id),
  // Kill-Switch + Claude-only VOR dem Speichern der User-Nachricht prüfen —
  // sonst bliebe bei abgeschaltetem Chat eine Frage ohne Antwort in der Session.
  preflight: (req2, res2, { userEmail }) => {
    const block = researchChatGate(userEmail);
    if (!block) return true;
    res2.status(block.status).json({ error_code: block.error_code });
    return false;
  },
}));

chatRouter.post('/plot-chat', jsonBody, (req, res) => _handleChatPost(req, res, {
  jobType: 'plot-chat',
  kind: 'plot',
  labelFn: s => s.book_name
    ? { key: 'job.label.plotChatBook', params: { name: s.book_name } }
    : { key: 'job.label.plotChat', params: null },
  // Agentisch bei Providern mit Werkzeug-Protokoll, sonst klassischer JSON-Call.
  runFn: runPlotChatJobDispatch,
}));

chatRouter.post('/ideen-chat', jsonBody, (req, res) => _handleChatPost(req, res, {
  jobType: 'ideen-chat',
  kind: 'ideen',
  labelFn: s => s.book_name
    ? { key: 'job.label.ideenChatBook', params: { name: s.book_name } }
    : { key: 'job.label.ideenChat', params: null },
  // Agentisch bei Providern mit Werkzeug-Protokoll, sonst klassischer JSON-Call.
  runFn: runIdeenChatJobDispatch,
}));

chatRouter.delete('/book-chat-cache', (req, res) => {
  const book_id = toIntId(req.query.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  // Gleiche Rolle wie Buch-Chat-Session/-Job (routes/chat.js, chat/shared.js): mit
  // allow_lektor_book_chat darf ein Lektor chatten — dann auch seinen Cache leeren
  // (sonst stilles 403 beim «Neues Gespräch»).
  const minRole = getBookSettings(book_id)?.allow_lektor_book_chat ? 'lektor' : 'editor';
  if (!guardBook(req, res, book_id, minRole)) return;
  const userEmail = sessionEmail(req);
  const key = `${book_id}:${userEmail}`;
  bookPageCache.delete(key);
  res.json({ ok: true });
});

module.exports = { chatRouter, invalidateBookPageCache };
