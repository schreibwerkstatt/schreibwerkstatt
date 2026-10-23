// SSRF-Schutz fuer ausgehende Requests auf user-kontrollierte URLs (z.B.
// WordPress-Blog-Connection). Blockt loopback, private, link-local, CGNAT,
// multicast/reserved und unspecified Ranges fuer IPv4 + IPv6 sowie
// 'localhost'-Hostnamen. `assertPublicUrl` loest den Hostnamen zusaetzlich via
// DNS auf und prueft ALLE Adressen — verhindert das Zielen auf interne Dienste
// ueber einen oeffentlichen DNS-Namen.
//
// Rest-Risiko: ein DNS-Rebind zwischen Resolve und Connect ist nicht
// ausgeschlossen. Die echte Pinning-Loesung waere ein undici-Dispatcher mit
// `connect.lookup`, der jede aufgeloeste Adresse prueft — Node bringt undici
// nur intern mit (`require('undici')` ist ohne eigene Dependency nicht
// aufloesbar), und die Konsumenten muessen gestubbtes `globalThis.fetch`
// behalten. Der Resolve-Zeit-Check pro Hop hebt die Huerde aber deutlich.
//
// `safeFetch` ist der einzige Weg fuer Requests auf user-kontrollierte URLs:
// Guard pro Redirect-Hop, Timeout, Byte-Deckel an einer Stelle.
const net = require('net');
const dns = require('dns').promises;

function ipv4Blocked(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true;                          // 0.0.0.0/8
  if (a === 10) return true;                         // 10/8 private
  if (a === 127) return true;                        // loopback
  if (a === 169 && b === 254) return true;           // link-local + 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12 private
  if (a === 192 && b === 168) return true;           // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true;                          // multicast + reserved
  return false;
}

// IPv6-Literal zu acht 16-Bit-Hextets expandieren (inkl. `::`-Kompression und
// eingebettetem dotted-IPv4-Schwanz wie `::ffff:1.2.3.4`). null = unparsebar.
function expandIPv6(ip) {
  let s = String(ip).toLowerCase();
  const pct = s.indexOf('%');            // Zone-ID (fe80::1%eth0) abschneiden
  if (pct >= 0) s = s.slice(0, pct);
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const p = tail[1].split('.').map(Number);
    if (p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = s.slice(0, -tail[1].length)
      + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part) => (part ? part.split(':') : []);
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...rest];
  const out = all.map(h => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

function _v4FromHextets(hi, lo) {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

// Blockt IPv6-Ranges UND jede Form, die eine IPv4-Adresse einbettet — sonst
// umgeht `[::ffff:127.0.0.1]` den IPv4-Check: WHATWG-URL normalisiert das zu
// `[::ffff:7f00:1]`, ein Match auf die dotted Form greift dann nicht mehr.
function ipv6Blocked(ip) {
  const h = expandIPv6(ip);
  if (!h) return true;                                   // unparsebar -> defensiv
  const [a, b] = h;
  const zeroUpTo = (n) => h.slice(0, n).every(x => x === 0);
  if (zeroUpTo(8)) return true;                          // :: unspecified
  if (zeroUpTo(7) && h[7] === 1) return true;            // ::1 loopback
  if (zeroUpTo(5) && h[5] === 0xffff) return ipv4Blocked(_v4FromHextets(h[6], h[7])); // ::ffff:0:0/96 IPv4-mapped
  if (zeroUpTo(4) && h[4] === 0xffff && h[5] === 0) return ipv4Blocked(_v4FromHextets(h[6], h[7])); // ::ffff:0:0:0/96 SIIT
  if (zeroUpTo(6)) return true;                          // ::/96 IPv4-compatible (veraltet)
  if (a === 0x64 && b === 0xff9b && h.slice(2, 6).every(x => x === 0)) {
    return ipv4Blocked(_v4FromHextets(h[6], h[7]));      // 64:ff9b::/96 NAT64 (Well-Known)
  }
  if (a === 0x64 && b === 0xff9b && h[2] === 1) return true; // 64:ff9b:1::/48 NAT64 lokal
  if (a === 0x2002) return ipv4Blocked(_v4FromHextets(h[1], h[2])); // 2002::/16 6to4
  if (a === 0x2001 && b === 0) return true;              // 2001::/32 Teredo (v4 verschleiert)
  if (a === 0x2001 && b === 0xdb8) return true;          // 2001:db8::/32 Doku
  if (a === 0x100 && h.slice(1, 4).every(x => x === 0)) return true; // 100::/64 discard
  if ((a & 0xffc0) === 0xfe80) return true;              // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) return true;              // fec0::/10 site-local (veraltet)
  if ((a & 0xfe00) === 0xfc00) return true;              // fc00::/7 unique-local
  if ((a & 0xff00) === 0xff00) return true;              // ff00::/8 multicast
  return false;
}

// true, wenn das IP-Literal in einem nicht-oeffentlichen Bereich liegt.
function isBlockedIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) return ipv4Blocked(ip);
  if (v === 6) return ipv6Blocked(ip);
  return true; // kein gueltiges Literal -> defensiv blocken
}

