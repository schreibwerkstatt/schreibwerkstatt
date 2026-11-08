'use strict';
// Quelle aus PDF: der Autor waehlt ein PDF, der Job bestimmt, welches Werk es
// ist, und liefert einen Quellen-ENTWURF. Gespeichert wird nichts — der Autor
// bestaetigt den Entwurf in der Quellen-Karte, und erst dann entstehen Quelle
// (POST /sources) und Anhang (POST /sources/:id/doc). Kein zweiter Schreibpfad.
//
// DREI STUFEN, die billigste und sicherste zuerst:
//   1. DOI aus PDF-Metadaten und Textanfang → Crossref.
//   2. ISBN aus dem Textanfang (Impressum) → OpenLibrary.
//   3. Das Modell liest die Titelseite (Titel, Personen, Jahr — nie Kennungen,
//      siehe public/js/prompts/sources.js) → searchWork in beiden Registern.
//      Kein Registertreffer heisst „unbestaetigt", nicht verworfen. Zeitungs-
//      und Magazinartikel fuehrt kein Register — dort entfaellt die Suche.
// Danach, fuer jede Stufe: die Adresse eines aus dem Browser gedruckten
// Artikels aus Kopf-/Fusszeile (findPrintedUrl), Abrufdatum = Erstellungsdatum
// des PDFs, nicht „heute".
// Eine Kennung zaehlt nur, wenn der Titel des Registertreffers im PDF-Text
// steht (lib/source-pdf-ident.js#titleInText): Titelseiten nennen auch fremde
// Kennungen (Begleitartikel, Vorauflage, E-Book-Ausgabe).
//
// Stufe 1 und 2 kommen ohne KI aus. Der Job laeuft trotzdem ganz in der Queue:
// ob Stufe 3 noetig wird, entscheidet sich erst unterwegs, und ein Endpunkt, der
// mal synchron und mal als Job antwortet, waere fuer die Karte zwei Vertraege.

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  createJob, enqueueJob, findActiveJobId,
  aiCall, getPrompts, tps,
  applyTierAiOverrides,
} = require('./shared');
const { resolveProvider } = require('../../lib/ai');
const { listPoolSources, listSources } = require('../../db/sources');
const { parsePersonName } = require('../../lib/bib-parse');
const { lookupDoi, lookupIsbn, searchWork, normalizeDoi, normalizeIsbn } = require('../../lib/source-lookup');
const {
  findDoiCandidates, findIsbnCandidates, titleInText, metaSearchStrings, DOI_HEAD_CHARS,
  findPrintedUrl, pdfDateToIso,
} = require('../../lib/source-pdf-ident');
const { parseIssuedDate } = require('../../lib/issued-date');
const { readPdfMeta } = require('../../lib/pdf-extract');
const { rawPdfBody, readDocUpload } = require('../../lib/pdf-attachment');
const { toIntId } = require('../../lib/validate');
const { guardBook, sessionEmail } = require('../../lib/acl');
const { setContext } = require('../../lib/log-context');

// Textanfang fuer das Modell: Titelseite + Titelei bzw. Kopf und Abstract.
const AI_HEAD_CHARS = 8000;

