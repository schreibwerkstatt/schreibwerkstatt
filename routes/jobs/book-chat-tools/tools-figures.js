'use strict';
// Figuren-fokussierte Tools: Pronomenzählung, Auftritte, Beziehungen, Voll-Profil.

const { _truncateResult, _findFigure } = require('./shared');
const {
  listPronounCountsWithChapters,
  listFigureMentionsWithPages,
  listFigureAppearancesWithChapters,
  listFigureEventsWithPlaces,
  listFigureScenesWithPlaces,
  listPronounCounts,
  listFigureRelationsWithNames,
  listFiguresByFigIds,
  getFigureRow,
  listFigureTagNames,
  listRelationsOfFigure,
} = require('../../../db/book-chat/figures');

// ── count_pronouns ────────────────────────────────────────────────────────────

const PRONOUN_KEYS = ['ich', 'du', 'er', 'sie_sg', 'wir', 'ihr_pl', 'man'];

function _aggregatePronounsFromRows(rows, filterKeys) {
  const agg = {};
  for (const k of filterKeys) agg[k] = { narr: 0, dlg: 0 };
  for (const r of rows) {
    if (!r.pronoun_counts) continue;
    let parsed;
    try { parsed = JSON.parse(r.pronoun_counts); } catch { continue; }
    for (const k of filterKeys) {
      const v = parsed[k];
      if (!v) continue;
      agg[k].narr += v.narr || 0;
      agg[k].dlg  += v.dlg  || 0;
    }
  }
  return agg;
}

function tool_count_pronouns(input, ctx) {
  const perChapter = !!input.per_chapter;
  const filterKeys = Array.isArray(input.pronouns) && input.pronouns.length
    ? input.pronouns.filter(p => PRONOUN_KEYS.includes(p))
    : PRONOUN_KEYS;

  if (!perChapter) {
    const rows = listPronounCounts(ctx.bookId);
    const counts = _aggregatePronounsFromRows(rows, filterKeys);
    return { counts, scope: 'book', pronouns: filterKeys, pages_indexed: rows.length };
  }

  // Pro Kapitel aggregieren
  const rows = listPronounCountsWithChapters(ctx.bookId);
  const byChapter = new Map();
  for (const r of rows) {
    const key = r.chapter_id ?? 0;
    if (!byChapter.has(key)) {
      byChapter.set(key, { chapter_id: r.chapter_id, chapter_name: r.chapter_name || '(ohne Kapitel)', position: r.chapter_position, rows: [] });
    }
    byChapter.get(key).rows.push(r);
  }
  const chapters = [...byChapter.values()]
    // Lesereihenfolge (Kapitel-Position), nicht Anlage-Reihenfolge (chapter_id).
    .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || (a.chapter_id ?? 0) - (b.chapter_id ?? 0))
    .map(ch => ({
      chapter_id: ch.chapter_id,
      chapter_name: ch.chapter_name,
      counts: _aggregatePronounsFromRows(ch.rows, filterKeys),
    }));
  return { chapters, scope: 'chapters', pronouns: filterKeys };
}

// ── get_figure_mentions ───────────────────────────────────────────────────────

function tool_get_figure_mentions(input, ctx) {
  const figRow = _findFigure(input, ctx);
  if (!figRow) {
    return { error: 'Figur nicht gefunden', hint: 'Prüfe die Figurenliste im System-Prompt.' };
  }

  const mentions = listFigureMentionsWithPages(figRow.id, ctx.bookId);

  if (!mentions.length) {
    return {
      fig_id: figRow.fig_id,
      name: figRow.name,
      total_mentions: 0,
      note: 'Keine Index-Erwähnungen vorhanden. Führe Komplettanalyse oder Sync aus, um den Figuren-Index zu aktualisieren.',
    };
  }

  const total = mentions.reduce((s, m) => s + m.count, 0);
  const first = mentions[0];
  const last  = mentions[mentions.length - 1];

  const byChapter = new Map();
  for (const m of mentions) {
    const key = m.chapter_id ?? 0;
    if (!byChapter.has(key)) byChapter.set(key, { chapter_id: m.chapter_id, chapter_name: m.chapter_name || '(ohne Kapitel)', count: 0, pages: [] });
    const ch = byChapter.get(key);
    ch.count += m.count;
    ch.pages.push({ page_id: m.page_id, page_name: m.page_name, count: m.count });
  }

  return _truncateResult({
    fig_id: figRow.fig_id,
    name: figRow.name,
    total_mentions: total,
    pages_with_mention: mentions.length,
    first_appearance: {
      chapter_id: first.chapter_id,
      chapter_name: first.chapter_name || '(ohne Kapitel)',
      page_id: first.page_id,
      page_name: first.page_name,
      count: first.count,
    },
    last_appearance: {
      chapter_id: last.chapter_id,
      chapter_name: last.chapter_name || '(ohne Kapitel)',
      page_id: last.page_id,
      page_name: last.page_name,
      count: last.count,
    },
    by_chapter: [...byChapter.values()],
  });
}

// ── get_figure_relations ──────────────────────────────────────────────────────

