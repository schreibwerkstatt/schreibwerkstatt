'use strict';
// Plot-Werkstatt: Kontext-Loader + Kontext-Budget für Brainstorm und Consistency
// (routes/jobs/plot.js). Liest, kappt und priorisiert; die Prompt-Darstellung
// liegt in public/js/prompts/plot*.js.
//
// Gekappt wird hier — und jede Kappung wird als { shown, total } in `kuerzungen`
// gemeldet, damit der Prompt „(N von M gezeigt)" ausweist. Eine stille Kappung
// liesse die KI das Fehlende als Mangel melden.

const { i18nError, getBookPrompts, getFiguren, loadOrderedBookContents } = require('../shared');
const { getContextConfigFor, resolveProvider } = require('../../../lib/ai');
const { db } = require('../../../db/connection');
const plotDb = require('../../../db/plot');
const draftFiguresDb = require('../../../db/draft-figures');
const { extractPsychologie } = require('../../../lib/draft-mindmap-extract');
const { getLatestContinuityCheck, listWorldFacts, worldFactsScanState, getBookSettings } = require('../../../db/schema');
const { listFigureEventsWithNames, listScenesWithChapterNames } = require('../../../db/content-names');
const logger = require('../../../logger');
const { ideaNotesByTarget } = require('../../../lib/idea-context');

// Wandelt einen echten Lade-/DB-Fehler in einen i18n-Job-Fehler um (Original als
// `cause` für den Log). Ein leeres Ergebnis ist kein Fehler.
function _plotContextError(source, cause) {
  const err = i18nError('job.error.plot.contextLoadFailed', { source });
  err.cause = cause;
  return err;
}

function _loadCtx(source, fn) {
  try { return fn(); }
  catch (e) { throw _plotContextError(source, e); }
}

// Liste nach Relevanz kappen: relevante Einträge zuerst, Rest auffüllen; die
// Ausgabe behält die Ursprungsreihenfolge (Buch-/Board-Ordnung bleibt lesbar).
function prioritize(list, cap, isRelevant = null) {
  const all = list || [];
  if (all.length <= cap) return { items: all, total: all.length };
  const keep = new Set();
  if (isRelevant) for (let i = 0; i < all.length && keep.size < cap; i++) if (isRelevant(all[i])) keep.add(i);
  for (let i = 0; i < all.length && keep.size < cap; i++) keep.add(i);
  return { items: all.filter((_, i) => keep.has(i)), total: all.length };
}

// Adaptives Kontext-Budget nach Eingabe-Budget des effektiven Providers.
function ctxLimits(userEmail) {
  let budgetChars = 600000;
  try {
    budgetChars = getContextConfigFor(resolveProvider({ userEmail })).inputBudgetChars || budgetChars;
  } catch { /* Default = grosszügig */ }
  if (budgetChars < 80000) {
    return { figuren: 25, relPerFig: 4, evtPerFig: 0, kapitel: 40, szenen: 30, orte: 15, zeitstrahl: 0, kontinuitaet: 8, recherche: 8, weltgesetze: 15,
      beats: 60, descMax: 100, werkstattFiguren: 12, relationen: 30, vorlauf: 10 };
  }
  if (budgetChars < 250000) {
    return { figuren: 45, relPerFig: 6, evtPerFig: 4, kapitel: 80, szenen: 70, orte: 30, zeitstrahl: 60, kontinuitaet: 15, recherche: 25, weltgesetze: 40,
      beats: 150, descMax: 160, werkstattFiguren: 30, relationen: 80, vorlauf: 20 };
  }
  return { figuren: 120, relPerFig: 12, evtPerFig: 10, kapitel: 200, szenen: 150, orte: 60, zeitstrahl: 200, kontinuitaet: 40, recherche: 60, weltgesetze: 90,
    beats: 400, descMax: 200, werkstattFiguren: 60, relationen: 120, vorlauf: 30 };
}

