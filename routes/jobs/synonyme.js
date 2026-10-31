'use strict';
const crypto = require('crypto');
const express = require('express');
const {
  getBookSettings,
  loadSynonymCache, saveSynonymCache,
} = require('../../db/schema');
const {
  makeJobLogger, updateJob, setJobModel, completeJob, failJob, i18nError,
  aiCall, getPrompts, getBookPrompts,
  _modelName, tps,
  jobs, runningJobs, createJob, enqueueJob, jobKey, findActiveJobId,
  jsonBody,
} = require('./shared');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const appSettings = require('../../lib/app-settings');
const { resolveProvider, _claudeUsesAdaptiveThinking } = require('../../lib/ai');
const { usesOwnAccess } = require('../../lib/ai/profile');
const { guardBook, sessionEmail } = require('../../lib/acl');

const synonymeRouter = express.Router();

// Deckel für das Wort (Mac-Client: EditorBridge maxWordLength). Ein längeres
// «Wort» ist kein Einzelwort, sondern ein Defekt beim Aufrufer.
const WORT_MAX = 120;

function _synonymKeyHash(wort, satz, bookSettings, cacheVersion) {
  const buchtyp = bookSettings?.buchtyp || '';
  const locale = `${bookSettings?.language || 'de'}-${bookSettings?.region || 'CH'}`;
  const buchKontext = bookSettings?.buch_kontext || '';
  const stilprofil = bookSettings?.stilprofil || '';
  const raw = `${wort.trim().toLowerCase()}|${satz.trim().toLowerCase()}|${buchtyp}|${locale}|${buchKontext}|${stilprofil}|${cacheVersion}`;
  return crypto.createHash('sha1').update(raw).digest('hex');
}

// Modell + Effort der Synonymsuche als EIN Job-Bag (setContext ersetzt `aiJob` ganz).
// Nur Claude. Die Suche ist ein interaktiver Kurz-Call: `ai.claude.model.synonym`
// erlaubt ein schnelles Modell neben einem schweren globalen, `ai.claude.effort.synonym`
// (Default 'low') verhindert, dass ein denkendes Modell fuer eine Wortliste lange
// stumm nachdenkt. Effort nur bei adaptivem Denken — aeltere Modelle kuerzten sonst
// die sichtbare Antwort. Rueckgabe: das effektiv laufende Modell + `:e=<effort>`
// fuer die cacheVersion.
function applySynonymAiOverrides(effectiveProvider, logger) {
  const baseModel = _modelName(effectiveProvider);
  if (effectiveProvider !== 'claude') return { model: baseModel, cacheSuffix: '' };
  // Eigener Zugang: jobOverride ignoriert das Instanz-Modell, die cacheVersion auch.
  const override = usesOwnAccess() ? '' : String(appSettings.get('ai.claude.model.synonym') || '').trim();
  const model = override || baseModel;
  const bag = { provider: 'claude' };
  if (override) bag.model = override;
  let cacheSuffix = '';
  if (_claudeUsesAdaptiveThinking(model)) {
    const effort = String(appSettings.get('ai.claude.effort.synonym') || '').trim().toLowerCase();
    if (effort) { bag.effort = effort; cacheSuffix = `:e=${effort}`; }
  }
  if (Object.keys(bag).length > 1) {
    setContext({ aiJob: bag });
    logger.info(`Synonym-Override: ${JSON.stringify(bag)}.`);
  }
  return { model, cacheSuffix };
}

