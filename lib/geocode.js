'use strict';
// Geocoding-Kern fuer die Orte-Karte. Schlaegt Koordinaten zu einem Ortsnamen
// vor. Genutzt von der HTTP-Route (routes/geocode.js, reiner Heuristik-Lookup)
// UND vom KI-Resolve-Job (routes/jobs/geocode.js) als Geocoding-Schritt nach der
// KI-Normalisierung. Beide teilen Provider, Rate-Limit-Kette und Normalisierung.
//
// Provider waehlbar via app_settings `geocode.provider`:
//   - 'nominatim' (Default): OSM-Nominatim `search`, jsonv2. Public-Instanz hat
//     Policy max. 1 Request/Sekunde + Pflicht-User-Agent → wir serialisieren mit
//     Mindestabstand. Self-hosted Instanz via `geocode.nominatim.url`.
//   - 'photon': Komoot-Photon (self-hosted), GeoJSON-Antwort. Kein Rate-Limit,
//     URL via `geocode.photon.url`. Photon braucht zwingend eine URL.
// Fehler/Timeout/Fehlkonfiguration → leeres Kandidaten-Array (non-fatal —
// manueller Pin bleibt immer moeglich).
const appSettings = require('./app-settings');
const logger = require('../logger');
const { fetchWithTimeout } = require('./http-util');

const USER_AGENT = process.env.NOMINATIM_USER_AGENT || 'Schreibwerkstatt/1.0 (self-hosted book tool)';
const NOMINATIM_MIN_INTERVAL_MS = 1100; // > 1s Nominatim-Public-Policy
const REQUEST_TIMEOUT_MS = 8000;
const MAX_QUERY_LEN = 200;

