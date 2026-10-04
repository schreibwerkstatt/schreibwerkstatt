'use strict';
// Motiv-Werkstatt-Tools: Konstellation (Themen & Motive) + Ist-Fundstellen.
// Planendes UND überwachendes Werkzeug — der Soll/Ist-Abgleich zeigt, wo ein
// geplantes Motiv laut Plan tragen soll (Soll-Brücken) vs. wo die KI-Motiverkennung
// es real im Text fand (motif_occurrences). Pro Buch + User skopiert. Read-only,
// kein KI-Call (liest die schon vorhandenen Motiv-Tabellen).

const { listMotifs, listOccurrences, getGraph } = require('../../../db/motifs');
const { _truncateResult } = require('./shared');
const appSettings = require('../../../lib/app-settings');

// Dieselbe Cosinus-Untergrenze wie die Motiv-Karte (routes/motifs.js#_motifFloor)
// und der Konsistenz-Job: sonst nennt der Buch-Chat Zahlen und Stellen, die die
// Karte als zu schwach ausblendet — zwei Bestände für dieselbe Frage.
function _motifFloor() {
  return Number(appSettings.get('motif.scan.min_score')) || 0;
}

const MOTIF_DESC_PREVIEW = 400;
const OCC_SNIPPET_PREVIEW = 300;
const OCC_LIMIT_DEFAULT = 40;
const OCC_LIMIT_MAX = 200;

// Soll-Verknüpfungen eines Motivs zu kompakten Namens-Listen. Leere Brücken
// werden weggelassen (kein Rauschen). count = Summe über alle fünf Brücken.
function _sollSummary(m) {
  const soll = {};
  if (m.figures?.length) soll.figuren = m.figures.map(f => f.name);
  if (m.draftFigures?.length) soll.werkstatt_figuren = m.draftFigures.map(f => f.name);
  if (m.beats?.length) soll.beats = m.beats.map(b => b.titel);
  if (m.chapters?.length) soll.kapitel = m.chapters.map(c => c.name);
  if (m.pages?.length) soll.seiten = m.pages.map(p => p.name);
  const count = (m.figures?.length || 0) + (m.draftFigures?.length || 0)
    + (m.beats?.length || 0) + (m.chapters?.length || 0) + (m.pages?.length || 0);
  return { soll, count };
}

function tool_get_motifs(_input, ctx) {
  const userEmail = ctx.userEmail || '';
  const graph = getGraph(ctx.bookId, userEmail, _motifFloor());

  if (!graph.motifs.length && !graph.themes.length) {
    return {
      themes: [],
      motifs: [],
      total_themes: 0,
      total_motifs: 0,
      hint: 'Keine Motiv-Werkstatt vorhanden. Der User plant Themen & Motive als Konstellation über die Motiv-Karte (tile.motifs) — abstrakte Themen bündeln konkrete, wiederkehrende Motive (Wasser, Spiegel, ein Lied). Leere Werkstatt ≠ Buch ohne Motive — es heisst nur, dass der User keine separate Motiv-Planung angelegt hat.',
    };
  }

  const themeNameById = new Map(graph.themes.map(t => [t.id, t.name]));
  const motifNameById = new Map(graph.motifs.map(m => [m.id, m.name]));

  let geister = 0;
  const motifs = graph.motifs.map(m => {
    const { soll, count: sollCount } = _sollSummary(m);
    // Geist = geplant, aber fehlt: hat Soll-Verknüpfungen, aber 0 reale Fundstellen.
    const geist = sollCount > 0 && m.occurrenceCount === 0;
    if (geist) geister++;
    return {
      id: m.id,
      name: m.name,
      thema: m.theme_id != null ? (themeNameById.get(m.theme_id) || null) : null,
      beschreibung: m.beschreibung && m.beschreibung.length > MOTIF_DESC_PREVIEW
        ? m.beschreibung.slice(0, MOTIF_DESC_PREVIEW) + '…'
        : (m.beschreibung || null),
      trigger_terms: m.trigger_terms || [],
      ...(Object.keys(soll).length ? { soll } : {}),
      ist_count: m.occurrenceCount,
      ...(geist ? { geist: true } : {}),
    };
  });

  const themes = graph.themes.map(t => ({
    id: t.id,
    name: t.name,
    beschreibung: t.beschreibung && t.beschreibung.length > MOTIF_DESC_PREVIEW
      ? t.beschreibung.slice(0, MOTIF_DESC_PREVIEW) + '…'
      : (t.beschreibung || null),
  }));

  const relations = graph.relations.map(r => ({
    von: motifNameById.get(r.from_motif_id) || null,
    zu: motifNameById.get(r.to_motif_id) || null,
    typ: r.typ,
  }));

  return _truncateResult({
    themes,
    motifs,
    ...(relations.length ? { relations } : {}),
    total_themes: themes.length,
    total_motifs: motifs.length,
    geister,
    soll_ist_legende: 'soll = wo das Motiv laut Plan tragen soll (verknüpfte Figuren/Beats/Kapitel/Abschnitte). ist_count = wie oft die KI-Motiverkennung das Motiv real im Text fand (motif_occurrences). geist=true heisst: geplant, aber 0 Fundstellen (fallengelassen oder noch nicht geschrieben). Fundstellen-Detail pro Motiv über get_motif_occurrences.',
  });
}

