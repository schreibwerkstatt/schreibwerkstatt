'use strict';
// Alters-Analyse der Figuren (Job `figur-alter`): beantwortet „wie alt ist diese
// Figur im Buch" AUS DEM TEXT und legt das Ergebnis als abgeleiteten Index ab
// (figure_ages/figure_age_belege/figure_age_scans, Full-Replace pro Lauf).
//
// WARUM NEBEN DER KOMPLETTANALYSE: die extrahiert `geburtstag` und die datierten
// Ereignisse als Nebenprodukt eines teuren Gesamtlaufs. Wer danach weiterschreibt,
// hat ein Alter auf dem Stand von damals — und sieht das nicht. Dieser Job ist
// klein genug, um auf Knopfdruck zu laufen, und liest den heutigen Text.
//
// DREI SCHICHTEN, in dieser Reihenfolge (Begruendung: lib/figure-age/patterns.js):
//   1. deterministisch: Kandidatensaetze (Muster + Figurenname im Satzfenster)
//      plus semantische Nachlese (`semanticQuery`) fuer Figuren, bei denen die
//      Muster wenig finden — „wie alt ist X" ist genau die Frage, die ein
//      Embedding-Index besser trifft als eine Wortsuche.
//   2. das Modell: was behaupten diese Saetze (ein Call pro Figuren-Buendel).
//   3. deterministisch: Zitat im Text nachschlagen, Zahl gegen das Zitat pruefen,
//      Spanne bilden, Widerspruch melden (lib/figure-age/consolidate.js).
//
// SCHREIBT NIE IN `figures`: `geburtstag` gehoert dem Autor. Weicht der Textfund
// davon ab, ist das ein Befund und keine Korrektur.

const express = require('express');
const crypto = require('crypto');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError, jsonBody, jobAbortControllers,
  aiCall, getPrompts, getBookPrompts,
  loadOrderedBookContents, loadPageContents,
  chunkLimitsFor, tps, _modelName,
  startBookJob,
} = require('./shared');
const { resolveProvider } = require('../../lib/ai');
const { db } = require('../../db/connection');
const { getBookSettings } = require('../../db/book-settings');
const { replaceFigureAges, getFigureAgeScan } = require('../../db/figure-ages');
const { computeFigureYears, bookYearSpan } = require('../../lib/figure-years');
const { buildFigureNamePatterns } = require('../../lib/page-index');
const {
  AGE_ANALYSIS_VERSION, buildNameIndex, scanPage, selectCandidates, isStrong,
  numbersIn, consolidateFigure, foldWord, passageStellen, isPlausibleWert,
} = require('../../lib/figure-age');
const embed = require('../../lib/embed');
const { semanticQuery } = require('../../lib/semantic-retrieval');
const { bestLivePassage } = require('../../lib/live-passage');

// Deckel pro Figur. Mehr Stellen heisst nicht mehr Erkenntnis: das Alter einer
// Figur haengt an einer Handvoll Saetzen, und die Auswahl verteilt sich bewusst
// ueber den Buchbogen (selectCandidates), damit Anfang UND Ende drin sind.
const MAX_STELLEN_PRO_FIGUR = 10;
// Ab wie vielen harten Funden die semantische Nachlese entfaellt — sie kostet je
// Figur einen Embedding-Call.
const EMBED_IF_STRONG_BELOW = 2;
// Obergrenze der Embedding-Abfragen pro Lauf (kein stiller Cap: die Zahl geht
// als `embedSkipped` ins Ergebnis).
const MAX_EMBED_QUERIES = 60;
const EMBED_TOP_K = 6;
// Zeichenbudget eines Figuren-Buendels im Prompt. Unter dem Chunk-Limit des
// Providers, weil System-Prompt, Buch-Kontext und Antwort dazukommen.
const BUNDLE_SHARE = 0.5;
// Ein Zitat unter dieser Laenge ("zwölf") steht in fast jeder vorgelegten Stelle —
// die Zitat-Pruefung waere dann wirkungslos.
const MIN_ZITAT_CHARS = 8;

