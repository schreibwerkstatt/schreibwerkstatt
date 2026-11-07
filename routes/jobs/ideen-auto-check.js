'use strict';
// Automatischer Erledigt-Check der Ideen (docs/ideen-board.md, «Erledigt-Check
// nach dem Speichern»).
//
// Auslöser: jedes Speichern eines Abschnitts (PUT /content/pages/:id — der Weg
// ALLER drei Editoren und der nativen Clients; kein Editor-Code ist beteiligt).
// noteIdeenPageSave entprellt je (Abschnitt, User): erst nach DEBOUNCE_MS ohne
// weiteres Speichern wird gemessen, ob sich der Text seit dem letzten Check
// grösser geändert hat (MIN_CHANGED_WORDS, Wort-Multimenge gegen den Ausgangs-
// stand in idee_check_baselines). Nur dann läuft der KI-Job — über die Queue.
// Gibt es noch keinen Ausgangsstand, wird der aktuelle Text zum Ausgangsstand
// (kein Lauf): «grössere Änderung» braucht einen Vergleichspunkt.
//
// Geprüft werden nur offene Pendenzen, die direkt am Abschnitt hängen. Was das
// Modell für eingelöst hält, kommt mit wörtlichem Zitat; das Zitat wird gegen
// denselben Text geprüft, den das Modell las (pageQuoteHaystack, wie der
// Ideen-Chat). Nur Verifiziertes wird Hinweis (idee_check_hints) — geschrieben
// wird an der Idee nichts, der User hakt selbst ab.
//
// Manuell: POST /jobs/ideen-auto-check { page_id } (Knopf in der Ideen-Karte)
// prüft sofort, ohne Schwelle.

const express = require('express');
const contentStore = require('../../lib/content-store');
const { toIntId } = require('../../lib/validate');
const { guardBook, sessionEmail } = require('../../lib/acl');
const { resolvePageBookId } = require('../../lib/content-ownership');
const { setContext } = require('../../lib/log-context');
const { resolveProvider } = require('../../lib/ai');
const { quoteFoundIn } = require('../../lib/quote-verify');
const ideenCheck = require('../../db/ideen-check');
const logger = require('../../logger');
const {
  makeJobLogger, updateJob, completeJob, failJob, aiCall, getPrompts, tps, jsonBody,
  htmlToText, createJob, enqueueJob, findActiveJobId, chunkLimitsFor, i18nError,
} = require('./shared');
const { pageQuoteHaystack } = require('./ideen-chat-tools');

const router = express.Router();

const DEBOUNCE_MS = 3 * 60 * 1000;
const MIN_CHANGED_WORDS = 40;
const MAX_IDEEN = 40;
const MAX_BELEG = 500;

function _words(text) {
  const m = new Map();
  for (const w of String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) m.set(w, (m.get(w) || 0) + 1);
  return m;
}

/** Wie viele Wörter sind dazugekommen oder weggefallen (Multimenge)? Pure. */
function changedWordCount(before, after) {
  const a = _words(before), b = _words(after);
  let n = 0;
  for (const [w, c] of a) n += Math.max(0, c - (b.get(w) || 0));
  for (const [w, c] of b) n += Math.max(0, c - (a.get(w) || 0));
  return n;
}

const _timers = new Map(); // `${pageId}:${email}` → Timeout

/**
 * Nach einem erfolgreichen Abschnitts-Save aufrufen. Wirft nie — ein Fehler
 * hier darf das Speichern nicht berühren.
 */
function noteIdeenPageSave(pageId, bookId, userEmail) {
  try {
    if (!pageId || !bookId || !userEmail) return;
    if (!ideenCheck.isAutoCheckEnabled(userEmail)) return;
    if (!ideenCheck.hasOpenPageIdeen(pageId, userEmail)) return;
    const key = `${pageId}:${userEmail}`;
    clearTimeout(_timers.get(key));
    const t = setTimeout(() => {
      _timers.delete(key);
      _afterQuiet(pageId, bookId, userEmail).catch(e =>
        logger.warn(`[ideen-auto-check] Seite ${pageId}: Auslöser fehlgeschlagen: ${e.message}`));
    }, DEBOUNCE_MS);
    t.unref?.();
    _timers.set(key, t);
  } catch (e) {
    logger.warn(`[ideen-auto-check] Seite ${pageId}: ${e.message}`);
  }
}

