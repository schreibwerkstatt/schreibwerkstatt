// Metrik-Katalog der Buchentwicklung: Labels, Gruppen, Quellen-Klassen und die
// Tagesreihe je Metrik aus den Rohzeilen. Ohne Chart.js/Alpine — die Karte
// (bookstats.js) und Tests lesen von hier.

import { CHARS_PER_NORMSEITE, charsToNormseiten } from '../utils.js';

// Chart-Labels kommen zur Render-Zeit über t() (siehe _metricLabel()), damit sie
// bei Sprachwechsel live nachgezogen werden.
export const METRIC_KEYS = {
  chars:              'bookstats.metric.chars',
  normseiten:         'bookstats.metric.normseiten',
  words:              'bookstats.metric.words',
  page_count:         'bookstats.metric.pages',
  tok:                'bookstats.metric.tok',
  unique_words:       'bookstats.metric.unique',
  delta_chars:        'bookstats.metric.deltaChars',
  delta_words:        'bookstats.metric.delta',
  avg_sentence_len:   'bookstats.metric.avgSentence',
  pages_per_chapter:  'bookstats.metric.pagesPerChapter',
  avg_lix:            'bookstats.metric.lix',
  avg_flesch_de:      'bookstats.metric.flesch',
  mattr:              'bookstats.metric.mattr',
  mtld:               'bookstats.metric.mtld',
  lex_density:        'bookstats.metric.lexDensity',
  hapax_ratio:        'bookstats.metric.hapaxRatio',
  writing_minutes:    'bookstats.metric.writingMinutes',
  writing_cumulative: 'bookstats.metric.writingCumulative',
  lektorat_minutes:    'bookstats.metric.lektoratMinutes',
  lektorat_cumulative: 'bookstats.metric.lektoratCumulative',
  stt_minutes:         'bookstats.metric.sttMinutes',
  stt_cumulative:      'bookstats.metric.sttCumulative',
  stt_chars:           'bookstats.metric.sttChars',
  status_done:         'bookstats.metric.statusDone',
  status_set:          'bookstats.metric.statusSet',
  chars_per_hour:      'bookstats.metric.charsPerHour',
};

// Wortschatz-Kennzahlen aus dem nächtlichen Scan (book_stats_history, Migration
// 308). Längenrobust — anders als `unique_words`, das vor allem die Buchlänge misst.
export const LEXICON_METRICS  = new Set(['mattr', 'mtld', 'lex_density', 'hapax_ratio']);
export const PERCENT_METRICS  = new Set(['lex_density', 'hapax_ratio']);
export const WRITING_METRICS  = new Set(['writing_minutes',  'writing_cumulative']);
export const LEKTORAT_METRICS = new Set(['lektorat_minutes', 'lektorat_cumulative']);
export const STT_METRICS      = new Set(['stt_minutes', 'stt_cumulative', 'stt_chars']);
// Schreibtempo: Snapshot-Zuwachs ÷ Schreibzeit desselben Tags (bookstats-avg.js#tempoRows).
export const TEMPO_METRICS    = new Set(['chars_per_hour']);
// Bearbeitungsstand (docs/bearbeitungsstand.md): eigene Zeitachse aus
// page_editorial_status_events, nur Tage mit Stufenwechsel.
export const STATUS_METRICS   = new Set(['status_done', 'status_set']);
export const CUMULATIVE_METRICS = new Set(['writing_cumulative', 'lektorat_cumulative', 'stt_cumulative']);
// Seltene Bestands-Quellen (nur Tage mit Wechsel bzw. Aktivität): der letzte
// Stand gilt bis heute weiter. Tägliche Snapshots enden am jüngsten Snapshot.
export const CARRY_FORWARD_METRICS = new Set([...CUMULATIVE_METRICS, ...STATUS_METRICS]);
// Quellen mit Live-Erfassung heute (Heartbeat, Stufenwechsel) — ihre Achse reicht
// bis heute. Snapshot-Metriken enden spätestens gestern: den Tagesstand schreibt
// der Nachtlauf nach Mitternacht (lib/cron.js), ein manueller Sync ausgenommen.
export const LIVE_TODAY_METRICS = new Set([...WRITING_METRICS, ...LEKTORAT_METRICS, ...STT_METRICS, ...STATUS_METRICS]);

