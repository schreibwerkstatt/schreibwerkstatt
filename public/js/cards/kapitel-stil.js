// Kapitel-Dashboard, Kachel „Stil" — Stil- und Lesbarkeitswerte des gewaehlten
// Kapitels neben dem Buchschnitt.
//
// Quelle ist dieselbe Antwort, aus der die Stil-Heatmap ihr Raster baut:
// `GET /history/style-stats/:book_id` (lib/stil-heatmap.js#buildStilHeatmap,
// eine Zeile pro Kapitel mit `key` = Kapitel-ID als String). Kein KI-Call und
// kein eigener Index. Gelesen werden nur die Felder, die die Antwort heute
// traegt; jedes fehlende oder `null`-Feld faellt still aus der Rechnung
// (Zeile weg), statt als 0 zu erscheinen.
//
// Aggregation (Scope mit Sub-Kapiteln und Buchschnitt): wortgewichteter
// Mittelwert der Kapitelzeilen — dieselbe Gewichtung, mit der der Server die
// Seiten zu Kapiteln verdichtet. Fuer `dialog_ratio` (dort zeichengewichtet)
// ist das eine Naeherung; die Kapitelzeile traegt keine Zeichenzahl.
//
// Abweichungs-Regel (deutlich anders als das Buch): ein Wert gilt als
// auffaellig, wenn er um mindestens 25 % des Buchwerts UND um mindestens die
// metrikeigene Mindestdifferenz `minAbs` vom Buchschnitt abweicht — und der
// Scope mindestens STIL_MIN_WORDS Woerter hat. Die relative Schwelle traegt
// grosse Werte, die absolute verhindert, dass bei kleinen Buchwerten (0,8
// Fuellwoerter/1k) schon Rauschen anschlaegt; der Wortsockel haelt kurze
// Kapitel stumm, deren Werte an zwei Saetzen haengen. Bewertet wird nur die
// RICHTUNG, nicht gut/schlecht: ein dialogreiches Kapitel ist kein Fehler.

// Metriken in Anzeige-Reihenfolge. Label/Tooltip teilen die Keys der
// Stil-Heatmap, damit dieselbe Zahl in beiden Karten gleich heisst.
export const STIL_METRICS = [
  { key: 'avg_sentence_len', labelKey: 'stil.metric.avgSentence', minAbs: 2 },
  { key: 'lix',              labelKey: 'stil.metric.lix',         minAbs: 4 },
  { key: 'flesch_de',        labelKey: 'stil.metric.flesch',      minAbs: 6 },
  { key: 'dialog_ratio',     labelKey: 'stil.metric.dialog',      minAbs: 8 },
  { key: 'filler_per1k',     labelKey: 'stil.metric.filler',      minAbs: 1 },
  { key: 'passive_per1k',    labelKey: 'stil.metric.passive',     minAbs: 1 },
  { key: 'adverb_per1k',     labelKey: 'stil.metric.adverb',      minAbs: 1 },
];

export const STIL_REL_THRESHOLD = 0.25;
export const STIL_MIN_WORDS = 300;

const _num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Wortgewichteter Schnitt je Metrik ueber die Kapitelzeilen.
 *  `ids === null` = ganzes Buch. Kapitel ohne Woerter zaehlen nicht (ihre
 *  0-Werte sind „kein Text", keine Messung). */
export function aggregateStil(chapters, ids) {
  let words = 0;
  const num = {}, den = {};
  for (const ch of Array.isArray(chapters) ? chapters : []) {
    if (!ch || (ids && !ids.has(String(ch.key)))) continue;
    const w = Number(ch.words) || 0;
    if (w <= 0) continue;
    words += w;
    for (const m of STIL_METRICS) {
      const v = _num(ch[m.key]);
      if (v == null) continue;
      num[m.key] = (num[m.key] || 0) + v * w;
      den[m.key] = (den[m.key] || 0) + w;
    }
  }
  const values = {};
  for (const m of STIL_METRICS) {
    values[m.key] = den[m.key] > 0 ? Math.round((num[m.key] / den[m.key]) * 10) / 10 : null;
  }
  return { words, values };
}

/** 'up' | 'down' | null — Abweichungs-Regel siehe Dateikopf. */
export function stilDeviation(value, book, minAbs, words) {
  if (value == null || book == null || !(words >= STIL_MIN_WORDS)) return null;
  const diff = value - book;
  if (Math.abs(diff) < Math.max(Math.abs(book) * STIL_REL_THRESHOLD, minAbs)) return null;
  return diff > 0 ? 'up' : 'down';
}

/** Kachel-Daten fuer den Scope. `null`, solange es keine Antwort gibt oder im
 *  Scope kein gemessener Text liegt — die Kachel faellt dann weg. */
export function computeKapitelStil(data, ids) {
  const chapters = data?.chapters;
  if (!Array.isArray(chapters) || !ids || ids.size === 0) return null;
  const scope = aggregateStil(chapters, ids);
  if (scope.words <= 0) return null;
  const book = aggregateStil(chapters, null);
  const rows = [];
  for (const m of STIL_METRICS) {
    const value = scope.values[m.key];
    if (value == null) continue;
    const bookVal = book.values[m.key];
    rows.push({
      key: m.key,
      labelKey: m.labelKey,
      tipKey: 'stil.tip.' + m.key,
      value,
      book: bookVal,
      dev: stilDeviation(value, bookVal, m.minAbs, scope.words),
    });
  }
  if (!rows.length) return null;
  return {
    words: scope.words,
    rows,
    deviating: rows.filter(r => r.dev).length,
    // `needsSync` der Heatmap-Antwort: Werte fehlen oder stammen aus einer
    // aelteren Metrik-Version. Fehlt das Feld, wird nichts behauptet.
    needsSync: data.needsSync === true,
  };
}
