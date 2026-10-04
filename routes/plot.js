'use strict';
// Plot-Werkstatt (Beat-Board): CRUD für Akte (Spalten) + Beats (Karten) +
// Drag-&-Drop-Reordering. Pro Buch + User skopiert; ACL-Guard via
// guardBook('editor') — planendes Welt-/Plot-Werkzeug, kein Lesezugang.
//
// KI-Assistenz (Brainstorm + Consistency) läuft separat über die Job-Queue
// (routes/jobs/plot.js), nicht hier.

const express = require('express');
const { getDraftFigure } = require('../db/schema');
const plotDb = require('../db/plot');
const { toIntId } = require('../lib/validate');
const { guardBook, sessionEmail } = require('../lib/acl');
const appSettings = require('../lib/app-settings');
const { computeTimeFindings } = require('../lib/plot-time-consistency');
const { yearFromString, bookYearSpan, computeFigureYears } = require('../lib/figure-years');
const { beatsInReadingOrder } = require('../lib/plot-reading-order');
const logger = require('../logger');
const {
  _loadOwned, _requireBook, _validChapterId, _parseIntensitaet, _parseFlag,
  _anchorOpts, _withAnchor, _resolveThreadFigure, _resolveThreadDraftFigure,
} = require('./plot-helpers');

const router = express.Router();
const jsonBody = express.json();

// Status der Plot-Chat-Vorschläge (übernommen/verworfen) — PATCH /plot/chat-proposal.
router.use('/', require('./plot-chat-proposals').plotChatProposalsRouter);

// Status ist die binäre Realisierungsachse (Idee ↔ eingearbeitet). „Verworfen" ist
// ein eigenes Flag (verworfen 0/1), keine Status-Stufe. Auf Akt-Ebene gibt es
// dazu archiviert (0/1) — abgeschlossen/eingearbeitet, nicht ausgemustert.
const STATUSES = ['geplant', 'im_buch'];
const MAX_TITEL = 200;
const MAX_BESCHREIBUNG = 4000;
// `zeit` ist Freitext wie `figure_events.datum` — ein Plan traegt „Sommer 1987"
// so oft wie ein Datum. Die Jahreszahl zieht derselbe Parser heraus wie ueberall
// sonst (lib/figure-years.js#yearFromString); validiert wird hier nur die Laenge.
const MAX_ZEIT = 120;
const MAX_ACT_NAME = 120;
const MAX_THREAD_NAME = 120;
// Validierungsfehler der Reorder-Transaktionen (db/plot/structure.js + beats.js) —
// geworfen VOR jedem Schreibzugriff, die Transaktion rollt komplett zurück.
const _ORDER_ERR = new Set(['ORDER_INVALID', 'ACT_MISMATCH', 'ACT_THREAD_MISMATCH', 'ACT_SCOPE_MIXED']);

// ── Board laden ──────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const ctx = _requireBook(req, res);
  if (!ctx) return;
  const { userEmail, bookId } = ctx;
  // Ist-Index der Beat-Verankerung an jeden Beat hängen (count + Top-Fundstellen)
  // → Drift-Badge + Fundstellen-Popover im Frontend (Soll `status` vs. Ist). Kein
  // Extra-Call. navigableOnly: nur anspringbare Fundstellen (Szene ohne Seite fällt
  // raus); minScore: konfigurierbarer Score-Floor blendet schwache Treffer aus.
  const occMap = plotDb.beatOccurrenceMap(bookId, userEmail, _anchorOpts());
  const beats = plotDb.listBeats(bookId, userEmail)
    .map(b => _withAnchor(b, occMap.get(b.id) || { count: 0, top: [] }));
  // Geplante Beats werden nur verankert, wenn die Promotion-Erkennung an ist — dann
  // zählen sie auch für die Stale-Heuristik (sonst würde ein geänderter geplanter
  // Beat fälschlich zum „Verankerung aktualisieren"-Angebot führen).
  const promoteOn = (Number(appSettings.get('plot.anchor.promote_min_score')) || 0) > 0;
  const staleStatuses = promoteOn ? ['im_buch', 'geplant'] : ['im_buch'];
  res.json({
    acts: plotDb.listActs(bookId, userEmail),
    threads: plotDb.listThreads(bookId, userEmail),
    beats,
    relations: plotDb.listBeatRelations(bookId, userEmail),
    beatAnchor: {
      stale: plotDb.beatAnchorStale(bookId, userEmail, staleStatuses),
      ranAt: plotDb.beatAnchorLastRun(bookId, userEmail),
    },
  });
});