// Synchroner Check: blockt IP-Literale in privaten Ranges und localhost-Namen.
// Hostnamen, die per DNS aufgeloest werden muessen, deckt erst assertPublicUrl ab.
function isBlockedHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return true;
  if (net.isIP(h)) return isBlockedIp(h);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  return false;
}

function _throw() {
  const e = new Error('SSRF_BLOCKED_HOST');
  e.code = 'SSRF_BLOCKED_HOST';
  throw e;
}

// Async-Vollcheck: validiert Scheme, blockt Literale und loest Hostnamen via
// DNS auf, um ALLE Zieladressen gegen die Blockliste zu pruefen.
async function assertPublicUrl(urlString) {
  let u;
  try { u = new URL(urlString); }
  catch { const e = new Error('SSRF_INVALID_URL'); e.code = 'SSRF_INVALID_URL'; throw e; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') _throw();
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isBlockedIp(host)) _throw();
    return;
  }
  if (isBlockedHost(host)) _throw();
  // Test-Seam: Integrationstests stubben globalThis.fetch und nutzen
  // nicht-aufloesbare Reserved-TLD-Hosts (z.B. wp.test). Nur die DNS-Aufloesung
  // wird dann uebersprungen — der Literal-/localhost-Block oben bleibt aktiv.
  if (process.env.SSRF_SKIP_DNS_CHECK === '1') return;
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); }
  catch { const e = new Error('SSRF_DNS_FAILED'); e.code = 'SSRF_DNS_FAILED'; throw e; }
  if (!addrs.length) _throw();
  for (const { address } of addrs) {
    if (isBlockedIp(address)) _throw();
  }
}

const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);

function _withoutCredentials(fetchOpts) {
  const h = fetchOpts.headers;
  if (!h) return fetchOpts;
  const entries = typeof h.entries === 'function' && !Array.isArray(h) ? [...h.entries()]
    : Array.isArray(h) ? h : Object.entries(h);
  const headers = Object.fromEntries(entries.filter(([k]) => !CREDENTIAL_HEADERS.has(String(k).toLowerCase())));
  return { ...fetchOpts, headers };
}

