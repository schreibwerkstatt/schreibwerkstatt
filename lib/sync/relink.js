'use strict';
// Wieder-Anschluss beider Blog-Syncs (WordPress, HubSpot): ein Remote-Post, der
// keinen Link hat, haengt sich an einen UNVERLINKTEN Abschnitt desselben Buchs,
// statt eine Dublette anzulegen. Der Fall: nach einem Zielwechsel oder Trennen +
// neu Verbinden sind die Links weg (eine Post-ID-Spur gibt es dann nirgends
// mehr — sie lebt nur in der Link-Tabelle), die Abschnitte aber noch da. Dazu
// Abschnitte, die in der App entstanden und auf anderem Weg in den Blog kamen.
//
// Treffer in dieser Reihenfolge, jede Stufe NUR bei genau einem freien Kandidaten
// (mehrdeutig → keiner, der Aufrufer legt neu an — raten waere schlimmer):
//   1. Seitenname == Name, den der Import vergaebe (`YYYY-MM-DD: Titel`)
//   2. Seitenname ohne Datums-Praefix == Titel
//   3. Titel-Werkstatt-Titel (`page_headline.titel`) == Titel
// Gleicher Text → der Link gilt als synchron; abweichender Text → Konflikt
// (`detected`), der User entscheidet im Diff, statt dass still ueberschrieben wird.
//
// Der Anbieter liefert nur: Titel, Tag und Ersatzname des Posts (`take`), das
// Remote-HTML schon in App-HTML umgesetzt und den Link-Schreiber (`relinkPage`).

const contentStore = require('../content-store');
const { importedPageName, splitDatePrefix } = require('../blog-title');
const { listBookHeadlines } = require('../../db/headline');

/** Verlinkte Abschnitte des Buchs bei BEIDEN Anbietern — ein Abschnitt, der an
 *  einem Blog haengt, gehoert keinem zweiten. Je Anbieter eine Abfrage. */
function _linkedPageIds(bookId) {
  const out = new Set();
  const blogs = require('../../db/blogs');
  const hubspot = require('../../db/hubspot');
  const bc = blogs.getConnection(bookId);
  if (bc) for (const id of blogs.linkedPageIds(bc.id)) out.add(id);
  const hc = hubspot.getConnection(bookId);
  if (hc) for (const id of hubspot.linkedPageIds(hc.id)) out.add(id);
  return out;
}

function _add(map, key, page) {
  const k = String(key || '').trim();
  if (!k) return;
  if (!map.has(k)) map.set(k, []);
  map.get(k).push(page);
}

/**
 * Bestand fuer einen Lauf. `take({ title, day, fallbackName })` liefert den
 * Abschnitt (`{ id, name }`) oder null und vergibt jeden Abschnitt hoechstens
 * einmal. Titel-Werkstatt einmal pro Buch gelesen (kein N+1).
 */
async function buildRelinkIndex({ bookId }) {
  const linked = _linkedPageIds(bookId);
  const pages = (await contentStore.listPages(bookId)).filter(p => !linked.has(p.id));
  const headlines = listBookHeadlines(bookId);
  const byName = new Map();
  const byRest = new Map();
  const byHeadline = new Map();
  for (const p of pages) {
    _add(byName, p.name, p);
    _add(byRest, splitDatePrefix(p.name).rest, p);
    _add(byHeadline, headlines[String(p.id)]?.titel, p);
  }
  const taken = new Set();
  const unique = (map, key) => {
    const free = (map.get(String(key || '').trim()) || []).filter(p => !taken.has(p.id));
    return free.length === 1 ? free[0] : null;
  };
  return {
    take({ title, day, fallbackName }) {
      const t = String(title || '').trim();
      const name = importedPageName(t, day, fallbackName);
      const hit = unique(byName, name) || (t ? unique(byRest, t) || unique(byHeadline, t) : null);
      if (hit) taken.add(hit.id);
      return hit;
    },
  };
}

/** Klartext fuer den Inhaltsvergleich: Markup und Leerraum zaehlen nicht (die
 *  Anbieter geben dieselben Absaetze mit anderem Markup zurueck). */
// Block-Grenzen trennen Woerter, Inline-Markup (`<strong>`, `<a>`) nicht.
const _BLOCK_TAG_RE = /<\/?(?:p|div|h[1-6]|li|ul|ol|blockquote|pre|figure|figcaption|table|thead|tbody|tr|td|th|caption|section|br|hr)\b[^>]*>/gi;
function plainText(html) {
  return String(html || '').replace(_BLOCK_TAG_RE, ' ').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Verliert ein Schreiber das Rennen um den UNIQUE-Index (Anbieter, Post-ID)? */
function isUniqueViolation(e) {
  return /UNIQUE/i.test(String(e?.code || '')) || /UNIQUE constraint/i.test(String(e?.message || ''));
}

/**
 * Abschnitt `page` an den Post haengen. `remoteAppHtml` = Remote-Inhalt schon
 * als App-HTML; `writeLink({ row, conflict })` schreibt den Link des Anbieters
 * (inkl. Konfliktstatus). Liefert `{ id, name, relinked: true, conflict }` oder
 * null (Seite weg bzw. der Post wurde parallel verlinkt — UNIQUE-Index).
 */
async function relinkPage({ page, remoteAppHtml, writeLink, logger = null, label = 'Sync' }) {
  const row = await contentStore.loadPage(page.id).catch(() => null);
  if (!row) return null;
  const conflict = plainText(row.html || row.body_html) !== plainText(remoteAppHtml);
  try {
    await writeLink({ row, conflict });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    logger?.warn?.(`${label}: wurde parallel bereits verlinkt – Wieder-Anschluss an Page ${page.id} entfaellt.`);
    return null;
  }
  return { id: page.id, name: row.name || page.name, relinked: true, conflict };
}

/** Gelber Toast-Hinweis nach einem Import/Pull: wieder verknuepfte Abschnitte
 *  mit abweichendem Text stehen im Konflikt und warten auf den Diff. */
function relinkToastWarnings(relinkConflicts) {
  return relinkConflicts > 0 ? [{ key: 'sync.import.relinkConflicts', n: relinkConflicts }] : [];
}

module.exports = { buildRelinkIndex, relinkPage, plainText, isUniqueViolation, relinkToastWarnings };