// ── Zeit-Messung ────────────────────────────────────────────────────────────
// Datierte Beats gegen Geburtsjahre, Buchspanne und Board-Reihenfolge — pure
// Rechnung in lib/plot-time-consistency.js, kein Job, kein callAI. Der KI-Check
// verlässt sich darauf, dass die App das selbst nachrechnet (prompts/plot.js).
// Reihenfolge PRO LANE (lib/plot-reading-order.js): die Chronologie wird nur
// innerhalb eines Strangs gemessen, parallele Stränge sind kein Rückschritt.
// Die Katalog-Hauptfigur des Strangs gilt in jedem Beat der Lane als beteiligt
// (Live-Vererbung). Geburtsjahr aus der SSoT lib/figure-years.js; ohne echte
// Zeitlinie ist es null, dann entsteht nur der Chronologie-/Spannen-Teil.
// `scanned` = mindestens ein Beat trägt eine Jahreszahl — undatiert ist
// ungeprüft, nicht in Ordnung.
router.get('/time-check', (req, res) => {
  const ctx = _requireBook(req, res);
  if (!ctx) return;
  const { userEmail, bookId } = ctx;
  const threads = plotDb.listThreads(bookId, userEmail);
  const threadFig = new Map(threads.filter(t => t.fig_id).map(t => [t.id, t.fig_id]));
  const beats = beatsInReadingOrder({
    acts: plotDb.listActs(bookId, userEmail), threads, beats: plotDb.listBeats(bookId, userEmail),
  }).map(b => {
    const inherited = b.thread_id != null ? threadFig.get(b.thread_id) : null;
    const figIds = inherited && !(b.fig_ids || []).includes(inherited) ? [...(b.fig_ids || []), inherited] : (b.fig_ids || []);
    return { ...b, fig_ids: figIds, jahr: yearFromString(b.zeit) };
  });
  const figures = new Map();
  const years = computeFigureYears(bookId, userEmail);
  if (years && years.size) {
    for (const f of plotDb.listFigureIdentities(bookId, userEmail)) {
      const fy = years.get(f.id);
      if (fy && fy.geburtsjahr != null) figures.set(f.fig_id, { name: f.name, geburtsjahr: fy.geburtsjahr });
    }
  }
  res.json({
    befunde: computeTimeFindings({ beats, figures, bookSpan: bookYearSpan(bookId, userEmail) }),
    scanned: beats.some(b => Number.isFinite(b.jahr)),
  });
});

// Map page_id → Anzahl nicht-verworfener Beats im Kapitel der Seite. Speist den
// Plot-Verknüpfungs-Indikator im Notebook-Editor (wie /ideen/counts,
// /research/page-counts). Pro Buch + User skopiert.
router.get('/page-beat-counts', (req, res) => {
  const ctx = _requireBook(req, res);
  if (!ctx) return;
  res.json(plotDb.pageBeatCounts(ctx.bookId, ctx.userEmail));
});