async function _afterQuiet(pageId, bookId, userEmail) {
  if (!ideenCheck.isAutoCheckEnabled(userEmail) || !ideenCheck.hasOpenPageIdeen(pageId, userEmail)) return;
  const page = await contentStore.loadPage(pageId);
  const text = htmlToText(page?.html || '');
  const base = ideenCheck.getBaseline(pageId, userEmail);
  if (base == null) { ideenCheck.setBaseline(pageId, userEmail, text); return; }
  if (changedWordCount(base, text) < MIN_CHANGED_WORDS) return;
  enqueueIdeenAutoCheck(pageId, bookId, userEmail);
}

function enqueueIdeenAutoCheck(pageId, bookId, userEmail) {
  const dedup = String(pageId);
  const existing = findActiveJobId('ideen-auto-check', dedup, userEmail);
  if (existing) return existing;
  const jobId = createJob('ideen-auto-check', bookId, userEmail, 'job.label.ideenAutoCheck', {}, dedup);
  enqueueJob(jobId, () => runIdeenAutoCheckJob(jobId, pageId, bookId, userEmail));
  return jobId;
}

async function runIdeenAutoCheckJob(jobId, pageId, bookId, userEmail) {
  const log = makeJobLogger(jobId);
  try {
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 5 });
    const ideen = ideenCheck.listOpenPageIdeen(pageId, userEmail).slice(0, MAX_IDEEN);
    const page = await contentStore.loadPage(pageId);
    const text = htmlToText(page?.html || '');
    if (!ideen.length || !text.trim()) {
      ideenCheck.setBaseline(pageId, userEmail, text);
      completeJob(jobId, { checked: 0, hints: 0 });
      return;
    }
    const { buildIdeenAutoCheckSystemPrompt, buildIdeenAutoCheckPrompt, SCHEMA_IDEEN_AUTO_CHECK } = await getPrompts(userEmail);
    const limit = chunkLimitsFor(resolveProvider({ userEmail })).singlePass;
    const promptText = text.length > limit ? text.slice(0, limit) : text;
    updateJob(jobId, { statusText: 'job.phase.ideenAutoCheck', progress: 15 });
    const tok = { in: 0, out: 0, ms: 0 };
    const result = await aiCall(jobId, tok,
      buildIdeenAutoCheckPrompt(page?.name || page?.page_name || '', promptText, ideen),
      buildIdeenAutoCheckSystemPrompt(),
      15, 95, 1500, 0.2, null, undefined, SCHEMA_IDEEN_AUTO_CHECK,
    );
    if (!Array.isArray(result?.eingeloest)) throw i18nError('job.error.ideenCheckMissing');

    const open = new Set(ideen.map(i => i.id));
    const haystack = pageQuoteHaystack(page?.html || '');
    let hints = 0, rejected = 0;
    for (const r of result.eingeloest) {
      const id = Number(r?.idee_id);
      const beleg = String(r?.beleg || '').trim().slice(0, MAX_BELEG);
      if (!open.has(id) || !beleg) { rejected++; continue; }
      if (!quoteFoundIn(beleg, haystack, { strict: true })) { rejected++; continue; }
      open.delete(id);
      if (ideenCheck.setHint(id, userEmail, { pageId, beleg, begruendung: String(r?.begruendung || '').trim().slice(0, 500) || null })) hints++;
    }
    ideenCheck.setBaseline(pageId, userEmail, text);
    log.info(`Auto-Erledigt-Check Seite ${pageId}: ${ideen.length} Pendenzen, ${hints} Hinweise, ${rejected} verworfen.`);
    completeJob(jobId, { checked: ideen.length, hints, pageId, tokensIn: tok.in, tokensOut: tok.out }, tps(tok));
  } catch (e) {
    if (e.name !== 'AbortError') log.error(`Fehler Auto-Erledigt-Check Seite ${pageId}: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// Manuell aus der Ideen-Karte: sofort prüfen, ohne Schwelle.
router.post('/ideen-auto-check', jsonBody, (req, res) => {
  const pageId = toIntId(req.body?.page_id);
  if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  const bookId = resolvePageBookId(pageId);
  if (!bookId) return res.status(404).json({ error_code: 'PAGE_NOT_FOUND' });
  setContext({ book: bookId });
  if (!guardBook(req, res, bookId, 'editor')) return;
  const userEmail = sessionEmail(req);
  const existing = findActiveJobId('ideen-auto-check', String(pageId), userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  res.json({ jobId: enqueueIdeenAutoCheck(pageId, bookId, userEmail) });
});

module.exports = {
  ideenAutoCheckRouter: router,
  noteIdeenPageSave, enqueueIdeenAutoCheck, runIdeenAutoCheckJob, changedWordCount,
  _afterQuiet,
  DEBOUNCE_MS, MIN_CHANGED_WORDS,
};
