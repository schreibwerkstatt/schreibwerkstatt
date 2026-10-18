'use strict';
// Gemeinsamer HTTP-Kern der beiden Blog-Sync-Clients (WordPress lib/wp-client.js,
// HubSpot lib/hubspot-client.js). EINE Stelle fuer Retry, Backoff, Retry-After,
// Abbruch, Fehler-Codes und den Byte-Deckel beim Lesen — die Clients liefern nur
// den eigentlichen Fetch (`send`) und ihr Fehler-Praefix (`BLOG` | `HUBSPOT`).
//
// Fehler-Codes (Praefix P):
//   P_AUTH_FAILED / P_FORBIDDEN … laut `statusCodes` (beide: 401 → AUTH_FAILED, 403 → FORBIDDEN)
//   P_RATE_LIMIT   429, nach Ausschoepfen der Wiederholungen
//   P_UPSTREAM     5xx, nach Ausschoepfen (bzw. sofort bei nicht-idempotenten Requests)
//   P_TIMEOUT      Zeitdeckel des Fetch gerissen
//   P_FETCH_FAILED Netzfehler
//   P_HTTP_<n>     jeder andere Nicht-2xx-Status (z.B. 404)
//
// Retry nur, wo ein zweiter Versuch nichts verdoppeln kann: 429 heisst „nicht
// verarbeitet" und darf immer wiederholt werden; Netzfehler und 5xx nur bei
// idempotenten Requests. Ein Create, dessen Antwort im Netz verloren ging, ist
// drueben womoeglich angelegt — ein Retry legte den Post ein zweites Mal an.

const { readCapped, sleep } = require('../http-util');

const DEFAULT_MAX_RETRIES = 2;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_RETRY_AFTER_MS = 30_000;

function codedError(code, extra = {}) {
  const err = new Error(code);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function backoffMs(attempt) {
  return Math.min(2000, 200 * 2 ** attempt);
}

function _retryAfterMs(res, attempt) {
  const raw = Number(res.headers?.get?.('Retry-After'));
  if (Number.isFinite(raw) && raw > 0) return Math.min(MAX_RETRY_AFTER_MS, raw * 1000);
  return Math.min(10_000, 500 * 2 ** attempt);
}

function _wait(ms, signal) {
  return signal ? sleep(ms, signal) : new Promise(r => setTimeout(r, ms));
}

/**
 * Fuehrt `send()` (liefert eine fetch-Response) mit Retry aus und mappt den
 * Status auf Fehler-Codes. Gibt die erfolgreiche Response zurueck.
 *
 * - `idempotent`  false → kein Retry bei Netzfehler/5xx (nur bei 429)
 * - `statusCodes` Status → Code-Suffix, z.B. `{ 401: 'AUTH_FAILED' }`
 * - `mapFetchError(err)` → Error | null: Fetch-Fehler, die NICHT wiederholt
 *   werden (SSRF-Block, Redirect-Fehler), auf einen eigenen Fehler abbilden
 * - `beforeAttempt()` z.B. das Token-Bucket des HubSpot-Clients
 */
async function requestWithRetry(send, {
  prefix, signal = null, idempotent = true, maxRetries = DEFAULT_MAX_RETRIES,
  statusCodes = {}, mapFetchError = null, beforeAttempt = null,
} = {}) {
  let attempt = 0;
  for (;;) {
    if (beforeAttempt) await beforeAttempt();
    let res;
    try {
      res = await send();
    } catch (err) {
      if (signal?.aborted) throw err;
      const mapped = mapFetchError ? mapFetchError(err) : null;
      if (mapped) throw mapped;
      if (idempotent && attempt < maxRetries) {
        attempt++;
        await _wait(backoffMs(attempt), signal);
        continue;
      }
      const suffix = err?.code === 'FETCH_TIMEOUT' ? 'TIMEOUT' : 'FETCH_FAILED';
      throw codedError(`${prefix}_${suffix}`, { cause: err });
    }

    if (res.status === 429) {
      if (attempt < maxRetries) {
        const waitMs = _retryAfterMs(res, attempt);
        attempt++;
        await _wait(waitMs, signal);
        continue;
      }
      throw codedError(`${prefix}_RATE_LIMIT`, { status: 429 });
    }
    if (res.status >= 500) {
      if (idempotent && attempt < maxRetries) {
        attempt++;
        await _wait(backoffMs(attempt), signal);
        continue;
      }
      throw codedError(`${prefix}_UPSTREAM`, { status: res.status });
    }
    const mappedSuffix = statusCodes[res.status];
    if (mappedSuffix) throw codedError(`${prefix}_${mappedSuffix}`, { status: res.status });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw codedError(`${prefix}_HTTP_${res.status}`, { status: res.status, body: String(text).slice(0, 500) });
    }
    return res;
  }
}

/** JSON einer Response lesen, mit Byte-Deckel (ein entgleister Remote darf den
 *  Prozess nicht mit einer Endlos-Antwort fuellen). */
async function readJson(res, { prefix, maxBytes = MAX_JSON_BYTES } = {}) {
  const buf = await readCapped(res, maxBytes, { tooLargeCode: `${prefix}_RESPONSE_TOO_LARGE` });
  const text = buf.toString('utf8');
  if (!text.trim()) return null;
  try { return JSON.parse(text); }
  catch (e) { throw codedError(`${prefix}_INVALID_JSON`, { cause: e }); }
}

/** 404 des Remote — Post/Draft drueben geloescht. */
function isNotFound(err) {
  return err?.status === 404 || /_HTTP_404$/.test(String(err?.code || ''));
}

module.exports = {
  requestWithRetry, readJson, codedError, backoffMs, isNotFound,
  DEFAULT_MAX_RETRIES, MAX_JSON_BYTES,
};