// Figuren-Ensemble (voll, ungekappt) mit Beziehungspartnern als Namen.
function figurenContext(bookId, userEmail) {
  const figuren = getFiguren(bookId, userEmail);
  const nameById = {};
  for (const f of figuren) nameById[f.id] = f.name;
  return figuren.map(f => ({
    id: f.id,
    name: f.name,
    typ: f.typ || null,
    kurzname: f.kurzname || null,
    beschreibung: f.beschreibung || null,
    beruf: f.beruf || null,
    geschlecht: f.geschlecht || null,
    tags: Array.isArray(f.eigenschaften) ? f.eigenschaften : [],
    beziehungen: Array.isArray(f.beziehungen)
      ? f.beziehungen
          .map(b => ({ mit: nameById[b.mit] || null, typ: b.typ || null, beschreibung: b.beschreibung || null }))
          .filter(b => b.mit)
      : [],
    lebensereignisse: Array.isArray(f.lebensereignisse)
      ? f.lebensereignisse.map(e => ({ datum: e.datum || null, ereignis: e.ereignis || null, typ: e.typ || null, kapitel: e.kapitel || null }))
      : [],
  }));
}

function _trimFigur(f, limits) {
  return {
    ...f,
    beziehungen: (f.beziehungen || []).slice(0, limits.relPerFig),
    lebensereignisse: limits.evtPerFig ? (f.lebensereignisse || []).slice(0, limits.evtPerFig) : [],
  };
}

// Schauplätze (nicht veraltete). locations ist keine pages/chapters/books.
function _orteContext(bookId, userEmail) {
  return _loadCtx('orte', () => db.prepare(`
    SELECT name, typ, beschreibung, stimmung
      FROM locations
     WHERE book_id = ? AND user_email = ? AND stale = 0
     ORDER BY sort_order, id
  `).all(parseInt(bookId), userEmail).map(o => ({
    name: o.name, typ: o.typ || null, beschreibung: o.beschreibung || null, stimmung: o.stimmung || null,
  })));
}

function _zeitstrahlContext(bookId, userEmail) {
  return _loadCtx('zeitstrahl', () => listFigureEventsWithNames(parseInt(bookId), userEmail, 300).map(e => ({
    datum: e.datum || null, ereignis: e.ereignis, typ: e.typ || null, figur: e.figur || null, kapitel: e.kapitel || null,
  })));
}

// Offene Kontinuitäts-Befunde aus dem letzten Continuity-Check (nur Consistency).
function kontinuitaetContext(bookId, userEmail) {
  return _loadCtx('kontinuitaet', () => {
    const check = getLatestContinuityCheck(bookId, userEmail);
    if (!check || !Array.isArray(check.issues)) return [];
    return check.issues
      .filter(i => !i.resolved)
      .map(i => ({
        schwere: i.schwere || null,
        typ: i.typ || null,
        beschreibung: i.beschreibung || null,
        figuren: Array.isArray(i.figuren) ? i.figuren : [],
        kapitel: Array.isArray(i.kapitel) ? i.kapitel : [],
        empfehlung: i.empfehlung || null,
      }));
  });
}

// An Beats/Stränge geknüpfte Recherche-Fundstücke, gruppiert pro Item. body fällt
// auf doc_text zurück. research_*/plot_* sind keine pages/chapters/books.
function rechercheContext(bookId, userEmail) {
  return _loadCtx('recherche', () => {
    const rows = db.prepare(`
      SELECT ri.id, ri.title, ri.body, ri.source, ri.doc_text,
             ril.target_kind, ril.beat_id, ril.thread_id,
             pb.titel AS beat_titel, pt.name AS thread_name
        FROM research_item_links ril
        JOIN research_items ri ON ri.id = ril.item_id
        LEFT JOIN plot_beats   pb ON pb.id = ril.beat_id
        LEFT JOIN plot_threads pt ON pt.id = ril.thread_id
       WHERE ri.book_id = ? AND ri.user_email = ?
         AND ri.archived = 0
         AND ril.target_kind IN ('beat', 'thread')
       ORDER BY ri.pinned DESC, ri.updated_at DESC, ri.id
    `).all(parseInt(bookId), userEmail);
    const byItem = new Map();
    for (const r of rows) {
      let it = byItem.get(r.id);
      if (!it) {
        it = {
          id: r.id,
          title: r.title || null,
          body: (r.body && r.body.trim()) ? r.body : (r.doc_text || null),
          source: r.source || null,
          beats: [], beatIds: [], threads: [], threadIds: [],
        };
        byItem.set(r.id, it);
      }
      if (r.target_kind === 'beat' && r.beat_id != null) {
        it.beatIds.push(r.beat_id);
        if (r.beat_titel) it.beats.push(r.beat_titel);
      } else if (r.target_kind === 'thread' && r.thread_id != null) {
        it.threadIds.push(r.thread_id);
        if (r.thread_name) it.threads.push(r.thread_name);
      }
    }
    return [...byItem.values()];
  });
}

