'use strict';
// Metrik-Berechnung pro Seite für den Agentic Buch-Chat:
// Pronomen-Counts (narrativ vs. Dialog getrennt), Dialoganteil, Satzzahl,
// Figuren-Erwähnungen. Schreibt in page_stats + page_figure_mentions.

const crypto = require('crypto');
const { db } = require('../db/schema');
const { STOPWORDS_DE_BASE } = require('./stopwords-de');
const { STOPWORDS_EN_BASE } = require('./stopwords-en');
const { percentileSorted } = require('./percentile');
const { sentenceRanges: _sentenceRanges, STYLE_WORD_RE: _STYLE_WORD_RE, styleWordKey, styleWordLength } = require('./sentence-split');
const { styleProfile, PRONOUN_GROUPS_DE } = require('./style-lang');

// Änderung dieser Zahl erzwingt Neuberechnung aller Seiten beim nächsten Sync
// (bei Algorithmus-Änderungen: Regex-Grenzen, neue Pronomen-Liste etc.).
// v2: Stil-Heatmap + Lesbarkeit (Füllwörter, Passiv, Adverbien, LIX, Flesch, Wiederholungen).
// v3: Konkrete Treffer-Samples pro Metrik für Drilldown in der Stil-Heatmap.
// v4: Eigennamen (Figuren, Szenen-Titel) werden aus der Wiederholungs-Metrik ausgeschlossen.
// v5: Zusätzlich locations.name ausgeschlossen.
// v6: Dialog-Erkennung erweitert um weitere Anführungszeichen (engl. Smart Quotes,
//     inverted DE »…«, franz. einfach ‹…›, DE einfach ‚…'), Speech-Verb-Heuristik
//     (Er sagte: …) und Em-Dash-Zeilenanfang (— Ich komme.).
// v7: Satzrhythmus — Satzlängen-Sequenz in Leserichtung (sentence_lens) und
//     Satzanfänge inkl. Nachbar-Wiederholungen (opener_counts).
// v8: HTML→Text dekodiert alle benannten Entities (lib/html-entities.js) —
//     `f&uuml;r` zählt als ein Wort, nicht als drei.
// v9: Satzerkennung kennt Abkürzungen, Ordinalzahlen und Dialog-Einschübe;
//     Stil-Wörter in allen Schriften (é, à, ø).
// v10: Stoppwörter der Wiederholung nach Buchsprache (de/en); Dialog kennt engl. ‘…’.
// v11: Nachrichten eines Verlaufs (div.msg-thread) zählen als Dialog; Satzmetriken ohne Verlauf.
// v12: `sentences` aus derselben Satzzerlegung wie die Satzlänge (zählte vorher an jedem Punkt).
// v13: Füllwörter, Adverbien, Passiv, Flesch und Pronomen nach Buchsprache (lib/style-lang.js).
// v14: Kontraktionen sind ein Wort („don't", „geht's"); lange Wörter (LIX) ohne Apostroph gezählt.
// v15: `repetition_data.words` = Wörter des Prosatexts (Nenner der Dichten pro 1000
//      Wörter, ohne Verlauf und Tabellen); Verlauf-Ende zählt verschachtelte <div>.
const METRICS_VERSION = 15;

// Deckel für die Satzlängen-Sequenz einer Seite. Der Rhythmus wird als Band gezeichnet;
// jenseits dieser Auflösung ist nichts mehr unterscheidbar, und page_stats soll pro Seite
// kein unbegrenztes Array tragen. Gestutzt wird nur die Sequenz — avg/p90 rechnen weiter
// über alle Sätze.
const MAX_SENTENCE_LENS = 2000;

// Maximale Anzahl Beispielsätze, die pro Seite und Metrik in style_samples gespeichert werden.
const MAX_SAMPLES_PER_METRIC = 5;
// Maximale Länge eines Sample-Satzes, damit style_samples nicht explodiert.
const SAMPLE_MAX_CHARS = 220;

// Pronomen-Gruppen der Buchsprache: lib/style-lang.js (Schlüssel sprachunabhängig).
// Export `PRONOUN_GROUPS` = deutsche Formen, für Konsumenten, die nur die Schlüssel lesen.
const PRONOUN_GROUPS = PRONOUN_GROUPS_DE;

