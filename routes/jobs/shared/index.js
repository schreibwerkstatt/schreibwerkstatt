'use strict';
// Facade-Re-Export: alle bisherigen `module.exports`-Keys von `shared.js`
// stehen weiterhin als `require('./shared')` zur Verfügung.
const express = require('express');
const { getPrompts, getPromptConfig } = require('../../../lib/prompts-loader');

const state    = require('./state');
const queue    = require('./queue');
const jobsMod  = require('./jobs');
const model    = require('./model');
const modelTier = require('./model-tier');
const ai       = require('./ai');
const loader   = require('./loader');
const queries  = require('./queries');
const router   = require('./router');
const { bundleBlocks } = require('./bundles');

const { getBookSettings } = require('../../../db/schema');

// Buch-Locale-Prompts mit Buchtyp + Buchkontext augmentieren. Liest
// book_settings, ohne Zeile mit den Profil-Defaults des Buch-Owners.
async function getBookPrompts(bookId, userEmail = null) {
  // userEmail waehlt zusaetzlich die Prompt-VARIANTE (cloud/local) nach dem
  // effektiven Provider dieses Users — siehe lib/prompts-loader.js.
  const { getLocalePromptsForBook } = await getPrompts(userEmail);
  const settings = bookId
    ? getBookSettings(bookId, userEmail)
    : { language: 'de', region: 'CH', buchtyp: null, buch_kontext: null, is_finished: 0, schauplatz_land: null, zeitlinie_real: 0 };
  const locale = `${settings.language}-${settings.region}`;
  return getLocalePromptsForBook(locale, settings.buchtyp || null, settings.buch_kontext || null, !!settings.is_finished, settings.schauplatz_land || null, settings.stilprofil || null, !!settings.zeitlinie_real);
}

// Text-Optionen fuer htmlToText/htmlToTextForPrompt/loadPageContents eines Jobs
// mit Buch: Nachrichtenverlauf-Marken in der Buchsprache (lib/html-text.js
// #markMsgThreads), damit ein englisches Buch keine deutschen Marken im Prompt
// traegt. Ohne Buch Deutsch, wie die Marken selbst.
function bookTextOpts(bookId, userEmail = null) {
  if (!bookId) return { langCode: 'de' };
  return { langCode: getBookSettings(bookId, userEmail).language || 'de' };
}

// Rückwärtskompatibler Export – einige Module lesen _promptConfig direkt.
const _promptConfig = getPromptConfig();

const jsonBody = express.json();
const jsonBodyLarge = express.json({ limit: '5mb' });

module.exports = {
  _promptConfig,
  jobs: state.jobs,
  runningJobs: state.runningJobs,
  jobAbortControllers: state.jobAbortControllers,
  jobQueue: state.jobQueue,
  jobKey: state.jobKey,

  makeJobLogger: jobsMod.makeJobLogger,
  enqueueJob: queue.enqueueJob,
  startBookJob: require('./start-job').startBookJob,
  komplettRunningPrecheck: require('./start-job').komplettRunningPrecheck,
  createJob: jobsMod.createJob,
  updateJob: jobsMod.updateJob,
  setJobModel: jobsMod.setJobModel,
  EMBED_PROVIDER: jobsMod.EMBED_PROVIDER,
  tps: jobsMod.tps,
  completeJob: jobsMod.completeJob,
  failJob: jobsMod.failJob,
  cancelJob: jobsMod.cancelJob,
  isJobActive: jobsMod.isJobActive,
  throwIfCancelled: jobsMod.throwIfCancelled,
  findActiveJobId: jobsMod.findActiveJobId,
  fmtTok: jobsMod.fmtTok,
  i18nError: jobsMod.i18nError,
  i18nErrText: jobsMod.i18nErrText,
  contentHttpError: jobsMod.contentHttpError,
  emptyScopeError: jobsMod.emptyScopeError,
  normalizeGesamtnote: require('./review-validate').normalizeGesamtnote,
  assertChapterAnalysis: require('./review-validate').assertChapterAnalysis,
  sortEmpfehlungen: require('./review-validate').sortEmpfehlungen,
  sigHash: require('./review-sig').sigHash,
  buildChapterPagesSig: require('./review-sig').buildChapterPagesSig,
  systemChars: require('./review-sig').systemChars,

  _modelName: model._modelName,
  applyEffortSetting: model.applyEffortSetting,
  applyReviewAiOverrides: model.applyReviewAiOverrides,
  applyTierAiOverrides: modelTier.applyTierAiOverrides,
  tierModel: modelTier.tierModel,
  settledAll: ai.settledAll,
  retryOnTransientAi: ai.retryOnTransientAi,

  htmlToText: ai.htmlToText,
  htmlToTextForPrompt: ai.htmlToTextForPrompt,
  cleanPageTextForAi: ai.cleanPageTextForAi,

  loadOrderedBookContents: loader.loadOrderedBookContents,
  idMapsFromContents: loader.idMapsFromContents,
  loadPageContents: loader.loadPageContents,
  groupByChapter: loader.groupByChapter,
  buildSinglePassBookText: loader.buildSinglePassBookText,
  splitGroupsIntoChunks: loader.splitGroupsIntoChunks,
  halveChunkPages: loader.halveChunkPages,
  pageSigSuffix: loader.pageSigSuffix,

  aiCall: ai.aiCall,
  toSystemBlocks: ai.toSystemBlocks,
  summarizeCostByPhase: ai.summarizeCostByPhase,
  formatCostByPhase: ai.formatCostByPhase,
  recordCallCost: ai.recordCallCost,

  getPrompts,
  getBookPrompts,
  bookTextOpts,

  getFiguren: queries.getFiguren,
  getLatestReview: queries.getLatestReview,
  getLatestPageCheck: queries.getLatestPageCheck,
  getOpenIdeen: queries.getOpenIdeen,
  buildChatMessageHistory: queries.buildChatMessageHistory,

  SINGLE_PASS_LIMIT: loader.SINGLE_PASS_LIMIT,
  PER_CHUNK_LIMIT: loader.PER_CHUNK_LIMIT,
  BATCH_SIZE: loader.BATCH_SIZE,
  chunkLimitsFor: loader.chunkLimitsFor,
  resolveExtractSinglePassLimit: loader.resolveExtractSinglePassLimit,
  bundleBlocks,

  jsonBody, jsonBodyLarge,
  sharedRouter: router.sharedRouter,
};