function _norm(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Leerer Entwurf mit allen Spalten — dieselbe Form wie lib/source-lookup.js. */
function _emptyDraft() {
  return {
    csl_type: 'other', citekey: null, authors: [], editors: [],
    title: null, container_title: null, publisher: null, place: null, year: null,
    issued_date: null, edition: null, volume: null, issue: null, pages: null,
    doi: null, isbn: null, issn: null, url: null, accessed_at: null, note: null,
  };
}

/** Modell-Antwort → Kandidat. null, wenn das Modell kein Werk benennt. */
function _normalizeWerk(v, typeMap) {
  if (!v || typeof v !== 'object') return null;
  const title = typeof v.titel === 'string' ? v.titel.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
  const authors = (Array.isArray(v.autoren) ? v.autoren : [])
    .filter(s => typeof s === 'string' && s.trim())
    .slice(0, 20)
    .map(s => parsePersonName(s.trim().slice(0, 200), { natural: true }))
    .filter(Boolean);
  if (!title && !authors.length) return null;
  const yearHit = /\b(1[0-9]{3}|2[0-9]{3})\b/.exec(String(v.jahr ?? ''));
  // Datum nur mit Monat; ein lesbares Datum fuehrt auch beim Jahr (dieselbe
  // Regel wie im Schreibpfad, db/sources/shared.js).
  const iso = parseIssuedDate(typeof v.datum === 'string' ? v.datum : '');
  const issued = iso && iso.length > 4 ? iso : null;
  return {
    csl_type: typeMap[v.typ] || 'other',
    title: title || null,
    authors,
    container_title: typeof v.container === 'string' && v.container.trim()
      ? v.container.replace(/\s+/g, ' ').trim().slice(0, 500) : null,
    year: issued ? issued.slice(0, 4) : (yearHit ? yearHit[1] : null),
    issued_date: issued,
  };
}

/**
 * Liegt das Werk schon in der Bibliothek? DOI, dann ISBN, dann Titel + Jahr.
 * Wie bei der Quellen-Erkennung markiert, nicht verworfen — die Karte bietet
 * dann „vorhandene verwenden" an statt eine Dublette anzulegen.
 */
function findExisting(draft, userEmail, bookId) {
  const pool = listPoolSources(userEmail, { includeArchived: true });
  const doi = normalizeDoi(draft.doi)?.toLowerCase();
  const isbn = normalizeIsbn(draft.isbn);
  const title = draft.title ? _norm(draft.title) : null;
  const hit = (doi && pool.find(s => normalizeDoi(s.doi)?.toLowerCase() === doi))
    || (isbn && pool.find(s => normalizeIsbn(s.isbn) === isbn))
    || (title && pool.find(s => s.title && _norm(s.title) === title
      && (!draft.year || !s.year || String(s.year) === String(draft.year))))
    || null;
  if (!hit) return { existing_source_id: null, existing_linked: false, existing_has_doc: false };
  const linked = listSources(bookId, { includeArchived: true }).some(s => s.id === hit.id);
  return { existing_source_id: hit.id, existing_linked: linked, existing_has_doc: !!hit.has_doc };
}

/** Registertreffer ueber eine Kennung, nur wenn sein Titel im PDF steht. */
async function _viaIdentifier(kind, candidates, text, logger) {
  const lookup = kind === 'doi' ? lookupDoi : lookupIsbn;
  for (const id of candidates) {
    let draft = null;
    try { draft = await lookup(id); }
    catch (e) { logger.warn(`${kind}-Lookup fehlgeschlagen (${id}): ${e.message}`); continue; }
    if (!draft) continue;
    if (!titleInText(draft.title, text)) {
      logger.info(`${kind} ${id} verworfen: Registertitel steht nicht im PDF ("${draft.title || '?'}")`);
      continue;
    }
    return draft;
  }
  return null;
}

/**
 * @param {object} input
 * @param {string} input.text   extrahierter PDF-Text (lib/pdf-extract.js)
 * @param {Buffer} input.buffer Original, nur fuer die Metadaten
 * @param {string} input.name   Anzeige-Dateiname
 */
async function runSourcePdfDraftJob(jobId, bookId, userEmail, { text, buffer, name }) {
  const logger = makeJobLogger(jobId);
  // Stufe «leicht» (shared/model-tier.js).
  applyTierAiOverrides(jobId, 'source-pdf-draft', resolveProvider({ userEmail }), logger);
  try {
    const tok = { in: 0, out: 0, ms: 0 };
    const body = String(text || '');

    updateJob(jobId, { statusText: 'job.phase.sourcePdfIdent', progress: 10 });
    const { info, xmp } = await readPdfMeta(buffer);

    let draft = null;
    let method = null;
    let register = null;
    let verified = false;
    let registerSkipped = false;

    // ── 1. DOI ────────────────────────────────────────────────────────────
    const dois = findDoiCandidates([...metaSearchStrings(info, xmp), body.slice(0, DOI_HEAD_CHARS)]);
    if (dois.length) {
      updateJob(jobId, { statusText: 'job.phase.sourcePdfLookup', progress: 25 });
      draft = await _viaIdentifier('doi', dois, body, logger);
      if (draft) { method = 'doi'; register = 'crossref'; verified = true; }
    }

    // ── 2. ISBN ───────────────────────────────────────────────────────────
    if (!draft) {
      const isbns = findIsbnCandidates(body);
      if (isbns.length) {
        updateJob(jobId, { statusText: 'job.phase.sourcePdfLookup', progress: 40 });
        draft = await _viaIdentifier('isbn', isbns, body, logger);
        if (draft) { method = 'isbn'; register = 'openlibrary'; verified = true; }
      }
    }

    // ── 3. Titelseite lesen + Register-Suche ──────────────────────────────
    if (!draft) {
      if (!body.trim()) throw i18nError('job.error.sourcePdfNoText');
      const prompts = await getPrompts(userEmail);
      const { buildSourcePdfSystemPrompt, buildSourcePdfPrompt, SCHEMA_SOURCE_PDF, SOURCE_DETECT_TYPES } = prompts;
      updateJob(jobId, { statusText: 'job.phase.sourcePdfRead', progress: 50 });
      const result = await aiCall(jobId, tok,
        buildSourcePdfPrompt(body.slice(0, AI_HEAD_CHARS), { title: info.Title, author: info.Author }),
        buildSourcePdfSystemPrompt(), 50, 85, 400, 0.15, 1000, undefined, SCHEMA_SOURCE_PDF,
      );
      // Pflichtfeld: ohne `werk` hat der Provider nicht wie verlangt geantwortet.
      if (!result || typeof result.werk !== 'object' || result.werk === null) {
        throw i18nError('job.error.sourcePdfMissing');
      }
      const cand = _normalizeWerk(result.werk, SOURCE_DETECT_TYPES);
      if (!cand) throw i18nError('job.error.sourcePdfNoWork');

      draft = { ..._emptyDraft(), ...cand };
      method = 'text';
      // Zeitungs-/Magazinartikel: kein Register kennt sie (searchWork steigt
      // ohnehin aus) — die Karte sagt das statt „unbestaetigt" ohne Grund.
      registerSkipped = cand.csl_type === 'newspaper';
      if (!registerSkipped) {
        updateJob(jobId, { statusText: 'job.phase.sourcePdfSearch', progress: 88 });
        try {
          const hit = await searchWork(cand);
          if (hit) {
            // Registerdaten gewinnen, aber ein leeres Registerfeld loescht die
            // Lesart der Titelseite nicht (dieselbe Regel wie source-detect).
            for (const [k, v] of Object.entries(hit.draft)) {
              if (v != null && !(Array.isArray(v) && !v.length)) draft[k] = v;
            }
            method = 'register';
            register = hit.register;
            verified = true;
          }
        } catch (e) {
          logger.warn(`Register-Suche fehlgeschlagen (${cand.title || '?'}): ${e.message}`);
        }
      }
    }

    // ── Adresse des gedruckten Artikels ───────────────────────────────────
    // Nur, wenn keine Stufe eine geliefert hat: ein Registertreffer bringt die
    // kanonische Adresse (doi.org) mit, die bleibt.
    let urlFromPrint = false;
    if (!draft.url) {
      const url = findPrintedUrl(body);
      if (url) {
        draft.url = url;
        draft.accessed_at = pdfDateToIso(info.CreationDate);
        urlFromPrint = true;
      }
    }

    const existing = findExisting(draft, userEmail, bookId);
    logger.info(
      `Quelle aus PDF: book=${bookId} datei="${name}" weg=${method} bestaetigt=${verified}`
      + ` register=${register || (registerSkipped ? 'uebersprungen' : '-')} dois=${dois.length}`
      + ` url=${urlFromPrint ? 'druck' : (draft.url ? 'register' : '-')} vorhanden=${existing.existing_source_id ?? '-'}`,
    );
    completeJob(jobId, {
      draft, method, verified, register, register_skipped: registerSkipped,
      url_from_print: urlFromPrint, doc_name: name, ...existing,
      tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok), draft.title || name);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Quelle aus PDF Fehler book=${bookId}: ${e.message}`, { stack: e.cause?.stack || e.stack });
    failJob(jobId, e);
  }
}

const sourcePdfDraftRouter = express.Router();

// POST /jobs/source-pdf-draft?book_id=…&name=Datei.pdf   body: raw PDF bytes
// Der Upload wird hier schon ausgelesen (Magic-Bytes, Groesse, Extraktion),
// damit „kein PDF"/„zu gross"/„passwortgeschuetzt" als sofortiger 4xx mit
// derselben error_code-Familie ankommen wie beim Anhaengen an eine Quelle.
sourcePdfDraftRouter.post('/source-pdf-draft', rawPdfBody(), async (req, res) => {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  // 'editor' wie POST /sources: der Entwurf fuehrt genau dorthin.
  if (!guardBook(req, res, bookId, 'editor')) return;
  setContext({ book: bookId });
  const userEmail = sessionEmail(req);

  const up = await readDocUpload(req.body, req.query.name);
  if (!up.ok) return res.status(up.status).json({ error_code: up.error_code });
  const { doc } = up;

  // Dedup ueber den Inhalts-Hash: dasselbe PDF zweimal gewaehlt → derselbe
  // Lauf. Ein anderes PDF darf parallel laufen, sein Ergebnis ist ein anderes.
  const existing = findActiveJobId('source-pdf-draft', doc.hash, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });

  const jobId = createJob('source-pdf-draft', bookId, userEmail, 'job.label.sourcePdfDraft', null, doc.hash);
  enqueueJob(jobId, () => runSourcePdfDraftJob(jobId, bookId, userEmail, {
    text: doc.text, buffer: doc.buffer, name: doc.name,
  }));
  res.json({ jobId });
});

module.exports = { sourcePdfDraftRouter, runSourcePdfDraftJob, findExisting };