// Motiv per motif_id (INTEGER) oder Name (exakt, dann Substring, case-insensitive).
function _findMotifByIdOrName(input, ctx) {
  const userEmail = ctx.userEmail || '';
  const all = listMotifs(ctx.bookId, userEmail);
  if (Number.isInteger(input?.motif_id)) {
    return all.find(m => m.id === input.motif_id) || null;
  }
  if (typeof input?.motif_name === 'string' && input.motif_name.trim()) {
    const needle = input.motif_name.trim().toLowerCase();
    return all.find(m => (m.name || '').toLowerCase() === needle)
        || all.find(m => (m.name || '').toLowerCase().includes(needle))
        || null;
  }
  return null;
}

function tool_get_motif_occurrences(input, ctx) {
  const motif = _findMotifByIdOrName(input, ctx);
  if (!motif) {
    return {
      error: 'Motiv nicht gefunden',
      hint: 'Per motif_id oder motif_name (exakt oder Substring, case-insensitive) suchen — IDs/Namen aus get_motifs.',
    };
  }

  const limit = Math.min(OCC_LIMIT_MAX, Math.max(1, Number.isInteger(input?.limit) ? input.limit : OCC_LIMIT_DEFAULT));
  const rows = listOccurrences(motif.id, _motifFloor());

  if (!rows.length) {
    return {
      motif_id: motif.id,
      name: motif.name,
      ist_count: 0,
      occurrences: [],
      hint: 'Keine Fundstellen. Entweder ein Geist-Motiv (geplant, aber noch nicht/nicht mehr im Text) oder der Motiv-Scan lief noch nicht (Job motif-scan, nächtlich nach embed-index). Ohne Embedding-Backend erkennt der Scan nur wörtliche trigger_terms.',
    };
  }

  const occurrences = rows.slice(0, limit).map(o => ({
    kind: o.kind,
    ...(o.kind === 'page'
      ? { page_id: o.page_id, page_name: o.page_name || null, chapter_name: o.chapter_name || null }
      : { scene_id: o.scene_id, scene_titel: o.scene_titel || null }),
    source: o.source, // 'semantic' (Embedding) | 'trigger' (FTS wörtlich)
    ...(o.score != null ? { score: Number(o.score.toFixed?.(3) ?? o.score) } : {}),
    snippet: o.snippet && o.snippet.length > OCC_SNIPPET_PREVIEW
      ? o.snippet.slice(0, OCC_SNIPPET_PREVIEW) + '…'
      : (o.snippet || null),
  }));

  return _truncateResult({
    motif_id: motif.id,
    name: motif.name,
    ist_count: rows.length,
    occurrences,
  });
}

module.exports = {
  tool_get_motifs,
  tool_get_motif_occurrences,
};
