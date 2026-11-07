'use strict';
// Erreichbarkeit EINER user-kontrollierten URL pruefen (Link-Check des
// Recherche-Boards, Job research-link-check). Laeuft ueber safeFetch: die URL
// stammt aus einem Fundstueck, also aus User-Inhalt — jeder Hop wird gegen
// interne Ziele geprueft (lib/ssrf-guard.js), Zeit gedeckelt, Body nie gelesen.
//
// Bewertung:
//   ok    = 2xx/3xx am Ende der Kette, ODER 401/403/429 — das sind Zugangs- und
//           Bot-Sperren, keine toten Links. Sie als „tot" zu melden, waere fuer
//           Paywalls und Cloudflare-Seiten Dauerrauschen. Der Code steht trotzdem
//           am Ergebnis, damit die Karte „gesperrt" von „ok" unterscheiden kann.
//   tot   = 404/410/5xx, Netz-/Timeout-Fehler, Redirect-Schleife; Host nicht
//           aufloesbar → `error: 'DNS'`, URL unlesbar → `error: 'INVALID'`.
//   SSRF  = interne Adresse → `error: 'SSRF_BLOCKED'`, nicht abgefragt.
// HEAD zuerst (billig); Server, die HEAD nicht koennen (405/501, manche 403/404),
// bekommen ein GET ohne Body-Lesen.

const { safeFetch } = require('./ssrf-guard');

const CHECK_TIMEOUT_MS = 10_000;
const ACCESS_CODES = new Set([401, 403, 429]);
const USER_AGENT = process.env.SOURCE_LOOKUP_USER_AGENT || 'Schreibwerkstatt/1.0 (link check)';

async function _probe(url, method, opts) {
  const { response } = await safeFetch(url, {
    method,
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    timeoutMs: CHECK_TIMEOUT_MS,
    maxRedirects: 5,
    readBody: false,
    ...opts,
  });
  // Body nie lesen, aber freigeben — sonst haelt der Socket bis zum Timeout.
  try { await response.body?.cancel?.(); } catch { /* schon zu */ }
  return response.status;
}

/** @returns {Promise<{ok: boolean, code: number|null, error: string|null}>} */
async function checkUrl(url, opts = {}) {
  try {
    let code = await _probe(url, 'HEAD', opts);
    if (code === 405 || code === 501 || code === 403 || code === 404) {
      code = await _probe(url, 'GET', opts);
    }
    const ok = (code >= 200 && code < 400) || ACCESS_CODES.has(code);
    return { ok, code, error: null };
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    const code = String(e?.code || '');
    // Ein nicht aufloesbarer Host ist ein toter Link (DNS), eine unlesbare URL
    // ein Erfassungsfehler (INVALID) — beide keine Sperre. Jeder andere SSRF-Code
    // (heute SSRF_BLOCKED_HOST) ist die Sperre, auch ein kuenftiger.
    const error = code === 'SSRF_DNS_FAILED' ? 'DNS'
      : code === 'SSRF_INVALID_URL' ? 'INVALID'
      : code.startsWith('SSRF') ? 'SSRF_BLOCKED'
      : code === 'FETCH_TIMEOUT' || e?.name === 'AbortError' ? 'TIMEOUT'
      : code.startsWith('FETCH_REDIRECT') ? 'REDIRECT'
      : 'NETWORK';
    return { ok: false, code: null, error };
  }
}

module.exports = { checkUrl, ACCESS_CODES };
