'use strict';
// Motiv-Werkstatt: Consistency-Job (KI-Schicht ueber der Messung).
//
// Zwei Schichten, deren Trennung der Sinn des Features ist:
//   1. lib/motif-consistency.js rechnet deterministisch, was rechenbar ist
//      (Kanten gegen Ist-Verteilung) — kein Modell, keine Kosten, laeuft mit
//      jedem Board-Load ueber GET /motifs/consistency.
//   2. Dieser Job urteilt ueber das, was sich NICHT messen laesst: traegt eine
//      behauptete Beziehung in den Belegstellen? Meinen zwei Motive dasselbe?
//      Greifen die trigger_terms daneben?
// Die Messbefunde gehen als VORBEFUND in den Prompt („verwenden, nicht
// wiederholen") — dieselbe Rahmung wie der Struktur-Check in der Buchbewertung.
//
// Rein rueckwaertsgewandt: liest Katalog + Ist-Index, schreibt NIE in den
// Buchtext und NIE in den Katalog. Ergebnis ist ein Befund fuer die Autorin.

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError, jsonBody, jobAbortControllers,
  aiCall, getPrompts, getBookPrompts,
  tps, _modelName,
  startBookJob,
} = require('./shared');
const motifsDb = require('../../db/motifs');
const { getBookSettings } = require('../../db/schema');
const { computeMotifFindings, chapterStructure, relFamily } = require('../../lib/motif-consistency');
const contentStore = require('../../lib/content-store');
const { tServerParams } = require('../../lib/i18n-server');
const { motifScoreFloor } = require('../../lib/motif-floor');
const { resolveProvider } = require('../../lib/ai');

const SEVERITY = ['kritisch', 'stark', 'mittel', 'schwach', 'niedrig'];

// Belegstellen pro Motiv. Wenige und starke: listOccurrences liefert nach Score
// sortiert, die ersten sind die tragfaehigsten. Der Deckel haelt den Prompt klein —
// drei wortgetreue Stellen sagen ueber ein Motiv mehr als dreissig.
const BELEGE_PRO_MOTIV = 3;
const BELEG_MAX_CHARS = 240;

// Belegstellen + Sprungziel aus EINER Lesung je Motiv (listOccurrences liefert
// nach Score sortiert, die ersten sind die tragfaehigsten).
//   belege — die staerksten Auszuege fuer den Prompt
//   ziele  — Sprungziel je Motiv: die staerkste Fundstelle mit einer Seite.
//            Deterministisch aus dem Index gebaut, NICHT aus dem Modelltext — ein
//            Befund soll an eine echte Stelle springen, und ein halluziniertes
//            Sprungziel faellt niemandem auf.
function _belegeUndZiele(motifs, floor) {
  const belege = {};
  const ziele = {};
  for (const m of motifs) {
    if (!m.occurrenceCount) continue;
    const rows = motifsDb.listOccurrences(m.id, floor);
    const clean = rows.slice(0, BELEGE_PRO_MOTIV)
      .map(r => ({
        kapitel: r.chapter_name || null,
        snippet: String(r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, BELEG_MAX_CHARS),
      }))
      .filter(r => r.snippet);
    if (clean.length) belege[m.id] = clean;
    const row = rows.find(r => r.page_id || r.scene_page_id);
    if (row) ziele[m.id] = { page_id: row.page_id || row.scene_page_id, page_name: row.page_name || null };
  }
  return { belege, ziele };
}

const _norm = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

