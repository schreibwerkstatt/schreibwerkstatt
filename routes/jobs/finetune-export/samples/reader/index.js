'use strict';

// Leser-Modell (Zielgruppe `reader`, docs/finetuning.md#leser-modell): Samples,
// die ein Modell für Leser trainieren statt für den Autor. Drei Einstiege, vom
// Orchestrator (../../index.js) in dieser Reihenfolge gerufen:
//   1) buildReaderSamples      — ohne KI: Innenleben aus der Werkstatt, Stimm-
//      Anker der Figuren, Grenzen (Nichtwissen, Off-Topic, Meta);
//   2) buildReaderAiSamples    — KI mit Belegpflicht: Ich-Form, Deutungen;
//   3) buildReaderConversations — mehrzügige Gespräche aus allem davor.
// Die Werkstatt-Figuren lädt (1) einmal und legt sie in ctx.readerFigures ab.

const { loadReaderFigures } = require('./figures');
const { makeReaderPush } = require('./push');
const { buildPsycheSamples } = require('./psyche');
const { buildPersonaAnchorSamples } = require('./persona');
const { buildBoundarySamples } = require('./boundaries');
const { buildReaderAiSamples: runReaderAi } = require('./ai');
const { buildReaderConversations: runConversations } = require('./conversations');
const { buildReaderSystem } = require('./system');

function buildReaderSamples(ctx) {
  ctx.readerFigures = loadReaderFigures(ctx);
  ctx.personaPairs = new Map();
  const push = makeReaderPush(ctx);
  buildPsycheSamples(ctx, ctx.readerFigures, push);
  buildPersonaAnchorSamples(ctx, ctx.readerFigures, push);
  buildBoundarySamples(ctx, ctx.readerFigures, push);
}

async function buildReaderAiSamples(ctx) {
  await runReaderAi(ctx, ctx.readerFigures || [], makeReaderPush(ctx));
}

function buildReaderConversations(ctx) {
  runConversations(ctx, makeReaderPush(ctx));
}

module.exports = { buildReaderSamples, buildReaderAiSamples, buildReaderConversations, buildReaderSystem };
