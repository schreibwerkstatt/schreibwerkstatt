'use strict';
// Wortschatz-Analyse (quantitative Stilistik pro Buch). Liest den Buchtext in
// Leserichtung, rechnet die längenrobusten Diversitätsmasse, die Lieblingswort-
// und die Wendungs-Rangliste und legt alles als abgeleiteten Index ab
// (book_lexicon / lexicon_terms / lexicon_ngrams, Full-Replace pro Scan).
//
// KEIN callAI. Der Job steht trotzdem in der Job-Queue, weil er Minuten laufen
// kann und abbrechbar sein muss — dasselbe Muster wie motif-scan und beat-anchor.
// Rein rückwärtsgewandt: schreibt nie in den Buchtext.
//
// Warum überhaupt ein buchweiter Pass und nicht ein Aggregat über `page_stats`:
// MATTR, MTLD und Heaps β sind Fenster- bzw. Präfix-Masse über die Token-Sequenz.
// Ein 1000-Token-Fenster liegt regelmässig quer über eine Seitengrenze; aus
// Pro-Seiten-Zahlen ist keines davon rekonstruierbar.

const express = require('express');
const crypto = require('crypto');
const {
  makeJobLogger, updateJob, completeJob, failJob,
  createJob, enqueueJob, findActiveJobId, jsonBody, jobAbortControllers,
  startBookJob,
} = require('./shared');
const contentStore = require('../../lib/content-store');
const lexiconDb = require('../../db/lexicon');
const { analyzeBook, buildNameStopwords, LEXICON_VERSION, MATTR_WINDOW } = require('../../lib/lexicon');
const {
  tokenizeNamesForStopwords, findDialogRanges, buildFigureNamePatterns,
} = require('../../lib/page-index');
const { localIsoDate } = require('../../lib/local-date');
const { db } = require('../../db/schema');
const logger = require('../../logger');

const lexiconScanRouter = express.Router();

// Gespeicherte Referenz-Frequenztabelle (`book_lexicon.freq_json`). Nur für die
// Keyness ANDERER Bücher — nicht für die Anzeige.
//
// Gekappt wird über eine MINDESTHÄUFIGKEIT, nicht über einen Rang. Der Unterschied
// ist nicht kosmetisch: bei einem Rangdeckel liegt die Kappungsgrenze irgendwo im
// zweistelligen Bereich, und ein Wort, das die Referenz deshalb nicht kennt, sieht
// aus wie ein Wort, das es dort nie gibt. Solange die Keyness nur eine Spalte war,
// blieb das eine dokumentierte Ungenauigkeit; seit sie über die AUSWAHL der Wortliste
// mitentscheidet, wäre es ein systematischer Fehler — die Auswahl würde bevorzugt
// Terme greifen, deren Wert allein aus der Kappung stammt.
// Bei 3 ist der verbleibende Fehler auf zwei Vorkommen begrenzt. Der Rangdeckel
// bleibt als Notbremse gegen ein absurd langes Buch stehen; greift er, steigt die
// Kappungsgrenze wieder — `loadReferenceCorpus` liest sie pro Buch aus der Tabelle
// selbst (`upper`) und die Auswahl wird von allein vorsichtiger.
const REF_MIN_COUNT = 3;
const REF_TERM_LIMIT = 40000;

// Nach jedem Yield-Punkt prüfen, ob der User abgebrochen hat.
function _checkAbort(signal) {
  if (signal?.aborted) {
    const e = new Error('Abgebrochen');
    e.name = 'AbortError';
    throw e;
  }
}

// Text-Signatur des Buchstands: Seiten-IDs + ihre `updated_at` in Leserichtung,
// plus die Analyse-Version. Die Reihenfolge gehört mit hinein — eine Umsortierung
// der Kapitel verschiebt die MATTR-Fenster. Sie geht in die Referenz-Fingerabdrücke
// der ANDEREN Bücher ein (siehe computeInputSig).
function computeContentSig(orderedPages) {
  const h = crypto.createHash('sha1');
  h.update(`v${LEXICON_VERSION}`);
  for (const p of orderedPages) h.update(`|${p.page_id}:${p.updated_at || ''}`);
  return h.digest('hex');
}

