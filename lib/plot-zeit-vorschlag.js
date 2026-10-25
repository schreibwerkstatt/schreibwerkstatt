'use strict';
// Zeitvorschlag für Beats aus dem Text — PURE, ohne DB und ohne KI.
//
// Ein Beat, der schon im Buch steht, hat seine Zeit im Text: die beste
// Fundstelle der Verankerung ist der Abschnitt, der ihn erzählt, und dessen
// datierte Zeitstrahl-Ereignisse sagen, wann das spielt. Der Vorschlag ist ein
// Freitext, den lib/datum-parse.js wieder als dasselbe Fenster liest.
//
// Bewusst NICHT aus Akt + Alter: wer nach Lebensphasen plant, ordnet geschriebene
// Beats oft einem Akt zu, dessen Altersspanne nicht zum Text passt — gerade das
// soll die Zeit-Messung (alterAusserhalbAkt) finden. Ein aus dem Akt
// gespeichertes Jahr würde den Widerspruch verdecken. Das Fenster des Akts zeigt
// das Board nur an (public/js/book/plot/zeit.js#aktFenster), gespeichert wird es nie.
//
// Regeln — jede an Prod-Daten nachgemessen:
//   · Nur `im_buch`, nicht verworfen, ohne Zeitangabe. Ein geplanter Beat steht
//     noch nicht im Text; seine beste Fundstelle ist zwangsläufig eine andere,
//     nur ähnliche Szene. Eine vorhandene Angabe gehört dem Autor.
//   · Nur die beste Fundstelle: schwache Treffer quer durchs Buch spannen
//     zusammen Jahrzehnte auf.
//   · Geburten zählen nicht (subtyp 'geburt'): sie hängen an dem Abschnitt, der
//     eine Figur einführt. Unsichere Datierungen zählen nicht.
//   · Persönliche Ereignisse vor Welt-Ereignissen (typ 'extern'): Zeitgeschichte
//     ist oft Hintergrund. Nur ohne persönliches Ereignis datieren die externen.
//   · Kalenderzeit vor Story-Tagen; beide werden nie gemischt.
// Auch danach liegt ein Teil daneben (die Fundstelle ist eine verwandte Szene,
// das Ereignis ein Rückblick) — darum trägt jeder Vorschlag seine Belege, und
// `eindeutig` (höchstens ein Jahr bzw. ein Story-Tag Streuung) entscheidet über
// die Vorauswahl in der Durchsicht.

const MONTHS = {
  de: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};
const TAG = { de: 'Tag', en: 'Day' };
const MAX_BELEGE = 3;

const _pad = n => String(n).padStart(2, '0');

function _monthName(lang, m) {
  return MONTHS[lang] ? MONTHS[lang][m - 1] : null;
}

// Fenster der Ereignisse als Freitext. Monats-/Tagesgenauigkeit nur, wenn
// ALLE Ereignisse im selben Jahr liegen und einen Monat tragen.
function _formatAbs(events, lang) {
  const yFrom = Math.min(...events.map(e => e.datum_year));
  const yTo = Math.max(...events.map(e => e.datum_ende_year ?? e.datum_year));
  if (yFrom !== yTo) return `${yFrom}–${yTo}`;
  const monthly = events.every(e => e.datum_month != null
    && (e.datum_ende_year == null || e.datum_ende_year === yFrom));
  if (!monthly) return String(yFrom);
  const mFrom = Math.min(...events.map(e => e.datum_month));
  const mTo = Math.max(...events.map(e => e.datum_ende_month ?? e.datum_month));
  if (mFrom === mTo) {
    const days = new Set(events.map(e => e.datum_day));
    const single = days.size === 1 && !days.has(null) && events.every(e => e.datum_ende_day == null);
    if (single) {
      const d = events[0].datum_day;
      if (lang === 'de') return `${_pad(d)}.${_pad(mFrom)}.${yFrom}`;
      if (lang === 'en') return `${d} ${_monthName('en', mFrom)} ${yFrom}`;
      return `${yFrom}-${_pad(mFrom)}-${_pad(d)}`;
    }
    const name = _monthName(lang, mFrom);
    return name ? `${name} ${yFrom}` : `${yFrom}-${_pad(mFrom)}`;
  }
  const a = _monthName(lang, mFrom), b = _monthName(lang, mTo);
  return a && b ? `${a}–${b} ${yFrom}` : String(yFrom);
}

function _formatTag(events, lang) {
  const from = Math.min(...events.map(e => e.story_tag));
  const to = Math.max(...events.map(e => e.story_tag));
  const word = TAG[lang] || TAG.en;
  return from === to ? `${word} ${from}` : `${word} ${from}–${to}`;
}

/**
 * @param {object} input
 * @param {Array<{id:number, status:string, zeit:?string, verworfen:?number}>} input.beats
 * @param {Map<number, {page_id:number, page_name:?string}>} input.topPage  beat_id → beste anspringbare Fundstelle
 * @param {Map<number, Array<object>>} input.eventsByPage  page_id → zeitstrahl_events-Zeilen
 *        (datum, datum_label, datum_year/_month/_day, datum_ende_*, story_tag,
 *        datum_unsicher, ereignis, typ, subtyp, sort_order)
 * @param {string} [input.lang]  Sprache des Buchs ('de' | 'en' | …) — sonst ISO-Formen
 * @returns {Array<{beat_id, zeit, page_id, page_name, n, spread, eindeutig, belege}>}
 */
function computeZeitVorschlaege({ beats = [], topPage = new Map(), eventsByPage = new Map(), lang = 'de' } = {}) {
  const out = [];
  for (const b of beats) {
    if (b.status !== 'im_buch' || b.verworfen || (b.zeit && String(b.zeit).trim())) continue;
    const top = topPage.get(b.id);
    if (!top) continue;
    const usable = (eventsByPage.get(top.page_id) || [])
      .filter(e => e.subtyp !== 'geburt' && !e.datum_unsicher);
    const abs = usable.filter(e => Number.isInteger(e.datum_year));
    const tag = usable.filter(e => !Number.isInteger(e.datum_year) && Number.isInteger(e.story_tag));
    const pick = list => {
      const own = list.filter(e => e.typ !== 'extern');
      return own.length ? own : list;
    };
    let events, zeit, spread;
    if (abs.length) {
      events = pick(abs);
      zeit = _formatAbs(events, lang);
      spread = Math.max(...events.map(e => e.datum_ende_year ?? e.datum_year)) - Math.min(...events.map(e => e.datum_year));
    } else if (tag.length) {
      events = pick(tag);
      zeit = _formatTag(events, lang);
      spread = Math.max(...events.map(e => e.story_tag)) - Math.min(...events.map(e => e.story_tag));
    } else continue;
    const belege = [...events]
      .sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0))
      .slice(0, MAX_BELEGE)
      .map(e => ({ datum: e.datum_label || e.datum, ereignis: e.ereignis }));
    out.push({
      beat_id: b.id, zeit, page_id: top.page_id, page_name: top.page_name || null,
      n: events.length, spread, eindeutig: spread <= 1, belege,
    });
  }
  return out;
}

module.exports = { computeZeitVorschlaege };
