// KI-Jobs: Brainstorm (pro Knoten) + Konsistenz-Check (gegen Buchwelt).
// Beide Jobs erzwingen Save vor Start; bei Save-Fail wird abgebrochen, sonst
// arbeitet KI auf altem Server-Snapshot und überschreibt user-edits beim Apply.

import { fetchJson } from '../utils.js';
import { startWerkstattJobPoll, stopWerkstattJob } from './job-poll.js';
import { _newNodeId } from './mindmap.js';
import { werkstattErrorText } from './crud.js';

export const jobsMethods = {
  async runBrainstorm() {
    const sel = this.selectedDraft();
    // Ein Brainstorm-Slot pro Karte: ein zweiter Start (Kontextmenü) übernähme
    // sonst Poll-Timer und Job-ID, und der erste Lauf liefe unsichtbar und
    // nicht mehr abbrechbar weiter.
    if (!sel || !this.selectedKnotenId || this.brainstormLoading) return;
    // Knoten VOR dem Save-await festhalten: während des Saves kann die Auswahl
    // wandern, der Lauf gehört aber zum Knoten, auf dem er gestartet wurde.
    const knotenId = this.selectedKnotenId;
    this.brainstormLoading = true;
    if (this.isDirty()) {
      const ok = await this.saveDraft();
      if (!ok) { this.brainstormLoading = false; return; } // Save-Fail: errorMessage steht.
    }
    this.brainstormStatus = '';
    this.brainstormResult = null;
    this._brainstormJobDraftId = sel.id;
    try {
      const resp = await fetchJson('/jobs/werkstatt-brainstorm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: sel.id, knotenId }),
      });
      this._brainstormJobId = resp.jobId;
      startWerkstattJobPoll(this, 'brainstorm', resp.jobId);
    } catch (e) {
      this.brainstormLoading = false;
      this._brainstormJobDraftId = null;
      this.errorMessage = werkstattErrorText(e, 'werkstatt.error.brainstorm');
    }
  },

  applyBrainstormVorschlag(idx) {
    if (!this.brainstormResult) return;
    const v = this.brainstormResult.vorschlaege[idx];
    if (!v || !this._jm) return;
    const parentId = this.brainstormResult.knotenId;
    // History-Run kann auf Knoten zeigen, der zwischenzeitlich aus der
    // Mindmap entfernt wurde — verständlich melden statt _mutateMindmap-Fail.
    if (this._jm.get_node && !this._jm.get_node(parentId)) {
      this.errorMessage = window.__app.t('werkstatt.error.knotenGone');
      return;
    }
    const ok = this._mutateMindmap(jm => jm.add_node(parentId, _newNodeId(), v.label));
    if (ok) {
      this.brainstormResult.vorschlaege = this.brainstormResult.vorschlaege.filter((_, i) => i !== idx);
    } else {
      this.errorMessage = window.__app.t('werkstatt.error.applyFailed');
    }
  },

  async runConsistency() {
    const sel = this.selectedDraft();
    if (!sel || this.consistencyLoading) return;
    this.consistencyLoading = true;
    if (this.isDirty()) {
      const ok = await this.saveDraft();
      if (!ok) { this.consistencyLoading = false; return; }
    }
    this.consistencyStatus = '';
    this.consistencyResult = null;
    this.selectedKonfliktIdx = null;
    this._consistencyJobDraftId = sel.id;
    try {
      const resp = await fetchJson('/jobs/werkstatt-consistency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: sel.id }),
      });
      this._consistencyJobId = resp.jobId;
      startWerkstattJobPoll(this, 'consistency', resp.jobId);
    } catch (e) {
      this.consistencyLoading = false;
      this._consistencyJobDraftId = null;
      this.errorMessage = werkstattErrorText(e, 'werkstatt.error.consistency');
    }
  },

  // Cancel: schickt DELETE /jobs/:id; Server setzt Status auf 'cancelled',
  // laufender callAI wird via AbortController unterbrochen.
  async cancelBrainstorm() {
    const id = this._brainstormJobId;
    if (!id) return;
    await window.__app.cancelJob(id);
    stopWerkstattJob(this, 'brainstorm');
  },

  async cancelConsistency() {
    const id = this._consistencyJobId;
    if (!id) return;
    await window.__app.cancelJob(id);
    stopWerkstattJob(this, 'consistency');
  },

  _clearJobs() {
    stopWerkstattJob(this, 'brainstorm');
    stopWerkstattJob(this, 'consistency');
    // Die Figuren-Verankerung ist buchweit — sie gehoert beim Buchwechsel
    // genauso gestoppt wie die beiden draft-skopierten Jobs.
    stopWerkstattJob(this, 'anchor');
  },
};
