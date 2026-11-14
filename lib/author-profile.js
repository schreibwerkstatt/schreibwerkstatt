'use strict';
// Deterministische Autorenprofil-Engine (read-time, PURE — kein DB, kein KI-Call).
//
// Stellt die Buecher EINES Autors nebeneinander und misst, worin sie sich
// stilistisch unterscheiden. Gegenstueck zu lib/narrative-report.js: dort wird ein
// Buch in sich verdichtet, hier ein Werk ueber seine Buecher hinweg.
//
// Warum ueberhaupt eine eigene Schicht, wo db/lexicon.js#loadPeerStats schon
// Mediane ueber die uebrigen Buecher desselben Besitzers rechnet: jene Antwort ist
// „dieses Buch gegen den Median" und lebt an der Wortschatz-Karte EINES Buchs.
// Die Frage hier ist „meine Buecher nebeneinander, in Werk-Reihenfolge" — dafuer
// braucht es die Reihe statt des Vergleichswerts, und die Satzbau-Achse aus
// `page_stats`, die in `loadPeerStats` vollstaendig fehlt.
//
// KEIN abgeleiteter Index: `book_lexicon` und `page_stats` SIND bereits die
// abgeleiteten Indexe. Eine dritte Tabelle waere eine dritte Wahrheit, die nach
// jedem Scan neu invalidiert werden muesste — gerechnet wird darum bei jedem
// Aufruf frisch (gleiches Muster wie der Buch-Befund in db/narrative-report.js).
//
// Die Engine WERTET NICHT. Sie liefert Zahlen, Mediane und Abweichungen; ob eine
// kuerzere Satzlaenge ein Fortschritt ist, sagt sie nirgends — das ist Sache des
// Autors (und, ab Stufe 2, eines KI-Calls, der diese Zahlen als Vorbefund bekommt).

const { styleLanguage } = require('./style-lang');

const AUTHOR_PROFILE_THRESHOLDS = {
  // Unter dieser Tokenzahl ist ein Buch kein Vergleichspunkt: die Diversitaetsmasse
  // sind laengenrobust, aber nicht laengenfrei, und eine Handvoll Seiten erzeugt
  // Ausreisser, die den Median der uebrigen Buecher verschieben. Solche Buecher
  // fallen nicht still weg, sondern werden als `skipped.tooShort` ausgewiesen.
  MIN_TOKENS: 2000,
  // MATTR gilt nur aus Buechern, die lang genug fuer ein echtes Fenster waren —
  // darunter liefert die Kennzahl die simple TTR und ist nicht vergleichbar.
  // Dieselbe Schranke wie in db/lexicon.js#loadPeerStats (bewusst deckungsgleich).
  MIN_MATTR_WINDOW: 1000,
  // Ab zwei gemessenen Buechern gibt es einen Median, ab drei eine Aussage ueber
  // die Richtung. Bei zweien waere die „Entwicklung" nur der Vergleich A gegen B,
  // und den zeigt die Tabelle ohnehin.
  MIN_BOOKS_COMPARE: 2,
  MIN_BOOKS_TREND: 3,
};

// Kennzahlen-Katalog = SSoT fuer Reihenfolge, Gruppierung und Anzeigeformat.
// Labels liegen in der i18n unter `autorenprofil.metric.<key>` (beide Locales).
// Bewusst OHNE Richtungswertung ("hoeher ist besser") — die gibt es hier nicht.
const AUTHOR_PROFILE_METRICS = [
  { key: 'satzlaenge',      group: 'satzbau',    decimals: 1 },
  // `crossLanguage`: sprachneutral gemessen (Zeichenanteil der wörtlichen Rede) und
  // darum über Bücher verschiedener Sprachen vergleichbar. Alle übrigen Kennzahlen
  // hängen an der Sprache (Wortlisten, Silbenregeln, Komposita, Satzbau) und werden
  // nur innerhalb einer Sprache verglichen.
  { key: 'dialogAnteil',    group: 'satzbau',    decimals: 1, percent: true, crossLanguage: true },
  { key: 'adverbDichte',    group: 'satzbau',    decimals: 2, percent: true },
  { key: 'passivQuote',     group: 'satzbau',    decimals: 1, percent: true },
  { key: 'fuellwortDichte', group: 'satzbau',    decimals: 2, percent: true },
  { key: 'mattr',           group: 'wortschatz', decimals: 3 },
  { key: 'mtld',            group: 'wortschatz', decimals: 1 },
  { key: 'hapaxRatio',      group: 'wortschatz', decimals: 1, percent: true },
  { key: 'yuleK',           group: 'wortschatz', decimals: 1 },
  { key: 'heapsBeta',       group: 'wortschatz', decimals: 3 },
  { key: 'lexDichte',       group: 'wortschatz', decimals: 1, percent: true },
  { key: 'lix',             group: 'lesbarkeit', decimals: 1 },
  { key: 'fleschDe',        group: 'lesbarkeit', decimals: 1 },
];

