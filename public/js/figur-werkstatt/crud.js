// Draft-CRUD: Liste laden, Auswahl, Neu/Speichern/Löschen, Reset, Dirty-Tracking.

import { fetchJson } from '../utils.js';
import { stopWerkstattJob } from './job-poll.js';

// Server-error_codes, für die die Werkstatt eine eigene Meldung hat. Alles
// andere fällt auf die Meldung der jeweiligen Aktion zurück.
const ERROR_CODE_KEYS = {
  DRAFT_CONFLICT: 'werkstatt.error.conflict',
  NO_BOOK_ACCESS: 'werkstatt.error.noBookAccess',
  INSUFFICIENT_ROLE: 'werkstatt.error.insufficientRole',
  MINDMAP_INVALID: 'werkstatt.error.mindmapInvalid',
};

/** Meldung zu einem fetchJson-Fehler: bekannter error_code → eigene Meldung,
 *  sonst der Aktions-Key (`fallbackKey`). */
export function werkstattErrorText(err, fallbackKey) {
  return window.__app.t(ERROR_CODE_KEYS[err?.code] || fallbackKey);
}

// Archetypen mit eigenem Label (Combobox-Optionen im Partial). Ein freier Wert
// eines Fremd-Clients wird roh angezeigt — `t()` liefert für unbekannte Keys
// den Key selbst zurück, nicht leer.
const KNOWN_ARCHETYPES = new Set(['protagonist', 'antagonist', 'nebenfigur', 'mentor', 'nemesis']);

