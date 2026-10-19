'use strict';
// SearXNG-Client: eine Query → normalisierte, deduplizierte Treffer. Rein, ohne
// KI-Bezug; Konsumenten sind die web_search-Werkzeuge von Recherche-Chat und
// Faktencheck, wenn lib/websearch#webSearchMode 'searxng' liefert.
//
// Der Host ist admin-konfiguriert (`websearch.searxng.url`) → kein SSRF-Guard,
// aber Timeout + Byte-Deckel aus lib/http-util.
//
// Domain-Eingrenzung (Recherche-Profil `research_domains`) wirkt doppelt:
// `site:`-Operatoren an der Query sorgen dafür, dass überhaupt passende Treffer
// kommen; der Host-Nachfilter grenzt wirklich ein — nicht jede Engine hält sich
// an den Operator.
//
// Fehlerbild: nicht konfiguriert / HTTP-Fehler / Timeout / kaputtes JSON →
// Error mit `code = 'WEBSEARCH_UNAVAILABLE'`. Leere Treffer sind KEIN Fehler.
// Ein Abbruch des Aufrufers kommt als AbortError unverändert durch.

const appSettings = require('../app-settings');
const logger = require('../../logger');
const { fetchWithTimeout, readCapped } = require('../http-util');
const { normalizeUrl } = require('../url-normalize');

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_QUERY_LEN = 400;
const SNIPPET_MAX = 400;
const TITLE_MAX = 300;

function _unavailable(msg, cause) {
  const e = new Error(msg);
  e.code = 'WEBSEARCH_UNAVAILABLE';
  if (cause) e.cause = cause;
  return e;
}

function _clip(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Basis-URL aus dem Setting, ohne Trailing-Slash. '' = nicht konfiguriert. */
function baseUrl() {
  const raw = String(appSettings.get('websearch.searxng.url') || '').trim();
  if (!/^https?:\/\//i.test(raw)) return '';
  return raw.replace(/\/+$/, '');
}

function isConfigured() {
  return !!baseUrl();
}

/** Domain-Eintrag des Recherche-Profils → nackter Host (`zeit.de`). Akzeptiert
 *  auch `https://www.zeit.de/pfad`. null, wenn nichts Brauchbares übrig bleibt. */
function normalizeDomain(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
  s = s.replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
}

/** Host gehört zu einer der Domains (Subdomains zählen, `www.` egal)? */
function hostMatches(host, domains) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  return domains.some(d => h === d || h.endsWith(`.${d}`));
}

/** Query mit `site:`-Operatoren. Ohne Domains unverändert. */
function buildQuery(query, domains) {
  const q = String(query || '').trim();
  if (!domains.length) return q;
  const sites = domains.map(d => `site:${d}`).join(' OR ');
  return `${q} (${sites})`;
}

function _published(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * SearXNG-JSON → Treffer. Pure, darum direkt testbar.
 * Reihenfolge = SearXNG-Ranking; Dubletten (lib/url-normalize) verschmelzen in
 * den ersten Treffer, ihre Engines werden vereint.
 *
 * @param {object} json      Antwort von `/search?format=json`
 * @param {object} [opts]    `domains` (bereits normalisiert), `maxResults`
 * @returns {{ results: Array<{title,url,snippet,engines,published}>, unresponsive: string[] }}
 */
function parseSearxngResponse(json, { domains = [], maxResults = 8 } = {}) {
  const raw = Array.isArray(json?.results) ? json.results : [];
  const byNorm = new Map();
  const out = [];
  for (const r of raw) {
    const norm = normalizeUrl(r?.url);
    if (!norm) continue;
    const engines = Array.isArray(r.engines) ? r.engines.map(String) : (r.engine ? [String(r.engine)] : []);
    const prev = byNorm.get(norm);
    if (prev) {
      for (const e of engines) if (!prev.engines.includes(e)) prev.engines.push(e);
      if (!prev.snippet && r.content) prev.snippet = _clip(r.content, SNIPPET_MAX);
      continue;
    }
    if (domains.length && !hostMatches(new URL(r.url).hostname, domains)) continue;
    const hit = {
      title: _clip(r.title, TITLE_MAX) || r.url,
      url: String(r.url),
      snippet: _clip(r.content, SNIPPET_MAX),
      engines,
      published: _published(r.publishedDate),
    };
    byNorm.set(norm, hit);
    out.push(hit);
  }
  // SearXNG liefert [[engine, grund], …]; ältere Versionen nur Namen.
  const unresponsive = (Array.isArray(json?.unresponsive_engines) ? json.unresponsive_engines : [])
    .map(u => (Array.isArray(u) ? u.filter(Boolean).join(': ') : String(u || '')))
    .filter(Boolean);
  return { results: out.slice(0, Math.max(1, Number(maxResults) || 8)), unresponsive };
}

/**
 * Eine Suche gegen die konfigurierte SearXNG-Instanz.
 *
 * @param {string} query
 * @param {object} [opts]
 *   domains     Domain-Eingrenzung (rohe Einträge des Recherche-Profils)
 *   language    SearXNG-Sprachcode ('de', 'en', 'de-CH'); leer = Instanz-Default
 *   maxResults  Default `websearch.max_results`
 *   signal      Abbruch des Aufrufers (Job-Abbruch)
 *   fetchImpl   nur für Tests
 */
async function search(query, { domains = [], language = '', maxResults, signal, fetchImpl } = {}) {
  const base = baseUrl();
  if (!base) throw _unavailable('SearXNG nicht konfiguriert (websearch.searxng.url)');
  const q = String(query || '').trim().slice(0, MAX_QUERY_LEN);
  if (!q) return { results: [], unresponsive: [] };

  const doms = [...new Set((Array.isArray(domains) ? domains : []).map(normalizeDomain).filter(Boolean))];
  const params = new URLSearchParams({ q: buildQuery(q, doms), format: 'json' });
  if (language) params.set('language', String(language));
  const timeoutMs = parseInt(appSettings.get('websearch.searxng.timeout_ms'), 10) || 8000;
  const limit = maxResults ?? (parseInt(appSettings.get('websearch.max_results'), 10) || 8);

  const t0 = Date.now();
  let json;
  try {
    const res = await fetchWithTimeout(`${base}/search?${params}`, {
      headers: { Accept: 'application/json' },
      signal,
    }, timeoutMs, { fetchImpl, timeoutCode: 'WEBSEARCH_TIMEOUT' });
    if (!res.ok) throw _unavailable(`SearXNG HTTP ${res.status}`);
    const buf = await readCapped(res, MAX_RESPONSE_BYTES);
    json = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    if (signal?.aborted) throw e;
    if (e.code === 'WEBSEARCH_UNAVAILABLE') throw e;
    throw _unavailable(`SearXNG nicht erreichbar: ${e.message}`, e);
  }

  const out = parseSearxngResponse(json, { domains: doms, maxResults: limit });
  const ms = Date.now() - t0;
  const line = `websearch q="${_clip(q, 120)}" hits=${out.results.length} ms=${ms}`;
  if (out.unresponsive.length) logger.warn(`${line} unresponsive=[${out.unresponsive.join(', ')}]`);
  else logger.info(line);
  return out;
}

module.exports = {
  search, isConfigured, parseSearxngResponse,
  normalizeDomain, hostMatches, buildQuery,
};