// Import-Zähler je Metrik (book_stats_history.imported_*, lib/import-baseline.js):
// Δ-Werte und Ø-Zuwachs zählen nur Geschriebenes, der Chart markiert Import-Tage.
export const IMPORT_SOURCE = {
  chars:       { col: 'imported_chars', scale: 1 },
  delta_chars: { col: 'imported_chars', scale: 1 },
  normseiten:  { col: 'imported_chars', scale: 1 / CHARS_PER_NORMSEITE },
  words:       { col: 'imported_words', scale: 1 },
  delta_words: { col: 'imported_words', scale: 1 },
};

// Gruppen der Metrik-Auswahl — dieselbe Ordnung wie die Kennzahlen unter dem Chart.
export const METRIC_GROUPS = [
  ['volume', ['chars', 'normseiten', 'words', 'page_count', 'tok', 'unique_words', 'delta_chars', 'delta_words']],
  ['quality', ['avg_sentence_len', 'pages_per_chapter', 'avg_lix', 'avg_flesch_de', 'mattr', 'mtld', 'lex_density', 'hapax_ratio', 'status_done', 'status_set']],
  ['effort', ['writing_minutes', 'writing_cumulative', 'chars_per_hour', 'lektorat_minutes', 'lektorat_cumulative', 'stt_minutes', 'stt_cumulative', 'stt_chars']],
];

// Verlauf des Bearbeitungsstands → Zeilen der Kurve: `done` = Abschnitte auf der
// letzten Stufe der Kette, `set` = Abschnitte mit irgendeiner Stufe.
export function statusRows(history) {
  const chain = history?.stufen || [];
  const last = chain[chain.length - 1];
  return (history?.daily || []).map(d => ({
    recorded_at: d.date,
    done: last ? (d[last] || 0) : 0,
    set: chain.reduce((a, s) => a + (d[s] || 0), 0),
  }));
}

// Tagesreihe der gewählten Metrik aus den Rohzeilen. Δ-Werte entstehen hier,
// VOR dem Zeitraum-Filter — sonst fehlte der erste sichtbare Tag.
// Δ-Werte sind NETTO: der Import-Zuwachs zwischen zwei Snapshots zählt nicht als
// geschrieben (imported_*).
export function _metricSeries(metric, rows) {
  const num = v => Number(v) || 0;
  const written = (r, f) => num(r[f]) - num(r['imported_' + f]);
  switch (metric) {
    case 'delta_words': return rows.map((r, i) => (i === 0 ? null : written(r, 'words') - written(rows[i - 1], 'words')));
    case 'delta_chars': return rows.map((r, i) => (i === 0 ? null : written(r, 'chars') - written(rows[i - 1], 'chars')));
    case 'normseiten': return rows.map(r => charsToNormseiten(r.chars));
    case 'pages_per_chapter': return rows.map(r => (r.chapter_count > 0 ? Math.round((r.page_count / r.chapter_count) * 10) / 10 : null));
    case 'writing_minutes': case 'lektorat_minutes': case 'stt_minutes': return rows.map(r => Math.round(r.seconds / 60));
    case 'writing_cumulative': case 'lektorat_cumulative': case 'stt_cumulative': {
      let sum = 0;
      return rows.map(r => { sum += r.seconds; return Math.round(sum / 360) / 10; });
    }
    case 'stt_chars': return rows.map(r => num(r.chars));
    case 'status_done': return rows.map(r => r.done);
    case 'status_set': return rows.map(r => r.set);
    case 'chars_per_hour': return rows.map(r => r.cph);
    default:
      // Anteile (0..1) als Prozent — dieselbe Darstellung wie in der Wortschatz-Karte.
      if (PERCENT_METRICS.has(metric)) return rows.map(r => (r[metric] == null ? null : Math.round(r[metric] * 1000) / 10));
      return rows.map(r => r[metric] ?? null);
  }
}