// Werkstatt-Figuren mit psychologischen Kernen der Mindmap.
function _werkstattFigurenContext(bookId, userEmail) {
  return _loadCtx('werkstattFiguren', () => draftFiguresDb.listDraftFigures(bookId, userEmail)
    .map(d => ({ id: d.id, name: d.name, archetype: d.archetype || null, psychologie: extractPsychologie(d.mindmap) })));
}

// Kapitel in Buchorganizer-Reihenfolge über die Content-Store-Facade.
async function _kapitelContext(bookId) {
  try {
    const { chaptersFlat } = await loadOrderedBookContents(bookId);
    return (chaptersFlat || []).map((c, i) => ({ id: c.id, nr: i + 1, name: c.name }));
  } catch (e) {
    throw _plotContextError('kapitel', e);
  }
}

// Extrahierte, nicht veraltete Szenen mit Kapitel + beteiligten Figuren (ungekappt;
// Auswahl nach Relevanz in consistencyExtras).
function _szenenContext(bookId, userEmail) {
  return _loadCtx('szenen', () => {
    const scenes = listScenesWithChapterNames(parseInt(bookId), userEmail, 5000, { excludeStale: true });
    if (!scenes.length) return [];
    const figRows = db.prepare(`
      SELECT sf.scene_id, f.name
        FROM scene_figures sf
        JOIN figure_scenes fs ON fs.id = sf.scene_id
        JOIN figures f ON f.id = sf.figure_id
       WHERE fs.book_id = ? AND fs.user_email = ? AND fs.stale = 0
    `).all(parseInt(bookId), userEmail);
    const byScene = {};
    for (const r of figRows) (byScene[r.scene_id] = byScene[r.scene_id] || []).push(r.name);
    return scenes.map(s => ({ titel: s.titel, kapitel: s.kapitel, chapter_id: s.chapter_id ?? null, figuren: byScene[s.id] || [] }));
  });
}

// Handlungsstränge mit aufgelöster Hauptfigur (Katalog über TEXT-fig_id, Werkstatt
// über draft_figures.id). Leeres Board → [] (flaches Board, opt-in).
function _threadContext(bookId, userEmail) {
  const { threads, figByFigId, draftById } = _loadCtx('threads', () => {
    const threads = plotDb.listThreads(bookId, userEmail);
    const figByFigId = {}, draftById = {};
    if (threads.length) {
      for (const r of db.prepare('SELECT fig_id, name FROM figures WHERE book_id = ? AND user_email = ?').all(parseInt(bookId), userEmail)) {
        figByFigId[r.fig_id] = r.name;
      }
      for (const d of draftFiguresDb.listDraftFigures(bookId, userEmail)) draftById[d.id] = d.name;
    }
    return { threads, figByFigId, draftById };
  });
  // Pendenzen des Autors am Strang (wie am Beat, siehe commonPlotContext).
  const ideasByThread = threads.length ? ideaNotesByTarget('thread', bookId, userEmail) : new Map();
  return threads.map(t => ({
    id: t.id,
    name: t.name,
    fig_id: t.fig_id || null,
    draft_figure_id: t.draft_figure_id || null,
    figur: t.fig_id ? (figByFigId[t.fig_id] || null)
      : (t.draft_figure_id ? (draftById[t.draft_figure_id] || null) : null),
    kapitel: t.chapter_name || null,
    chapter_id: t.chapter_id || null,
    ...(ideasByThread.has(t.id) ? { ideen: ideasByThread.get(t.id) } : {}),
  }));
}

