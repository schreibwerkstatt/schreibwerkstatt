'use strict';
// Exposé: Logline, Kurzinhalt, Synopse, Figurenliste und ein Klappentext-
// Vorschlag (Roman) bzw. Logline, Kurzbeschreibung, Alleinstellung, Gliederung
// und Klappentext-Vorschlag (Sachbuch). Liest nur, schreibt NIE in den Buchtext
// und nie in book_publication — der Klappentext-Vorschlag wird erst durch den
// User übernommen (Bucheinstellungen → Reiter Exposé). Doku: docs/expose.md.
//
// Zwei Wege: passt der fertige Prompt ins Budget, bekommt das Modell den
// Volltext (basis 'single'). Sonst entstehen zuerst Inhaltsangaben je Kapitel
// (gecacht nach gesendetem Prompt, nur intern) und daraus das Exposé ('multi').
// Die Eckdaten (Titel, Autor, Genre, Umfang, Zielgruppe, Vergleichstitel) sind
// Fakten aus book_settings/book_publication und gehen nur als Rahmen in den Prompt.
const crypto = require('crypto');
const express = require('express');
const { getBookSettings } = require('../../db/schema');
const { getMeta: getPublication } = require('../../db/book-publication');
const {
  insertExpose, findExposeBySig, listExposeFiguren,
  loadSynopsisCache, saveSynopsisCache, pruneSynopsisCache,
} = require('../../db/expose');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError, contentHttpError,
  aiCall, getPrompts,
  loadOrderedBookContents, loadPageContents, groupByChapter, splitGroupsIntoChunks, buildSinglePassBookText,
  chunkLimitsFor, BATCH_SIZE, jobAbortControllers, settledAll,
  _modelName, tps, jsonBody, startBookJob, systemChars: _systemChars,
} = require('./shared');
const { narrativeLabels } = require('./narrative-labels');
const { werkstandFor } = require('./review-context');
const { normseiten } = require('../../lib/normseite');
const { buchtypLabel } = require('../../lib/buchtyp');
const { resolveProvider } = require('../../lib/ai');
const contentStore = require('../../lib/content-store');
const { sessionEmail } = require('../../lib/acl');

const exposeRouter = express.Router();

const FIGUREN_CAP = 40;

const _sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

// Teil-Nummer eines zerlegten Kapitels (`<key>__subN`), sonst null.
function _teilOf(chunkKey, chunkOrder) {
  const base = chunkKey.replace(/__sub\d+$/, '');
  const parts = chunkOrder.filter(k => k.replace(/__sub\d+$/, '') === base);
  if (parts.length < 2) return null;
  return { nr: parts.indexOf(chunkKey) + 1, von: parts.length };
}

/** Prüft und bereinigt das Modell-Ergebnis. Pflicht-Textfelder müssen gefüllt
 *  sein (sonst Fehler statt halber Daten); Figuren-/Kapitel-IDs müssen aus der
 *  vorgelegten Liste stammen. Liefert { result, warnungen }. */
function validateExposeResult(r, { profil, fields, figurenIds, kapitelIds }) {
  if (!r || typeof r !== 'object') throw i18nError('job.error.exposeIncomplete');
  const out = {};
  for (const f of fields.text) {
    const v = typeof r[f] === 'string' ? r[f].trim() : '';
    if (!v) throw i18nError('job.error.exposeIncomplete');
    out[f] = v;
  }
  const warnungen = [];
  const raw = Array.isArray(r[fields.list]) ? r[fields.list] : [];
  const idKey = profil === 'sachlich' ? 'chapter_id' : 'fig_id';
  const valid = profil === 'sachlich' ? kapitelIds : figurenIds;
  const seen = new Set();
  let dropped = 0;
  out[fields.list] = [];
  for (const item of raw) {
    // Figuren tragen die TEXT-fig_id, Kapitel die numerische chapter_id.
    const id = profil === 'sachlich' ? Number(item?.[idKey]) : String(item?.[idKey] ?? '').trim();
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    if (!valid.has(id) || seen.has(id) || !text) { dropped++; continue; }
    seen.add(id);
    out[fields.list].push({ [idKey]: id, text });
  }
  if (dropped) warnungen.push({ key: profil === 'sachlich' ? 'expose.warn.kapitelDropped' : 'expose.warn.figurenDropped', params: { n: dropped } });
  return { result: out, warnungen };
}