// Plot-Beteiligung einer Werkstatt-Figur: Anzahl Beats (gesamt + aktiv) + die
// Stränge, an die die Figur als Hauptfigur gebunden ist. Speist das „in N Beats
// geplant"-Badge in der Figuren-Werkstatt (Navigation Werkstatt → Plot). draft_id
// Pflicht; die Katalog-Quellfigur (source_figure_id) wird serverseitig aus dem
// Owner-geprüften Draft gezogen, nicht vom Client geliefert (kein Cross-Figur-Leak).
router.get('/figure-usage', (req, res) => {
  const ctx = _requireBook(req, res);
  if (!ctx) return;
  const { userEmail, bookId } = ctx;
  const draftId = toIntId(req.query.draft_id);
  if (!draftId) return res.status(400).json({ error_code: 'DRAFT_ID_REQ' });
  const draft = getDraftFigure(draftId);
  if (!draft || draft.user_email !== userEmail || draft.book_id !== bookId) {
    return res.json({ beatCount: 0, activeBeatCount: 0, threads: [] });
  }
  const usage = plotDb.figurePlotUsage(bookId, userEmail, {
    draftFigureId: draft.id, sourceFigureId: draft.source_figure_id,
  });
  res.json({
    beatCount: usage.beats.length,
    activeBeatCount: usage.beats.filter(b => !b.verworfen).length,
    threads: usage.threads,
  });
});

// Gegenrichtung der Beat-Brücken: Map Ziel-ID → nicht-verworfene Beats für EINE
// Achse (figure = fig_id inkl. Strang-Vererbung, location = loc_id, scene =
// figure_scenes.id aus der Beat-Verankerung). Speist die Plot-Referenzen in den
// Detailansichten von Figuren-, Orte- und Szenen-Karte (read-only, Sprung aufs
// Board). Editor+ wie das ganze Board; ein Reader bekommt 403 und die Karte
// bleibt ohne Referenzen.
const _LINK_KINDS = new Set(['figure', 'location', 'scene']);
router.get('/links', (req, res) => {
  const ctx = _requireBook(req, res);
  if (!ctx) return;
  const kind = String(req.query.kind || '');
  if (!_LINK_KINDS.has(kind)) return res.status(400).json({ error_code: 'KIND_INVALID' });
  res.json({ links: plotDb.plotEntityLinks(ctx.bookId, ctx.userEmail, kind, { minScore: _anchorOpts().minScore }) });
});

// Map chapter_id → Anzahl nicht-verworfener Beats im Kapitel. Speist den
// Plot-Verknüpfungs-Indikator in der Kapitelansicht.
router.get('/chapter-beat-counts', (req, res) => {
  const ctx = _requireBook(req, res);
  if (!ctx) return;
  res.json(plotDb.chapterBeatCounts(ctx.bookId, ctx.userEmail));
});

// ── Akte ─────────────────────────────────────────────────────────────────────
router.post('/acts', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.body?.book_id);
  const name = (req.body?.name || '').toString().trim();
  const farbe = req.body?.farbe ? String(req.body.farbe).slice(0, 32) : null;
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!name)   return res.status(400).json({ error_code: 'NAME_REQ' });
  if (name.length > MAX_ACT_NAME) return res.status(400).json({ error_code: 'NAME_TOO_LONG' });
  if (!guardBook(req, res, bookId, 'editor')) return;
  // thread_id optional: gesetzt → strang-eigener Akt (Hybrid). Fremd/leer → NULL
  // (geteilter Akt). Validierung gegen (Buch, User) via _validThreadId. Nur für
  // Stränge, die schon eigene Akte haben — die eigene Struktur entsteht per Fork
  // (Klon aller geteilten Akte), nie durch einen einzelnen Akt.
  const threadId = plotDb._validThreadId(bookId, userEmail, toIntId(req.body?.thread_id));
  if (threadId != null && !plotDb.threadHasOwnActs(bookId, userEmail, threadId)) {
    return res.status(400).json({ error_code: 'THREAD_NOT_FORKED' });
  }
  const act = plotDb.createAct(bookId, userEmail, { name, farbe, threadId });
  logger.info(`[plot] act create id=${act.id} book=${bookId} thread=${threadId ?? '-'}`);
  res.json(act);
});

