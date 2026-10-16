'use strict';
// Kleine, framework-freie Bausteine fuer ausgehende HTTP-Requests: Timeout-Fetch,
// Body lesen mit Byte-Deckel, abbrechbares Sleep, Retry mit Backoff.
//
// Gilt fuer fest verdrahtete und admin-konfigurierte Ziele. Ist das Ziel
// user-kontrolliert, ist `safeFetch` aus lib/ssrf-guard.js der Weg (baut auf
// diesen Bausteinen auf und prueft zusaetzlich jeden Redirect-Hop).

function _err(code, msg) {
  const e = new Error(msg || code);
  e.code = code;
  return e;
}

/** AbortError im Format, das fetch selbst wirft (name === 'AbortError'). */
function abortError(msg = 'aborted') {
  const e = new Error(msg);
  e.name = 'AbortError';
  return e;
}

/** Kombiniert ein optionales Aufrufer-Signal mit einem Timeout.
 *  Rueckgabe: `{ signal, timeoutSignal }` — `timeoutSignal.aborted` trennt nach
 *  dem Abbruch einen Timeout vom Aufrufer-Abbruch. Abbruch-Grund des Timeouts
 *  ist ein AbortError mit `code = timeoutCode`: fetch und ein laufendes
 *  Body-Lesen rejecten mit genau diesem Grund, bestehende
 *  `e.name === 'AbortError'`-Checks greifen also auch fuer den Body. Der Timer
 *  ist `unref`t und laeuft nach einem fertigen Request folgenlos ab. */
function timeoutSignal(timeoutMs, signal, timeoutCode = 'FETCH_TIMEOUT') {
  const ms = Math.max(1, Number(timeoutMs) || 1);
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    const e = abortError(`timeout after ${ms} ms`);
    e.code = timeoutCode;
    ctrl.abort(e);
  }, ms);
  timer.unref?.();
  return { signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal, timeoutSignal: ctrl.signal };
}

/** fetch mit Timeout (deckt auch das Body-Lesen). Ein Timeout wirft einen
 *  AbortError mit `code = timeoutCode` (Default `FETCH_TIMEOUT`); ein
 *  Aufrufer-Abbruch (`opts.signal`) kommt unveraendert durch. */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 10_000, { fetchImpl, timeoutCode = 'FETCH_TIMEOUT' } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const { signal, timeoutSignal: t } = timeoutSignal(timeoutMs, opts.signal, timeoutCode);
  try {
    return await doFetch(url, { ...opts, signal });
  } catch (e) {
    if (t.aborted && !opts.signal?.aborted && e !== t.reason) {
      t.reason.cause = e;
      throw t.reason;
    }
    throw e;
  }
}

/** Antwort-Body mit Byte-Deckel lesen (Buffer).
 *
 *  `content-length` wird zuerst geprueft (billiger Abbruch), ist aber nicht
 *  vertrauenswuerdig — darum zaehlt der Stream-Zweig mit. Reihenfolge der
 *  Lese-Wege: Async-Iterator (Node-fetch), `getReader()` (Web-Stream ohne
 *  Iterator), `arrayBuffer()` (gestubbter fetch im Test). Ueberlaenge wirft
 *  einen Error mit `code = tooLargeCode`. */
async function readCapped(res, maxBytes, { tooLargeCode = 'RESPONSE_TOO_LARGE' } = {}) {
  const tooLarge = (how) => _err(tooLargeCode, `response exceeds ${maxBytes} bytes${how ? ` (${how})` : ''}`);
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge('declared');
  const body = res.body;
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let total = 0;
    for await (const chunk of body) {
      total += chunk.length ?? chunk.byteLength;
      if (total > maxBytes) throw tooLarge(); // break aus for-await cancelt den Stream
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* noop */ }
        throw tooLarge();
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw tooLarge();
  return buf;
}

/** Abbrechbares Sleep: rejected, sobald `signal` feuert — mit `signal.reason`,
 *  wenn das ein Error ist (Default-Reason von `abort()` ist eine DOMException
 *  'AbortError'), sonst mit einem AbortError. */
function sleep(ms, signal) {
  const reason = () => (signal.reason instanceof Error ? signal.reason : abortError());
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(reason()); return; }
    const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(t); reject(reason()); }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/** Retry fuer transiente Fehler.
 *  `fn()` laeuft einmal plus bis zu `retries` Wiederholungen, solange
 *  `isRetryable(err)` (Default: `err.retriable`) zutrifft. Ein Abbruch
 *  (`signal.aborted` oder AbortError) wird nie wiederholt. Wartezeit vor
 *  Wiederholung n (1-basiert): `delayMs(n, baseMs)`, Default linear `baseMs * n`.
 *  `onRetry(err, n, retries)` z.B. fuers Logging. */
async function withRetry(fn, {
  retries = 3, baseMs = 800, signal,
  isRetryable = (e) => !!e?.retriable,
  delayMs = (n, base) => base * n,
  onRetry,
} = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') throw e;
      if (!isRetryable(e) || attempt >= retries) throw e;
      attempt++;
      try { onRetry?.(e, attempt, retries); } catch { /* noop */ }
      await sleep(delayMs(attempt, baseMs), signal);
    }
  }
}

/**
 * `Range: bytes=…`-Header gegen eine Ressource der Groesse `size` aufloesen.
 * Nur ein einzelner Bereich (Mehrfach-Ranges braucht kein Medien-Element).
 *
 * `maxChunk` deckelt die Antwort: ein `<audio>` fragt zum Start `bytes=0-` an,
 * also die ganze Datei — ohne Deckel waere der Range-Pfad fuer grosse BLOBs so
 * teuer wie ein voller Download. Kuerzer zu antworten ist erlaubt (RFC 9110
 * §14.4): der Client liest das tatsaechliche Ende aus `Content-Range` und fragt
 * den Rest nach.
 *
 * @returns {null | {unsatisfiable: true} | {start: number, end: number}}
 *   `null` = kein (gueltiger) Range-Header, voll ausliefern.
 */
function resolveByteRange(header, size, maxChunk = Infinity) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end = m[2] === '' ? null : parseInt(m[2], 10);
  if (start === null && end === null) return { unsatisfiable: true };
  if (start === null) { start = Math.max(0, size - end); end = size - 1; }
  if (end === null || end >= size) end = size - 1;
  if (start > end || start >= size) return { unsatisfiable: true };
  if (end - start + 1 > maxChunk) end = start + maxChunk - 1;
  return { start, end };
}

module.exports = { abortError, timeoutSignal, fetchWithTimeout, readCapped, sleep, withRetry, resolveByteRange };