export const crudMethods = {
  // Vergleich Form-Felder gegen selectedDraft + Mindmap-Generation (gezählt durch
  // jsMind-Mutationsevents). card:refresh prüft isDirty() und ruft appConfirm.
  isDirty() {
    const sel = this.selectedDraft();
    if (!sel) return false;
    if ((this.editName || '').trim() !== (sel.name || '').trim()) return true;
    if ((this.editArchetype || '') !== (sel.archetype || '')) return true;
    if ((this.editNotes || '') !== (sel.notes || '')) return true;
    return this._mindmapGen !== this._mindmapSavedGen;
  },

  // Mindmap-Dirty als Generationszähler statt Boolean: jede Mutation zählt hoch,
  // ein Save markiert nur die Generation als gespeichert, die er exportiert hat.
  // Eine Änderung, die während des laufenden PUT entsteht, bleibt so dirty —
  // ein Boolean würde sie mit dem Save-Ende als gespeichert ausgeben.
  _markMindmapDirty() { this._mindmapGen++; },
  _markMindmapClean(gen = this._mindmapGen) { this._mindmapSavedGen = gen; },

  archetypeLabel(a) {
    if (!a) return '';
    return KNOWN_ARCHETYPES.has(a) ? window.__app.t('werkstatt.archetype.' + a) : a;
  },

  // Formularfelder aus einer Draft-Zeile (Auswahl und Neu-Laden nach Refresh).
  _applyDraftToForm(d) {
    this.editName = d.name;
    this.editArchetype = d.archetype || '';
    this.editNotes = d.notes || '';
  },

  // Refresh mit Verwerfen: Formular UND Canvas aus der frisch geladenen Zeile
  // neu aufbauen. Ohne Remount blieben die verworfenen Knoten im Canvas stehen
  // und gingen beim nächsten Save über den neueren Server-Stand.
  _reloadSelectedDraft() {
    const d = this.selectedDraft();
    if (!d) return;
    this._destroyMindmap();
    this._applyDraftToForm(d);
    this._markMindmapClean();
    this.brainstormResult = null;
    this.consistencyResult = null;
    this.selectedRunId = null;
    this.selectedKnotenId = null;
    // Neuer Schlüssel der x-for-Hülle → Alpine mountet ein frisches Canvas.
    this._mindmapMountKey++;
  },

  async loadDrafts() {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.drafts = []; return; }
    // Stale-Schutz: bei Buchwechsel während des Fetch verwirft eine spätere
    // Antwort des alten Buchs den frisch geladenen State des neuen sonst.
    const isStale = () => Alpine.store('nav').selectedBookId !== bookId;
    this.loading = true;
    try {
      const rows = await fetchJson(`/draft-figures/${bookId}`);
      if (isStale()) return;
      this.drafts = Array.isArray(rows) ? rows : [];
      this.errorMessage = '';
      if (this.selectedDraftId && !this.drafts.find(d => d.id === this.selectedDraftId)) {
        this.selectedDraftId = null;
      }
      if (this._pendingDraftId) {
        const pid = this._pendingDraftId;
        this._pendingDraftId = null;
        if (this.drafts.some(d => d.id === pid)) {
          this.selectDraft(pid);
        }
      }
      if (!this.selectedDraftId && this.drafts.length > 0) {
        this.selectDraft(this.drafts[0].id);
      }
    } catch (e) {
      if (isStale()) return;
      this.errorMessage = app.t('werkstatt.error.load');
      this.drafts = [];
    } finally {
      if (!isStale()) this.loading = false;
    }
    // Bogen-Ansicht (Ist-Index + Messung) nachziehen. Eigenstaendig vom Draft-
    // Load und best-effort: der Bogen ist eine Nebenansicht, sein Ausfall darf
    // die Werkstatt nicht blockieren (gleiche Regel wie loadConsistencyRuns in
    // der Plot-Werkstatt).
    if (!isStale()) {
      this._reattachAnchorJob?.();
      await this.loadArc();
    }
  },

  // Vollstaendiger Karten-Reset (Buchwechsel, view:reset). Verdrahtet in
  // figur-werkstatt-card.js als onBookChanged/onViewReset — NICHT als
  // resetState-Literal: ein Object.assign kann die jsMind-Instanz nicht
  // abraeumen, die Poll-Timer nicht stoppen und das Vollbild nicht verlassen.
  // Wer hier ein Feld ergaenzt, ergaenzt es an genau dieser Stelle.
  resetDrafts() {
    this._destroyMindmap();
    this._clearJobs();
    this._hideContextMenu?.();
    if (document.fullscreenElement) {
      try { document.exitFullscreen(); } catch {}
    }
    this.drafts = [];
    this.selectedDraftId = null;
    this.selectedKnotenId = null;
    this.editName = '';
    this.editArchetype = '';
    this.editNotes = '';
    this.creating = false;
    this.newName = '';
    this.errorMessage = '';
    this.busy = false;
    this.brainstormResult = null;
    this.consistencyResult = null;
    this.mindmapFullscreen = false;
    this.contextMenuOpen = false;
    this.importing = false;
    this.importables = [];
    this.selectedImportFigureId = '';
    this.linking = false;
    this.linkCandidates = [];
    this.linkCandidatesLoading = false;
    this.selectedLinkFigureId = '';
    this.runs = { brainstorm: [], consistency: [] };
    this.runsLoadedDraftId = null;
    this.plotUsage = null;
    this.motifUsage = null;
    this.selectedRunId = null;
    this.selectedKonfliktIdx = null;
    this.runsLoading = false;
    this.importablesLoading = false;
    this.werkstattMenuOpen = false;
    this.contextMenuNodeId = null;
    this.loading = false;
    this._markMindmapClean();
    this._runsLoadDraftId = null;
    // Geparkte Permalink-Ziele gehoeren zum alten Buch — sonst springt die
    // Karte nach dem Wechsel auf eine Figur, die es hier nicht gibt.
    this._pendingDraftId = null;
    this._pendingKnotenId = null;
    // Bogen-Ansicht: Ist-Index und Zell-Cache gehoeren zum alten Buch (der
    // laufende Anchor-Job wird oben von _clearJobs gestoppt).
    this.arc = null;
    this.arcOccCache = {};
    this.activeArcDetailKey = null;
    this.arcDetailLoading = false;
    this._memos = {};
  },

  async selectDraft(id) {
    const d = this.drafts.find(x => x.id === id);
    if (!d) { this.selectedDraftId = null; return; }
    // Auto-Save: beim Wechsel auf andere Figur ungespeicherte Änderungen am
    // bisherigen Draft (Form + Mindmap) persistieren. Bei Save-Fehler nicht
    // wechseln — sonst stiller Datenverlust.
    if (this.selectedDraftId && this.selectedDraftId !== id && this.isDirty()) {
      const ok = await this.saveDraft();
      if (!ok) return;
    }
    // Lokale Poll/Loading-State auf foreign Draft kappen, sonst zeigt der
    // Progress-Bar auf der falschen Figur. Server-Job läuft weiter; wenn der
    // User zurückwechselt, hängt _reattachActiveJobs den Poll wieder an.
    if (this._brainstormJobId && this._brainstormJobDraftId !== id) stopWerkstattJob(this, 'brainstorm');
    if (this._consistencyJobId && this._consistencyJobDraftId !== id) stopWerkstattJob(this, 'consistency');
    // selectedDraftId-Wechsel ist :key der x-for-Mindmap-Hülle. Alpine entfernt
    // das alte Mindmap-Element und mountet ein frisches via x-init mit $el.
    if (this.selectedDraftId !== id) this._destroyMindmap();
    this.selectedDraftId = id;
    this._applyDraftToForm(d);
    this.creating = false;
    this.brainstormResult = null;
    this.consistencyResult = null;
    this.selectedKnotenId = null;
    this.selectedRunId = null;
    this.selectedKonfliktIdx = null;
    this._markMindmapClean();
    this.loadRuns?.();
    this.loadPlotUsage?.();
    this.loadMotifUsage?.();
    this._reattachActiveJobs?.(id);
  },

  // Cross-Feature: Plot-Beteiligung der ausgewählten Werkstatt-Figur laden (Anzahl
  // Beats + gebundene Stränge) → „in N Beats geplant"-Badge (Navigation → Plot).
  // Best-effort: Plot ist optional; ein Fehler hier lässt das Badge nur weg.
  async loadPlotUsage() {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    const draftId = this.selectedDraftId;
    this.plotUsage = null;
    if (!bookId || !draftId) return;
    try {
      const u = await fetchJson(`/plot/figure-usage?book_id=${bookId}&draft_id=${draftId}`);
      if (this.selectedDraftId !== draftId) return; // Stale (Draft inzwischen gewechselt)
      this.plotUsage = u || null;
    } catch { this.plotUsage = null; }
  },

  // Badge nur, wenn die Figur überhaupt im Plot vorkommt (Beats ODER Strang-Bindung).
  plotUsageVisible() {
    const u = this.plotUsage;
    return !!(u && (u.activeBeatCount > 0 || (u.threads && u.threads.length)));
  },

  plotUsageLabel() {
    const u = this.plotUsage;
    if (!u) return '';
    const app = window.__app;
    if (u.activeBeatCount > 0) return app.t('werkstatt.plotUsage.badge', { n: u.activeBeatCount });
    if (u.threads && u.threads.length) return app.t('werkstatt.plotUsage.threadBadge');
    return '';
  },

  // Cross-Feature: Motiv-Beteiligung der ausgewählten Werkstatt-Figur (welche
  // Motive hängen laut Plan an ihr?) → Badge mit Navigation in die Motiv-
  // Werkstatt. Pendant zu loadPlotUsage; ohne sie ist die Kante Motiv ↔ Figur
  // einseitig. Best-effort wie dort.
  async loadMotifUsage() {
    const bookId = Alpine.store('nav').selectedBookId;
    const draftId = this.selectedDraftId;
    this.motifUsage = null;
    if (!bookId || !draftId) return;
    try {
      const u = await fetchJson(`/motifs/figure-usage?book_id=${bookId}&draft_id=${draftId}`);
      if (this.selectedDraftId !== draftId) return; // Stale (Draft inzwischen gewechselt)
      this.motifUsage = u || null;
    } catch { this.motifUsage = null; }
  },

  motifUsageVisible() {
    const u = this.motifUsage;
    return !!(u && u.motifCount > 0);
  },

  motifUsageLabel() {
    const u = this.motifUsage;
    if (!u) return '';
    return window.__app.t('werkstatt.motifUsage.badge', { n: u.motifCount });
  },

  // Der Tooltip nennt die Motive beim Namen UND sagt, wie viele davon im Text
  // überhaupt belegt sind — „geplant" ist nicht „trägt", und ein Badge, das nur
  // die Planzahl zeigt, verschweigt genau den Unterschied.
  motifUsageTip() {
    const u = this.motifUsage;
    const app = window.__app;
    if (!u || !u.motifs?.length) return '';
    const names = u.motifs.map(m => m.name).filter(Boolean).join(', ');
    return app.t('werkstatt.motifUsage.tip', { names, belegt: u.belegteCount, n: u.motifCount });
  },

  // Sprung in die Motiv-Werkstatt: das erste Motiv dieser Figur öffnen. Ein
  // gefilterter Bestand wie beim Plot-Badge gibt es dort nicht — die
  // Konstellation ist keine Liste.
  openMotifForFigure() {
    const first = this.motifUsage?.motifs?.[0];
    if (!first) return;
    window.__app.openMotifById(first.id);
  },

  plotUsageTip() {
    const u = this.plotUsage;
    const app = window.__app;
    if (!u) return '';
    const names = (u.threads || []).map(t => t.name).filter(Boolean);
    return names.length
      ? app.t('werkstatt.plotUsage.threadTip', { names: names.join(', ') })
      : app.t('werkstatt.plotUsage.tip');
  },

  selectedDraft() {
    if (!this.selectedDraftId) return null;
    return this.drafts.find(d => d.id === this.selectedDraftId) || null;
  },

  startCreate() {
    this.creating = true;
    this.newName = '';
    this.errorMessage = '';
    this.$nextTick(() => {
      const input = this.$el?.querySelector('.werkstatt-new-name');
      input?.focus();
    });
  },

  cancelCreate() {
    this.creating = false;
    this.newName = '';
  },

  async createDraft() {
    const app = window.__app;
    const name = (this.newName || '').trim();
    if (!name) { this.errorMessage = app.t('werkstatt.error.nameRequired'); return; }
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    this.busy = true;
    try {
      const row = await fetchJson(`/draft-figures/${bookId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      this.drafts = [row, ...this.drafts];
      this.creating = false;
      this.newName = '';
      this.selectDraft(row.id);
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = werkstattErrorText(e, 'werkstatt.error.create');
    } finally {
      this.busy = false;
    }
  },

  async saveDraft() {
    const app = window.__app;
    const sel = this.selectedDraft();
    if (!sel) return false;
    const name = (this.editName || '').trim();
    if (!name) { this.errorMessage = app.t('werkstatt.error.nameRequired'); return false; }
    // Generation VOR dem Export festhalten: nur sie gilt nach dem Save als
    // gespeichert (siehe _markMindmapDirty).
    const gen = this._mindmapGen;
    // Mindmap nur exportieren, wenn Editor zu diesem Draft gehört (_jmDraftId
    // wird in _mountMindmap nach show() gesetzt). Sonst Server-State behalten.
    const exported = this._jmDraftId === sel.id ? this._exportMindmap() : null;
    const mindmap = exported || sel.mindmap;
    this.busy = true;
    try {
      const updated = await fetchJson(`/draft-figures/${sel.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          archetype: this.editArchetype || null,
          notes: this.editNotes || null,
          mindmap,
          // Optimistic Concurrency: der Stand, auf dem editiert wurde. Weicht der
          // Server-Stand ab (zweiter Tab, Zweitgerät), kommt 409 DRAFT_CONFLICT
          // statt eines stillen Überschreibens.
          expectedUpdatedAt: sel.updated_at || null,
        }),
      });
      this.drafts = this.drafts.map(d => d.id === updated.id ? updated : d);
      this.errorMessage = '';
      this._markMindmapClean(gen);
      return true;
    } catch (e) {
      this.errorMessage = werkstattErrorText(e, 'werkstatt.error.save');
      return false;
    } finally {
      this.busy = false;
    }
  },

  async requestDelete() {
    const sel = this.selectedDraft();
    if (!sel) return;
    const app = window.__app;
    const ok = await app.appConfirm({
      message: app.t('werkstatt.confirmDelete'),
      danger: true,
    });
    if (!ok) return;
    await this._doDelete(sel.id);
  },

  async _doDelete(id) {
    const app = window.__app;
    this.busy = true;
    try {
      await fetchJson(`/draft-figures/${id}`, { method: 'DELETE' });
      this._destroyMindmap();
      this.drafts = this.drafts.filter(d => d.id !== id);
      if (this.selectedDraftId === id) {
        this.selectedDraftId = null;
        this.editName = '';
        this.editArchetype = '';
        this.editNotes = '';
        this.brainstormResult = null;
        this.consistencyResult = null;
        this.runs = { brainstorm: [], consistency: [] };
        this.runsLoadedDraftId = null;
        this.plotUsage = null;
        this.motifUsage = null;
        this.selectedRunId = null;
        this.selectedKonfliktIdx = null;
        if (this.drafts.length > 0) this.selectDraft(this.drafts[0].id);
      }
    } catch (e) {
      this.errorMessage = werkstattErrorText(e, 'werkstatt.error.delete');
    } finally {
      this.busy = false;
    }
  },
};