async function runExposeJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  const bookIdInt = parseInt(bookId);
  try {
    const prompts = await getPrompts(userEmail);
    const {
      exposeProfil, buildExposeSystem, buildExposeSynopsisPrompt, SCHEMA_EXPOSE_SYNOPSIS,
      buildExposePrompt, buildExposeSchema, EXPOSE_FIELDS, getResearchPromptContext,
    } = prompts;
    const settings = getBookSettings(bookIdInt, userEmail);
    const profil = exposeProfil(settings?.buchtyp || null);
    if (!profil) throw i18nError('job.error.exposeBuchtyp');
    const fields = EXPOSE_FIELDS[profil];
    const locale = `${settings?.language || 'de'}-${settings?.region || 'CH'}`;
    // Sprachnorm + Buch-Kontext (Buchtyp-Zusatz, Angaben des Autors, Hauptland)
    // ohne Lektorats-Persona und Stilprofil: das Exposé beschreibt, es korrigiert nicht.
    const system = buildExposeSystem(getResearchPromptContext(locale, {
      buchtyp: settings?.buchtyp || null, buchKontext: settings?.buch_kontext || null, hauptland: settings?.schauplatz_land || null,
    }));

    const provider = resolveProvider({ userEmail });
    const model = _modelName(provider);
    const { singlePass: SINGLE_PASS_LIMIT, perChunk: PER_CHUNK_LIMIT, inputBudget: INPUT_BUDGET } = chunkLimitsFor(provider);

    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    const book = await contentStore.loadBook(bookIdInt).catch(e => { throw contentHttpError(e); });
    const { chMap, chaptersFlat, pages } = await loadOrderedBookContents(bookIdInt)
      .catch(e => { throw contentHttpError(e); });
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const pageContents = await loadPageContents(pages, chMap, 50, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 30),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, total), total },
      });
    }, jobAbortControllers.get(jobId)?.signal);
    if (!pageContents.length) { completeJob(jobId, { empty: true }); return; }

    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    const { groupOrder, groups } = groupByChapter(pageContents);

    // Eckdaten: Fakten des Autors, live gelesen (nichts davon wird gespeichert).
    const pub = getPublication(bookIdInt);
    const labels = narrativeLabels(settings);
    const unfertig = !settings?.is_finished;
    const eckdaten = {
      titel: book.name,
      untertitel: pub.subtitle,
      autor: pub.author_name,
      genre: buchtypLabel(settings?.buchtyp, settings?.language),
      erzaehlperspektive: profil === 'narrativ' ? labels.erzaehlperspektive : null,
      erzaehlzeit: profil === 'narrativ' ? labels.erzaehlzeit : null,
      normseiten: normseiten(totalChars),
      zielgruppe: pub.zielgruppe,
      vergleichstitel: pub.vergleichstitel,
      unfertig,
    };

    const figurenAll = profil === 'narrativ' ? listExposeFiguren(bookIdInt, userEmail) : [];
    if (figurenAll.length > FIGUREN_CAP) logger.info(`Figurenkatalog: ${figurenAll.length - FIGUREN_CAP} von ${figurenAll.length} Figuren abgeschnitten (Cap ${FIGUREN_CAP}).`);
    const figuren = figurenAll.slice(0, FIGUREN_CAP);
    const textChapterIds = new Set(groupOrder.filter(k => k !== '__ungrouped__').map(Number));
    const kapitel = profil === 'sachlich'
      ? chaptersFlat.filter(c => textChapterIds.has(Number(c.id))).map(c => ({ id: Number(c.id), name: c.name }))
      : [];

    const tok = { in: 0, out: 0, ms: 0 };
    let quelle = null;
    let basis = 'single';
    if (totalChars <= SINGLE_PASS_LIMIT) {
      quelle = { kind: 'volltext', text: buildSinglePassBookText(groups, groupOrder) };
      const probe = buildExposePrompt({ profil, eckdaten, figuren, kapitel, quelle });
      if (probe.length + _systemChars(system) > INPUT_BUDGET) {
        logger.info(`Single-Pass-Prompt ${probe.length} Zeichen > Budget ${INPUT_BUDGET} – weiche auf Inhaltsangaben aus.`);
        quelle = null;
      }
    }

    if (!quelle) {
      basis = 'multi';
      const { chunkOrder, chunks } = splitGroupsIntoChunks(groups, groupOrder, PER_CHUNK_LIMIT);
      logger.info(`Exposé «${book.name}»: ${totalChars} Zeichen → Inhaltsangaben über ${chunkOrder.length} Kapitel(-Teile).`);
      const usedSigs = [];
      let hits = 0, done = 0;
      const settled = await settledAll(chunkOrder.map((key) => async () => {
        const chunk = chunks.get(key);
        const prompt = buildExposeSynopsisPrompt({
          bookName: book.name, kapitel: chunk.name, teil: _teilOf(key, chunkOrder), profil,
          text: chunk.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n'),
        });
        const sig = _sha(`${model}\n${system}\n${prompt}`);
        usedSigs.push(sig);
        let inhalt = loadSynopsisCache(bookIdInt, userEmail, provider, sig);
        if (inhalt) { hits++; } else {
          const r = await aiCall(jobId, tok, prompt, system, null, null, 2500, 0.1, null, provider, SCHEMA_EXPOSE_SYNOPSIS);
          inhalt = typeof r?.inhalt === 'string' ? r.inhalt.trim() : '';
          if (!inhalt) throw i18nError('job.error.exposeIncomplete');
          saveSynopsisCache(bookIdInt, userEmail, provider, sig, inhalt);
        }
        done++;
        updateJob(jobId, {
          progress: 30 + Math.round((done / chunkOrder.length) * 50),
          statusText: 'job.phase.exposeSynopsis', statusParams: { current: done, total: chunkOrder.length },
        });
        const teil = _teilOf(key, chunkOrder);
        return { kapitel: teil ? `${chunk.name} (Teil ${teil.nr}/${teil.von})` : chunk.name, inhalt };
      }));
      const items = settled.map(r => { if (r.status === 'rejected') throw r.reason; return r.value; });
      if (hits) logger.info(`Inhaltsangaben: ${hits}/${chunkOrder.length} aus Cache.`);
      pruneSynopsisCache(bookIdInt, userEmail, provider, usedSigs);
      quelle = { kind: 'inhaltsangaben', items };
    }

    const prompt = buildExposePrompt({ profil, eckdaten, figuren, kapitel, quelle });
    const sig = _sha(`${model}\n${profil}\n${system}\n${prompt}`);
    const figurenIds = new Set(figuren.map(f => String(f.id)));
    const kapitelIds = new Set(kapitel.map(k => k.id));

    // Unveränderte Eingabe → derselbe Lauf, kein neuer KI-Call, keine zweite Zeile.
    const cached = findExposeBySig(bookIdInt, userEmail, sig);
    let result, warnungen, unchanged = false;
    if (cached) {
      logger.info('Exposé – unveränderte Eingabe, jüngster Lauf wird wiederverwendet.');
      ({ result, warnungen } = { result: cached.result, warnungen: cached.warnungen });
      unchanged = true;
    } else {
      updateJob(jobId, { progress: 82, statusText: 'job.phase.exposeWriting' });
      const raw = await aiCall(jobId, tok, prompt, system, 82, 97, 9000, 0.3, null, provider, buildExposeSchema(profil));
      ({ result, warnungen } = validateExposeResult(raw, { profil, fields, figurenIds, kapitelIds }));
      if (unfertig) warnungen.unshift({ key: 'expose.warn.unfertig' });
      const werkstand = unfertig ? werkstandFor(settings, totalChars, {}) : null;
      if (werkstand?.zielProzent != null) warnungen.push({ key: 'expose.warn.zielumfang', params: { pct: werkstand.zielProzent } });
    }
    const ins = insertExpose({ bookId: bookIdInt, userEmail, profil, basis, sig, result, warnungen, model });

    completeJob(jobId, { exposeId: ins.id, unchanged: unchanged || ins.unchanged, basis, tokensIn: tok.in, tokensOut: tok.out },
      unchanged ? null : tps(tok), `«${book.name}» ${profil}/${basis}${unchanged ? ' (unverändert)' : ''}`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────
// Buchtypen ohne Exposé (Gegenstück zu exposeProfil() → null). Drift gegated
// durch tests/unit/expose-prompt.test.mjs.
const EXPOSE_BUCHTYP_EXCLUDED = new Set(['lyrik', 'tagebuch', 'journalismus']);

exposeRouter.post('/expose', jsonBody, (req, res) => {
  startBookJob(req, res, {
    type: 'expose', minRole: 'editor', label: 'job.label.expose',
    precheck: (bookId) => {
      const settings = getBookSettings(bookId, sessionEmail(req));
      // Gleiche Profil-Regel wie der Job, synchron über den Buchtyp
      // (exposeProfil liegt im ESM-Prompt-Modul).
      return EXPOSE_BUCHTYP_EXCLUDED.has(settings?.buchtyp) ? 'EXPOSE_BUCHTYP' : null;
    },
    run: (jobId, { bookId, userEmail }) => runExposeJob(jobId, bookId, userEmail),
  });
});

module.exports = { exposeRouter, runExposeJob, validateExposeResult, EXPOSE_BUCHTYP_EXCLUDED };