async function runMotifConsistencyJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  const prompts = await getPrompts(userEmail);
  const { buildMotivSystemPrompt, buildMotivConsistencyPrompt, SCHEMA_MOTIV_CONSISTENCY } = prompts;
  try {
    const provider = resolveProvider({ userEmail });

    // Score-Floor wie die Konstellation (routes/motifs.js#_motifFloor): die KI muss
    // ueber DIESELBEN Zahlen urteilen, die die Autorin im Graph sieht — sonst meldet
    // sie eine Luecke, die auf dem Bildschirm keine ist.
    const floor = motifScoreFloor();

    updateJob(jobId, { statusText: 'job.phase.motivConsistencyCollect', progress: 5 });
    const graph = motifsDb.getGraph(bookId, userEmail, floor);
    if (!graph.motifs.length) throw i18nError('job.error.motivKatalogLeer');

    // Kapitel-Struktur des ganzen Baums (ueber die Content-Store-Facade) — DIESELBE
    // wie GET /motifs/consistency, inkl. Unterkapitel und ausgeschlossener Kapitel.
    // Sonst waeren die Vorbefunde im Prompt nicht die, die die Autorin sieht, und
    // die K-Nummern im Kapitel-Verlauf verschoben sich.
    const structure = chapterStructure(await contentStore.bookTree(bookId));
    const kapitel = structure.order.map(id => ({ id, name: structure.names.get(id) }));

    // Ist der Index ueberhaupt befuellt? Ungescannt heisst ungeprueft, nicht
    // abwesend — der Prompt bekommt das ausdruecklich gesagt, sonst meldet das
    // Modell fuer jedes Motiv „kommt im Text nicht vor".
    const scanned = motifsDb.hasOccurrences(bookId, userEmail);

    // Deterministische Vorbefunde, in der Buchsprache gerendert. Der Server
    // uebersetzt hier ausnahmsweise selbst: der Text geht in den Prompt, nicht an
    // einen Betrachter — die Locale ist die des Buchs, nicht die des Browsers.
    const settings = getBookSettings(bookId, userEmail);
    const locale = settings?.language || 'de';
    const messbefunde = computeMotifFindings({
      motifs: graph.motifs, relations: graph.relations,
      structure, scanned,
    });
    // Freitext-Typen (geistNachbar gilt fuer jeden Typ) haben kein Label — dann
    // der Typ selbst statt eines rohen i18n-Keys im Prompt.
    const typLabel = (typ) => (relFamily(typ) ? tServerParams(`motiv.relation.type.${typ}`, null, locale) : typ);
    const vorbefunde = messbefunde.map(f => tServerParams(`motiv.check.${f.code}`, {
      motiv: f.motiv || '', partner: f.partner || '',
      typ: f.typ ? typLabel(f.typ) : '',
      ...(f.params || {}),
    }, locale));

    const { belege, ziele } = _belegeUndZiele(graph.motifs, floor);
    const { BUCH_KONTEXT } = await getBookPrompts(bookId, userEmail);

    logger.info(`Motiv-Consistency Start: book=${bookId} motive=${graph.motifs.length} themen=${graph.themes.length} kanten=${graph.relations.length} kapitel=${kapitel.length} belege=${Object.keys(belege).length} vorbefunde=${vorbefunde.length} gescannt=${scanned}`);
    updateJob(jobId, { statusText: 'job.phase.motivConsistencyAi', progress: 12 });

    const tok = { in: 0, out: 0, ms: 0 };
    const result = await aiCall(jobId, tok,
      buildMotivConsistencyPrompt(
        graph.themes, graph.motifs, graph.relations, kapitel, belege,
        vorbefunde, BUCH_KONTEXT, { scanned },
      ),
      buildMotivSystemPrompt(),
      12, 95, 4000, 0.3, 8000, undefined, SCHEMA_MOTIV_CONSISTENCY,
    );

    if (!Array.isArray(result?.konflikte)) throw i18nError('job.error.motivKonflikteMissing');
    if (typeof result.fazit !== 'string') throw i18nError('job.error.motivFazitMissing');

    // Modell-Output aufs eigene Motiv-Subset validieren: die ID aus dem [#…]-Marker
    // gilt nur, wenn es sie in diesem Buch gibt; sonst ueber den Namen aufloesen
    // (Modelle, die den Marker nicht zurueckgeben) — und sonst uebergreifend.
    const validIds = new Set(graph.motifs.map(m => m.id));
    const idByName = new Map(graph.motifs.map(m => [_norm(m.name), m.id]));

    const konflikte = result.konflikte
      .filter(k => k && typeof k.problem === 'string' && k.problem.trim())
      .map(k => {
        const motiv = typeof k.motiv === 'string' && k.motiv.trim() ? k.motiv.trim() : '—';
        const rawId = k.motiv_id != null ? parseInt(k.motiv_id) : null;
        let motivId = Number.isInteger(rawId) && validIds.has(rawId) ? rawId : null;
        if (motivId == null && motiv !== '—') {
          const byName = idByName.get(_norm(motiv));
          if (byName != null) motivId = byName;
        }
        return {
          motiv,
          motiv_id: motivId,
          quelle: 'ki',
          schwere: SEVERITY.includes(k.schwere) ? k.schwere : 'mittel',
          problem: k.problem.trim(),
          vorschlag: typeof k.vorschlag === 'string' ? k.vorschlag.trim() : '',
          fundstelle: (motivId != null ? ziele[motivId] : null) || null,
        };
      });
    const fazit = result.fazit.trim();

    // Lauf historisieren (best-effort — ein DB-Fehler darf das Ergebnis nicht
    // verschlucken). runId geht in den Payload, damit das Frontend den frischen
    // Lauf ohne Round-Trip als ausgewaehlt markieren kann.
    let runId = null;
    try {
      runId = motifsDb.insertConsistencyRun({
        bookId, userEmail, konfliktCount: konflikte.length,
        result: { konflikte, fazit, scanned }, model: _modelName(provider),
      });
    } catch (e) {
      logger.warn(`Motiv-Consistency-Run-Insert fehlgeschlagen book=${bookId}: ${e.message}`);
    }

    completeJob(jobId, { konflikte, fazit, scanned, runId, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `${konflikte.length} Befunde`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Motiv-Consistency Fehler book=${bookId}: ${e.message}`, { stack: e.cause?.stack || e.stack });
    failJob(jobId, e);
  }
}

const motifConsistencyRouter = express.Router();

motifConsistencyRouter.post('/motif-consistency', jsonBody, (req, res) => startBookJob(req, res, {
  type: 'motif-consistency',
  minRole: 'lektor',
  label: 'job.label.motivConsistency',
  run: (jobId, { bookId, userEmail }) => runMotifConsistencyJob(jobId, bookId, userEmail),
}));

module.exports = { motifConsistencyRouter, runMotifConsistencyJob };
