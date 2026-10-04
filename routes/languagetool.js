'use strict';
// LanguageTool-Proxy (self-hosted).
// Frontend ruft POST /languagetool/check; Server holt URL aus app_settings,
// forwarded an `${url}/v2/check`. Credentials/URL verlassen den Server nicht.
//
// Disabled / no-URL -> 404 { error: 'languagetool_disabled' } (Frontend
// behandelt als "Feature aus", kein Retry).
//
// Absatz-Cache: der Text wird in Absatz-Segmente zerlegt
// (lib/languagetool-chunk.js); nur Segmente ohne Cache-Eintrag gehen an LT,
// gepackt zu Anfragen <= CHUNK_MAX, parallel mit Pool 4. Der Cache haelt
// UNGEFILTERTE Treffer — Woerterbuch, Buchnamen und abgeschaltete Regeln des
// Users filtert lib/languagetool-filter.js beim Ausliefern.
//
// Body-Cap 600 KB (text bis TEXT_MAX 500 KB, JSON-Overhead). Timeout
// UPSTREAM_TIMEOUT_MS pro Upstream-Anfrage; laeuft eine ab, faellt ein Fehler
// oder trennt der Client die Verbindung, bricht der ganze Request ab — keine
// Worker rufen danach noch LT auf.
//
// Daneben: GET/POST/DELETE /languagetool/rules — abgeschaltete Regeln des Users.

const express = require('express');
const logger = require('../logger');
const appSettings = require('../lib/app-settings');
const { toIntId } = require('../lib/validate');
const { getBookLocale } = require('../db/schema');
const { splitSegments, packSegments, assignMatches, CHUNK_MAX } = require('../lib/languagetool-chunk');
const { filterMatches, buildNameSet } = require('../lib/languagetool-filter');
const ltCache = require('../db/languagetool-cache');
const dict = require('../db/user-dictionary');
const ltRules = require('../db/languagetool-rules');
const ltNames = require('../db/languagetool-names');
const { getUser } = require('../db/app-users');
const { guardBook, sessionEmail } = require('../lib/acl');

const router = express.Router();
const TEXT_MAX = 500_000;
const PARALLEL = 4;
const UPSTREAM_TIMEOUT_MS = 15_000;
// Bevorzugte Varianten fuer `language=auto`: ohne sie erkennt LT nur „Deutsch"
// bzw. „Englisch" und prueft nach de-DE/en-US — „Strasse" waere ein Fehler.
// Gleiche Defaults wie db/book-settings.js#getBookSettings.
const DEFAULT_VARIANTS = { de: 'de-CH', en: 'en-US' };
const RULE_ID_MAX = 120;
const RULE_LABEL_MAX = 200;

function _userLocale(userEmail) {
  if (!userEmail) return null;
  try {
    const u = getUser(userEmail);
    const l = u?.default_language;
    if (!l) return null;
    const r = u.default_region || (l === 'en' ? 'US' : 'CH');
    return `${l}-${r}`;
  } catch { return null; }
}

function _preferredVariants(userLocale) {
  const v = { ...DEFAULT_VARIANTS };
  if (userLocale) v[userLocale.split('-')[0]] = userLocale;
  return Object.values(v).join(',');
}

