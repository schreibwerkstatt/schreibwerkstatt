// KI-Lauf-Historie: persistierte Brainstorm- und Consistency-Runs pro Draft.
// Server liefert kompakte Liste (ohne result_json); Detail wird beim Öffnen
// lazy geholt. Apply (Brainstorm) prüft beim Anwenden, ob knoten_id noch in
// der Mindmap existiert — Live-Run gegen mutierten Tree nach `werkstatt.error.knotenGone`.

import { fetchJson } from '../utils.js';
import { makeRunHistoryMethods } from '../run-history.js';
import { reattachWerkstattJob } from './job-poll.js';

// Eine Lauf-Art (brainstorm | consistency): beide teilen `selectedRunId`, die
// Liste steht unter `runs[kind]`.
function werkstattRunMethods(kind, cfg) {
  const K = kind[0].toUpperCase() + kind.slice(1);
  return makeRunHistoryMethods({
    names: { open: `openWerkstatt${K}Run`, remove: `deleteWerkstatt${K}Run`, row: `werkstatt${K}RunRow` },
    getList: (ctx) => ctx.runs[kind],
    setList: (ctx, rows) => { ctx.runs = { ...ctx.runs, [kind]: rows }; },
    selected: 'selectedRunId',
    runUrl: (id) => `/draft-figures/runs/${id}`,
    busyKey: 'werkstatt.run.busy',
    confirmKey: 'werkstatt.run.confirmDelete',
    errorKeys: { open: 'werkstatt.error.runLoad', remove: 'werkstatt.error.runDelete' },
    ...cfg,
  });
}

export const runsMethods = {
  async loadRuns() {
    const app = window.__app;
    const sel = this.selectedDraft();
    if (!sel) {
      this.runs = { brainstorm: [], consistency: [] };
      this.runsLoadedDraftId = null;
      return;
    }
    // Re-Entry-Guard: bei schnellem Draft-Wechsel zwei parallele Fetches —
    // späterer würde sonst älteren ggf. überschreiben.
    const draftId = sel.id;
    this._runsLoadDraftId = draftId;
    this.runsLoading = true;
    try {
      const rows = await fetchJson(`/draft-figures/by-id/${draftId}/runs`);
      if (this._runsLoadDraftId !== draftId) return; // stale
      const brainstorm = [];
      const consistency = [];
      for (const r of (Array.isArray(rows) ? rows : [])) {
        if (r.kind === 'brainstorm') brainstorm.push(r);
        else if (r.kind === 'consistency') consistency.push(r);
      }
      this.runs = { brainstorm, consistency };
      this.runsLoadedDraftId = draftId;
    } catch (e) {
      if (this._runsLoadDraftId !== draftId) return;
      this.runs = { brainstorm: [], consistency: [] };
      this.errorMessage = app.t('werkstatt.error.runsLoad');
    } finally {
      if (this._runsLoadDraftId === draftId) this.runsLoading = false;
    }
  },

  // Öffnen (Toggle) und Löschen je Lauf-Art über den geteilten Kern; die Liste
  // lädt loadRuns oben (eine Anfrage je Draft, nach Art aufgeteilt). Ein
  // laufender Job DERSELBEN Art sperrt das Öffnen — sein onDone renderte sonst
  // über den geöffneten Lauf; der andere Slot bleibt frei.
  ...werkstattRunMethods('brainstorm', {
    busy: (ctx) => ctx.brainstormLoading,
    apply: (ctx, run) => {
      ctx.brainstormResult = {
        knotenId: run.knoten_id,
        knotenPfad: run.knoten_pfad || '',
        vorschlaege: run.result.vorschlaege || [],
      };
      ctx.consistencyResult = null;
    },
    clear: (ctx) => { ctx.brainstormResult = null; },
    row: { badges(r) { return [{ text: r.knoten_pfad }]; } },
  }),
  ...werkstattRunMethods('consistency', {
    busy: (ctx) => ctx.consistencyLoading,
    apply: (ctx, run) => {
      ctx.consistencyResult = {
        konflikte: run.result.konflikte || [],
        fazit: run.result.fazit || '',
        textbelege: run.result.textbelege || [],
      };
      ctx.brainstormResult = null;
    },
    clear: (ctx) => { ctx.consistencyResult = null; },
  }),

  // Beim Öffnen einer Figur prüfen, ob noch ein Brainstorm-/Consistency-Job
  // für diesen Draft auf dem Server läuft (Tab-Wechsel, Reload, Card-Reopen).
  // Ohne Reattach würde der Progress-Bar verschwinden, der Job aber im
  // Hintergrund weiterlaufen — Result landet dann nur in der Run-Historie.
  // jobQueueItems enthält dedupId + type; brainstorm-dedupId hat Format
  // "${draftId}|${knotenId}", consistency-dedupId ist die nackte draftId.
  async _reattachActiveJobs(draftId) {
    if (!draftId) return;
    const queued = window.Alpine?.store('jobs')?.jobQueueItems;
    let queue;
    try {
      queue = Array.isArray(queued) && queued.length > 0
        ? queued
        : await fetchJson('/jobs/queue');
    } catch { return; }
    if (!Array.isArray(queue)) return;
    const draftStr = String(draftId);

    if (!this._brainstormJobId && !this.brainstormLoading) {
      const bs = queue.find(j => j.type === 'werkstatt-brainstorm'
        && typeof j.dedupId === 'string'
        && j.dedupId.startsWith(draftStr + '|'));
      if (bs && this.selectedDraftId === draftId) reattachWerkstattJob(this, 'brainstorm', bs, draftId);
    }
    if (!this._consistencyJobId && !this.consistencyLoading) {
      const cs = queue.find(j => j.type === 'werkstatt-consistency'
        && String(j.dedupId) === draftStr);
      if (cs && this.selectedDraftId === draftId) reattachWerkstattJob(this, 'consistency', cs, draftId);
    }
  },
};