router.patch('/acts/:id', jsonBody, (req, res) => {
  const act = _loadOwned(req, res, plotDb.getAct, 'ACT_NOT_FOUND');
  if (!act) return;
  const id = act.id;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : act.name;
  if (!name) return res.status(400).json({ error_code: 'NAME_REQ' });
  if (name.length > MAX_ACT_NAME) return res.status(400).json({ error_code: 'NAME_TOO_LONG' });
  const farbe = typeof req.body?.farbe === 'string' ? req.body.farbe.slice(0, 32)
    : (req.body?.farbe === null ? null : act.farbe);
  // archiviert (0/1): Akt abgeschlossen (Beats eingearbeitet) → raus aus dem
  // Board-Alltag. Eigene Achse, kein Status: die Beats bleiben unangetastet und
  // zaehlen weiter in allen Kennzahlen (siehe db/plot.js).
  const archiviert = typeof req.body?.archiviert !== 'undefined'
    ? _parseFlag(req.body.archiviert)
    : (act.archiviert ? 1 : 0);
  if (archiviert === undefined) return res.status(400).json({ error_code: 'INVALID_FLAG' });
  res.json(plotDb.updateAct(id, { name, farbe, archiviert }));
});

router.delete('/acts/:id', (req, res) => {
  const act = _loadOwned(req, res, plotDb.getAct, 'ACT_NOT_FOUND');
  if (!act) return;
  plotDb.deleteAct(act.id);
  logger.info(`[plot] act delete id=${act.id} book=${act.book_id}`);
  res.json({ ok: true });
});

router.put('/acts/order', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.body?.book_id);
  const order = Array.isArray(req.body?.order) ? req.body.order : null;
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!order)  return res.status(400).json({ error_code: 'ORDER_REQ' });
  if (!guardBook(req, res, bookId, 'editor')) return;
  try {
    plotDb.reorderActs(bookId, userEmail, order);
  } catch (e) {
    if (_ORDER_ERR.has(e.code)) return res.status(400).json({ error_code: e.code });
    throw e;
  }
  res.json({ ok: true });
});

// ── Handlungsstränge (Swimlanes) ───────────────────────────────────────────
router.post('/threads', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.body?.book_id);
  const name = (req.body?.name || '').toString().trim();
  const farbe = req.body?.farbe ? String(req.body.farbe).slice(0, 32) : null;
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!name)   return res.status(400).json({ error_code: 'NAME_REQ' });
  if (name.length > MAX_THREAD_NAME) return res.status(400).json({ error_code: 'NAME_TOO_LONG' });
  if (!guardBook(req, res, bookId, 'editor')) return;
  // Figurenbindung exklusiv: Katalog ODER Werkstatt, nie beides.
  if (req.body?.figure_id && req.body?.draft_figure_id) return res.status(400).json({ error_code: 'THREAD_FIGURE_CONFLICT' });
  const figureId = _resolveThreadFigure(bookId, userEmail, req.body?.figure_id);
  const draftFigureId = _resolveThreadDraftFigure(bookId, userEmail, req.body?.draft_figure_id);
  const chapterId = _validChapterId(bookId, toIntId(req.body?.chapter_id));
  const thread = plotDb.createThread(bookId, userEmail, { name, farbe, figureId, draftFigureId, chapterId });
  logger.info(`[plot] thread create id=${thread.id} book=${bookId}`);
  res.json(thread);
});