router.post('/check', express.json({ limit: '600kb' }), async (req, res) => {
  const enabled = appSettings.get('languagetool.enabled') === true;
  const url = String(appSettings.get('languagetool.url') || '').replace(/\/$/, '').replace(/\/v2$/i, '');
  if (!enabled || !url) {
    return res.status(404).json({ error_code: 'LANGUAGETOOL_DISABLED', error: 'languagetool_disabled' });
  }

  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text) return res.json({ matches: [] });
  if (text.length > TEXT_MAX) {
    return res.status(413).json({ error_code: 'TEXT_TOO_LARGE', error: 'text_too_large', max: TEXT_MAX });
  }

  // bookId steuert Sprache, Buch-Woerterbuch und Buchnamen — darum Buch-ACL.
  const bookId = toIntId(body.bookId);
  if (bookId && !guardBook(req, res, bookId, 'viewer')) return;
  const userEmail = sessionEmail(req);

  // Sprache: Buch > explizite Client-Sprache > Profil-Default > auto.
  const userLocale = _userLocale(userEmail);
  let language = null;
  if (bookId) {
    try { language = getBookLocale(bookId, userEmail); } catch { /* noop */ }
  }
  if (!language) {
    const raw = typeof body.language === 'string' ? body.language.trim() : '';
    language = raw && raw !== 'auto' ? raw : (userLocale || 'auto');
  }
  const preferredVariants = language === 'auto' ? _preferredVariants(userLocale) : null;

  // Per-Request-Override: Client kann picky:true/false schicken und damit den
  // serverseitigen Default fuer genau diesen Request uebersteuern.
  const bodyPicky = typeof body.picky === 'boolean' ? body.picky : null;
  const picky = bodyPicky !== null ? bodyPicky : (appSettings.get('languagetool.picky') === true);
  const log = logger.child({ job: 'lt', user: userEmail || '-', book: bookId || '-' });

  const segments = splitSegments(text, CHUNK_MAX);
  const hashes = segments.map(s => ltCache.hashText(s.text));
  let cached;
  try { cached = ltCache.getMany({ hashes, lang: language, picky }); }
  catch (e) { log.warn(`cache get failed: ${e.message}`); cached = new Map(); }

  const missing = [];
  segments.forEach((s, i) => { if (!cached.has(hashes[i])) missing.push(i); });
  const perSegment = new Map(); // segIndex -> Treffer relativ zum Segment
  segments.forEach((s, i) => { if (cached.has(hashes[i])) perSegment.set(i, cached.get(hashes[i])); });

  const ctrl = new AbortController();
  // Client weg (neuer Check nach Weitertippen, Seitenwechsel) -> LT-Anfragen
  // abbrechen, statt Antworten zu berechnen, die niemand mehr liest.
  let clientGone = false;
  res.on('close', () => { if (!res.writableEnded) { clientGone = true; ctrl.abort(); } });
  const t0 = Date.now();
  let languageMeta = null;
  let chunkCount = 0;

  try {
    if (missing.length) {
      const batches = packSegments(missing.map(i => segments[i]), CHUNK_MAX);
      chunkCount = batches.length;
      const fresh = [];
      let cursor = 0;
      async function worker() {
        while (cursor < batches.length && !ctrl.signal.aborted) {
          const b = batches[cursor++];
          const r = await _callLT(url, b.text, language, picky, preferredVariants, ctrl.signal);
          if (!languageMeta && r.language) languageMeta = r.language;
          for (const [localIdx, ms] of assignMatches(b, r.matches)) {
            const segIdx = missing[localIdx];
            perSegment.set(segIdx, ms);
            fresh.push({ hash: hashes[segIdx], matches: ms });
          }
        }
      }
      const workers = Array.from({ length: Math.min(PARALLEL, batches.length) }, () => worker());
      try {
        await Promise.all(workers);
      } catch (err) {
        ctrl.abort(); // die uebrigen Worker stoppen
        throw err;
      }
      try { ltCache.setMany({ entries: fresh, lang: language, picky }); }
      catch (e) { log.warn(`cache set failed: ${e.message}`); }
    }

    const all = [];
    segments.forEach((s, i) => {
      for (const m of perSegment.get(i) || []) all.push({ ...m, offset: m.offset + s.offset });
    });
    all.sort((a, b) => a.offset - b.offset);

    let filtered = all;
    try {
      filtered = filterMatches(all, {
        words: userEmail ? dict.getCheckSet(userEmail, bookId, language) : null,
        names: bookId ? buildNameSet(ltNames.listBookNames(bookId)) : null,
        rules: userEmail ? ltRules.getCheckSet(userEmail, bookId) : null,
      });
    } catch (e) { log.warn(`filter failed: ${e.message}`); }

    if (clientGone) return;
    res.json({
      matches: filtered,
      language: languageMeta,
      chunks: chunkCount,
      cached: segments.length - missing.length,
      segments: segments.length,
    });
  } catch (err) {
    if (clientGone || res.headersSent) return;
    if (err && err.upstreamStatus) {
      log.warn(`upstream ${err.upstreamStatus} latency=${Date.now() - t0}ms`);
      return res.status(502).json({ error_code: 'LANGUAGETOOL_UPSTREAM', error: 'languagetool_upstream', upstream_status: err.upstreamStatus });
    }
    const isTimeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError' || err.code === 'ABORT_ERR');
    log.warn(`fetch ${isTimeout ? 'TIMEOUT' : err.message} latency=${Date.now() - t0}ms`);
    return res.status(isTimeout ? 408 : 502).json(isTimeout
      ? { error_code: 'LANGUAGETOOL_TIMEOUT', error: 'languagetool_timeout' }
      : { error_code: 'LANGUAGETOOL_FETCH_FAILED', error: 'languagetool_fetch_failed' });
  }
});

async function _callLT(url, text, language, picky, preferredVariants, signal) {
  const params = new URLSearchParams();
  params.set('text', text);
  params.set('language', language);
  if (preferredVariants) params.set('preferredVariants', preferredVariants);
  if (picky) params.set('level', 'picky');
  const upstream = await fetch(`${url}/v2/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: params.toString(),
    // Timeout gilt pro Anfrage; der Request-Signal bricht alle gemeinsam ab.
    signal: AbortSignal.any([signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
  });
  if (!upstream.ok) {
    const err = new Error('upstream_error');
    err.upstreamStatus = upstream.status;
    throw err;
  }
  const json = await upstream.json();
  return {
    matches: Array.isArray(json?.matches) ? json.matches : [],
    language: json?.language || null,
  };
}

// ─── Abgeschaltete Regeln ──────────────────────────────────────────────────

function _ruleBody(req) {
  const body = req.body || {};
  return {
    ruleId: typeof body.ruleId === 'string' ? body.ruleId.trim() : '',
    label: typeof body.label === 'string' ? body.label.trim().slice(0, RULE_LABEL_MAX) : null,
    bookId: toIntId(body.bookId) || 0,
  };
}

router.get('/rules', (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  res.json({ entries: ltRules.listForUser(userEmail) });
});

router.post('/rules', express.json({ limit: '4kb' }), (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const { ruleId, label, bookId } = _ruleBody(req);
  if (!ruleId || ruleId.length > RULE_ID_MAX) {
    return res.status(400).json({ error_code: 'INVALID_RULE', params: { max: RULE_ID_MAX } });
  }
  if (bookId && !guardBook(req, res, bookId, 'viewer')) return;
  ltRules.add(userEmail, { ruleId, bookId, label });
  logger.child({ job: 'lt-rules', user: userEmail, book: bookId || '-' }).info(`disable rule ${ruleId}`);
  res.json({ ok: true });
});

router.delete('/rules', express.json({ limit: '4kb' }), (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const { ruleId, bookId } = _ruleBody(req);
  if (!ruleId) return res.status(400).json({ error_code: 'INVALID_RULE', params: { max: RULE_ID_MAX } });
  if (bookId && !guardBook(req, res, bookId, 'viewer')) return;
  res.json({ ok: true, removed: ltRules.remove(userEmail, { ruleId, bookId }) });
});

module.exports = router;