function tool_get_figure_relations(input, ctx) {
  const userEmail = ctx.userEmail || null;
  let focus = null;
  if (input?.figur_id || input?.figur_name) {
    focus = _findFigure(input, ctx);
    if (!focus) return { error: 'Figur nicht gefunden', hint: 'Prüfe die Figurenliste im System-Prompt.' };
  }

  const rows = listFigureRelationsWithNames(ctx.bookId, userEmail);

  const filtered = focus
    ? rows.filter(r => r.from_fig_id === focus.fig_id || r.to_fig_id === focus.fig_id)
    : rows;

  const edges = filtered.map(r => {
    let belege = [];
    if (r.belege) { try { belege = JSON.parse(r.belege) || []; } catch { belege = []; } }
    return {
      from: { fig_id: r.from_fig_id, name: r.from_name },
      to:   { fig_id: r.to_fig_id,   name: r.to_name },
      typ: r.typ,
      beschreibung: r.beschreibung || null,
      machtverhaltnis: r.machtverhaltnis ?? null,
      belege: Array.isArray(belege) ? belege.slice(0, 3) : [],
    };
  });

  const nodeIds = new Set();
  for (const e of edges) { nodeIds.add(e.from.fig_id); nodeIds.add(e.to.fig_id); }
  const nodes = nodeIds.size
    ? listFiguresByFigIds(ctx.bookId, userEmail, nodeIds)
    : [];

  return _truncateResult({
    ...(focus ? { focus: { fig_id: focus.fig_id, name: focus.name } } : {}),
    edges,
    nodes,
    total: edges.length,
    ...(rows.length === 0
      ? { hint: 'Keine Beziehungen vorhanden. Komplettanalyse (Soziogramm) noch nicht ausgeführt.' }
      : {}),
  });
}

// ── get_figure_profile ────────────────────────────────────────────────────────

function tool_get_figure_profile(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const figRow = _findFigure(input, ctx);
  if (!figRow) return { error: 'Figur nicht gefunden', hint: 'Prüfe die Figurenliste im System-Prompt.' };

  const f = getFigureRow(figRow.id);

  const tags = listFigureTagNames(figRow.id);

  const appearances = listFigureAppearancesWithChapters(figRow.id);

  const events = listFigureEventsWithPlaces(figRow.id);

  const scenes = listFigureScenesWithPlaces(figRow.id, ctx.bookId, userEmail);

  const relations = listRelationsOfFigure(ctx.bookId, userEmail, figRow.id);

  let zitate = [];
  if (f.schluesselzitate) { try { zitate = JSON.parse(f.schluesselzitate) || []; } catch { zitate = []; } }
  let arc = null;
  if (f.arc) { try { arc = JSON.parse(f.arc); } catch { arc = null; } }

  return _truncateResult({
    fig_id: f.fig_id,
    name: f.name,
    kurzname: f.kurzname || null,
    typ: f.typ || null,
    geburtstag: f.geburtstag || null,
    geschlecht: f.geschlecht || null,
    beruf: f.beruf || null,
    wohnadresse: f.wohnadresse || null,
    aeusseres: f.aeusseres || null,
    stimme: f.stimme || null,
    hintergrund: f.hintergrund || null,
    beschreibung: f.beschreibung || null,
    sozialschicht: f.sozialschicht || null,
    praesenz: f.praesenz || null,
    rolle: f.rolle || null,
    motivation: f.motivation || null,
    konflikt: f.konflikt || null,
    entwicklung: f.entwicklung || null,
    arc: (arc && typeof arc === 'object') ? arc : null,
    erste_erwaehnung: f.erste_erwaehnung || null,
    erste_erwaehnung_page_id: f.erste_erwaehnung_page_id || null,
    eigenschaften: tags,
    schluesselzitate: Array.isArray(zitate) ? zitate : [],
    kapitel: appearances.map(a => ({ chapter_id: a.chapter_id, chapter_name: a.chapter_name, haeufigkeit: a.haeufigkeit })),
    lebensereignisse: events.map(e => ({
      datum: e.datum,
      ereignis: e.ereignis,
      bedeutung: e.bedeutung || null,
      typ: e.typ || 'persoenlich',
      chapter_id: e.chapter_id, chapter_name: e.chapter_name || null,
      page_id: e.page_id,       page_name: e.page_name || null,
    })),
    szenen: scenes.map(s => ({
      scene_id: s.id, titel: s.titel, wertung: s.wertung || null, kommentar: s.kommentar || null,
      chapter_id: s.chapter_id, chapter_name: s.chapter_name || null,
      page_id: s.page_id, page_name: s.page_name || null,
    })),
    beziehungen: relations.map(r => ({
      from: { fig_id: r.from_fig_id, name: r.from_name },
      to:   { fig_id: r.to_fig_id,   name: r.to_name },
      typ: r.typ, beschreibung: r.beschreibung || null,
      machtverhaltnis: r.machtverhaltnis ?? null,
    })),
  });
}

module.exports = {
  tool_count_pronouns,
  tool_get_figure_mentions,
  tool_get_figure_relations,
  tool_get_figure_profile,
};
