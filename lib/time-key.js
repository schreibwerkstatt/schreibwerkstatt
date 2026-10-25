'use strict';
// Zeitfenster für erzählte Zeit — PURE, ohne DB und ohne KI.
//
// Macht aus dem Ergebnis von lib/datum-parse.js#parseDatum ein vergleichbares
// Fenster [from, to] auf einer Tages-Ordinalskala. Ein Datum ist in erzählter
// Zeit fast nie ein Punkt: „1987" ist ein Jahr, „Sommer 1987" drei Monate,
// „12. März 1987" ein Tag. Wer vergleicht (Zeit-Messung, Zeitstrahl), vergleicht
// deshalb Fenster, nicht Jahreszahlen — „1987" und „März 1987" überlappen und
// widersprechen sich nicht.
//
// Zwei Modi, die NIE miteinander verglichen werden:
//   · 'abs' — Kalenderzeit (braucht ein Jahr; Monat/Tag ohne Jahr ist kein Fenster)
//   · 'tag' — relative Story-Zeit („Tag 3"), Einheit = ein Story-Tag
//
// Die Skala rechnet jeden Monat mit 31 Tagen und jedes Jahr mit 372: sie dient
// nur dem Ordnen und dem Überlappen, nicht dem Abstand in echten Tagen. Damit
// laufen v.-Chr.-Jahre (negativ) ohne Date-Objekt und ohne Kalenderfallen mit.

const { parseDatum } = require('./datum-parse');

const _DAYS_PER_YEAR = 372;

function _ord(y, m, d) { return y * _DAYS_PER_YEAR + (m - 1) * 31 + (d - 1); }

// Monat ausserhalb 1–12 rollt ins Nachbarjahr (Winter: Dezember bis Februar).
function _monthStart(y, m) { const z = m - 1; return _ord(y + Math.floor(z / 12), (((z % 12) + 12) % 12) + 1, 1); }
function _monthEnd(y, m)   { const z = m - 1; return _ord(y + Math.floor(z / 12), (((z % 12) + 12) % 12) + 1, 31); }

// „Winter 1987" ist der Winter 87/88 (Dezember 1987 bis Februar 1988) — dieselbe
// Lesart, nach der „Winter 1944/45" die Spanne 1944–1945 nennt.
const SEASON_MONTHS = { fruehling: [3, 5], sommer: [6, 8], herbst: [9, 11], winter: [12, 14] };
const PART_MONTHS   = { anfang: [1, 4], mitte: [5, 8], ende: [9, 12] };
const PART_DAYS     = { anfang: [1, 10], mitte: [11, 20], ende: [21, 31] };
// Teil einer Jahreszeit: erster, mittlerer, letzter ihrer drei Monate.
const PART_OF_SEASON = { anfang: 0, mitte: 1, ende: 2 };

// „um 1900" / „ca. März 1987": das Fenster wird breiter, nicht verschoben —
// zwei Jahre um ein Jahres-Datum, ein Monat um alles Feinere.
const UNSICHER_YEAR = 2 * _DAYS_PER_YEAR;
const UNSICHER_FINE = 31;

/**
 * @param {object|null} p  parseDatum-Ergebnis.
 * @returns {null | { mode: 'abs'|'tag', from: number, to: number,
 *   precision: 'day'|'part'|'month'|'season'|'year'|'range',
 *   yearFrom: number|null, yearTo: number|null, unsicher: boolean }}
 */
function timeKey(p) {
  if (!p) return null;

  if (Number.isInteger(p.story_tag)) {
    const to = Number.isInteger(p.story_tag_ende) && p.story_tag_ende > p.story_tag ? p.story_tag_ende : p.story_tag;
    return { mode: 'tag', from: p.story_tag, to, precision: to === p.story_tag ? 'day' : 'range', yearFrom: null, yearTo: null, unsicher: false };
  }
  if (!Number.isInteger(p.year)) return null;

  const y = p.year;
  let from, to, precision;
  // „Winter 1944/45" ist EIN Winter, keine Zwei-Jahres-Spanne.
  const winterPair = p.season === 'winter' && p.ende_year === y + 1 && p.month == null && p.ende_month == null;

  if (p.ende_year != null && !winterPair) {
    from = p.month != null ? _ord(y, p.month, p.day ?? 1) : _ord(y, 1, 1);
    to = p.ende_month != null ? _ord(p.ende_year, p.ende_month, p.ende_day ?? 31) : _ord(p.ende_year, 12, 31);
    precision = 'range';
  } else if (p.month != null && p.day != null) {
    from = to = _ord(y, p.month, p.day);
    precision = 'day';
  } else if (p.month != null) {
    if (p.part) {
      const [d1, d2] = PART_DAYS[p.part];
      from = _ord(y, p.month, d1); to = _ord(y, p.month, d2);
      precision = 'part';
    } else {
      from = _monthStart(y, p.month); to = _monthEnd(y, p.month);
      precision = 'month';
    }
  } else if (p.season) {
    let [m1, m2] = SEASON_MONTHS[p.season];
    if (p.part) { m1 += PART_OF_SEASON[p.part]; m2 = m1; }
    from = _monthStart(y, m1); to = _monthEnd(y, m2);
    precision = 'season';
  } else if (p.part) {
    const [m1, m2] = PART_MONTHS[p.part];
    from = _monthStart(y, m1); to = _monthEnd(y, m2);
    precision = 'part';
  } else {
    from = _ord(y, 1, 1); to = _ord(y, 12, 31);
    precision = 'year';
  }

  const unsicher = !!p.unsicher;
  if (unsicher) {
    const w = precision === 'year' ? UNSICHER_YEAR : UNSICHER_FINE;
    from -= w; to += w;
  }
  return {
    mode: 'abs', from, to, precision,
    yearFrom: Math.floor(from / _DAYS_PER_YEAR),
    yearTo: Math.floor(to / _DAYS_PER_YEAR),
    unsicher,
  };
}

// Bequemer Einstieg für Freitext-Felder (plot_beats.zeit): parsen + Fenster.
function timeKeyOf(label) {
  return timeKey(parseDatum(label));
}

// Überlappen sich zwei Fenster desselben Modus?
function keysOverlap(a, b) {
  return !!a && !!b && a.mode === b.mode && a.from <= b.to && b.from <= a.to;
}

module.exports = { timeKey, timeKeyOf, keysOverlap };