router.patch('/threads/:id', jsonBody, (req, res) => {
  const thread = _loadOwned(req, res, plotDb.getThread, 'THREAD_NOT_FOUND');
  if (!thread) return;
  const id = thread.id;
  const userEmail = thread.user_email;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : thread.name;
  if (!name) return res.status(400).json({ error_code: 'NAME_REQ' });
  if (name.length > MAX_THREAD_NAME) return res.status(400).json({ error_code: 'NAME_TOO_LONG' });
  const farbe = typeof req.body?.farbe === 'string' ? req.body.farbe.slice(0, 32)
    : (req.body?.farbe === null ? null : thread.farbe);
  // Bindung nur ändern, wenn der Key explizit mitkommt — sonst Bestand behalten.
  // Exklusiv: eine gesetzte Katalog-Bindung leert die Werkstatt-Bindung und
  // umgekehrt; beide zugleich zu setzen ist ein Client-Fehler.
  if (req.body?.figure_id && req.body?.draft_figure_id) return res.status(400).json({ error_code: 'THREAD_FIGURE_CONFLICT' });
  let figureId = thread.figure_id;
  let draftFigureId = thread.draft_figure_id;
  if (typeof req.body?.figure_id !== 'undefined') {
    figureId = _resolveThreadFigure(thread.book_id, userEmail, req.body.figure_id);
    if (figureId != null) draftFigureId = null;
  }
  if (typeof req.body?.draft_figure_id !== 'undefined') {
    draftFigureId = _resolveThreadDraftFigure(thread.book_id, userEmail, req.body.draft_figure_id);
    if (draftFigureId != null) figureId = null;
  }
  // Kapitel-Bindung nur ändern, wenn der Key explizit mitkommt — sonst Bestand.
  let chapterId = thread.chapter_id;
  if (typeof req.body?.chapter_id !== 'undefined') {
    chapterId = _validChapterId(thread.book_id, toIntId(req.body.chapter_id));
  }
  res.json(plotDb.updateThread(id, { name, farbe, figureId, draftFigureId, chapterId }));
});

router.delete('/threads/:id', (req, res) => {
  const thread = _loadOwned(req, res, plotDb.getThread, 'THREAD_NOT_FOUND');
  if (!thread) return;
  plotDb.deleteThread(thread.id);
  logger.info(`[plot] thread delete id=${thread.id} book=${thread.book_id}`);
  res.json({ ok: true });
});

router.put('/threads/order', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.body?.book_id);
  const order = Array.isArray(req.body?.order) ? req.body.order : null;
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!order)  return res.status(400).json({ error_code: 'ORDER_REQ' });
  if (!guardBook(req, res, bookId, 'editor')) return;
  plotDb.reorderThreads(bookId, userEmail, order);
  res.json({ ok: true });
});

// Eigene Aktstruktur für einen Strang aktivieren (Hybrid-Akte): die geteilten Akte
// werden in den Strang geklont, dessen Beats wandern auf die Klone. Braucht ≥1
// geteilten Akt (sonst NO_SHARED_ACTS). Idempotent (schon geforkt → ok).
router.post('/threads/:id/fork-acts', (req, res) => {
  const thread = _loadOwned(req, res, plotDb.getThread, 'THREAD_NOT_FOUND');
  if (!thread) return;
  try {
    plotDb.forkThreadActs(thread.book_id, thread.user_email, thread.id);
  } catch (e) {
    if (e.code === 'NO_SHARED_ACTS') return res.status(400).json({ error_code: 'NO_SHARED_ACTS' });
    throw e;
  }
  logger.info(`[plot] thread fork-acts id=${thread.id} book=${thread.book_id}`);
  res.json({ ok: true });
});

// Eigene Aktstruktur auflösen: Beats zurück auf die geteilten Akte umhängen
// (positionsweise) und die strang-eigenen Akte löschen.
router.delete('/threads/:id/fork-acts', (req, res) => {
  const thread = _loadOwned(req, res, plotDb.getThread, 'THREAD_NOT_FOUND');
  if (!thread) return;
  plotDb.unforkThreadActs(thread.book_id, thread.user_email, thread.id);
  logger.info(`[plot] thread unfork-acts id=${thread.id} book=${thread.book_id}`);
  res.json({ ok: true });
});