// Textbeleg-Index als plain object beat_id → { count, top[] }; nur befüllt (sonst
// hiesse „KEIN Textbeleg" bloss „nie gescannt"). Best-effort.
function anchorContext(bookId, userEmail) {
  try {
    const map = plotDb.beatOccurrenceMap(bookId, userEmail);
    let occTotal = 0;
    const obj = {};
    for (const [beatId, e] of map) { obj[beatId] = e; occTotal += e.count; }
    if (occTotal === 0) return { anchorMap: null, anchorInfo: {} };
    return { anchorMap: obj, anchorInfo: { stale: plotDb.beatAnchorStale(bookId, userEmail) } };
  } catch (e) {
    logger.warn(`[plot-consistency] Textbeleg-Kontext übersprungen: ${e.message}`);
    return { anchorMap: null, anchorInfo: {} };
  }
}

// Weltgesetze (world_facts regel/technik). Leerer Index = „nie analysiert" → Block
// fällt weg. Best-effort: ein Fehler hier darf den Check nicht failen.
function weltgesetzeContext(bookId, userEmail) {
  try {
    const { scanned } = worldFactsScanState(bookId, userEmail);
    if (!scanned) return [];
    return listWorldFacts(bookId, userEmail, { kategorien: ['regel', 'technik'] })
      .map(f => ({ kategorie: f.kategorie, subjekt: f.subjekt, fakt: f.fakt, kapitel: f.kapitel }));
  } catch (e) {
    logger.warn(`[plot-consistency] Weltgesetz-Kontext übersprungen: ${e.message}`);
    return [];
  }
}

// Beats mit aufgelösten Figuren-Namen (Katalog über TEXT-fig_id, Werkstatt über
// draft_figures.id) — der Prompt-Builder bleibt namensbasiert.
function enrichBeats(beats, figuren, werkstatt) {
  const figName = new Map((figuren || []).map(f => [f.id, f.name]));
  const wfName = new Map((werkstatt || []).map(w => [w.id, w.name]));
  return (beats || []).map(b => ({
    ...b,
    figuren_namen: (b.fig_ids || []).map(id => figName.get(id)).filter(Boolean),
    werkstatt_namen: (b.draft_fig_ids || []).map(id => wfName.get(id)).filter(Boolean),
  }));
}

// Kapitel, auf die das Board zeigt: eigenes Beat-Kapitel oder (geerbt) das des Strangs.
function linkedChapterIds(beats, threads) {
  const byThread = new Map((threads || []).map(t => [t.id, t.chapter_id]));
  const ids = new Set();
  for (const b of beats || []) {
    if (b.verworfen) continue;
    const cid = b.chapter_id != null ? b.chapter_id : (b.thread_id != null ? byThread.get(b.thread_id) : null);
    if (cid != null) ids.add(cid);
  }
  return ids;
}

// Board-Beats fürs Outline kappen: verworfene zuerst opfern, Board-Ordnung bleibt.
function capBeats(beats, cap) {
  return prioritize(beats, cap, b => !b.verworfen);
}

