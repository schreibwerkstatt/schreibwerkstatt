'use strict';
// Figuren-Werkstatt-Tools: Liste der Drafts + Detail-Lookup mit Mindmap +
// Brainstorm/Consistency-Runs.

const { getUser } = require('../../../db/app-users');
const { resolveI18nTree, resolveI18n } = require('../../../lib/i18n-server');
const { listDraftFigures, getDraftFigure, listWerkstattRuns, getWerkstattRun } = require('../../../db/draft-figures');
const { _truncateResult } = require('./shared');

const WERKSTATT_NOTES_PREVIEW_CHARS = 200;
const WERKSTATT_RUN_LIMIT_DEFAULT = 5;
const WERKSTATT_CONSISTENCY_FAZIT_PREVIEW = 400;
const WERKSTATT_CONSISTENCY_PROBLEM_PREVIEW = 240;
const WERKSTATT_BRAINSTORM_BEGRUENDUNG_PREVIEW = 160;

function _userLocale(userEmail) {
  return getUser(userEmail)?.language || 'de';
}

function _flattenMindmapTree(node, indent = 0, out = []) {
  if (!node) return out;
  const topic = (typeof node.topic === 'string' ? node.topic : '').trim();
  if (topic) out.push('  '.repeat(indent) + '- ' + topic);
  for (const child of node.children || []) _flattenMindmapTree(child, indent + 1, out);
  return out;
}

function _summarizeRunListItem(runRow, locale) {
  const path = runRow.knoten_pfad ? resolveI18n(runRow.knoten_pfad, locale) : null;
  return {
    run_id: runRow.id,
    kind: runRow.kind,
    created_at: runRow.created_at,
    ...(path ? { knoten_pfad: path } : {}),
    model: runRow.model || null,
  };
}

function _findDraftByNameOrId(input, ctx) {
  const userEmail = ctx.userEmail || '';
  if (Number.isInteger(input?.draft_id)) {
    const d = getDraftFigure(input.draft_id);
    if (d && d.book_id === ctx.bookId && d.user_email === userEmail) return d;
    return null;
  }
  if (typeof input?.figur_name === 'string' && input.figur_name.trim()) {
    const needle = input.figur_name.trim().toLowerCase();
    const all = listDraftFigures(ctx.bookId, userEmail);
    return all.find(d => (d.name || '').toLowerCase() === needle)
        || all.find(d => (d.name || '').toLowerCase().includes(needle))
        || null;
  }
  return null;
}

function tool_list_werkstatt_drafts(_input, ctx) {
  const userEmail = ctx.userEmail || '';
  const locale = _userLocale(userEmail);

  const drafts = listDraftFigures(ctx.bookId, userEmail);
  if (!drafts.length) {
    return {
      drafts: [],
      total: 0,
      hint: 'Keine Figuren-Werkstatt-Drafts vorhanden. User legt sie ueber die Werkstatt-Karte (tile.werkstatt) an.',
    };
  }
  const items = drafts.map(d => {
    const runRows = listWerkstattRuns(d.id, userEmail);
    const counts = { brainstorm: 0, consistency: 0 };
    for (const r of runRows) {
      if (r.kind === 'brainstorm') counts.brainstorm++;
      else if (r.kind === 'consistency') counts.consistency++;
    }
    const lastRun = runRows[0] || null;
    const notes = d.notes || null;
    return {
      draft_id: d.id,
      name: d.name,
      archetype: d.archetype || null,
      source_figure_name: d.source_figure_name || null,
      notes: notes && notes.length > WERKSTATT_NOTES_PREVIEW_CHARS
        ? notes.slice(0, WERKSTATT_NOTES_PREVIEW_CHARS) + '…'
        : notes,
      updated_at: d.updated_at,
      runs: counts,
      ...(lastRun ? { last_run: _summarizeRunListItem(lastRun, locale) } : {}),
    };
  });
  return _truncateResult({ drafts: items, total: items.length });
}

function tool_get_werkstatt_draft(input, ctx) {
  const userEmail = ctx.userEmail || '';
  const locale = _userLocale(userEmail);

  const draft = _findDraftByNameOrId(input, ctx);
  if (!draft) {
    return {
      error: 'Werkstatt-Draft nicht gefunden', errorKey: 'chat.toolError.notFound',
      hint: 'Per draft_id (aus list_werkstatt_drafts) oder figur_name suchen.',
    };
  }

  const resolvedRoot = draft.mindmap?.data ? resolveI18nTree(draft.mindmap.data, locale) : null;
  const mindmapText = resolvedRoot ? _flattenMindmapTree(resolvedRoot).join('\n') : '';

  const includeRuns = input?.include_runs !== false;
  const runLimit = Math.min(20, Math.max(1, Number.isInteger(input?.run_limit) ? input.run_limit : WERKSTATT_RUN_LIMIT_DEFAULT));

  const runs = [];
  if (includeRuns) {
    const runRows = listWerkstattRuns(draft.id, userEmail).slice(0, runLimit);
    for (const r of runRows) {
      const detail = getWerkstattRun(r.id);
      if (!detail) continue;
      const path = detail.knoten_pfad ? resolveI18n(detail.knoten_pfad, locale) : null;
      const entry = {
        run_id: detail.id,
        kind: detail.kind,
        created_at: detail.created_at,
        ...(path ? { knoten_pfad: path } : {}),
      };
      if (detail.kind === 'brainstorm' && Array.isArray(detail.result?.vorschlaege)) {
        entry.vorschlaege = detail.result.vorschlaege.map(v => ({
          label: v.label,
          begruendung: typeof v.begruendung === 'string' && v.begruendung.length > WERKSTATT_BRAINSTORM_BEGRUENDUNG_PREVIEW
            ? v.begruendung.slice(0, WERKSTATT_BRAINSTORM_BEGRUENDUNG_PREVIEW) + '…'
            : (v.begruendung || ''),
        }));
      } else if (detail.kind === 'consistency') {
        const fazit = detail.result?.fazit || null;
        entry.fazit = fazit && fazit.length > WERKSTATT_CONSISTENCY_FAZIT_PREVIEW
          ? fazit.slice(0, WERKSTATT_CONSISTENCY_FAZIT_PREVIEW) + '…'
          : fazit;
        if (Array.isArray(detail.result?.konflikte)) {
          entry.konflikte = detail.result.konflikte.map(k => ({
            feld: k.feld,
            schwere: k.schwere,
            problem: typeof k.problem === 'string' && k.problem.length > WERKSTATT_CONSISTENCY_PROBLEM_PREVIEW
              ? k.problem.slice(0, WERKSTATT_CONSISTENCY_PROBLEM_PREVIEW) + '…'
              : k.problem,
            vorschlag: k.vorschlag || null,
          }));
        }
      }
      runs.push(entry);
    }
  }

  return _truncateResult({
    draft_id: draft.id,
    name: draft.name,
    archetype: draft.archetype || null,
    source_figure_name: draft.source_figure_name || null,
    notes: draft.notes || null,
    updated_at: draft.updated_at,
    mindmap_text: mindmapText,
    ...(includeRuns ? { runs } : {}),
  });
}

module.exports = {
  tool_list_werkstatt_drafts,
  tool_get_werkstatt_draft,
};