/** Vergleichsform fuer Zitat-Nachschlag und Namens-Zuordnung. */
function _norm(s) {
  return String(s ?? '').toLowerCase().replace(/[«»„“”‚‘’"'`´]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
}

/** Signatur des Laufs: Buchstand (Seiten + updated_at in Leserichtung), Figuren-
 *  stamm (Namen + kuratiertes Geburtsjahr) und die Analyse-Version. Aendert sich
 *  nichts davon, ist das Ergebnis dasselbe. Der Figurenstamm gehoert mit hinein —
 *  eine neu angelegte Figur veraendert das Ergebnis, ohne dass eine Seite
 *  angefasst wurde. */
function computeContentSig(pages, figuren, model) {
  const h = crypto.createHash('sha1');
  h.update(`v${AGE_ANALYSIS_VERSION}|${model || ''}`);
  for (const p of pages) h.update(`|p${p.id}:${p.updated_at || ''}`);
  for (const f of figuren) h.update(`|f${f.id}:${f.name}:${f.kurzname || ''}:${f.geburtstag || ''}`);
  return h.digest('hex');
}

// Ausschnitt aus dem Live-Text um einen Index-Treffer (Chunk ~1500 Zeichen).
const LIVE_PASSAGE_MAX = 2000;

/** Kandidatenstellen aus dem Embedding-Index. Eine Passage (Chunk, bis ~1500
 *  Zeichen) wird auf den Satz MIT der Angabe zugeschnitten (`passageStellen`) —
 *  der Passagen-Anfang enthielte die Zahl meist nicht, und die Zitat-Pruefung
 *  verwuerfe dann ein korrektes Zitat. Treffer ohne Alters-/Jahressignal oder ohne
 *  Nennung der Figur fallen weg. Non-fatal: ohne Index laeuft der Job weiter
 *  (dann eben nur mit den Musterfunden); ein Abbruch wird durchgereicht.
 *
 *  Der Chunk ist nur Wegweiser: geschnitten wird aus dem AKTUELLEN Seitentext
 *  (`pageText`, derselbe Stand wie die Musterfunde), denn die Zitat-Pruefung
 *  laeuft gegen `satz` — ein Satz aus einem veralteten Chunk belegte ein Alter,
 *  das so nicht mehr im Buch steht. Ist die Stelle umgeschrieben, faellt der
 *  Treffer weg. */
async function _semanticStellen(bookId, fig, pageMeta, nameIndex, signal, pageText = new Map()) {
  const query = [fig.name, fig.kurzname].filter(Boolean).join(' ')
    + ' Alter Jahre alt geboren Geburtsjahr Geburtstag wie alt';
  const hits = await semanticQuery(bookId, query, { kinds: ['page'], topK: EMBED_TOP_K, signal });
  const out = [];
  for (const h of hits) {
    if (h.kind !== 'page') continue;
    const pageId = parseInt(h.entity_id, 10);
    const meta = pageMeta.get(pageId) || {};
    const live = bestLivePassage(pageText.get(pageId) || '', h.text || '', { maxChars: LIVE_PASSAGE_MAX });
    if (!live) continue;
    for (const st of passageStellen(live.text, nameIndex, fig.id)) {
      out.push({
        figure_id: fig.id,
        satz: st.satz,
        signale: st.signale,
        page_id: Number.isFinite(pageId) ? pageId : null,
        page_name: meta.page_name ?? null,
        chapter: meta.chapter ?? null,
        chapter_id: meta.chapter_id ?? null,
        ordinal: meta.ordinal ?? 0,
        offset: 0,
        indirekt: st.indirekt,
        semantisch: true,
      });
    }
  }
  return out;
}

async function runFigurAlterJob(jobId, bookId, userEmail, { force = false } = {}) {
  const logger = makeJobLogger(jobId);
  const { buildFigurAlterSystemPrompt, buildFigurAlterPrompt, SCHEMA_FIGUR_ALTER } = await getPrompts(userEmail);
  const effectiveProvider = resolveProvider({ userEmail });
  const { perChunk: PER_CHUNK_LIMIT } = chunkLimitsFor(effectiveProvider);
  const model = _modelName(effectiveProvider);

  try {
    const signal = () => jobAbortControllers.get(jobId)?.signal;
    // Abbruch WIRFT, statt eine Schleife zu verlassen: der Lauf endet sonst regulaer,
    // ersetzt den Index (Full-Replace) mit den bis dahin gesammelten Teilfunden und
    // meldet `done` — der vorige Stand waere weg und der Teilstand als aktuell markiert.
    const throwIfAborted = () => {
      if (signal()?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    };

    updateJob(jobId, { statusText: 'job.phase.figurAlterCollect', progress: 4 });

    const figuren = db.prepare(`
      SELECT id, fig_id, name, kurzname, typ, geburtstag
      FROM figures
      WHERE book_id = ? AND user_email = ? AND stale = 0
      ORDER BY sort_order, id
    `).all(bookId, userEmail || '');
    if (!figuren.length) throw i18nError('job.error.figurAlterNoFiguren');

    const { chMap, pages } = await loadOrderedBookContents(bookId);
    const pageContents = await loadPageContents(pages, chMap, 1, null, signal());
    if (!pageContents.some(p => p.text)) throw i18nError('job.error.figurAlterNoText');

    // Delta-Skip: derselbe Buchstand + derselbe Figurenstamm ergeben dasselbe
    // Ergebnis. Der Knopf in der Karte setzt `force` — manuell ausgeloest heisst
    // „ich will jetzt eine Zahl sehen" (gleiche Haltung wie beim Wortschatz-Scan).
    const sig = computeContentSig(pageContents, figuren, model);
    const prev = getFigureAgeScan(bookId, userEmail);
    if (!force && prev && prev.content_sig === sig && prev.age_version === AGE_ANALYSIS_VERSION) {
      logger.info(`Alters-Analyse uebersprungen (unveraendert): book=${bookId} sig=${sig.slice(0, 8)}`);
      completeJob(jobId, { skipped: true, scannedAt: prev.scanned_at, figuren: prev.figuren_total, mitAlter: prev.mit_alter }, null, 'unverändert');
      return;
    }

    // ── Schicht 1: Kandidatensaetze ──────────────────────────────────────────
    const patterns = figuren.map(f => ({ id: f.id, patterns: buildFigureNamePatterns(f.name, f.kurzname) }));
    const nameIndex = buildNameIndex(patterns);
    if (!nameIndex) throw i18nError('job.error.figurAlterNoFiguren');

    const pageMeta = new Map();
    const pageText = new Map();
    const byFigur = new Map(figuren.map(f => [f.id, []]));
    for (let i = 0; i < pageContents.length; i++) {
      throwIfAborted();
      const p = pageContents[i];
      pageText.set(p.id, p.text || '');
      pageMeta.set(p.id, { page_name: p.title || null, chapter: p.chapter || null, chapter_id: p.chapter_id ?? null, ordinal: i });
      for (const c of scanPage(p.text, nameIndex, {
        page_id: p.id, page_name: p.title || null, chapter: p.chapter || null,
        chapter_id: p.chapter_id ?? null, ordinal: i,
      })) {
        byFigur.get(c.figure_id)?.push(c);
      }
      if (i % 50 === 0) updateJob(jobId, { statusText: 'job.phase.figurAlterCollect', progress: 4 + Math.floor((i / pageContents.length) * 8) });
    }

    // ── Schicht 1b: semantische Nachlese ────────────────────────────────────
    let embedQueries = 0, embedSkipped = 0, embedUsed = false;
    if (embed.isEnabled()) {
      updateJob(jobId, { statusText: 'job.phase.figurAlterSemantic', progress: 13 });
      for (const f of figuren) {
        throwIfAborted();
        const have = (byFigur.get(f.id) || []).filter(isStrong).length;
        if (have >= EMBED_IF_STRONG_BELOW) continue;
        if (embedQueries >= MAX_EMBED_QUERIES) { embedSkipped++; continue; }
        embedQueries++;
        try {
          const found = await _semanticStellen(bookId, f, pageMeta, nameIndex, signal(), pageText);
          if (found.length) embedUsed = true;
          // Dieselbe Seite nicht zweimal — der Musterfund ist praeziser (Satz
          // statt Passage), also gewinnt er.
          const seenPages = new Set((byFigur.get(f.id) || []).map(c => c.page_id));
          for (const c of found) if (!seenPages.has(c.page_id)) byFigur.get(f.id)?.push(c);
        } catch (e) {
          // Nicht fatal: ohne Index bleiben die Musterfunde. Gleiche Haltung wie
          // beim Textbeleg-Kontext der Figuren-Werkstatt. Ein Abbruch ist kein
          // Index-Fehler und beendet den Lauf.
          if (e.name === 'AbortError' || signal()?.aborted) { throwIfAborted(); throw e; }
          logger.warn(`Semantische Nachlese fehlgeschlagen figur=${f.id}: ${e.message}`);
        }
      }
    }

    // ── Bündel für das Modell ────────────────────────────────────────────────
    let stellenDropped = 0;
    const blocks = [];
    for (const f of figuren) {
      const { picked, dropped } = selectCandidates(byFigur.get(f.id) || [], MAX_STELLEN_PRO_FIGUR);
      stellenDropped += dropped;
      if (!picked.length) continue;
      blocks.push({
        fig: f,
        stellen: picked,
        chars: picked.reduce((s, c) => s + c.satz.length, 0) + (f.name || '').length + 40,
      });
    }

    const settings = getBookSettings(bookId, userEmail);
    const zeitlinieReal = !!settings?.zeitlinie_real;
    const buchJahre = zeitlinieReal ? bookYearSpan(bookId, userEmail) : null;
    const yearMap = computeFigureYears(bookId, userEmail);
    const { BUCH_KONTEXT } = await getBookPrompts(bookId, userEmail);
    const systemPrompt = buildFigurAlterSystemPrompt();

    const tok = { in: 0, out: 0, ms: 0 };
    // figur-Name (gefaltet) → Figur. Das Modell antwortet mit dem Namen, nicht mit
    // einer ID; der Prompt verlangt den Namen aus der Liste (= Vollname), der
    // Kurzname ist die Toleranz dafuer, dass es «Anna» statt «Anna Berg» schreibt.
    //
    // Ein Kurzname wird nur eingetragen, wenn er EINDEUTIG ist: haben zwei Figuren
    // dieselbe «Anna», ist die Zuordnung geraten — und eine falsch zugeordnete
    // Altersangabe ist schlimmer als eine fehlende (sie steht mit Beleg in der
    // Tabelle und sieht dadurch besonders glaubwuerdig aus).
    const shortCount = new Map();
    for (const f of figuren) {
      const k = foldWord(f.kurzname);
      if (k) shortCount.set(k, (shortCount.get(k) || 0) + 1);
    }
    const nameLookup = new Map();
    for (const f of figuren) {
      const full = foldWord(f.name);
      if (full && !nameLookup.has(full)) nameLookup.set(full, f);
    }
    for (const f of figuren) {
      const k = foldWord(f.kurzname);
      if (k && shortCount.get(k) === 1 && !nameLookup.has(k)) nameLookup.set(k, f);
    }

    const fundeByFigur = new Map();
    let verworfenZitat = 0, verworfenZahl = 0, verworfenFigur = 0, verworfenWert = 0;

    function consume(funde, stellenOf) {
      for (const v of Array.isArray(funde) ? funde : []) {
        if (!v || typeof v !== 'object') continue;
        const fig = nameLookup.get(foldWord(v.figur));
        if (!fig) { verworfenFigur++; continue; }
        const art = ['alter', 'geburtsjahr', 'todesjahr'].includes(v.art) ? v.art : null;
        const wert = Number.isFinite(Number(v.wert)) ? Math.round(Number(v.wert)) : null;
        const zitat = typeof v.zitat === 'string' ? v.zitat.trim() : '';
        if (!art || wert == null || zitat.length < MIN_ZITAT_CHARS) { verworfenZitat++; continue; }
        // Plausibilitaet: ein Geburtsjahr 12 oder ein Alter 400 ist eine Verwechslung,
        // auch wenn die Zahl im Zitat steht.
        if (!isPlausibleWert(art, wert)) { verworfenWert++; continue; }

        // Zitat-Pruefung: das Zitat muss in einer der VORGELEGTEN Stellen dieser
        // Figur stehen. Eine Zahl aus einem Sprachmodell ohne nachschlagbare
        // Fundstelle ist eine Behauptung — und in einer Tabelle sieht sie aus wie
        // eine Messung. Gleiche Haltung wie bei den Belegzitaten der Bewertung
        // (lib/quote-verify.js), hier nur mit engerem Heuhaufen.
        const nz = _norm(zitat);
        const treffer = (stellenOf.get(fig.id) || []).find(s => _norm(s.satz).includes(nz));
        if (!treffer) { verworfenZitat++; continue; }

        // Zahl-Pruefung: der Wert muss im Zitat vorkommen — als Ziffer oder als
        // Zahlwort. Faellt das weg, wandern gerechnete und geratene Werte als
        // „belegt" in die Tabelle.
        if (!numbersIn(zitat).has(wert)) { verworfenZahl++; continue; }

        if (!fundeByFigur.has(fig.id)) fundeByFigur.set(fig.id, []);
        fundeByFigur.get(fig.id).push({
          art, wert,
          bezugsjahr: Number.isFinite(Number(v.bezugsjahr)) && Number(v.bezugsjahr) > 999 ? Math.round(Number(v.bezugsjahr)) : null,
          zitat: zitat.slice(0, 400),
          page_id: treffer.page_id ?? null,
          chapter_id: treffer.chapter_id ?? null,
          ordinal: treffer.ordinal ?? 0,
          offset: treffer.offset ?? 0,
          unsicher: !!v.unsicher,
          begruendung: typeof v.begruendung === 'string' ? v.begruendung.trim().slice(0, 400) : null,
        });
      }
    }

    // Bündel bilden: so viele Figuren pro Call, wie ins Zeichenbudget passen.
    const budget = Math.max(4000, Math.floor(PER_CHUNK_LIMIT * BUNDLE_SHARE));
    const bundles = [];
    let cur = [], curChars = 0;
    for (const b of blocks) {
      if (cur.length && curChars + b.chars > budget) { bundles.push(cur); cur = []; curChars = 0; }
      cur.push(b); curChars += b.chars;
    }
    if (cur.length) bundles.push(cur);

    const AI_FROM = 16, AI_TO = 92;
    logger.info(
      `Alters-Analyse Start: book=${bookId} figuren=${figuren.length} mitStellen=${blocks.length} `
      + `buendel=${bundles.length} embedQueries=${embedQueries} stellenVerworfen=${stellenDropped}`,
    );

    // Arbeitsliste statt fester Schleife: reisst ein Bündel am Output-Cap (viele
    // Funde in einem Bündel), wird es halbiert und beide Hälften laufen einzeln —
    // statt den ganzen Lauf mit `aiTruncated` zu verwerfen. Eine einzelne Figur, die
    // allein nicht passt, bleibt ein Fehler (dann ist das Cap schlicht zu klein).
    const queue = [...bundles];
    let done = 0;
    while (queue.length) {
      throwIfAborted();
      const bundle = queue.shift();
      const total = done + queue.length + 1;
      const from = AI_FROM + Math.floor((done / total) * (AI_TO - AI_FROM));
      const to = AI_FROM + Math.floor(((done + 1) / total) * (AI_TO - AI_FROM));
      updateJob(jobId, {
        statusText: 'job.phase.figurAlterAsk',
        statusParams: { done: done + 1, total },
        progress: from,
      });
      const stellenOf = new Map(bundle.map(b => [b.fig.id, b.stellen]));
      let result;
      try {
        result = await aiCall(jobId, tok,
          buildFigurAlterPrompt(bundle.map(b => ({
            name: b.fig.name, kurzname: b.fig.kurzname, typ: b.fig.typ,
            geburtstag: b.fig.geburtstag,
            stellen: b.stellen.map(s => ({ satz: s.satz, chapter: s.chapter, page_name: s.page_name, indirekt: s.indirekt, semantisch: !!s.semantisch })),
          })), BUCH_KONTEXT, buchJahre),
          systemPrompt, from, to, 4000, 0.25, 8000, undefined, SCHEMA_FIGUR_ALTER,
        );
      } catch (e) {
        if (e?.message === 'job.error.aiTruncated' && bundle.length > 1) {
          const mid = Math.ceil(bundle.length / 2);
          queue.unshift(bundle.slice(0, mid), bundle.slice(mid));
          logger.warn(`Alters-Analyse: Bündel mit ${bundle.length} Figuren am Output-Cap abgeschnitten – wird geteilt.`);
          continue;
        }
        throw e;
      }
      // Pflichtfeld: fehlt `funde`, hat der Provider nicht geantwortet wie
      // verlangt. Ein leeres ARRAY ist dagegen gueltig (Stellen ohne Aussage).
      if (!Array.isArray(result?.funde)) throw i18nError('job.error.figurAlterMissing');
      consume(result.funde, stellenOf);
      done++;
    }

    // ── Schicht 3: Verdichtung ──────────────────────────────────────────────
    // Letzter Abbruch-Punkt VOR dem Full-Replace: was bis hier gesammelt ist, ist ein
    // Teilstand und darf den vorigen Index nicht ersetzen.
    throwIfAborted();
    updateJob(jobId, { statusText: 'job.phase.figurAlterConsolidate', progress: AI_TO + 2 });
    const rows = [];
    for (const f of figuren) {
      // `buchJahre` geht NICHT in die Verdichtung: die Jahresspanne des ganzen
      // Buchs ist der Rahmen fuer das Modell, nicht der Bezugspunkt einer Figur.
      // Deren Alter haengt an ihrem eigenen Ankerjahr (lib/figure-years.js) — sonst
      // ist eine Figur, die 1987 aus der Geschichte verschwindet, so alt, wie sie
      // am Buchende waere.
      const row = consolidateFigure({
        funde: fundeByFigur.get(f.id) || [],
        kuratiert: { geburtstag: f.geburtstag },
        zeitstrahl: yearMap?.get(f.id) || null,
      });
      // Eine Figur ohne jede Angabe braucht keine Zeile — „unbekannt" ist der
      // Default der Tabelle, und eine leere Zeile behauptete, es sei gemessen.
      if (row.alter_von == null && row.geburtsjahr == null && !row.belege.length) continue;
      rows.push({ figure_id: f.id, ...row });
    }

    const written = replaceFigureAges(bookId, userEmail, {
      rows,
      scan: { content_sig: sig, age_version: AGE_ANALYSIS_VERSION, model, figuren_total: figuren.length, embed_used: embedUsed },
    });

    const widersprueche = rows.filter(r => r.widerspruch).length;
    logger.info(
      `Alters-Analyse fertig: book=${bookId} zeilen=${written.rows} mitAlter=${written.mitAlter} `
      + `belege=${written.belegeTotal} widersprueche=${widersprueche} `
      + `verworfen(zitat=${verworfenZitat} zahl=${verworfenZahl} wert=${verworfenWert} figur=${verworfenFigur})`,
    );

    completeJob(jobId, {
      figuren: figuren.length,
      mitAlter: written.mitAlter,
      belege: written.belegeTotal,
      widersprueche,
      stellenDropped,
      embedQueries, embedSkipped, embedUsed,
      verworfen: { zitat: verworfenZitat, zahl: verworfenZahl, wert: verworfenWert, figur: verworfenFigur },
      tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok), `${written.mitAlter}/${figuren.length} Figuren mit Alter`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Alters-Analyse Fehler book=${bookId}: ${e.message}`, { stack: e.cause?.stack || e.stack });
    failJob(jobId, e);
  }
}

const figurAlterRouter = express.Router();

// 'editor': das Ergebnis ist ein Analyse-Index am Buch, kein Lesevorgang.
figurAlterRouter.post('/figur-alter', jsonBody, (req, res) => startBookJob(req, res, {
  type: 'figur-alter', minRole: 'editor', label: 'job.label.figurAlter',
  run: (jobId, { bookId, userEmail }) => runFigurAlterJob(jobId, bookId, userEmail, { force: req.body?.force !== false }),
}));

module.exports = { figurAlterRouter, runFigurAlterJob };