/**
 * fetch auf eine user-kontrollierte URL: `assertPublicUrl` auf JEDEM Hop,
 * Redirects von Hand (`redirect: 'manual'`, Deckel `maxRedirects`), ein
 * Timeout ueber den ganzen Ablauf inkl. Body-Lesen und ein Byte-Deckel.
 *
 * Optionen:
 *   timeoutMs, maxBytes, maxRedirects, signal (Aufrufer-Abbruch),
 *   maxBytes darf eine Funktion (res) → Zahl sein: Deckel je nach Antwort
 *   (content-type), gefragt nach `accept`, vor dem Body-Lesen,
 *   method/headers/body (an fetch durchgereicht), fetchImpl (Test-Seam),
 *   accept(res, url)  — vor dem Body-Lesen, darf werfen (z.B. content-type),
 *   assertUrl         — Hop-Pruefung (Default assertPublicUrl; Test-Seam fuer
 *                       Konsumenten mit injiziertem fetch),
 *   readBody          — false: Body nicht lesen (`buffer` bleibt null),
 *   tooLargeCode / timeoutCode — Fehler-Codes fuer Ueberlaenge / Timeout.
 *
 * Rueckgabe `{ response, url, buffer }` — `url` ist das Ziel des letzten Hops.
 * Eine nicht-OK-Antwort wird zurueckgegeben (Body ungelesen), nicht geworfen.
 * Wirft mit `code`: SSRF_* (Guard), `timeoutCode` (Default FETCH_TIMEOUT),
 * FETCH_REDIRECT_LIMIT, FETCH_REDIRECT_INVALID, `tooLargeCode`
 * (Default RESPONSE_TOO_LARGE). Netzfehler und Aufrufer-Abbruch kommen
 * unveraendert durch.
 */
async function safeFetch(rawUrl, opts = {}) {
  const { readCapped, timeoutSignal } = require('./http-util');
  const {
    timeoutMs = 10_000, maxBytes = 10 * 1024 * 1024, maxRedirects = 3, signal: callerSignal,
    fetchImpl, accept, readBody = true, assertUrl = assertPublicUrl,
    tooLargeCode = 'RESPONSE_TOO_LARGE', timeoutCode = 'FETCH_TIMEOUT',
    ...initialFetchOpts
  } = opts;
  let fetchOpts = initialFetchOpts;
  const doFetch = fetchImpl || globalThis.fetch;
  const { signal, timeoutSignal: t } = timeoutSignal(timeoutMs, callerSignal, timeoutCode);
  const onTimeout = (e) => {
    if (t.aborted && !callerSignal?.aborted && e !== t.reason) {
      t.reason.cause = e;
      return t.reason;
    }
    return e;
  };
  const fail = (code, msg) => { const e = new Error(msg || code); e.code = code; return e; };

  let url = String(rawUrl);
  for (let hop = 0; ; hop++) {
    await assertUrl(url);
    let res;
    try { res = await doFetch(url, { ...fetchOpts, redirect: 'manual', signal }); }
    catch (e) { throw onTimeout(e); }
    if (!res) throw fail('FETCH_FAILED', 'no response');
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers?.get?.('location');
      if (!loc) throw fail('FETCH_REDIRECT_INVALID', `redirect ${res.status} without location`);
      if (hop >= maxRedirects) {
        const e = fail('FETCH_REDIRECT_LIMIT', `more than ${maxRedirects} redirects`);
        e.status = res.status;
        throw e;
      }
      let next;
      try { next = new URL(loc, url); }
      catch { throw fail('FETCH_REDIRECT_INVALID', `invalid location ${String(loc).slice(0, 60)}`); }
      // Wie natives fetch: Credentials gehen nicht an eine fremde Origin mit
      // (auch nicht beim https→http-Wechsel auf demselben Host).
      if (next.origin !== new URL(url).origin) fetchOpts = _withoutCredentials(fetchOpts);
      url = next.toString();
      continue;
    }
    if (!res.ok || !readBody) return { response: res, url, buffer: null };
    if (accept) await accept(res, url);
    let buffer;
    const cap = typeof maxBytes === 'function' ? maxBytes(res) : maxBytes;
    try { buffer = await readCapped(res, cap, { tooLargeCode }); }
    catch (e) { throw onTimeout(e); }
    return { response: res, url, buffer };
  }
}

module.exports = { isBlockedIp, isBlockedHost, assertPublicUrl, expandIPv6, safeFetch };
