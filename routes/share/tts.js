'use strict';
// Public, token-skopierte Vorlese-Route des Share-Readers: POST /share/:token/tts.
// Laeuft ohne Session (der auth-pflichtige /tts/speak-Proxy ist fuer den
// anonymen Leser nicht erreichbar). Synthese ueber den geteilten Kern
// lib/tts-synth.js; Host/Voice/Key verlassen den Server nie, Audio wird nicht
// persistiert.
//
// Weil der Token nur das WER beschraenkt, prueft die Route zusaetzlich das WAS
// (lib/share-tts-guard.js): Ratenlimit pro Token+IP und Bindung des Texts an
// den geteilten Inhalt — sonst waere jeder Link ein freier Zugang zum
// Speech-Server.

const express = require('express');
const shareLinks = require('../../db/share-links');
const rateLimit = require('../../lib/share-ratelimit');
const guard = require('../../lib/share-tts-guard');
const { setContext } = require('../../lib/log-context');
const logger = require('../../logger');
const tts = require('../../lib/tts-synth');
const { getBookLocale } = require('../../db/schema');
const { TOKEN_RE, isExpired } = require('../../lib/share-helpers');

function register(router) {
  router.post('/:token/tts', express.json({ limit: tts.TEXT_MAX + 2048 }), async (req, res) => {
    const token = String(req.params.token || '');
    if (!TOKEN_RE.test(token)) return res.status(404).json({ error_code: 'NOT_FOUND', error: 'not_found' });
    const link = shareLinks.getShareLinkByToken(token);
    if (!link || isExpired(link)) return res.status(404).json({ error_code: 'NOT_FOUND', error: 'not_found' });
    setContext({ book: link.book_id });

    // Feature aus -> 404 (Frontend behandelt als „Vorlesen nicht verfuegbar").
    if (!tts.isEnabled()) return res.status(404).json({ error_code: 'TTS_DISABLED', error: 'tts_disabled' });

    const ipHash = rateLimit.hashIp(req.ip || req.connection?.remoteAddress || '');
    const rl = rateLimit.checkTts(token, ipHash);
    if (!rl.allowed) {
      logger.warn(`[share/tts] rate-limit token=${token.slice(0, 8)} ipHash=${ipHash}`);
      res.setHeader('Retry-After', String(rl.retryAfterSec));
      return res.status(429).json({ error_code: 'TTS_RATE_LIMITED', error: 'tts_rate_limited' });
    }

    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (text.length <= tts.TEXT_MAX && text.trim()) {
      let ok = false;
      try { ok = await guard.isFromSharedContent(link, text); } catch (e) {
        logger.warn(`[share/tts] Inhaltspruefung fehlgeschlagen: ${e.message}`);
      }
      if (!ok) {
        logger.warn(`[share/tts] Text nicht aus geteiltem Inhalt token=${token.slice(0, 8)} chars=${text.length}`);
        return res.status(422).json({ error_code: 'TTS_TEXT_NOT_SHARED', error: 'tts_text_not_shared' });
      }
    }

    // Stimme aus der Buch-Locale (SSoT wie im authed Pfad). owner_email ist der
    // Buch-Besitzer — dessen Locale-Override bestimmt die Sprache des Buchs.
    let lang = '';
    try { lang = getBookLocale(link.book_id, link.owner_email) || ''; } catch { /* noop */ }

    try {
      const { buf, mime } = await tts.synthesizeSpeech({ text, lang });
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'no-store');
      return res.end(buf);
    } catch (err) {
      if (err instanceof tts.TtsError) {
        if (err.status >= 500 || err.status === 408) {
          logger.warn(`[share/tts] ${err.code} token=${token.slice(0, 8)} book=${link.book_id} status=${err.status}`);
        }
        const body = { error: err.code };
        if (err.max) body.max = err.max;
        return res.status(err.status).json(body);
      }
      logger.warn(`[share/tts] unexpected ${err?.message} token=${token.slice(0, 8)}`);
      return res.status(502).json({ error_code: 'TTS_UPSTREAM', error: 'tts_upstream' });
    }
  });
}

module.exports = { register };