// Eingangs-Signatur: ALLES, wovon das Ergebnis abhängt. Neben dem Text sind das
// die Namensliste (eine neue Figur muss aus den Lieblingswörtern verschwinden, auch
// wenn keine Seite geändert wurde) und der Stand der Referenzbücher (Keyness,
// auffällige Wörter, Einmalwort-Reihenfolge). Ohne die Referenz bliebe ein Buch,
// das in einer frischen Installation vor allen anderen gescannt wurde, für immer
// ohne Keyness — jede folgende Nacht hätte es als „unverändert" übersprungen.
function computeInputSig(contentSig, nameWords, figureNames, refFingerprint) {
  const h = crypto.createHash('sha1');
  h.update(contentSig);
  h.update('|names:' + [...nameWords].sort().join(','));
  h.update('|figs:' + [...figureNames].sort().join(','));
  h.update('|ref:' + refFingerprint);
  return h.digest('hex');
}

// Figuren-, Orts- und Szenennamen als Zusatz-Stoppwörter. Ohne sie führt die Figur,
// die auf jeder Seite vorkommt, die Lieblingswort-Liste an — kein Stilbefund.
// Gleiche Zerlegung wie routes/sync.js, danach dieselbe Normalisierung wie der
// Buchtext plus Genitivformen (lib/lexicon/names.js).
function _loadNames(bookId) {
  const figures = db.prepare('SELECT id, name, kurzname FROM figures WHERE book_id = ? AND COALESCE(stale, 0) = 0').all(bookId);
  const names = [
    ...figures.flatMap(r => [r.name, r.kurzname]),
    ...db.prepare('SELECT name FROM locations WHERE book_id = ?').all(bookId).map(r => r.name),
    ...db.prepare('SELECT titel FROM figure_scenes WHERE book_id = ?').all(bookId).map(r => r.titel),
  ];
  return { figures, stopwords: buildNameStopwords(names, tokenizeNamesForStopwords(names)) };
}

// Referenztabelle dieses Buchs: alle Terme ab der Mindesthäufigkeit, absteigend
// sortiert (damit ein greifender Notbremsen-Deckel die seltensten trifft).
function _buildFreqJson(freq) {
  const rows = [...freq.entries()]
    .filter(([, count]) => count >= REF_MIN_COUNT)
    .sort((a, b) => b[1] - a[1])
    .slice(0, REF_TERM_LIMIT);
  const obj = {};
  for (const [term, count] of rows) obj[term] = count;
  return JSON.stringify(obj);
}

