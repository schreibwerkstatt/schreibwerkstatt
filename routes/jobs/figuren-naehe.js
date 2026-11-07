'use strict';
// Nähe-Einschätzung (Job `figuren-naehe`, docs/graph.md «Nähe»): schätzt für die
// bestehenden Beziehungen eines Buchs die emotionale Nähe (−2 … +2) aus Typ,
// Beschreibung und Rollen der beiden Figuren — ohne Buchtext, ohne neuen
// Komplettlauf. Die Komplettanalyse liefert denselben Wert mit; der Job füllt
// ältere Analysen und lokale Provider nach (dort fehlt das Feld im Schema).
//
// Scope: standardmässig nur Beziehungen ohne Nähe; `alle: true` schätzt alle neu.
// SCHREIBT NUR `figure_relations.naehe` (db/figures/naehe.js).

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError, jsonBody, jobAbortControllers,
  aiCall, getPrompts, getBookPrompts, tps, startBookJob,
} = require('./shared');
const { listRelationsForNaehe, setRelationNaehe } = require('../../db/figures/naehe');
const { normNaehe } = require('../../lib/relation-naehe');

// Beziehungen pro Call: ~200 Zeichen Eingabe und ~15 Ausgabe-Tokens je Zeile.
const BATCH = 80;
const MAX_OUT_TOKENS = 4000;

async function runFigurenNaeheJob(jobId, bookId, userEmail, { alle = false } = {}) {
  const logger = makeJobLogger(jobId);
  try {
    const { buildNaeheSystemPrompt, buildNaehePrompt, buildNaeheSchema } = await getPrompts(userEmail);
    const signal = () => jobAbortControllers.get(jobId)?.signal;
    const throwIfAborted = () => {
      if (signal()?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    };

    updateJob(jobId, { statusText: 'job.phase.naeheCollect', progress: 3 });
    const rels = listRelationsForNaehe(bookId, userEmail, { nurOffen: !alle });
    if (!rels.length) throw i18nError(alle ? 'job.error.naeheNoRelations' : 'job.error.naeheNothingOpen');
    const { BUCH_KONTEXT } = await getBookPrompts(bookId, userEmail);
    const system = buildNaeheSystemPrompt();
    const schema = buildNaeheSchema();

    const queue = [];
    for (let i = 0; i < rels.length; i += BATCH) queue.push(rels.slice(i, i + BATCH));
    const tok = { in: 0, out: 0, ms: 0 };
    const AI_FROM = 8, AI_TO = 95;
    const ergebnis = [];
    let fehlend = 0, done = 0;
    logger.info(`Nähe-Einschätzung Start: book=${bookId} beziehungen=${rels.length} alle=${alle} buendel=${queue.length}`);

    while (queue.length) {
      throwIfAborted();
      const batch = queue.shift();
      const total = done + queue.length + 1;
      const from = AI_FROM + Math.floor((done / total) * (AI_TO - AI_FROM));
      const to = AI_FROM + Math.floor(((done + 1) / total) * (AI_TO - AI_FROM));
      updateJob(jobId, { statusText: 'job.phase.naeheAsk', statusParams: { done: done + 1, total }, progress: from });
      // Kurzer, batch-lokaler Schlüssel statt der DB-ID: das Modell schreibt ihn ab.
      const byKey = new Map(batch.map((r, i) => [`r${i + 1}`, r]));
      let result;
      try {
        result = await aiCall(jobId, tok,
          buildNaehePrompt({
            buchKontext: BUCH_KONTEXT,
            beziehungen: [...byKey].map(([key, r]) => ({
              key, typ: r.typ, beschreibung: r.beschreibung || '',
              von: r.from_name, vonRolle: r.from_rolle || '', zu: r.to_name, zuRolle: r.to_rolle || '',
            })),
          }),
          system, from, to, batch.length * 25, 0.2, MAX_OUT_TOKENS, undefined, schema,
        );
      } catch (e) {
        if (e?.message === 'job.error.aiTruncated' && batch.length > 1) {
          const mid = Math.ceil(batch.length / 2);
          queue.unshift(batch.slice(0, mid), batch.slice(mid));
          logger.warn(`Nähe-Einschätzung: Bündel mit ${batch.length} Beziehungen am Output-Cap abgeschnitten – wird geteilt.`);
          continue;
        }
        throw e;
      }
      if (!Array.isArray(result?.bewertungen)) throw i18nError('job.error.naeheMissing');
      const gesehen = new Set();
      for (const b of result.bewertungen) {
        const r = byKey.get(String(b?.key || '').trim());
        const v = normNaehe(b?.naehe);
        if (!r || v == null || gesehen.has(r.id)) continue;
        gesehen.add(r.id);
        ergebnis.push({ id: r.id, naehe: v });
      }
      fehlend += batch.length - gesehen.size;
      done++;
    }

    throwIfAborted();
    const geschrieben = setRelationNaehe(bookId, userEmail, ergebnis);
    const verteilung = { '-2': 0, '-1': 0, '0': 0, '1': 0, '2': 0 };
    for (const e of ergebnis) verteilung[String(e.naehe)]++;
    logger.info(`Nähe-Einschätzung fertig: book=${bookId} geschrieben=${geschrieben}/${rels.length} fehlend=${fehlend} verteilung=${JSON.stringify(verteilung)}`);
    completeJob(jobId, {
      beziehungen: rels.length, geschrieben, fehlend, verteilung,
      tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok), `${geschrieben}/${rels.length}`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Nähe-Einschätzung Fehler book=${bookId}: ${e.message}`, { stack: e.cause?.stack || e.stack });
    failJob(jobId, e);
  }
}

const figurenNaeheRouter = express.Router();

// 'editor': der Lauf schreibt an den Beziehungen. Ein Lauf pro Buch und User.
figurenNaeheRouter.post('/figuren-naehe', jsonBody, (req, res) => startBookJob(req, res, {
  type: 'figuren-naehe', minRole: 'editor', label: 'job.label.figurenNaehe',
  run: (jobId, { bookId, userEmail }) => runFigurenNaeheJob(jobId, bookId, userEmail, { alle: req.body?.alle === true }),
}));

module.exports = { figurenNaeheRouter, runFigurenNaeheJob };