// Beschreibendes/fiktives Schauplatz-Label → wahrscheinlicher Toponym. Schneidet
// einen fuehrenden Beschreibungsteil vor einem lokativen Bindewort ab
// («Bar in Olten» → «Olten», «Marktplatz von Bern» faellt nicht, kein Bindewort
// in der Liste — dafuer greift der KI-Fallback). Rein regelbasiert, pure →
// unit-testbar. null, wenn kein Bindewort gefunden oder Rest leer.
const _LOCATIVE_RE = /\s(?:in der|in dem|im|in|bei der|beim|bei|an der|an dem|am|an|auf der|auf dem|auf|vor der|vor dem|vor|zur|zum|zu|near|at|on)\s/gi;
function parseToponym(q) {
  const s = String(q || '').trim();
  if (!s) return null;
  const matches = [...s.matchAll(_LOCATIVE_RE)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  const tail = s.slice(last.index + last[0].length).trim();
  return tail || null;
}

// Nominatim-Antwort (Fremd-Input) → flaches Kandidaten-Array. Verwirft Eintraege
// ohne gueltige Koordinaten. Pure → unit-testbar ohne Netzwerk.
function parseNominatimResults(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(item => {
      const rawLat = item?.lat;
      const rawLng = item?.lon;
      if (rawLat == null || rawLat === '' || rawLng == null || rawLng === '') return null;
      const lat = Number(rawLat);
      const lng = Number(rawLng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { lat, lng, displayName: String(item?.display_name || '') };
    })
    .filter(Boolean);
}

// Photon-Antwort (GeoJSON FeatureCollection) → flaches Kandidaten-Array.
// Koordinaten liegen als [lon, lat] in geometry.coordinates. displayName aus den
// Adress-Properties zusammengesetzt. Pure → unit-testbar ohne Netzwerk.
function parsePhotonResults(fc) {
  const feats = Array.isArray(fc?.features) ? fc.features : [];
  return feats
    .map(f => {
      const coords = f?.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return null;
      const lng = Number(coords[0]);
      const lat = Number(coords[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const p = f.properties || {};
      const displayName = [p.name, p.street, p.city, p.state, p.country]
        .filter(s => s != null && String(s).trim() !== '')
        .join(', ');
      // Laendercode (ISO-3166-1-alpha-2, lowercase) fuer den Post-Filter — Photon
      // kennt keinen countrycodes-Anfrageparameter.
      const countrycode = /^[A-Za-z]{2}$/.test(String(p.countrycode || '')) ? String(p.countrycode).toLowerCase() : null;
      // Gemeinde + Ortsteil fuer die Gemeinde-Pruefung in geocodeAnchored —
      // displayName traegt den Ortsteil nicht. Ohne county: der Bezirk heisst oft
      // wie sein Hauptort («Amtei Olten-Gösgen») und liesse jede Strasse im
      // Bezirk als «in Olten» durchgehen.
      const area = [p.name, p.city, p.district, p.locality]
        .filter(s => s != null && String(s).trim() !== '')
        .join(', ');
      return { lat, lng, displayName, countrycode, area };
    })
    .filter(Boolean);
}

// Nur Kandidaten im Zielland (cc, ISO-2 lowercase); ohne Treffer dort leer.
// Ersatz fuer Nominatims countrycodes-Param bei Photon (nur Post-Filter moeglich),
// gleich streng wie dieser. Why: ein Index, der das Zielland nicht enthaelt
// (Photon mit Europa-Ausschnitt), liefert sonst einen gleichnamigen Fehltreffer
// («Boston» in England, «Japan» in Montenegro) — ein falscher blauer Pin ist
// schlimmer als ein roter ohne Verortung. Pure → unit-testbar.
function onlyCountry(results, cc) {
  if (!cc || !Array.isArray(results)) return results || [];
  return results.filter(r => r.countrycode === cc);
}

// Vergleichsform fuer Ortsnamen: klein, ohne Diakritika, ß → ss.
function _fold(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');
}

// «Objekt, Gemeinde[, …]» → { town: erstes Wort der Gemeinde, rest: alles nach
// dem ersten Komma }. Ohne Komma oder ohne brauchbares Gemeindewort → null.
// «Fröschenlochstrasse, Rickenbach bei Olten» → town «rickenbach». Pure.
function splitAnchor(query) {
  const s = String(query || '');
  const i = s.indexOf(',');
  if (i < 0) return null;
  const rest = s.slice(i + 1).trim();
  const town = _fold(rest.split(/[\s,/]+/)[0]);
  if (!rest || town.length < 3) return null;
  return { town, rest };
}

// Liegt der Kandidat in der Gemeinde? Wortgenau gegen area (Photon) bzw.
// displayName (Nominatim, traegt die ganze Adresskette) — «olten» trifft nicht
// «Oltingen». Pure.
function inTown(cand, town) {
  return _fold(cand?.area || cand?.displayName).split(/[^a-z0-9]+/).includes(town);
}

// Serialisierung: jede Anfrage haengt sich hinten an die Kette und wartet, bis
// der Mindestabstand zur letzten erreicht ist. Verhindert Policy-Verstoss bei
// der Public-Nominatim-Instanz (Photon self-hosted: minInterval 0). Geteilt
// zwischen Route und Cron → beide drosseln gemeinsam gegen dieselbe API.
let _chain = Promise.resolve();
let _lastCallAt = 0;

function _schedule(task, minIntervalMs) {
  const run = _chain.then(async () => {
    const wait = Math.max(0, _lastCallAt + minIntervalMs - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastCallAt = Date.now();
    return task();
  });
  // Kette darf nicht durch einen Fehler reissen.
  _chain = run.then(() => {}, () => {});
  return run;
}

async function _fetchJson(url) {
  const r = await fetchWithTimeout(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
  }, REQUEST_TIMEOUT_MS);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

// Loest den aktiven Provider + dessen Basis-URL + Mindestabstand auf.
// base === null signalisiert Fehlkonfiguration (Photon ohne URL).
function _resolveProvider() {
  const provider = appSettings.get('geocode.provider') === 'photon' ? 'photon' : 'nominatim';
  if (provider === 'photon') {
    const base = String(appSettings.get('geocode.photon.url') || '')
      .replace(/\/+$/, '')
      .replace(/\/api$/i, '');
    return { provider, base: base || null, minInterval: 0 };
  }
  const base = String(appSettings.get('geocode.nominatim.url') || 'https://nominatim.openstreetmap.org/search');
  return { provider, base, minInterval: NOMINATIM_MIN_INTERVAL_MS };
}

/**
 * Geocodet einen Ortsnamen → Kandidaten-Array `[{ lat, lng, displayName }]`.
 * Fehler/Timeout/Fehlkonfiguration → `[]` (non-fatal). lang: 'de'|'en'.
 * region: optionaler ISO-3166-1-alpha-2-Code — beschraenkt die Treffer auf das
 * Land (Nominatim per countrycodes, Photon per onlyCountry).
 * bias: optionaler Punkt { lat, lng } (nur Photon) — Treffer nahe dem Punkt
 * gewinnen gegen prominentere ferne («Engelberg» im Buch aus der Region Olten =
 * der Weiler bei Dulliken, nicht der Kurort). Prominenz zaehlt dann nicht mehr
 * (location_bias_scale=0): eindeutige Namen («Zürich») trifft Photon weiterhin.
 */
async function geocode(query, { lang = 'de', region = null, bias = null } = {}) {
  const q = String(query || '').trim();
  if (!q || q.length > MAX_QUERY_LEN) return [];
  const safeLang = /^(de|en)$/.test(String(lang)) ? String(lang) : 'de';
  const cc = /^[A-Za-z]{2}$/.test(String(region || '')) ? String(region).toLowerCase() : null;
  const { provider, base, minInterval } = _resolveProvider();
  if (provider === 'photon' && !base) {
    logger.warn('[geocode] Photon als Provider gewaehlt, aber geocode.photon.url leer.');
    return [];
  }

  const runQuery = async (qStr) => {
    try {
      if (provider === 'photon') {
        return await _schedule(async () => {
          const params = new URLSearchParams({ q: qStr, limit: '5', lang: safeLang });
          if (bias && Number.isFinite(bias.lat) && Number.isFinite(bias.lng)) {
            params.set('lat', String(bias.lat));
            params.set('lon', String(bias.lng));
            params.set('location_bias_scale', '0');
            params.set('zoom', '10');
          }
          const fc = await _fetchJson(`${base}/api?${params.toString()}`);
          // Photon hat keinen countrycodes-Param → aufgeloesten Laendercode per
          // Post-Filter anwenden (Nominatim filtert via params.countrycodes).
          return onlyCountry(parsePhotonResults(fc), cc);
        }, minInterval);
      }
      return await _schedule(async () => {
        const params = new URLSearchParams({ q: qStr, format: 'jsonv2', limit: '5', 'accept-language': safeLang });
        if (cc) params.set('countrycodes', cc);
        const arr = await _fetchJson(`${base}?${params.toString()}`);
        return parseNominatimResults(arr);
      }, minInterval);
    } catch (e) {
      logger.warn(`[geocode] ${provider}-Abfrage fehlgeschlagen: ${e.message}`);
      return [];
    }
  };

  // Erst das rohe Label, dann — falls leer — der regelbasiert extrahierte Toponym
  // («Bar in Olten» → «Olten»). KI-Fallback (Job/Cron) greift erst, wenn auch das leer bleibt.
  let results = await runQuery(q);
  if (!results.length) {
    const top = parseToponym(q);
    if (top && top.toLowerCase() !== q.toLowerCase()) results = await runQuery(top);
  }
  return results;
}

/**
 * geocode() fuer KI-aufgeloeste Anfragen der Form «Objekt, Gemeinde»: behaelt
 * nur Treffer, die in der genannten Gemeinde liegen; gibt es keinen, wird die
 * Gemeinde selbst geocodet. Why: Photon matcht unscharf — «Hammerstrasse, Olten»
 * ergab eine Hambergstraße in Niedersachsen, «Hauptstrasse, Olten» die in
 * Eppenberg. Ein Pin in der richtigen Gemeinde schlaegt einen auf dem falschen
 * Objekt. Anfragen ohne Komma laufen unveraendert durch.
 */
async function geocodeAnchored(query, opts = {}) {
  const cands = await geocode(query, opts);
  const anchor = splitAnchor(query);
  if (!anchor) return cands;
  const hits = cands.filter(c => inTown(c, anchor.town));
  if (hits.length) return hits;
  return geocode(anchor.rest, opts);
}

module.exports = {
  geocode, geocodeAnchored, parseToponym, parseNominatimResults, parsePhotonResults,
  onlyCountry, splitAnchor, inTown,
};
