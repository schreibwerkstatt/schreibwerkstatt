'use strict';
// Herkunft einer Zugangsanfrage ableiten — woher kam der Besucher auf /register?
//
// Reihenfolge: Kampagnen-Parameter des Einstiegslinks (utm_source/utm_medium/
// utm_campaign, ref) schlagen den Referer, weil sie bewusst gesetzt wurden. Ein
// Referer zaehlt nur, wenn er von einer fremden Seite kommt; der eigene Host
// (Landing → Register) ist keine Herkunft. Vom Referer bleiben Origin + Pfad —
// Query und Fragment koennen Tokens oder Suchbegriffe tragen.
//
// Die Landing-Seite reicht ihre eigene Herkunft als `src`-Parameter an den
// Register-Link weiter, damit der Weg Suchmaschine → Landing → Register nicht
// als „von der Landing" endet.

const MAX_LEN = 300;
const CAMPAIGN_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'ref'];

// Steuerzeichen raus, Whitespace verdichten, deckeln. Der Wert ist Client-Eingabe
// und landet in Admin-Tabelle und Admin-Mail.
function cleanSource(value, max = MAX_LEN) {
  // eslint-disable-next-line no-control-regex
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

function _first(v) {
  return Array.isArray(v) ? v[0] : v;
}

function _campaign(query) {
  const parts = [];
  for (const k of CAMPAIGN_KEYS) {
    const v = cleanSource(_first(query?.[k]), 80);
    if (v) parts.push(`${k}=${v}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

function _externalReferer(referer, ownHost) {
  if (!referer) return null;
  let u;
  try { u = new URL(String(referer)); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (ownHost && u.host.toLowerCase() === String(ownHost).toLowerCase()) return null;
  return cleanSource(u.origin + (u.pathname === '/' ? '' : u.pathname));
}

/**
 * @param {{ query?: object, referer?: string|null, ownHost?: string|null }} input
 * @returns {string|null}
 */
function deriveSource({ query = {}, referer = null, ownHost = null } = {}) {
  return _campaign(query)
    || cleanSource(_first(query.src))
    || _externalReferer(referer, ownHost);
}

module.exports = { deriveSource, cleanSource, MAX_LEN };