// ── Beats ──────────────────────────────────────────────────────────────────
router.post('/beats', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.body?.book_id);
  const actId = toIntId(req.body?.act_id);
  const titel = (req.body?.titel || '').toString().trim();
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!actId)  return res.status(400).json({ error_code: 'ACTID_REQ' });
  if (!titel)  return res.status(400).json({ error_code: 'TITEL_REQ' });
  if (titel.length > MAX_TITEL) return res.status(400).json({ error_code: 'TITEL_TOO_LONG' });
  if (!guardBook(req, res, bookId, 'editor')) return;

  const act = plotDb.getAct(actId);
  if (!act || act.book_id !== bookId || act.user_email !== userEmail) {
    return res.status(400).json({ error_code: 'ACT_MISMATCH' });
  }
  const beschreibung = req.body?.beschreibung ? String(req.body.beschreibung).slice(0, MAX_BESCHREIBUNG) : null;
  const status = typeof req.body?.status === 'undefined' ? 'geplant' : req.body.status;
  if (!STATUSES.includes(status)) return res.status(400).json({ error_code: 'INVALID_STATUS' });
  const verworfen = typeof req.body?.verworfen === 'undefined' ? 0 : _parseFlag(req.body.verworfen);
  if (verworfen === undefined) return res.status(400).json({ error_code: 'INVALID_FLAG' });
  const chapterId = _validChapterId(bookId, toIntId(req.body?.chapter_id));
  const intensitaet = typeof req.body?.intensitaet === 'undefined' ? null : _parseIntensitaet(req.body.intensitaet);
  if (intensitaet === undefined) return res.status(400).json({ error_code: 'INVALID_INTENSITAET' });
  const zeit = req.body?.zeit ? String(req.body.zeit).trim().slice(0, MAX_ZEIT) || null : null;
  const threadId = plotDb._validThreadId(bookId, userEmail, toIntId(req.body?.thread_id));
  if (!plotDb.actFitsThread(act, threadId)) return res.status(400).json({ error_code: 'ACT_THREAD_MISMATCH' });
  const figureIds = plotDb.resolveFigureIds(bookId, userEmail, req.body?.figure_ids);
  const draftFigureIds = plotDb.resolveDraftFigureIds(bookId, userEmail, req.body?.draft_figure_ids);
  const motifIds = plotDb.resolveMotifIds(bookId, userEmail, req.body?.motif_ids);
  const locationIds = plotDb.resolveLocationIds(bookId, req.body?.location_ids);

  const beat = plotDb.createBeat(bookId, actId, userEmail, { titel, beschreibung, status, verworfen, chapterId, intensitaet, zeit, threadId, figureIds, draftFigureIds, motifIds, locationIds });
  logger.info(`[plot] beat create id=${beat.id} act=${actId} book=${bookId}`);
  res.json(_withAnchor(beat));
});