const T = AUTHOR_PROFILE_THRESHOLDS;
const METRIC_KEYS = AUTHOR_PROFILE_METRICS.map(m => m.key);

const _num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** a/b als Verhaeltnis; null sobald der Nenner fehlt oder 0 ist (keine 0-Division,
 *  aber auch keine 0 als Ergebnis — „keine Saetze" ist nicht „Satzlaenge 0"). */
function _ratio(a, b) {
  const x = _num(a), y = _num(b);
  if (x === null || y === null || y === 0) return null;
  return x / y;
}

function _median(nums) {
  const s = nums.filter(v => _num(v) !== null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Kennzahlen EINES Buchs aus seiner Lexikon-Zeile + der Seiten-Summe.
 *
 * Die Satzbau-Werte entstehen aus SUMMEN ueber die Seiten, nicht als Mittel der
 * Seitenmittelwerte: eine Seite mit zwei Saetzen zaehlte sonst so viel wie eine
 * mit achtzig, und der Buchwert wanderte in Richtung der kurzen Seiten. Die
 * Lesbarkeitsmasse sind pro Seite berechnet und werden darum mit der Wortzahl
 * gewichtet gemittelt (die Gewichtssumme zaehlt nur Seiten, die den Wert haben).
 */
function _bookMetrics(lex, agg) {
  const a = agg || {};
  const mattrWindow = _num(lex?.mattr_window) || 0;
  return {
    // Satzlaenge und Dichten gegen die Prosa-Woerter: Saetze, Adverbien und
    // Fuellwoerter sind ohne Verlauf und Tabellen gezaehlt (lib/page-index.js).
    satzlaenge:      _ratio(a.prose_words ?? a.words, a.sentences),
    dialogAnteil:    _ratio(a.dialog_chars, a.chars),
    adverbDichte:    _ratio(a.adverb_count, a.prose_words ?? a.words),
    passivQuote:     _ratio(a.passive_count, a.sentences),
    fuellwortDichte: _ratio(a.filler_count, a.prose_words ?? a.words),
    // MATTR nur aus einem echten Fenster — sonst ist es die simple TTR.
    mattr:      mattrWindow >= T.MIN_MATTR_WINDOW ? _num(lex?.mattr) : null,
    mtld:       _num(lex?.mtld),
    hapaxRatio: _num(lex?.hapax_ratio),
    yuleK:      _num(lex?.yule_k),
    heapsBeta:  _num(lex?.heaps_beta),
    lexDichte:  _num(lex?.lex_density),
    lix:        _ratio(a.lix_w, a.lix_wsum),
    fleschDe:   _ratio(a.flesch_w, a.flesch_wsum),
  };
}

/**
 * Richtung einer Kennzahl ueber die Werk-Reihenfolge: Median der ersten Haelfte
 * gegen den der zweiten. Bewusst grob — eine Regression ueber vier Buecher
 * suggerierte eine Praezision, die die Datenlage nicht hergibt.
 *
 * Bei ungerader Buchzahl gehoert das mittlere Buch KEINER Haelfte an: es waere
 * sonst in beiden und zoege die Differenz gegen null.
 */
function _trend(values) {
  const vals = values.filter(v => _num(v) !== null);
  if (vals.length < T.MIN_BOOKS_TREND) return null;
  const half = Math.floor(vals.length / 2);
  const first = _median(vals.slice(0, half));
  const second = _median(vals.slice(vals.length - half));
  if (first === null || second === null) return null;
  const delta = second - first;
  // Relative Aenderung nur, wo der Ausgangswert nicht bei null liegt.
  const pct = first !== 0 ? (delta / Math.abs(first)) * 100 : null;
  return { first, second, delta, pct };
}

/** Median, Spanne und Richtung EINER Kennzahl über eine Buchmenge. */
function _metricStats(spec, books) {
  const values = books.map(b => b.metrics[spec.key]);
  const known = values.filter(v => _num(v) !== null);
  const comparable = books.length >= T.MIN_BOOKS_COMPARE;
  return {
    ...spec,
    median: comparable ? _median(known) : null,
    min: known.length ? Math.min(...known) : null,
    max: known.length ? Math.max(...known) : null,
    covered: known.length,
    trend: comparable ? _trend(values) : null,
  };
}

/**
 * Ein Vergleichsabschnitt: eine Buchmenge + die Kennzahlen, die über genau diese
 * Menge verglichen werden. `kind`:
 *   'all'           — einsprachiges Werk: alle Kennzahlen über alle Bücher
 *   'language'      — mehrsprachig: die sprachgebundenen Kennzahlen je Sprache
 *   'crossLanguage' — mehrsprachig: die sprachneutralen über alle Bücher
 */
function _section(kind, language, books, specs) {
  return {
    kind,
    language,
    bookIds: books.map(b => b.book_id),
    measured: books.length,
    comparable: books.length >= T.MIN_BOOKS_COMPARE,
    trendAvailable: books.length >= T.MIN_BOOKS_TREND,
    metrics: specs.map(spec => _metricStats(spec, books)),
  };
}

/** Sprachen des Werks, die mit dem meisten Text zuerst. */
function _languagesByWeight(books) {
  const weight = new Map();
  for (const b of books) weight.set(b.language, (weight.get(b.language) || 0) + (b.tokens || 0));
  return [...weight.keys()].sort((a, b) => weight.get(b) - weight.get(a));
}

/**
 * @param {object} input
 *   input.books     [{ book_id, created_at, excluded, language }] — Buecher des
 *                   Besitzers, bereits in Werk-Reihenfolge (aelteste zuerst);
 *                   `language` = Messsprache (lib/style-lang.js#styleLanguage)
 *   input.lexicon   [{ book_id, tokens, pages, scanned_at, mattr, mattr_window,
 *                      mtld, hapax_ratio, yule_k, heaps_beta, lex_density }]
 *   input.pageStats [{ book_id, pages, words, chars, sentences, dialog_chars,
 *                      adverb_count, passive_count, filler_count,
 *                      lix_w, lix_wsum, flesch_w, flesch_wsum }]
 * @returns {object} Reihe je Buch + Vergleichsabschnitte (Median/Spanne/Richtung
 *   je Kennzahl). Ein Werk in mehreren Sprachen wird nicht über die Sprachgrenze
 *   gemittelt: Flesch nach Amstad und nach Flesch sind zwei Formeln, die Wortlisten
 *   von Füllwort/Adverb/Passiv sind zwei Listen, und deutsche Komposita treiben die
 *   Wortschatz-Masse. Ein Sprachwechsel erschiene sonst als Stilentwicklung.
 */
function computeAuthorProfile(input) {
  const rawBooks = Array.isArray(input?.books) ? input.books : [];
  const lexById = new Map((input?.lexicon || []).map(r => [r.book_id, r]));
  const aggById = new Map((input?.pageStats || []).map(r => [r.book_id, r]));

  const skipped = { excluded: [], unscanned: [], tooShort: [] };
  const books = [];

  for (const b of rawBooks) {
    const lex = lexById.get(b.book_id) || null;
    const agg = aggById.get(b.book_id) || null;
    // Aus der Statistik genommene Buecher gehoeren nicht ins Autorenprofil —
    // derselbe Schalter, der sie aus „Meine Statistik" haelt (book_settings).
    if (b.excluded) { skipped.excluded.push(b.book_id); continue; }
    // Ohne Lexikon-Scan gibt es keine Wortschatz-Achse. Das Buch faellt nicht
    // still weg, sondern wird benannt — sonst sieht das Profil vollstaendig aus
    // und ist es nicht (gleiche Regel wie der Einmalwort-Deckel im Wortschatz).
    if (!lex) { skipped.unscanned.push(b.book_id); continue; }
    const tokens = _num(lex.tokens) || 0;
    if (tokens < T.MIN_TOKENS) { skipped.tooShort.push(b.book_id); continue; }
    books.push({
      book_id: b.book_id,
      language: styleLanguage(b.language),
      created_at: b.created_at || null,
      scanned_at: lex.scanned_at || null,
      content_sig: lex.content_sig || null,
      tokens,
      pages: _num(lex.pages) ?? _num(agg?.pages) ?? null,
      metrics: _bookMetrics(lex, agg),
    });
  }

  const measured = books.length;
  const languages = _languagesByWeight(books);
  const multiLanguage = languages.length > 1;

  const sections = [];
  if (!multiLanguage) {
    sections.push(_section('all', languages[0] || null, books, AUTHOR_PROFILE_METRICS));
  } else {
    const bound = AUTHOR_PROFILE_METRICS.filter(m => !m.crossLanguage);
    const neutral = AUTHOR_PROFILE_METRICS.filter(m => m.crossLanguage);
    for (const lang of languages) {
      sections.push(_section('language', lang, books.filter(b => b.language === lang), bound));
    }
    sections.push(_section('crossLanguage', null, books, neutral));
  }

  // Abweichung jedes Buchs vom Median SEINES Abschnitts — die eigentliche Aussage
  // der Tabelle. Nur wo es einen Median gibt; ein einzelnes Buch weicht von nichts ab.
  const byId = new Map(books.map(b => [b.book_id, b]));
  for (const b of books) b.deviation = Object.fromEntries(METRIC_KEYS.map(k => [k, null]));
  for (const sec of sections) {
    for (const id of sec.bookIds) {
      const b = byId.get(id);
      for (const m of sec.metrics) {
        const v = b.metrics[m.key];
        b.deviation[m.key] = (_num(v) !== null && _num(m.median) !== null && m.median !== 0)
          ? ((v - m.median) / Math.abs(m.median)) * 100
          : null;
      }
    }
  }

  return {
    books,
    sections,
    languages,
    multiLanguage,
    skipped,
    counts: {
      total: rawBooks.length,
      measured,
      excluded: skipped.excluded.length,
      unscanned: skipped.unscanned.length,
      tooShort: skipped.tooShort.length,
    },
    // „comparable: false" heisst NICHT „kein Stil", sondern „noch kein Vergleich":
    // die Karte zeigt dann die Einzelwerte und sagt, was fehlt.
    comparable: sections.some(sec => sec.comparable),
    trendAvailable: sections.some(sec => sec.trendAvailable),
    // Entwicklung ist nur innerhalb EINER Sprache belegbar: zwischen zwei Sprachen
    // waere jeder Unterschied zuerst ein Sprachunterschied. Der sprachuebergreifende
    // Abschnitt (nur Dialoganteil) traegt darum keine Entwicklung.
    developmentAvailable: sections.some(sec => sec.kind !== 'crossLanguage' && sec.comparable),
  };
}

/** Einen Messwert nach seiner Spec formatieren. Spiegel der Karten-Formatierung —
 *  der Prompt soll dieselben Zahlen sehen wie der Autor auf dem Bildschirm. */
function _fmt(value, spec) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const v = Number(value);
  return spec.percent
    ? `${(v * 100).toFixed(spec.decimals ?? 1)} %`
    : v.toFixed(spec.decimals ?? 1);
}

/**
 * Messung als Text fuer den Prompt. Bewusst hier und nicht im Job: der Wortlaut
 * dessen, was das Modell sieht, ist Teil der Sachlogik und damit testbar.
 *
 * `nameById` kommt vom Aufrufer (Content-Store-Regel — dieses Modul kennt keine
 * Buchnamen). Fehlt ein Name, steht die ID da; erfunden wird keiner.
 *
 * `labels` ebenso: die lesbaren Kennzahl-Namen sind PROMPT-Wortlaut und leben
 * darum in public/js/prompts/autorenprofil.js, nicht hier. Sie sind bewusst NICHT
 * die i18n-Labels der Karte — die sind lokalisiert und folgen der Sprache des
 * Betrachters, waehrend der Prompt in einer Sprache geschrieben ist. Fehlt ein
 * Label, steht der Schluessel da. `languageNames` (Sprachcode → Prompt-Wortlaut)
 * gleich.
 */
function renderAuthorProfileMeasurement(result, { nameById = {}, labels = {}, languageNames = {} } = {}) {
  const books = result?.books || [];
  if (!books.length) return '(Keine gemessenen Buecher.)';
  const byId = new Map(books.map(b => [b.book_id, b]));
  const label = (b) => nameById[b.book_id] || `Buch ${b.book_id}`;
  const langName = (l) => languageNames[l] || l;
  const lines = [];
  lines.push(`Buecher in Werk-Reihenfolge: ${books.map((b, i) => `${i + 1}. ${label(b)}`).join(', ')}`);
  if (result.multiLanguage) {
    const perLang = (result.languages || []).map(l =>
      `${langName(l)}: ${books.filter(b => b.language === l).map(label).join(', ')}`);
    lines.push(`Sprachen: ${perLang.join('; ')}.`);
    lines.push('Die Kennzahlen sind je Sprache gemessen und nur innerhalb einer Sprache vergleichbar. '
      + 'Ausnahme ist der Dialoganteil, der ueber alle Buecher verglichen wird.');
  }
  for (const sec of (result.sections || [])) {
    const secBooks = sec.bookIds.map(id => byId.get(id)).filter(Boolean);
    lines.push('');
    if (sec.kind === 'language') lines.push(`== ${langName(sec.language)} ==`);
    else if (sec.kind === 'crossLanguage') lines.push('== Ueber alle Sprachen ==');
    let group = null;
    for (const m of sec.metrics) {
      if (m.group !== group) { group = m.group; lines.push(`[${group}]`); }
      const per = secBooks.map(b => `${label(b)} ${_fmt(b.metrics[m.key], m)}`).join(' | ');
      const name = labels[m.key] || m.key;
      const med = m.median != null ? ` (Median ${_fmt(m.median, m)})` : '';
      // Die Richtung nur anhaengen, wo sie ueberhaupt berechnet wurde — eine
      // ausgelassene Zeile ist ehrlicher als „Richtung: unbekannt".
      const tr = (m.trend && m.trend.pct != null)
        ? `, Richtung ueber die Werkhaelften ${m.trend.pct > 0 ? '+' : ''}${m.trend.pct.toFixed(0)} %`
        : '';
      lines.push(`${name}: ${per}${med}${tr}`);
    }
  }
  return lines.join('\n');
}

/**
 * Signatur der Messgrundlage: welche Buecher in welchem Stand das Profil tragen.
 *
 * Sie beantwortet die einzige Frage, die ein gespeicherter Profiltext sonst nicht
 * beantworten kann — „gilt das noch?". Es geht bewusst NUR der gemessene Bestand
 * ein: ein neu angelegtes, noch ungescanntes Buch aendert am gedeuteten Stil
 * nichts und darf den Text nicht als veraltet markieren.
 *
 * `content_sig` statt `scanned_at`: ein erneuter Scan mit unveraendertem Text
 * verschiebt den Zeitstempel, nicht aber die Grundlage.
 */
function authorProfileBasisSig(result) {
  const books = (result?.books || []).slice().sort((a, b) => a.book_id - b.book_id);
  if (!books.length) return null;
  // Die Sprache geht nur bei einem mehrsprachigen Werk ein: dort aendert sie, was
  // womit verglichen wird. Einsprachige Signaturen bleiben so, wie sie waren.
  const lang = (b) => (result?.multiLanguage ? `${b.language}:` : '');
  return books.map(b => `${b.book_id}:${lang(b)}${b.content_sig || b.scanned_at || '?'}`).join('|');
}

module.exports = {
  computeAuthorProfile, authorProfileBasisSig, renderAuthorProfileMeasurement,
  AUTHOR_PROFILE_METRICS, AUTHOR_PROFILE_THRESHOLDS,
};