// Gemeinsamer Kontext beider Jobs. Liefert gekappte Listen + `kuerzungen` + die
// volle Beat-Liste (für Aktions-Validierung) und die Outline-Beats (gekappt).
async function commonPlotContext(bookId, userEmail) {
  const { BUCH_KONTEXT } = await getBookPrompts(bookId, userEmail);
  const settings = getBookSettings(bookId, userEmail) || {};
  const locale = `${settings.language || 'de'}-${settings.region || 'CH'}`;
  const limits = ctxLimits(userEmail);
  const threads = _threadContext(bookId, userEmail);
  const allFiguren = figurenContext(bookId, userEmail);
  const allWerkstatt = _werkstattFigurenContext(bookId, userEmail);
  // Pendenzen des Autors am Beat (offen/in Arbeit/verworfen) — der Prompt zeigt sie
  // am Beat: bekannte Probleme nicht neu melden, Verworfenes nicht neu vorschlagen.
  const ideasByBeat = ideaNotesByTarget('beat', bookId, userEmail);
  const beats = enrichBeats(_loadCtx('beats', () => plotDb.listBeats(bookId, userEmail)), allFiguren, allWerkstatt)
    .map(b => (ideasByBeat.has(b.id) ? { ...b, ideen: ideasByBeat.get(b.id) } : b));
  const linkedCh = linkedChapterIds(beats, threads);

  const usedFig = new Set([...beats.flatMap(b => b.fig_ids || []), ...threads.map(t => t.fig_id).filter(Boolean)]);
  const usedWf = new Set([...beats.flatMap(b => b.draft_fig_ids || []), ...threads.map(t => t.draft_figure_id).filter(Boolean)]);
  const fig = prioritize(allFiguren, limits.figuren, f => usedFig.has(f.id));
  const wf = prioritize(allWerkstatt, limits.werkstattFiguren, w => usedWf.has(w.id));
  const kap = prioritize(await _kapitelContext(bookId), limits.kapitel, c => linkedCh.has(c.id));
  const orte = prioritize(_orteContext(bookId, userEmail), limits.orte);
  const zeit = limits.zeitstrahl ? prioritize(_zeitstrahlContext(bookId, userEmail), limits.zeitstrahl) : { items: [], total: 0 };
  const outline = capBeats(beats, limits.beats);

  return {
    BUCH_KONTEXT,
    locale,
    limits,
    beats,
    outlineBeats: outline.items,
    figuren: fig.items.map(f => _trimFigur(f, limits)),
    werkstattFiguren: wf.items,
    kapitel: kap.items.length === kap.total ? kap.items.map(c => c.name) : kap.items.map(c => ({ nr: c.nr, name: c.name })),
    orte: orte.items,
    zeitstrahl: zeit.items,
    threads,
    linkedChapterIds: linkedCh,
    kuerzungen: {
      beats: { shown: outline.items.length, total: outline.total },
      figuren: { shown: fig.items.length, total: fig.total },
      werkstattFiguren: { shown: wf.items.length, total: wf.total },
      kapitel: { shown: kap.items.length, total: kap.total },
      orte: { shown: orte.items.length, total: orte.total },
      zeitstrahl: { shown: zeit.items.length, total: zeit.total },
    },
  };
}

// Consistency-spezifische Listen: Szenen (verlinkte Kapitel zuerst), Kontinuität,
// Recherche, Relationen, Weltgesetze — gekappt + in `kuerzungen` vermerkt.
function consistencyExtras(bookId, userEmail, { limits, linkedChapterIds: linked, kuerzungen }) {
  const sz = prioritize(_szenenContext(bookId, userEmail), limits.szenen, s => s.chapter_id != null && linked.has(s.chapter_id));
  const ko = prioritize(kontinuitaetContext(bookId, userEmail), limits.kontinuitaet);
  const re = prioritize(rechercheContext(bookId, userEmail), limits.recherche);
  const rel = prioritize(_loadCtx('relations', () => plotDb.listBeatRelations(bookId, userEmail)), limits.relationen);
  const we = prioritize(weltgesetzeContext(bookId, userEmail), limits.weltgesetze);
  Object.assign(kuerzungen, {
    szenen: { shown: sz.items.length, total: sz.total },
    kontinuitaet: { shown: ko.items.length, total: ko.total },
    recherche: { shown: re.items.length, total: re.total },
    relationen: { shown: rel.items.length, total: rel.total },
    weltgesetze: { shown: we.items.length, total: we.total },
  });
  return { szenen: sz.items, kontinuitaet: ko.items, recherche: re.items, relations: rel.items, weltgesetze: we.items };
}

module.exports = {
  prioritize, ctxLimits, enrichBeats, linkedChapterIds, capBeats,
  commonPlotContext, consistencyExtras, rechercheContext, anchorContext,
};