router.patch('/beats/:id', jsonBody, (req, res) => {
  const beat = _loadOwned(req, res, plotDb.getBeatMeta, 'BEAT_NOT_FOUND');
  if (!beat) return;
  const id = beat.id;
  const userEmail = beat.user_email;

  const fields = {};
  if (typeof req.body?.titel === 'string') {
    const t = req.body.titel.trim();
    if (!t) return res.status(400).json({ error_code: 'TITEL_REQ' });
    if (t.length > MAX_TITEL) return res.status(400).json({ error_code: 'TITEL_TOO_LONG' });
    fields.titel = t;
  }
  if (typeof req.body?.beschreibung === 'string') {
    fields.beschreibung = req.body.beschreibung.slice(0, MAX_BESCHREIBUNG) || null;
  }
  if (typeof req.body?.status !== 'undefined') {
    if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error_code: 'INVALID_STATUS' });
    fields.status = req.body.status;
  }
  if (typeof req.body?.verworfen !== 'undefined') {
    fields.verworfen = _parseFlag(req.body.verworfen);
    if (fields.verworfen === undefined) return res.status(400).json({ error_code: 'INVALID_FLAG' });
  }
  if (typeof req.body?.chapter_id !== 'undefined') {
    fields.chapter_id = _validChapterId(beat.book_id, toIntId(req.body.chapter_id));
  }
  if (typeof req.body?.intensitaet !== 'undefined') {
    fields.intensitaet = _parseIntensitaet(req.body.intensitaet);
    if (fields.intensitaet === undefined) return res.status(400).json({ error_code: 'INVALID_INTENSITAET' });
  }
  if (typeof req.body?.zeit !== 'undefined') {
    const z = req.body.zeit == null ? '' : String(req.body.zeit).trim();
    fields.zeit = z ? z.slice(0, MAX_ZEIT) : null;
  }
  // act_id-Move ohne Reorder (z.B. Detail-Edit): act muss zum Buch gehören.
  if (typeof req.body?.act_id !== 'undefined') {
    const act = plotDb.getAct(toIntId(req.body.act_id));
    if (!act || act.book_id !== beat.book_id || act.user_email !== userEmail) {
      return res.status(400).json({ error_code: 'ACT_MISMATCH' });
    }
    fields.act_id = act.id;
  }
  // thread_id-Zuordnung (Strang) — Fremd/leer → NULL („ohne Strang"-Lane).
  if (typeof req.body?.thread_id !== 'undefined') {
    fields.thread_id = plotDb._validThreadId(beat.book_id, userEmail, toIntId(req.body.thread_id));
  }
  // Akt-Strang-Kompatibilität des RESULTIERENDEN Paars prüfen (Hybrid-Akte).
  if (typeof fields.act_id !== 'undefined' || typeof fields.thread_id !== 'undefined') {
    const effActId = typeof fields.act_id !== 'undefined' ? fields.act_id : beat.act_id;
    const effThreadId = typeof fields.thread_id !== 'undefined' ? fields.thread_id : (beat.thread_id ?? null);
    const effAct = plotDb.getAct(effActId);
    if (effAct && !plotDb.actFitsThread(effAct, effThreadId)) {
      return res.status(400).json({ error_code: 'ACT_THREAD_MISMATCH' });
    }
  }
  const figureIds = Array.isArray(req.body?.figure_ids)
    ? plotDb.resolveFigureIds(beat.book_id, userEmail, req.body.figure_ids)
    : undefined;
  const draftFigureIds = Array.isArray(req.body?.draft_figure_ids)
    ? plotDb.resolveDraftFigureIds(beat.book_id, userEmail, req.body.draft_figure_ids)
    : undefined;
  const motifIds = Array.isArray(req.body?.motif_ids)
    ? plotDb.resolveMotifIds(beat.book_id, userEmail, req.body.motif_ids)
    : undefined;
  const locationIds = Array.isArray(req.body?.location_ids)
    ? plotDb.resolveLocationIds(beat.book_id, req.body.location_ids)
    : undefined;

  if (!Object.keys(fields).length && typeof figureIds === 'undefined' && typeof draftFigureIds === 'undefined'
      && typeof motifIds === 'undefined' && typeof locationIds === 'undefined') {
    return res.status(400).json({ error_code: 'NO_FIELDS' });
  }
  res.json(_withAnchor(plotDb.updateBeat(id, fields, figureIds, draftFigureIds, motifIds, locationIds)));
});

router.delete('/beats/:id', (req, res) => {
  const beat = _loadOwned(req, res, plotDb.getBeatMeta, 'BEAT_NOT_FOUND');
  if (!beat) return;
  plotDb.deleteBeat(beat.id);
  logger.info(`[plot] beat delete id=${beat.id} book=${beat.book_id}`);
  res.json({ ok: true });
});

router.put('/beats/order', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.body?.book_id);
  const order = Array.isArray(req.body?.order) ? req.body.order : null;
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!order)  return res.status(400).json({ error_code: 'ORDER_REQ' });
  if (!guardBook(req, res, bookId, 'editor')) return;
  try {
    plotDb.reorderBeats(bookId, userEmail, order);
  } catch (e) {
    if (_ORDER_ERR.has(e.code)) return res.status(400).json({ error_code: e.code });
    throw e;
  }
  res.json({ ok: true });
});

