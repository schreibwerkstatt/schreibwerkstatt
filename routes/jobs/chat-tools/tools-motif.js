'use strict';
// Motiv-Werkstatt-Tools: Konstellation (Themen & Motive) + Ist-Fundstellen.
// Planendes UND überwachendes Werkzeug — der Soll/Ist-Abgleich zeigt, wo ein
// geplantes Motiv laut Plan tragen soll (Soll-Brücken) vs. wo die KI-Motiverkennung
// es real im Text fand (motif_occurrences). Pro Buch + User skopiert. Read-only,
// kein KI-Call (liest die schon vorhandenen Motiv-Tabellen).

const { listMotifs, listOccurrences, getGraph, hasOccurrences } = require('../../../db/motifs');
const { _truncateResult, clampInt, clip, findByName, ambiguousNameError } = require('./shared');
// Dieselbe Cosinus-Untergrenze wie die Motiv-Karte und der Konsistenz-Job: sonst
// nennt der Buch-Chat Zahlen und Stellen, die die Karte als zu schwach ausblendet —
// zwei Bestände für dieselbe Frage.
const { motifScoreFloor: _motifFloor } = require('../../../lib/motif-floor');

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

function _motifOverview(ctx) {
  const userEmail = ctx.userEmail || '';
  const graph = getGraph(ctx.bookId, userEmail, _motifFloor());

  if (!graph.motifs.length && !graph.themes.length) {
    return {
      total_themes: 0,
      total_motifs: 0,
      hint: 'Keine Motiv-Werkstatt vorhanden. Der User plant Themen & Motive als Konstellation über die Motiv-Karte (tile.motifs) — abstrakte Themen bündeln konkrete, wiederkehrende Motive (Wasser, Spiegel, ein Lied). Leere Werkstatt ≠ Buch ohne Motive — es heisst nur, dass der User keine separate Motiv-Planung angelegt hat.',
      themes: [],
      motifs: [],
    };
  }

  const themeNameById = new Map(graph.themes.map(t => [t.id, t.name]));
  const motifNameById = new Map(graph.motifs.map(m => [m.id, m.name]));
  // Ungescannt ist ungeprüft, nicht abwesend: ohne Ist-Index gibt es weder
  // ist_count noch Geister — sonst hiesse jedes geplante Motiv „fehlt im Text".
  const scanned = hasOccurrences(ctx.bookId, userEmail);

  let geister = 0;
  const motifs = graph.motifs.map(m => {
    const { soll, count: sollCount } = _sollSummary(m);
    // Geist = geplant, aber fehlt: hat Soll-Verknüpfungen, aber 0 reale Fundstellen.
    const geist = scanned && sollCount > 0 && m.occurrenceCount === 0;
    if (geist) geister++;
    return {
      id: m.id,
      name: m.name,
      thema: m.theme_id != null ? (themeNameById.get(m.theme_id) || null) : null,
      beschreibung: m.beschreibung ? clip(m.beschreibung, MOTIF_DESC_PREVIEW) : null,
      trigger_terms: m.trigger_terms || [],
      ...(Object.keys(soll).length ? { soll } : {}),
      ...(scanned ? { ist_count: m.occurrenceCount } : {}),
      ...(geist ? { geist: true } : {}),
    };
  });

  const themes = graph.themes.map(t => ({
    id: t.id,
    name: t.name,
    beschreibung: t.beschreibung ? clip(t.beschreibung, MOTIF_DESC_PREVIEW) : null,
  }));

  const relations = graph.relations.map(r => ({
    von: motifNameById.get(r.from_motif_id) || null,
    zu: motifNameById.get(r.to_motif_id) || null,
    typ: r.typ,
  }));

  // Zusammenfassung und Legende vor den Listen: die strukturierte Kürzung
  // halbiert die Listen, die Summen bleiben stehen.
  return _truncateResult({
    total_themes: themes.length,
    total_motifs: motifs.length,
    scanned,
    ...(scanned ? { geister } : {
      hint: 'Der Motiv-Scan lief für dieses Buch noch nie — es gibt keine Fundstellen-Zahlen. Das heisst UNGEPRÜFT, nicht «kommt im Text nicht vor».',
    }),
    soll_ist_legende: 'soll = wo das Motiv laut Plan tragen soll (verknüpfte Figuren/Beats/Kapitel/Abschnitte). ist_count = wie oft die KI-Motiverkennung das Motiv real im Text fand (motif_occurrences). geist=true heisst: geplant, aber 0 Fundstellen (fallengelassen oder noch nicht geschrieben). Fundstellen-Detail eines Motivs: erneut mit motif_id bzw. motif_name aufrufen.',
    themes,
    motifs,
    ...(relations.length ? { relations } : {}),
  });
}

// Motiv per motif_id (INTEGER) oder Name (shared.js#findByName: exakt > Wortanfang
// > Teilstring; mehrdeutig → { ambiguous }).
function _findMotifByIdOrName(input, ctx) {
  const userEmail = ctx.userEmail || '';
  const all = listMotifs(ctx.bookId, userEmail);
  if (Number.isInteger(input?.motif_id)) {
    return all.find(m => m.id === input.motif_id) || null;
  }
  if (typeof input?.motif_name === 'string' && input.motif_name.trim()) {
    const hit = findByName(all, input.motif_name);
    return hit.ambiguous ? { ambiguous: hit.ambiguous } : hit.row;
  }
  return null;
}

function _motifOccurrences(input, ctx) {
  const motif = _findMotifByIdOrName(input, ctx);
  if (motif?.ambiguous) {
    return ambiguousNameError(input.motif_name, motif.ambiguous, m => ({ motif_id: m.id, name: m.name }), 'motif_id');
  }
  if (!motif) {
    return {
      error: 'Motiv nicht gefunden', errorKey: 'chat.toolError.notFound',
      hint: 'Per motif_id oder motif_name (exakt oder Teilstring) suchen — IDs/Namen stehen in der Übersicht (Aufruf ohne Motiv).',
    };
  }

  const limit = clampInt(input?.limit, OCC_LIMIT_DEFAULT, 1, OCC_LIMIT_MAX);
  const rows = listOccurrences(motif.id, _motifFloor());

  if (!rows.length) {
    if (!hasOccurrences(ctx.bookId, ctx.userEmail || '')) {
      return {
        motif_id: motif.id,
        name: motif.name,
        scanned: false,
        occurrences: [],
        hint: 'Der Motiv-Scan lief für dieses Buch noch nie — ungeprüft, nicht abwesend.',
      };
    }
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
    snippet: o.snippet ? clip(o.snippet, OCC_SNIPPET_PREVIEW) : null,
  }));

  return _truncateResult({
    motif_id: motif.id,
    name: motif.name,
    ist_count: rows.length,
    ...(occurrences.length < rows.length ? { shown: occurrences.length } : {}),
    occurrences,
  });
}

// ── get_motifs (Übersicht oder, mit Motiv, dessen Fundstellen) ───────────────

function tool_get_motifs(input, ctx) {
  const wantsOne = Number.isInteger(input?.motif_id)
    || (typeof input?.motif_name === 'string' && input.motif_name.trim());
  return wantsOne ? _motifOccurrences(input, ctx) : _motifOverview(ctx);
}

module.exports = {
  tool_get_motifs,
};