// Regex: ein Wort (mit Umlauten). \b in JS-Regex kennt keine Umlaute,
// deshalb explizite Grenz-Klasse via Lookahead/Lookbehind.
const _WORD_RE = /(?<![A-Za-zÄÖÜäöüß])([A-Za-zÄÖÜäöüß]+)(?![A-Za-zÄÖÜäöüß])/g;

// Dialog-Marker: Paare (öffnend, schliessend). Max 500 Zeichen pro Dialog-Block
// gegen Catastrophic Backtracking und unbalancierte Paare (Textende im Dialog).
// Abgedeckt: CH-Guillemets «…», inverted DE »…«, DE typografisch „…" (inkl.
// gemischter Smart-Close-Varianten), engl. Smart „…" (U+201C/U+201D),
// gerade "…", franz. einfach ‹…›, DE einfach ‚…'.
// Einfache gerade Quotes ('…') werden bewusst NICHT erkannt — zu viele
// False Positives mit Apostroph (geht's, Annas'). Engl. einfach ‘…’ (britisch) nur
// mit Öffner nach Leerraum/Zeilenanfang/öffnendem Zeichen und Schliesser ohne
// folgenden Buchstaben: ’ ist zugleich Apostroph (don’t, ’tis, James’). Erst mit
// Satzzeichen vor dem Schliesser (überspringt „James’ hat“), sonst der erste.
const DIALOG_PATTERNS = [
  /\u00AB([^\u00BB]{1,500})\u00BB/g,
  /\u00BB([^\u00AB]{1,500})\u00AB/g,
  /\u201E([^\u201C\u201D\u0022]{1,500})[\u201C\u201D\u0022]/g,
  /\u201C([^\u201D]{1,500})\u201D/g,
  /\u0022([^\u0022]{1,500})\u0022/g,
  /\u2039([^\u203A]{1,500})\u203A/g,
  /\u201A([^\u2018\u2019\u0027]{1,500})[\u2018\u2019\u0027]/g,
  /(?<=^|[\s(\[\u2014\u2013\u201C\u201E\u00AB\u00BB"])\u2018([^\u2018\n]{0,500}?[.,!?;:\u2026\u2014\u2013-])\u2019(?!\p{L})/gu,
  /(?<=^|[\s(\[\u2014\u2013\u201C\u201E\u00AB\u00BB"])\u2018((?:[^\u2018\u2019\n]|\u2019(?=\p{L})){1,500}?)\u2019(?!\p{L})/gu,
];

// Speech-Verben (DE + EN), die eine direkte Rede einleiten können —
// Muster: "VERB: Text." Streng gehalten, um Aufzählungen (z.B. "Er hatte drei
// Probleme: …") nicht fälschlich als Dialog zu werten.
const SPEECH_VERBS = [
  'sagte', 'sagt', 'sage', 'sagten',
  'fragte', 'fragt', 'frage', 'fragten',
  'antwortete', 'antwortet', 'antworten',
  'entgegnete', 'entgegnet',
  'erwiderte', 'erwidert',
  'flüsterte', 'flüstert',
  'rief', 'ruft', 'rufen',
  'murmelte', 'murmelt',
  'brüllte', 'brüllt',
  'schrie', 'schreit',
  'zischte', 'zischt',
  'raunte', 'raunt',
  'stammelte', 'stammelt',
  'hauchte', 'haucht',
  'seufzte', 'seufzt',
  'stöhnte', 'stöhnt',
  'knurrte', 'knurrt',
  'fauchte', 'faucht',
  'lachte', 'lacht',
  'kicherte', 'kichert',
  'jammerte', 'jammert',
  'klagte', 'klagt',
  'wisperte', 'wispert',
  'meinte', 'meint',
  'bemerkte', 'bemerkt',
  'erklärte', 'erklärt',
  'verkündete', 'verkündet',
  'behauptete', 'behauptet',
  'versicherte', 'versichert',
  'gestand', 'gesteht',
  'fuhr fort',
  'dachte', 'denkt',
  'überlegte', 'überlegt',
  'said', 'says', 'asked', 'asks', 'replied', 'whispered', 'shouted',
  'murmured', 'muttered', 'cried', 'exclaimed', 'answered',
];

// Regex: Satz endet mit Speech-Verb + ":" + Inhalt bis Satzende.
// Wortgrenze mit Umlaut-Lookbehind. Verb-Liste wird zur Alternation.
const _SPEECH_VERB_ALT = SPEECH_VERBS
  .map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
const _SPEECH_COLON_RE = new RegExp(
  `(?<![A-Za-zÄÖÜäöüß])(?:${_SPEECH_VERB_ALT})(?![A-Za-zÄÖÜäöüß])\\s*:\\s*([^.!?\\n]{1,500}[.!?])`,
  'gi'
);

// Em-Dash-Dialogstil: Zeile beginnt mit — oder – + Leerzeichen + Inhalt.
// Nur am Zeilenanfang, damit normale Gedankenstriche nicht fälschlich greifen.
const _EM_DASH_LINE_RE = /(?:^|\n)[ \t]*[—–][ \t]+([^\n]{1,500})/g;

// Scan-Helper: iteriert alle Matches eines Regex und pusht Ranges.
function _pushMatches(re, text, ranges, groupIndex) {
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (groupIndex && m[groupIndex]) {
      const g = m[groupIndex];
      const start = m.index + m[0].lastIndexOf(g);
      ranges.push([start, start + g.length]);
    } else {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
}

/** Liefert die Zeichen-Ranges aller Dialog-Blöcke in `text`.
 *  Nicht-überlappend (erstes Match gewinnt pro Position).
 *  Kombiniert Anführungszeichen-Paare, Speech-Verb+Colon-Muster und
 *  Em-Dash-Zeilenanfänge. `extraRanges`: Rede ohne Marker (Nachrichten, html-text.js#htmlToPlainTextWithMsgRanges). */
function _findDialogRanges(text, extraRanges = []) {
  const ranges = extraRanges.map(r => [r[0], r[1]]);
  for (const re of DIALOG_PATTERNS) _pushMatches(re, text, ranges, 0);
  // Speech-Verb + Doppelpunkt: nur der Inhalt nach dem ":" zählt als Dialog,
  // damit Erzähltext-Anteile (inkl. Verb) korrekt narrativ bleiben.
  _pushMatches(_SPEECH_COLON_RE, text, ranges, 1);
  // Em-Dash-Zeilenanfang: nur der Inhalt nach dem Dash (ohne führendes \n/Whitespace).
  _pushMatches(_EM_DASH_LINE_RE, text, ranges, 1);
  // Sortieren + mergen (Overlaps): bei unterschiedlichen Marker-Typen kann es Überschneidungen geben.
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

function _inRange(pos, ranges) {
  // Binärsuche — ranges ist sortiert und nicht-überlappend.
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid];
    if (pos < a) hi = mid - 1;
    else if (pos >= b) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Berechnet Pronomen-Counts (getrennt narr/dlg) + Dialog-Zeichen.
 *  `language` ('de' | 'en') wählt die Wortformen der Pronomen-Gruppen. */
function computePronounsAndDialog(text, extraRanges = [], language = 'de') {
  const { pronounGroups, wordToGroup } = styleProfile(language);
  const dialogRanges = _findDialogRanges(text, extraRanges);
  const dialogChars = dialogRanges.reduce((s, [a, b]) => s + (b - a), 0);

  const counts = {};
  for (const grp of Object.keys(pronounGroups)) {
    counts[grp] = { narr: 0, dlg: 0 };
  }

  _WORD_RE.lastIndex = 0;
  let m;
  while ((m = _WORD_RE.exec(text)) !== null) {
    const word = m[1].toLowerCase();
    const grp = wordToGroup.get(word);
    if (!grp) continue;
    const bucket = _inRange(m.index, dialogRanges) ? 'dlg' : 'narr';
    counts[grp][bucket]++;
  }
  return { pronoun_counts: counts, dialog_chars: dialogChars };
}

// ── Stil-Statistiken (deterministisch, kein KI-Call) ──────────────────────────

// Füllwörter, Adverbien, Passiv, Silben + Flesch-Formel: je Buchsprache in lib/style-lang.js.

// Häufige Stoppwörter DE – werden bei Wiederholungs-Analyse ignoriert.
// Liste lebt in lib/stopwords-de.js (SSoT, Spiegel public/js/shared/stopwords-de.js);
// englische Bücher (`opts.language = 'en'`) nehmen lib/stopwords-en.js.
const STOPWORDS_DE = new Set(STOPWORDS_DE_BASE);
const STOPWORDS_EN = new Set(STOPWORDS_EN_BASE);

function _sentenceAt(pos, ranges) {
  // Lineare Suche reicht — in der Praxis <1000 Sätze pro Seite.
  for (const r of ranges) {
    if (pos >= r[0] && pos < r[1]) return r;
  }
  return null;
}

function _makeSample(text, pos, token, ranges) {
  const r = _sentenceAt(pos, ranges);
  if (!r) return null;
  let sentence = text.slice(r[0], r[1]).trim().replace(/\s+/g, ' ');
  if (sentence.length > SAMPLE_MAX_CHARS) sentence = sentence.slice(0, SAMPLE_MAX_CHARS - 1) + '…';
  return { token, sentence };
}

/** Satzanfänge einer Seite: Häufigkeit des ersten Wortes je Satz (kleingeschrieben)
 *  plus die Zahl der direkt aufeinanderfolgenden Sätze mit demselben Anfang.
 *
 *  `repeats` ist die eigentliche Stilaussage: „84× ‚Er…'" über ein ganzes Buch ist
 *  bei einem Er-Erzähler unauffällig, „‚Er…' viermal hintereinander" ist der
 *  Befund, den man beim Schreiben nicht sieht. Die Zahl zählt Nachbarpaare, eine
 *  Kette aus vier gleichen Anfängen liefert also 3.
 *
 *  Nachbarschaft über Seitengrenzen hinweg wird bewusst nicht betrachtet — der
 *  Index ist pro Seite, und der Effekt liegt im Promillebereich. */
function _computeOpeners(sentenceWords) {
  const counts = Object.create(null);
  let repeats = 0;
  let prev = null;
  for (const words of sentenceWords) {
    const opener = styleWordKey(words[0]);
    counts[opener] = (counts[opener] || 0) + 1;
    if (prev !== null && prev === opener) repeats++;
    prev = opener;
  }
  return { counts, repeats };
}

/** Berechnet deterministische Stil-Statistiken für eine Seite.
 *  Metriken sind absolute Zählungen + LIX/Flesch (Lesbarkeitsindizes).
 *  `language` ('de' | 'en') wählt die Stoppwortliste der Wiederholungs-Metrik und
 *  das Sprachprofil (lib/style-lang.js) für Füllwörter, Adverbien, Passiv und Flesch.
 *  `extraStopwords` (Set<string>, lowercase) wird zusätzlich zu ihr
 *  aus der Wiederholungs-Metrik ausgeschlossen — gedacht für Eigennamen
 *  (Figuren, Schauplätze, Szenen-Titel), die sonst die Top-Liste dominieren. */
function computeStyleStats(text, opts = {}) {
  const extraStopwords = opts.extraStopwords instanceof Set ? opts.extraStopwords : null;
  const repStopwords = opts.language === 'en' ? STOPWORDS_EN : STOPWORDS_DE;
  const lang = styleProfile(opts.language);
  if (!text || !text.trim()) {
    return {
      filler_count: 0, passive_count: 0, adverb_count: 0,
      sentences: 0, sentence_words: 0,
      avg_sentence_len: null, sentence_len_p90: null,
      repetition_data: JSON.stringify({ top: [], score: 0, words: 0 }),
      lix: null, flesch_de: null,
      style_samples: JSON.stringify({ filler: [], passive: [], adverb: [] }),
      sentence_lens: JSON.stringify([]),
      opener_counts: JSON.stringify({ counts: {}, repeats: 0 }),
    };
  }

  const sentRanges = _sentenceRanges(text);
  const fillerSamples = [];
  const passiveSamples = [];
  const adverbSamples = [];

  // Sätze aufteilen und Wörter pro Satz ermitteln (für Histogramm & avg/p90).
  // `sentenceWords` hält die Wortlisten, damit Länge und Satzanfang aus
  // derselben Zerlegung stammen — sonst zählen Band und Heatmap verschiedene
  // Satzmengen und die Summen widersprechen sich. Auch `sentences` (page_stats)
  // kommt von hier.
  const sentenceWords = sentRanges
    .map(([a, b]) => text.slice(a, b).match(_STYLE_WORD_RE) || [])
    .filter(w => w.length > 0);
  const sentenceLens = sentenceWords.map(w => w.length);
  const { counts: openerCounts, repeats: openerRepeats } = _computeOpeners(sentenceWords);
  const sortedLens = [...sentenceLens].sort((a, b) => a - b);
  const totalWords = sentenceLens.reduce((a, b) => a + b, 0);
  const totalSentences = sentenceLens.length;
  const avgSentenceLen = totalSentences > 0 ? Math.round((totalWords / totalSentences) * 10) / 10 : null;
  const p90 = percentileSorted(sortedLens, 0.9);

  // Einzel-Wort-Scan: Füllwörter, Adverbien, Silbenzählung für Flesch, Wiederholungs-Fenster.
  let fillerCount = 0;
  let adverbCount = 0;
  let syllableTotal = 0;
  let longWordCount = 0;
  const lowerWords = [];

  _STYLE_WORD_RE.lastIndex = 0;
  let m;
  while ((m = _STYLE_WORD_RE.exec(text)) !== null) {
    const raw = m[0];
    const w = styleWordKey(raw);
    lowerWords.push(w);
    if (lang.fillerWords.has(w)) {
      fillerCount++;
      if (fillerSamples.length < MAX_SAMPLES_PER_METRIC) {
        const s = _makeSample(text, m.index, raw, sentRanges);
        if (s) fillerSamples.push(s);
      }
    }
    if (lang.isAdverb(w)) {
      adverbCount++;
      if (adverbSamples.length < MAX_SAMPLES_PER_METRIC) {
        const s = _makeSample(text, m.index, raw, sentRanges);
        if (s) adverbSamples.push(s);
      }
    }
    syllableTotal += lang.countSyllables(w);
    if (styleWordLength(raw) > 6) longWordCount++;
  }

  const wordCountScan = lowerWords.length;

  // Passiv-Zählung (DE: werden-Formen, EN: be/get + Partizip).
  const passives = lang.findPassives(text);
  const passiveCount = passives.length;
  for (const pm of passives) {
    if (passiveSamples.length >= MAX_SAMPLES_PER_METRIC) break;
    const s = _makeSample(text, pm.index, pm.token, sentRanges);
    if (s) passiveSamples.push(s);
  }

  // Wiederholungs-Analyse: Top-Wörter ausserhalb Stoppwort-Liste, Mindestlänge 4.
  // Score = (Summe der Counts der Top-10 Wörter) / wordCount * 1000 → Dichte pro 1000 Wörter.
  const repCounts = new Map();
  for (const w of lowerWords) {
    if (w.length < 4) continue;
    if (repStopwords.has(w)) continue;
    if (extraStopwords && extraStopwords.has(w)) continue;
    repCounts.set(w, (repCounts.get(w) || 0) + 1);
  }
  const topRepetitions = [...repCounts.entries()]
    .filter(([, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word, count]) => ({ word, count }));
  const repScore = wordCountScan > 0
    ? Math.round((topRepetitions.reduce((s, r) => s + r.count, 0) / wordCountScan) * 1000 * 10) / 10
    : 0;

  // LIX = A/B + (C·100)/A mit A=Wörter, B=Sätze, C=lange Wörter (>6 Zeichen).
  const lix = (totalWords > 0 && totalSentences > 0)
    ? Math.round(((totalWords / totalSentences) + (longWordCount * 100) / totalWords) * 10) / 10
    : null;

  // Flesch der Buchsprache (DE: Amstad, EN: Reading Ease), ASL = Wörter/Sätze,
  // ASW = Silben/Wörter. Höher = leichter. Spalte heisst historisch `flesch_de`.
  const flesch = (wordCountScan > 0 && totalSentences > 0)
    ? Math.round(lang.flesch(wordCountScan / totalSentences, syllableTotal / wordCountScan) * 10) / 10
    : null;

  return {
    sentences: totalSentences,
    sentence_words: totalWords, // nicht persistiert: Σ Wörter / Σ Sätze im Buch (syncBook)
    filler_count: fillerCount,
    passive_count: passiveCount,
    adverb_count: adverbCount,
    avg_sentence_len: avgSentenceLen,
    sentence_len_p90: p90,
    // `words`: Wörter des Prosatexts, auf dem auch Füllwörter, Adverbien und Passiv
    // gezählt sind — der Nenner jeder Dichte pro 1000 Wörter (lib/stil-heatmap.js,
    // lib/author-profile.js). `page_stats.words` zählt dagegen Verlauf und
    // Tabellen mit und verdünnte die Dichten.
    repetition_data: JSON.stringify({ top: topRepetitions, score: repScore, words: wordCountScan }),
    lix,
    flesch_de: flesch,
    style_samples: JSON.stringify({
      filler: fillerSamples,
      passive: passiveSamples,
      adverb: adverbSamples,
    }),
    sentence_lens: JSON.stringify(sentenceLens.slice(0, MAX_SENTENCE_LENS)),
    opener_counts: JSON.stringify({ counts: openerCounts, repeats: openerRepeats }),
  };
}

/** SHA1 über den reinen Textinhalt — identifiziert inhaltliche Änderungen
 *  unabhängig von `updated_at` (das auch bei Metadaten-Updates flippt). */
function computeContentSig(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

/** UPSERT-Felder für page_stats (ohne Figuren-Mentions). `opts`: language + extraStopwords → computeStyleStats,
 *  msgRanges = Nachrichten als Dialog, proseText = Text ohne Verlauf für die Satzmetriken. */
function computePageIndex(text, opts = {}) {
  const { pronoun_counts, dialog_chars } = computePronounsAndDialog(text, opts.msgRanges || [], opts.language);
  const prose = opts.proseText ?? text;
  const style = computeStyleStats(prose, opts);
  return {
    pronoun_counts: JSON.stringify(pronoun_counts),
    dialog_chars,
    content_sig: computeContentSig(text),
    metrics_version: METRICS_VERSION,
    ...style,
  };
}

// ── Figuren-Matching ─────────────────────────────────────────────────────────

// Namensmuster einer Figur (Name, Kurzname, Tokens, weitere Rufnamen):
// lib/figure-name-patterns.js — geteilt mit Alters-Analyse, Idiolekt und den Vorschlags-Jobs.
const { FIGURE_TOKEN_BLOCKLIST, escapeRegex: _escapeRegex, buildFigureNamePatterns: _buildNamePatterns } = require('./figure-name-patterns');

/** Zählt Erwähnungen aller Figuren in `text`.
 *  figures: [{ id (DB-PK), name, kurzname }]
 *  Rückgabe: [{ figure_id, count, first_offset }] — nur Figuren mit count > 0. */
function computeFigureMentions(text, figures) {
  const results = [];
  for (const fig of figures) {
    const patterns = _buildNamePatterns(fig.name, fig.kurzname, fig.weitere_namen);
    if (!patterns.length) continue;
    let total = 0;
    let firstOffset = null;
    for (const { text: p, weight } of patterns) {
      // Lookbehind/Lookahead gegen Wortgrenzen (umlaut-sicher).
      // 'i'-Flag — Namen matchen auch bei abweichender Gross-/Kleinschreibung.
      const re = new RegExp(
        `(?<![A-Za-zÄÖÜäöüß])${_escapeRegex(p)}(?![A-Za-zÄÖÜäöüß])`,
        'gi'
      );
      let m;
      while ((m = re.exec(text)) !== null) {
        total += weight;
        if (firstOffset === null || m.index < firstOffset) firstOffset = m.index;
      }
    }
    const count = Math.round(total);
    if (count > 0) {
      results.push({ figure_id: fig.id, count, first_offset: firstOffset });
    }
  }
  return results;
}

// ── DB-Writer ─────────────────────────────────────────────────────────────────

const _upsertPageIndex = db.prepare(`
  UPDATE page_stats
     SET sentences = @sentences,
         dialog_chars = @dialog_chars,
         pronoun_counts = @pronoun_counts,
         content_sig = @content_sig,
         metrics_version = @metrics_version,
         filler_count = @filler_count,
         passive_count = @passive_count,
         adverb_count = @adverb_count,
         avg_sentence_len = @avg_sentence_len,
         sentence_len_p90 = @sentence_len_p90,
         repetition_data = @repetition_data,
         lix = @lix,
         flesch_de = @flesch_de,
         style_samples = @style_samples,
         sentence_lens = @sentence_lens,
         opener_counts = @opener_counts
   WHERE page_id = @page_id
`);

/** Schreibt das Index-Resultat in page_stats. Setzt voraus, dass
 *  der page_stats-Row bereits via upsertPageStats existiert. */
function writePageIndex(pageId, index) {
  _upsertPageIndex.run({ page_id: pageId, ...index });
}

const _delMentionsForPage = db.prepare('DELETE FROM page_figure_mentions WHERE page_id = ?');
const _insMention = db.prepare(
  'INSERT INTO page_figure_mentions (page_id, figure_id, count, first_offset) VALUES (?, ?, ?, ?)'
);

/** Berechnet Figuren-Mentions für alle Seiten eines Buchs neu und schreibt sie.
 *  Wird nach Komplettanalyse (saveFigurenToDb) aufgerufen, damit die Mentions
 *  mit dem aktuellen Figuren-Bestand übereinstimmen.
 *  Liest Seitentexte aus pages.preview_text (gecacht, ~800 Zeichen) —
 *  approximativ. Der nächste syncBook-Lauf verfeinert die Mentions mit Volltext. */
function recomputeBookFigureMentions(bookId, userEmail) {
  const figures = db.prepare(
    'SELECT id, name, kurzname, weitere_namen FROM figures WHERE book_id = ? AND user_email IS ?'
  ).all(bookId, userEmail || null);
  if (!figures.length) {
    return { figures: 0, pagesProcessed: 0 };
  }
  const pages = db.prepare(
    'SELECT page_id, preview_text FROM pages WHERE book_id = ? AND preview_text IS NOT NULL'
  ).all(bookId);
  let processed = 0;
  db.transaction(() => {
    for (const p of pages) {
      const mentions = computeFigureMentions(p.preview_text, figures);
      _delMentionsForPage.run(p.page_id);
      for (const m of mentions) _insMention.run(p.page_id, m.figure_id, m.count, m.first_offset);
      processed++;
    }
  })();
  return { figures: figures.length, pagesProcessed: processed };
}

const _selectBookFigures = db.prepare('SELECT id, name, kurzname, weitere_namen FROM figures WHERE book_id = ?');

/** Lädt die Figuren-Liste eines Buchs (über alle User) für die Mention-Berechnung.
 *  Einmal pro Sync-Buch laden und in writeFigureMentionsForPageAllUsers durchreichen,
 *  statt die identische Query pro Seite zu wiederholen. */
function loadBookFiguresForMentions(bookId) {
  return _selectBookFigures.all(bookId);
}

/** Berechnet Figuren-Mentions für eine Seite über alle User, die Figuren für das Buch haben.
 *  Wird von syncBook() mit dem Volltext aufgerufen (präziser als Preview-Text).
 *  Atomic pro Seite: löscht vorhandene Mentions aller User und schreibt neu.
 *  `figures` optional vorgeladen (loadBookFiguresForMentions) durchreichen, um die
 *  Figuren-Query nicht pro Seite zu wiederholen; ohne Param Fallback auf eigene Query.
 *  Gibt Anzahl geschriebener Mentions zurück. */
function writeFigureMentionsForPageAllUsers(pageId, bookId, fullText, figures = null) {
  const figs = figures || loadBookFiguresForMentions(bookId);
  if (!figs.length) return 0;
  const mentions = computeFigureMentions(fullText, figs);
  db.transaction(() => {
    _delMentionsForPage.run(pageId);
    for (const m of mentions) _insMention.run(pageId, m.figure_id, m.count, m.first_offset);
  })();
  return mentions.length;
}

/** Zerlegt mehrteilige Eigennamen (z.B. "Anna Müller", "Sankt-Gallen", "Hotel am See")
 *  in lowercased Einzel-Tokens, die als Extra-Stoppwörter für die Wiederholungs-
 *  Metrik taugen. Tokens < 4 Zeichen oder in FIGURE_TOKEN_BLOCKLIST werden
 *  weggelassen. Gedacht für figures.name/kurzname, locations.name, figure_scenes.titel. */
function tokenizeNamesForStopwords(names) {
  const set = new Set();
  for (const n of names) {
    if (!n) continue;
    for (const tok of String(n).split(/[\s\-–—/,.:;()'"«»„"]+/)) {
      const w = tok.toLowerCase();
      if (w.length < 4) continue;
      if (FIGURE_TOKEN_BLOCKLIST.has(w)) continue;
      if (STOPWORDS_DE.has(w)) continue;
      set.add(w);
    }
  }
  return set;
}

module.exports = {
  METRICS_VERSION,
  // SSoT „was zaehlt als Erwaehnung dieser Figur" — auch fuer lib/figure-age/scan.js.
  buildFigureNamePatterns: _buildNamePatterns,
  PRONOUN_GROUPS,
  computePageIndex,
  computePronounsAndDialog,
  findDialogRanges: _findDialogRanges,
  computeContentSig,
  computeStyleStats,
  computeFigureMentions,
  tokenizeNamesForStopwords,
  writePageIndex,
  
  writeFigureMentionsForPageAllUsers,
  loadBookFiguresForMentions,
  recomputeBookFigureMentions,
};