// ── Beat-Beziehungen (Kausalität + Setup/Payoff) ────────────────────────────
// Gerichtete Kante from_beat --typ--> to_beat. Beide Beats werden serverseitig aufs
// (Buch, User)-Subset validiert; Selbst-Kanten + Fremd-Verweise sind unmöglich.
const _REL_ERR = { SELF_RELATION: 'SELF_RELATION', BEAT_MISMATCH: 'BEAT_MISMATCH', BEAT_REQUIRED: 'BEAT_REQUIRED', TYP_REQUIRED: 'TYP_REQUIRED' };
router.post('/beat-relations', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.body?.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!guardBook(req, res, bookId, 'editor')) return;
  try {
    const rel = plotDb.createBeatRelation(bookId, userEmail, {
      fromBeatId: toIntId(req.body?.from_beat_id),
      toBeatId: toIntId(req.body?.to_beat_id),
      typ: req.body?.typ,
    });
    if (!rel) return res.status(400).json({ error_code: 'REL_FAILED' });
    logger.info(`[plot] beat-relation create id=${rel.id} from=${rel.from_beat_id} to=${rel.to_beat_id} book=${bookId}`);
    res.json(rel);
  } catch (e) {
    return res.status(400).json({ error_code: _REL_ERR[e.code] || 'REL_FAILED' });
  }
});

router.delete('/beat-relations/:id', (req, res) => {
  const rel = _loadOwned(req, res, plotDb.getBeatRelation, 'REL_NOT_FOUND');
  if (!rel) return;
  plotDb.deleteBeatRelation(rel.id, rel.user_email);
  logger.info(`[plot] beat-relation delete id=${rel.id} book=${rel.book_id}`);
  res.json({ ok: true });
});

// ── Konsistenz-Prüfungs-Historie ────────────────────────────────────────────
// Persistierte Plot-Consistency-Läufe pro (Buch, User), damit der User frühere
// Prüfungen später nochmal ansehen kann. Insert geschieht beim Job-Complete in
// routes/jobs/plot.js. Hier nur Lesen + Löschen.
router.get('/consistency-runs', (req, res) => {
  const ctx = _requireBook(req, res);
  if (!ctx) return;
  res.json(plotDb.listPlotConsistencyRuns(ctx.bookId, ctx.userEmail));
});

router.get('/consistency-runs/:id', (req, res) => {
  const run = _loadOwned(req, res, plotDb.getPlotConsistencyRun, 'RUN_NOT_FOUND');
  if (!run) return;
  res.json(run);
});

router.delete('/consistency-runs/:id', (req, res) => {
  const run = _loadOwned(req, res, plotDb.getPlotConsistencyRun, 'RUN_NOT_FOUND');
  if (!run) return;
  plotDb.deletePlotConsistencyRun(run.id, run.user_email);
  res.json({ ok: true });
});

// ── Brainstorm-Lauf-Historie ─────────────────────────────────────────────────
// Persistierte Plot-Brainstorm-Läufe pro (Buch, User), zusätzlich pro Akt/Strang.
// Insert geschieht beim Job-Complete in routes/jobs/plot.js. Hier nur Lesen +
// Löschen. Liste mit act_name/thread_name (JOIN, nullbar bei gelöschtem Akt/Strang).
router.get('/brainstorm-runs', (req, res) => {
  const ctx = _requireBook(req, res);
  if (!ctx) return;
  res.json(plotDb.listPlotBrainstormRuns(ctx.bookId, ctx.userEmail));
});

router.get('/brainstorm-runs/:id', (req, res) => {
  const run = _loadOwned(req, res, plotDb.getPlotBrainstormRun, 'RUN_NOT_FOUND');
  if (!run) return;
  res.json(run);
});

router.delete('/brainstorm-runs/:id', (req, res) => {
  const run = _loadOwned(req, res, plotDb.getPlotBrainstormRun, 'RUN_NOT_FOUND');
  if (!run) return;
  plotDb.deletePlotBrainstormRun(run.id, run.user_email);
  res.json({ ok: true });
});

module.exports = router;
