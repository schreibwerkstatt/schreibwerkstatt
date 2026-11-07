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
// `eindeutig` entscheidet über die Vorauswahl in der Durchsicht. Eindeutig ist
// ein Vorschlag nur, wenn alle drei Prüfungen bestehen:
//   · schmal: höchstens ein Jahr bzw. ein Story-Tag Streuung;
//   · keine Konkurrenz: keine fast gleich starke Fundstelle (RIVAL_MARGIN) in
//     einem anders datierten Abschnitt. Ein Beat „Streit, dann Vergewaltigung"
//     trifft jede ähnliche Szene des Buchs fast gleich stark — die Streuung
//     innerhalb EINES Abschnitts sagt darüber nichts;
//   · im Akt-Fenster, falls der Akt eine Altersspanne trägt und die
//     Strang-Figur ein Geburtsjahr hat. Der Akt liefert die Zeit nie, er nimmt
//     nur das Häkchen.

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

// Konkurrierende Fundstelle: bis zu so viel Cosinus unter der besten gilt eine
// andere Fundstelle als gleich stark. Die semantischen Scores eines Beats liegen
// eng beieinander (Prod: 0.56–0.68 über acht Treffer), ein kleiner Abstand ist
// kein Beleg, dass die beste Fundstelle die gemeinte Szene ist. Kostet ein zu
// weiter Wert etwas, dann nur ein fehlendes Häkchen — der Vorschlag bleibt.
const RIVAL_MARGIN = 0.1;

// Datierung eines Abschnitts nach den Regeln oben — für die beste Fundstelle
// (der Vorschlag) und für jede Konkurrentin (der Vergleich).
function _dateEvents(events) {
  const usable = (events || []).filter(e => e.subtyp !== 'geburt' && !e.datum_unsicher);
  const abs = usable.filter(e => Number.isInteger(e.datum_year));
  const tag = usable.filter(e => !Number.isInteger(e.datum_year) && Number.isInteger(e.story_tag));
  const pick = list => {
    const own = list.filter(e => e.typ !== 'extern');
    return own.length ? own : list;
  };
  if (abs.length) {
    const ev = pick(abs);
    const from = Math.min(...ev.map(e => e.datum_year));
    const to = Math.max(...ev.map(e => e.datum_ende_year ?? e.datum_year));
    return { mode: 'abs', events: ev, from, to };
  }
  if (tag.length) {
    const ev = pick(tag);
    return { mode: 'tag', events: ev, from: Math.min(...ev.map(e => e.story_tag)), to: Math.max(...ev.map(e => e.story_tag)) };
  }
  return null;
}

// Zwei Fenster gleicher Achse widersprechen sich, wenn sie mehr als eine
// Einheit (Jahr bzw. Story-Tag) auseinanderliegen — dieselbe Toleranz wie
// `eindeutig`.
const _apart = (a, b) => a.mode === b.mode && (b.from > a.to + 1 || a.from > b.to + 1);

/**
 * @param {object} input
 * @param {Array<{id:number, status:string, zeit:?string, verworfen:?number}>} input.beats
 * @param {Map<number, {page_id:number, page_name:?string, score:?number}>} input.topPage  beat_id → beste anspringbare Fundstelle
 * @param {Map<number, Array<{page_id:number, page_name:?string, score:?number}>>} [input.rivals]
 *        beat_id → die übrigen anspringbaren Fundstellen (score null = wörtlicher Treffer)
 * @param {Map<number, {name:string, from:number, to:number}>} [input.aktFenster]
 *        beat_id → Jahresfenster, das sein Akt für die Strang-Figur bedeutet
 * @param {Map<number, Array<object>>} input.eventsByPage  page_id → zeitstrahl_events-Zeilen
 *        (datum, datum_label, datum_year/_month/_day, datum_ende_*, story_tag,
 *        datum_unsicher, ereignis, typ, subtyp, sort_order)
 * @param {string} [input.lang]  Sprache des Buchs ('de' | 'en' | …) — sonst ISO-Formen
 * @returns {Array<{beat_id, zeit, page_id, page_name, n, spread, eindeutig, belege, konkurrenz, akt}>}
 *   eindeutig = schmal UND ohne gleich starke, anders datierte Fundstelle UND im
 *   Akt-Fenster. `konkurrenz` nennt die widersprechenden Fundstellen, `akt` das
 *   verfehlte Fenster (sonst null) — damit die Durchsicht sagt, warum kein Häkchen.
 */
function computeZeitVorschlaege({
  beats = [], topPage = new Map(), rivals = new Map(), aktFenster = new Map(),
  eventsByPage = new Map(), lang = 'de',
} = {}) {
  const out = [];
  for (const b of beats) {
    if (b.status !== 'im_buch' || b.verworfen || (b.zeit && String(b.zeit).trim())) continue;
    const top = topPage.get(b.id);
    if (!top) continue;
    const d = _dateEvents(eventsByPage.get(top.page_id));
    if (!d) continue;
    const zeit = d.mode === 'abs' ? _formatAbs(d.events, lang) : _formatTag(d.events, lang);
    const spread = d.to - d.from;

    // Gleich starke Fundstelle in einem anders datierten Abschnitt: welche der
    // beiden die gemeinte Szene ist, entscheidet der Score nicht.
    const konkurrenz = [];
    const seen = new Set([top.page_id]);
    for (const r of rivals.get(b.id) || []) {
      if (seen.has(r.page_id)) continue;
      seen.add(r.page_id);
      const close = r.score == null || top.score == null || top.score - r.score <= RIVAL_MARGIN;
      if (!close) continue;
      const rd = _dateEvents(eventsByPage.get(r.page_id));
      if (!rd || !_apart(d, rd)) continue;
      konkurrenz.push({
        page_id: r.page_id, page_name: r.page_name || null,
        zeit: rd.mode === 'abs' ? _formatAbs(rd.events, lang) : _formatTag(rd.events, lang),
      });
    }

    // Akt-Fenster liefert nie die Zeit (Kopfkommentar), nimmt aber das Häkchen:
    // ein Vorschlag ausserhalb des Akts ist ein Widerspruch, den der Autor sehen
    // und selbst auflösen muss — Text oder Akt.
    const fenster = d.mode === 'abs' ? aktFenster.get(b.id) : null;
    const akt = fenster && (d.to < fenster.from || d.from > fenster.to) ? fenster : null;

    const belege = [...d.events]
      .sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0))
      .slice(0, MAX_BELEGE)
      .map(e => ({ datum: e.datum_label || e.datum, ereignis: e.ereignis }));
    out.push({
      beat_id: b.id, zeit, page_id: top.page_id, page_name: top.page_name || null,
      n: d.events.length, spread, eindeutig: spread <= 1 && !konkurrenz.length && !akt,
      belege, konkurrenz, akt,
    });
  }
  return out;
}

module.exports = { computeZeitVorschlaege, RIVAL_MARGIN };