async function runSynonymJob(jobId, wort, satz, bookId, userEmail, pageId) {
  const logger = makeJobLogger(jobId);
  const pageTag = pageId ? ` page=${pageId}` : '';
  const prompts = await getPrompts(userEmail);
  const { buildSynonymPrompt, prepareSynonymSatz, SCHEMA_SYNONYM, SYNONYM_PROMPT_REV, PROMPTS_VERSION } = prompts;
  const { SYSTEM_SYNONYM } = await getBookPrompts(bookId, userEmail);
  const bookSettings = bookId ? getBookSettings(bookId, userEmail) : null;
  // Gekürzt + Wort markiert; der Cache-Key hasht genau den Satz, der im Prompt steht.
  const promptSatz = prepareSynonymSatz(wort, satz);
  const effectiveProvider = resolveProvider({ userEmail });
  const { model, cacheSuffix } = applySynonymAiOverrides(effectiveProvider, logger);
  // createJob trägt das globale Modell ein; das Kosten-Ledger entsteht in endJobRun
  // aus job_runs, also das tatsächlich laufende Modell vor dem Laufende nachziehen.
  setJobModel(jobId, effectiveProvider, model);
  const cacheVersion = `${model}${cacheSuffix}:${PROMPTS_VERSION || ''}:syn${SYNONYM_PROMPT_REV}`;
  const keyHash = _synonymKeyHash(wort, promptSatz, bookSettings, cacheVersion);
  try {
    logger.info(`Start: «${wort}»${pageTag}`);
    updateJob(jobId, { statusText: 'job.phase.searchingSynonyms', progress: 10 });

    const cached = loadSynonymCache(userEmail, keyHash, effectiveProvider);
    if (cached) {
      logger.info(`«${wort}»${pageTag} – Cache-HIT, spart Synonym-Call.`);
      completeJob(jobId, { synonyme: cached, tokensIn: 0, tokensOut: 0, cached: true },
        null, `«${wort}» Cache-HIT ${cached.length} Vorschläge`);
      return;
    }

    const tok = { in: 0, out: 0, ms: 0 };
    const result = await aiCall(jobId, tok,
      buildSynonymPrompt(wort, promptSatz, bookSettings?.language),
      SYSTEM_SYNONYM,
      10, 95, 800, 0.3, 2000, undefined, SCHEMA_SYNONYM,
    );

    if (!Array.isArray(result?.synonyme)) throw i18nError('job.error.synonymeArrayMissing');
    const normWort = wort.trim().toLowerCase();
    const seen = new Set();
    const synonyme = result.synonyme
      .filter(s => s && typeof s.wort === 'string' && s.wort.trim())
      .filter(s => s.wort.trim().toLowerCase() !== normWort)
      .map(s => ({ wort: s.wort.trim(), hinweis: typeof s.hinweis === 'string' ? s.hinweis.trim() : '' }))
      .filter(s => {
        const key = s.wort.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    // Leere Liste nicht cachen: ein einzelner Fehlgriff des Modells hielte sonst
    // 90 Tage (cache-cleanup TTL) für genau dieses Wort in diesem Satz.
    if (synonyme.length > 0) saveSynonymCache(userEmail, keyHash, synonyme, effectiveProvider);

    completeJob(jobId, { synonyme, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `«${wort}» ${synonyme.length} Vorschläge`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler «${wort}»${pageTag}: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

synonymeRouter.post('/synonym', jsonBody, (req, res) => {
  const { wort, satz } = req.body || {};
  const book_id = toIntId(req.body?.book_id);
  const page_id = toIntId(req.body?.page_id);
  if (!wort || typeof wort !== 'string' || !wort.trim()) return res.status(400).json({ error_code: 'WORT_REQUIRED' });
  if (wort.trim().length > WORT_MAX) return res.status(400).json({ error_code: 'WORT_TOO_LONG' });
  if (!satz || typeof satz !== 'string' || !satz.trim()) return res.status(400).json({ error_code: 'SATZ_REQUIRED' });
  if (book_id) setContext({ book: book_id });
  if (book_id) {
    if (!guardBook(req, res, book_id, 'lektor')) return;
  }
  const userEmail = sessionEmail(req);
  // Ganzer Satz im Key: zwei lange Sätze mit gleichem Anfang sind verschiedene Kontexte.
  const satzHash = crypto.createHash('sha1').update(satz.trim()).digest('hex').slice(0, 16);
  const entityKey = `${book_id || 0}|${wort.trim().toLowerCase()}|${satzHash}`;
  const existing = findActiveJobId('synonym', entityKey, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const label = 'job.label.synonymWord';
  const labelParams = { word: wort.trim() };
  const jobId = createJob('synonym', book_id || 0, userEmail, label, labelParams, entityKey);
  enqueueJob(jobId, () => runSynonymJob(jobId, wort.trim(), satz.trim(), book_id || null, userEmail, page_id || null));
  res.json({ jobId });
});

module.exports = { synonymeRouter, runSynonymJob, applySynonymAiOverrides };