async function runLexiconScanJob(jobId, bookId, userEmail, opts = {}) {
  const log = makeJobLogger('lexicon-scan', userEmail, bookId, jobId);
  const signal = jobAbortControllers.get(jobId)?.signal;
  const ctx = { userEmail };
  try {
    updateJob(jobId, { statusText: 'job.phase.lexiconPages' });
    const tree = await contentStore.bookTree(bookId, ctx);
    const flat = contentStore.flattenTree(tree);
    if (!flat.length) {
      // Kein Text → alte Analyse räumen und ehrlich leer melden, statt die
      // Zahlen des letzten Stands stehen zu lassen.
      lexiconDb.replaceBookLexicon(bookId, {
        stats: { version: LEXICON_VERSION, pages: 0, segments: 0, tokens: 0, types: 0, hapax: 0, hapax_listed: 0 },
        terms: [], phrases: [],
      });
      completeJob(jobId, { tokens: 0, types: 0, terms: 0, phrases: 0, skipped: false }, null, '0 Seiten');
      return;
    }

    const metas = flat.map(f => ({ id: f.page.id, chapterId: f.chapterId, updated_at: f.page.updated_at }));
    const sig = computeContentSig(metas.map(m => ({ page_id: m.id, updated_at: m.updated_at })));
    const names = _loadNames(bookId);
    const inputSig = computeInputSig(
      sig, names.stopwords, names.figures.map(f => `${f.id}:${f.name}:${f.kurzname || ''}`),
      lexiconDb.referenceFingerprint(bookId, LEXICON_VERSION),
    );
    const prev = lexiconDb.getLexiconSignature(bookId);
    if (!opts.force && prev && prev.input_sig === inputSig && prev.lexicon_version === LEXICON_VERSION) {
      log.info(`Wortschatz-Scan übersprungen (unverändert, sig ${inputSig.slice(0, 8)}).`);
      completeJob(jobId, { skipped: true }, null, 'unverändert');
      return;
    }

    updateJob(jobId, { statusText: 'job.phase.lexiconLoad', statusParams: { count: metas.length } });
    const loaded = await contentStore.loadPagesBatch(metas.map(m => ({ id: m.id })), ctx, {
      onError: (p, e) => { log.warn(`Seite ${p.id} nicht ladbar: ${e.message}`); return null; },
    });
    _checkAbort(signal);

    const chapterById = new Map(metas.map(m => [m.id, m.chapterId]));
    const pages = [];
    for (const pd of loaded) {
      if (!pd) continue;
      pages.push({ page_id: pd.id, chapter_id: chapterById.get(pd.id) ?? null, html: pd.html || '' });
    }

    updateJob(jobId, { statusText: 'job.phase.lexiconMeasure' });
    const reference = lexiconDb.loadReferenceCorpus(bookId, LEXICON_VERSION);
    const result = await analyzeBook(pages, {
      nameStopwords: names.stopwords,
      reference,
      idiolect: {
        figures: names.figures,
        deps: { findDialogRanges, buildFigureNamePatterns },
      },
      onYield: async () => {
        _checkAbort(signal);
        await new Promise(r => setImmediate(r));
      },
    });
    _checkAbort(signal);

    result.stats.content_sig = sig;
    result.stats.input_sig = inputSig;
    result.stats.freq_json = _buildFreqJson(result.freq);
    lexiconDb.replaceBookLexicon(bookId, result);
    // Tageszeile des Verlaufs auf den frischen Stand ziehen (nur wenn der Sync sie
    // heute schon geschrieben hat — siehe db/lexicon.js#stampLexiconHistory).
    lexiconDb.stampLexiconHistory(bookId, localIsoDate(), MATTR_WINDOW);

    const s = result.stats;
    const byKind = { freq: 0, key: 0, hapax: 0 };
    for (const t of result.terms) byKind[t.kind || 'freq']++;
    log.info(`Wortschatz: ${s.tokens} Token, ${s.types} Types, MATTR ${s.mattr} (Fenster ${s.mattr_window}), `
      + `MTLD ${s.mtld}, Yule K ${s.yule_k}, β ${s.heaps_beta}, Dichte ${s.lex_density}, `
      + `${byKind.freq} Terme + ${byKind.key} auffällige + ${byKind.hapax}/${s.hapax_listed} Einmalwörter, `
      + `${result.phrases.length} Wendungen, ${result.chapters.length} Kapitel, `
      + `Idiolekt ${result.idiolect.length} Figur(en) (Abdeckung ${s.idiolect_coverage})`
      + (reference
        ? `, Referenz aus ${reference.books} Buch/Büchern (Fehl-Schranke ${reference.absentBound})`
        : ', ohne Referenzkorpus'));

    completeJob(jobId, {
      skipped: false,
      tokens: s.tokens, types: s.types,
      terms: byKind.freq + byKind.key, hapax: byKind.hapax, phrases: result.phrases.length,
      hasReference: !!reference,
    }, null, `${s.types} Wortformen, ${result.phrases.length} Wendungen`);
  } catch (e) {
    if (e.name !== 'AbortError') log.error(`Wortschatz-Scan Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// Nacht-Cron: hält die Analyse aller Bücher frisch. Buch-skopiert (nicht pro User —
// der Wortschatz ist eine Eigenschaft des Textes), der Job läuft unter dem Besitzer.
// Der Delta-Skip macht den Lauf für unveränderte Bücher praktisch kostenlos.
async function scanAllBooks() {
  const { getOwnerEmail } = require('../../db/book-access');
  let enqueued = 0, skipped = 0;
  for (const bookId of lexiconDb.listScanScopes()) {
    const owner = getOwnerEmail(bookId) || 'system';
    if (findActiveJobId('lexicon-scan', bookId, owner)) { skipped++; continue; }
    const jobId = createJob('lexicon-scan', bookId, owner, 'job.label.lexiconScan', null, bookId);
    enqueueJob(jobId, () => runLexiconScanJob(jobId, bookId, owner));
    enqueued++;
  }
  logger.info(`Wortschatz-Scan (Cron): ${enqueued} Buch/Bücher eingereiht, ${skipped} übersprungen (läuft bereits).`);
  return { enqueued, skipped };
}

lexiconScanRouter.post('/lexicon-scan', jsonBody, (req, res) => startBookJob(req, res, {
  type: 'lexicon-scan', minRole: 'lektor', label: 'job.label.lexiconScan',
  // Manuell ausgelöst heisst: der Autor will jetzt eine Zahl sehen — Delta-Skip
  // wird übersprungen, sonst quittiert der Knopf mit „unverändert" und nichts passiert.
  run: (jobId, { bookId, userEmail }) => runLexiconScanJob(jobId, bookId, userEmail, { force: true }),
}));

module.exports = {
  lexiconScanRouter, runLexiconScanJob, scanAllBooks,
  computeContentSig, computeInputSig,
};
