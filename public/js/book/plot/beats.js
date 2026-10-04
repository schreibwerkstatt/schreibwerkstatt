// Plot-Werkstatt: Beat-CRUD (flach + grid-zellen-granular), Verwerfen-Flag,
// Intensität/Figuren-Draft und Drag-&-Drop-Reordering über beide Pfade.

import { fetchJson } from '../../utils.js';
import { mergeBeatRow, beatFieldsEqual } from './constants.js';

export const beatsMethods = {
  // ── Beat anlegen (flach + Grid-Zelle teilen den Kern) ───────────────────────
  // Flach: akt-only (thread_id null), Selektor `[data-add-beat-act]`, Add-Modus
  // über `addingActId`. Grid: zell-granular (thread_id gesetzt), Selektor
  // `[data-add-beat-cell]`, Add-Modus über `addingCell`. Die öffentlichen Methoden
  // (von den Partials referenziert) bleiben dünn und delegieren an die Kerne.

  // Das Eingabefeld einer Add-Zone refokussieren (nach dem Stapeln eines Beats).
  _focusAddInput(scopeSelector) {
    this.$root?.querySelector(`${scopeSelector} .plot-add-beat-input`)?.focus();
  },

  // Gemeinsamer Speicherpfad. cancel/refocus/close kapseln den einzigen
  // Unterschied (addingActId vs addingCell). threadId === null im flachen Pfad.
  async _createBeatInline({ actId, threadId, keepAdding, cancel, refocus, close }) {
    const app = window.__app;
    const titel = (this.newBeatTitel || '').trim();
    if (!titel) { cancel(); return; }
    // Doppel-Enter / Undo im Flug: kein zweiter POST, kein verschluckter Record
    // (der Titel bleibt im Feld stehen).
    if (this.busy || this._inHistoryFlight) return;
    this.busy = true;
    try {
      const beat = await fetchJson('/plot/beats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: Alpine.store('nav').selectedBookId, act_id: actId, thread_id: threadId ?? null, titel }),
      });
      this.beats = [...this.beats, beat];
      this._memos = {};
      this._recordCreate('beat', beat?.id);
      this.newBeatTitel = '';
      this.errorMessage = '';
      if (keepAdding) this.$nextTick(refocus); else close();
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    } finally { this.busy = false; }
  },

  // Auto-Save beim Verlassen des Eingabefelds (analog Akt-Umbenennen). NICHT
  // speichern, wenn der Fokus auf die Add-Buttons (Hinzufügen/Abbrechen) oder ins
  // LanguageTool-Badge/-Popover wandert — die behandeln den Klick selbst bzw. der
  // User korrigiert gerade Rechtschreibung. Leeres Feld → Add-Modus nur schliessen.
  //
  // Der Spellcheck-Dispatcher wickelt das Feld beim Fokus in ein
  // <span class="lt-field-wrap"> — der DOM-Move feuert ein synchrones blur,
  // obwohl der Fokus unmittelbar danach wiederhergestellt wird. Würde blur sofort
  // canceln (leeres Feld beim ersten Klick), blendete das x-if das Input direkt
  // wieder aus und der User kann gar nichts eingeben. Darum eine Frame deferren und
  // nur reagieren, wenn der Fokus das Feld wirklich verlassen hat (analog onActBlur).
  _deferAddBeatBlur(ev, isActive, cancel, save) {
    if (this.busy || !isActive()) return;
    const to = ev?.relatedTarget;
    if (to?.closest?.('.plot-add-beat-actions, .lt-badge, .lt-popover')) return;
    if (document.querySelector('.lt-popover')) return;
    const input = ev?.target || null;
    requestAnimationFrame(() => {
      if (this.busy || !isActive()) return;
      if (input && document.activeElement === input) return;
      if (!(this.newBeatTitel || '').trim()) { cancel(); return; }
      save();
    });
  },

  // ── Flaches Board (akt-only) ────────────────────────────────────────────────
  startAddBeat(actId) {
    this.addingActId = actId;
    this.newBeatTitel = '';
    this.$nextTick(() => this._focusAddInput(`[data-add-beat-act="${actId}"]`));
  },
  cancelAddBeat() { this.addingActId = null; this.newBeatTitel = ''; },

  // keepAdding=true (Enter / „Hinzufügen"): Feld leeren + refokussieren zum
  // schnellen Stapeln. keepAdding=false (Blur): speichern + Add-Modus schliessen.
  saveNewBeat(actId, { keepAdding = true } = {}) {
    return this._createBeatInline({
      actId, threadId: null, keepAdding,
      cancel: () => this.cancelAddBeat(),
      refocus: () => this._focusAddInput(`[data-add-beat-act="${actId}"]`),
      close: () => { this.addingActId = null; },
    });
  },

  onAddBeatBlur(actId, ev) {
    this._deferAddBeatBlur(ev,
      () => this.addingActId === actId,
      () => this.cancelAddBeat(),
      () => this.saveNewBeat(actId, { keepAdding: false }));
  },

  // ── Grid-Zelle (Akt × Strang) ───────────────────────────────────────────────
  // addingCell ist der Zell-Schlüssel `${actId}:${threadId|null}`.
  _cellKey(actId, threadId) { return `${actId}:${threadId == null ? 'null' : threadId}`; },

  startAddBeatCell(actId, threadId) {
    this.addingCell = this._cellKey(actId, threadId);
    this.newBeatTitel = '';
    this.$nextTick(() => this._focusAddInput(`[data-add-beat-cell="${this.addingCell}"]`));
  },
  cancelAddBeatCell() { this.addingCell = null; this.newBeatTitel = ''; },

  saveNewBeatCell(actId, threadId, { keepAdding = true } = {}) {
    return this._createBeatInline({
      actId, threadId: threadId ?? null, keepAdding,
      cancel: () => this.cancelAddBeatCell(),
      refocus: () => this._focusAddInput(`[data-add-beat-cell="${this._cellKey(actId, threadId)}"]`),
      close: () => { this.addingCell = null; },
    });
  },

  onAddBeatCellBlur(actId, threadId, ev) {
    const key = this._cellKey(actId, threadId);
    this._deferAddBeatBlur(ev,
      () => this.addingCell === key,
      () => this.cancelAddBeatCell(),
      () => this.saveNewBeatCell(actId, threadId, { keepAdding: false }));
  },

  // Ein offener ANDERER Beat wird zuerst committet (wie Klick ausserhalb), erst
  // danach überschreibt der neue Draft den alten — sonst gingen dessen Edits still
  // verloren (der @click.outside des alten Panels feuert NACH diesem Handler und
  // sieht editingBeatId schon umgesetzt). Scheitert das Speichern, bleibt der alte
  // Beat offen. Derselbe Beat erneut (z. B. Spannungsbogen-Punkt) → Draft bleibt.
  async startEditBeat(beat) {
    if (!beat) return false;
    if (this.editingBeatId === beat.id) return true;
    if (this.editingBeatId != null) {
      const prev = (this.beats || []).find(b => b.id === this.editingBeatId);
      if (prev) {
        const ok = await this.commitEditBeat(prev);
        if (ok === false) return false;
      } else {
        this.cancelEditBeat();
      }
    }
    this.editingBeatId = beat.id;
    this.relDraftTyp = '';
    this.relDraftTarget = '';
    // Permalink-Spiegel für den Beat (#book/X/plot/<beatId>): Hash-Router liest
    // Alpine.store('nav').plotBeatId. editingBeatId bleibt SSoT in der Karte.
    if (window.Alpine) window.Alpine.store('nav').plotBeatId = beat.id;
    this.beatDraft = {
      titel: beat.titel || '',
      beschreibung: beat.beschreibung || '',
      status: beat.status || 'geplant',
      chapter_id: beat.chapter_id || '',
      intensitaet: beat.intensitaet || null,
      zeit: beat.zeit || '',
      figure_ids: [...(beat.fig_ids || [])],
      draft_figure_ids: [...(beat.draft_fig_ids || [])],
      motif_ids: (beat.motifs || []).map(m => m.id),
      location_ids: (beat.locations || []).map(l => l.id),
    };
    return true;
  },
  cancelEditBeat() { this.editingBeatId = null; if (window.Alpine) window.Alpine.store('nav').plotBeatId = null; },

  // Zahl der gesetzten Einordnungs-Felder im Entwurf (Kapitel, Zeit, Figuren,
  // Schauplaetze, Motive) — Badge am zugeklappten „Einordnung"-Toggle.
  beatDraftDetailCount() {
    const d = this.beatDraft || {};
    return (d.chapter_id ? 1 : 0) + ((d.zeit || '').trim() ? 1 : 0)
      + (d.figure_ids || []).length + (d.draft_figure_ids || []).length
      + (d.location_ids || []).length + (d.motif_ids || []).length;
  },

  // Panel-weite Tastaturkürzel im Beat-Editor (am .plot-beat-edit-Container, damit sie
  // auch bei Fokus in Beschreibung/Combobox greifen, nicht nur im Titelfeld): Cmd/Ctrl+S
  // committet den Beat (speichern + schliessen, wie Enter), Escape verwirft. Combobox/
  // EntityPicker konsumieren Escape selbst, solange ihr Dropdown offen ist (stopPropagation).
  onBeatEditKeydown(event, beat) {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.shiftKey && !event.altKey && (event.key === 's' || event.key === 'S')) {
      event.preventDefault();
      this.commitEditBeat(beat);
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); this.cancelEditBeat(); }
  },

  // Klick ausserhalb des Edit-Panels: Änderungen committen (wie Save) und dann
  // schliessen. Leerer Titel → nichts Sinnvolles zu speichern, einfach verwerfen
  // (saveEditBeat würde sonst mit Fehler offen bleiben).
  // true = gespeichert/verworfen (Panel zu), false = Speichern gescheitert.
  async commitEditBeat(beat) {
    if (!(this.beatDraft.titel || '').trim()) { this.cancelEditBeat(); return true; }
    return this.saveEditBeat(beat);
  },

  // Deep-Link-Ziel öffnen: Beat suchen → Edit + zentriert ins Bild. Noch nicht
  // geladenes Board → ID merken, loadBoard() ruft uns danach mit fromLoad erneut
  // auf. Fehlt die ID auch im frisch geladenen Board (gelöscht, fremder Link),
  // wird sie verworfen statt endlos neu geparkt.
  _focusBeatById(rawId, { fromLoad = false } = {}) {
    const id = parseInt(rawId);
    if (!Number.isInteger(id)) return;
    const beat = (this.beats || []).find(b => b.id === id);
    if (!beat) {
      if (!fromLoad) { this._pendingFocusBeatId = id; return; }
      const nav = window.Alpine?.store('nav');
      if (nav && nav.plotBeatId === id) nav.plotBeatId = null;
      return;
    }
    this.startEditBeat(beat);
    this.$nextTick(() => this.scrollToBeat(id));
  },

  intensitaetScale() { return [1, 2, 3, 4, 5]; },

  // Intensität setzen — erneuter Klick auf den aktiven Wert löscht ihn (null).
  setBeatDraftIntensitaet(n) {
    this.beatDraft.intensitaet = (this.beatDraft.intensitaet === n) ? null : n;
  },

  // Kombinierte Figuren-Combobox (zwei Quellen als opt-Gruppen, wie in der
  // Motiv-Werkstatt): Präfix fig: → Katalog-Figur (TEXT-fig_id), draft: →
  // Werkstatt-Figur (INTEGER draft_figures.id). Fügt nur hinzu (Set-dedupe);
  // Entfernen läuft über die Chip-Buttons (toggleBeatDraft*Figure).
  addBeatFigureLink(val) {
    if (val == null || val === '') return;
    const s = String(val);
    if (s.startsWith('draft:')) {
      const id = parseInt(s.slice(6));
      if (Number.isInteger(id) && !this.beatDraft.draft_figure_ids.includes(id)) {
        this.beatDraft.draft_figure_ids = [...this.beatDraft.draft_figure_ids, id];
      }
    } else {
      const id = s.startsWith('fig:') ? s.slice(4) : s;
      if (!this.beatDraft.figure_ids.includes(id)) {
        this.beatDraft.figure_ids = [...this.beatDraft.figure_ids, id];
      }
    }
  },

  toggleBeatDraftFigure(figId) {
    const set = new Set(this.beatDraft.figure_ids);
    if (set.has(figId)) set.delete(figId); else set.add(figId);
    this.beatDraft.figure_ids = [...set];
  },

  // Werkstatt-Figur (draft_figures.id, INTEGER) im Beat an-/abwählen.
  toggleBeatDraftWerkstattFigure(draftId) {
    const set = new Set(this.beatDraft.draft_figure_ids);
    if (set.has(draftId)) set.delete(draftId); else set.add(draftId);
    this.beatDraft.draft_figure_ids = [...set];
  },

  // Motiv (motifs.id, INTEGER) im Beat an-/abwählen — schreibt in dieselbe
  // motif_beats-Brücke wie die Motiv-Werkstatt (Beat-Achse, Full-Replace beim Save).
  toggleBeatDraftMotif(motifId) {
    const set = new Set(this.beatDraft.motif_ids);
    if (set.has(motifId)) set.delete(motifId); else set.add(motifId);
    this.beatDraft.motif_ids = [...set];
  },

  // Schauplatz (locations.loc_id, TEXT) im Beat an-/abwählen.
  toggleBeatDraftOrt(locId) {
    const set = new Set(this.beatDraft.location_ids);
    if (set.has(locId)) set.delete(locId); else set.add(locId);
    this.beatDraft.location_ids = [...set];
  },

  // Reentrance-sicher: Commit-Wege (Enter, Cmd+S, Klick ausserhalb, Wechsel auf
  // einen anderen Beat via startEditBeat) können im selben Klick zusammenfallen —
  // ein zweiter Aufruf während des Flights teilt dessen Ergebnis statt doppelt
  // zu PATCHen. Liefert true (gespeichert bzw. nichts zu speichern) / false.
  saveEditBeat(beat) {
    if (this._beatSavePromise) return this._beatSavePromise;
    const p = this._saveEditBeatCore(beat);
    this._beatSavePromise = p;
    const clear = () => { if (this._beatSavePromise === p) this._beatSavePromise = null; };
    p.then(clear, clear);
    return p;
  },

  async _saveEditBeatCore(beat) {
    const app = window.__app;
    const titel = (this.beatDraft.titel || '').trim();
    if (!titel) { this.errorMessage = app.t('plot.error.titelRequired'); return false; }
    // Ausgangsstand VOR dem PATCH festhalten (Undo-Ziel) — der Draft ist das
    // After, der aktuelle Beat-Row-Snapshot das Before.
    const cur = (this.beats || []).find(b => b.id === beat.id) || beat;
    const before = this._beatFieldSnapshot(cur);
    const after = {
      titel,
      beschreibung: this.beatDraft.beschreibung || '',
      status: this.beatDraft.status,
      chapter_id: this.beatDraft.chapter_id ? parseInt(this.beatDraft.chapter_id) : null,
      intensitaet: this.beatDraft.intensitaet || null,
      // Leerer Text heisst „keine Angabe" → null, nicht '': die Zeit-Messung
      // fragt auf `Number.isFinite(jahr)`, und ein Leerstring waere ein
      // datierter Beat ohne Datum.
      zeit: (this.beatDraft.zeit || '').trim() || null,
      figure_ids: [...this.beatDraft.figure_ids],
      draft_figure_ids: [...this.beatDraft.draft_figure_ids],
      motif_ids: [...this.beatDraft.motif_ids],
      location_ids: [...this.beatDraft.location_ids],
    };
    const close = () => {
      if (this.editingBeatId !== beat.id) return;
      this.editingBeatId = null;
      if (window.Alpine) window.Alpine.store('nav').plotBeatId = null;
    };
    // Dirty-Check: nichts geändert → kein PATCH, kein Undo-Record, nur schliessen.
    if (beatFieldsEqual(before, after)) { close(); this.errorMessage = ''; return true; }
    this.busy = true;
    try {
      const updated = await fetchJson(`/plot/beats/${beat.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(after),
      });
      this._replaceBeat(updated);
      this._recordBeatFields(beat.id, before, after);
      close();
      this.errorMessage = '';
      // Kapitel-Zuweisung kann sich geändert haben → Editor-Indikator syncen.
      app.refreshPlotBeatCounts?.();
      return true;
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
      return false;
    } finally { this.busy = false; }
  },

  // Verwerfen-Flag umschalten (eigene Achse, unabhängig vom Status). Sofort
  // persistiert — funktioniert aus Ansicht und Edit-Panel.
  // busy-Guard: läuft gerade ein Undo/Redo oder eine andere Mutation, würde der
  // Record sonst zwischen Pop und Gegen-Push landen (und den Redo-Stack leeren).
  async toggleBeatVerworfen(beat) {
    const app = window.__app;
    if (!beat || this.busy || this._inHistoryFlight) return;
    const was = beat.verworfen ? 1 : 0;
    this.busy = true;
    try {
      const updated = await fetchJson(`/plot/beats/${beat.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verworfen: was ? 0 : 1 }),
      });
      this._replaceBeat(updated);
      this._recordBeatFields(beat.id, { verworfen: was }, { verworfen: was ? 0 : 1 });
      // Verwerfen ändert, ob der Beat in den Page-Count zählt → Indikator syncen.
      app.refreshPlotBeatCounts?.();
    } catch (e) { this.errorMessage = app.t('plot.error.save'); }
    finally { this.busy = false; }
  },

  async deleteBeat(beat) {
    const app = window.__app;
    if (!await app.appConfirm({
      message: app.t('plot.confirmDeleteBeat', { titel: beat.titel }),
      confirmLabel: app.t('common.delete'),
      danger: true,
    })) return;
    this.busy = true;
    try {
      await fetchJson(`/plot/beats/${beat.id}`, { method: 'DELETE' });
      // Hard-Delete ohne Snapshot: der Beat ist weg, und Records im Stack, die ihn
      // referenzieren (Platzierung, Felder), wären danach Nieten → Historie leeren.
      this._clearHistory();
      this._pruneBeatsLocal([beat.id]);
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.delete');
    } finally { this.busy = false; }
  },

  // Server-Antwort eines Beat-PATCH über den bisherigen Board-Beat legen: die
  // nur von GET /plot gelieferten Felder (occ_count/occ_top) bleiben erhalten,
  // wenn die Antwort sie nicht trägt (pure: constants.js#mergeBeatRow).
  _mergeBeatRow(updated) {
    if (!updated || updated.id == null) return updated;
    const cur = (this.beats || []).find(b => b.id === updated.id);
    return mergeBeatRow(cur, updated);
  },

  // Einziger Weg, einen PATCH-Rückgabewert ins Board zu legen — merged immer
  // über _mergeBeatRow, damit kein Pfad das Anker-Badge auf 'drift' kippt.
  _replaceBeat(row) {
    if (!row || row.id == null) return;
    const merged = this._mergeBeatRow(row);
    this.beats = this.beats.map(b => (b.id === merged.id ? merged : b));
    this._memos = {};
    // Zeit, Figuren oder Verworfen-Flag können sich geändert haben.
    this.loadTimeChecks();
  },

  // Gemeinsamer lokaler Nachzug, wenn Beats serverseitig verschwunden sind
  // (Beat-/Akt-Löschen, Undo eines Create): Beats + ihre ein-/ausgehenden Kanten
  // raus, offener Edit/Permalink/Fundstellen-Popover zurücksetzen, Memos leeren,
  // Kapitel-Indikator + Zeit-Messung nachladen. Historie fasst er NICHT an — das
  // entscheidet der Aufrufer (Löschen leert, ein Undo-Applier darf es nicht).
  _pruneBeatsLocal(ids) {
    const gone = new Set(ids || []);
    if (gone.size) {
      this.beats = (this.beats || []).filter(b => !gone.has(b.id));
      this.relations = (this.relations || []).filter(r => !gone.has(r.from_beat_id) && !gone.has(r.to_beat_id));
      if (gone.has(this.editingBeatId)) this.cancelEditBeat();
      const nav = window.Alpine?.store('nav');
      if (nav && gone.has(nav.plotBeatId)) nav.plotBeatId = null;
      if (gone.has(this.beatOccPopoverBeatId)) this.closeBeatOccPopover?.();
      if (gone.has(this._pendingFocusBeatId)) this._pendingFocusBeatId = null;
    }
    this._memos = {};
    window.__app?.refreshPlotBeatCounts?.();
    this.loadTimeChecks?.();
  },

  // ── Beat-zu-Beat-Beziehungen (Kausalität + Setup/Payoff) ────────────────────
  // Kante vom aktuell bearbeiteten Beat (`from`) auf den im Picker gewählten
  // Ziel-Beat (`to`) mit dem gewählten Typ. Server validiert Selbst-Kante +
  // Fremd-Verweise; UNIQUE macht Doppel-Kanten idempotent. Sofort persistiert
  // (wie toggleBeatVerworfen — eigene Achse neben dem Beat-Draft-Save).
  async addBeatRelation(fromBeat) {
    const app = window.__app;
    if (!fromBeat) return;
    const toId = this.relDraftTarget ? parseInt(this.relDraftTarget) : null;
    const typ = this.relDraftTyp || '';
    if (!toId || !typ) { this.errorMessage = app.t('plot.relation.incomplete'); return; }
    if (this.busy || this._inHistoryFlight) return;
    this.busy = true;
    try {
      const rel = await fetchJson('/plot/beat-relations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: Alpine.store('nav').selectedBookId, from_beat_id: fromBeat.id, to_beat_id: toId, typ }),
      });
      // Idempotent: bei bestehender Kante liefert der Server die vorhandene zurück —
      // nur einreihen, wenn sie noch nicht in der Liste ist.
      if (rel && !this.relations.some(r => r.id === rel.id)) {
        this.relations = [...this.relations, rel];
        this._recordCreate('relation', rel.id);
      }
      this._memos = {};
      this.relDraftTarget = '';
      this.relDraftTyp = '';
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.relation.error');
    } finally { this.busy = false; }
  },

  async deleteBeatRelationById(relId) {
    const app = window.__app;
    if (!relId || this.busy || this._inHistoryFlight) return;
    try {
      await fetchJson(`/plot/beat-relations/${relId}`, { method: 'DELETE' });
      // Wie jedes Löschen: nicht reversibel (Wiederanlegen vergibt eine neue ID).
      this._clearHistory();
      this.relations = this.relations.filter(r => r.id !== relId);
      this._memos = {};
    } catch (e) {
      this.errorMessage = app.t('plot.relation.error');
    }
  },

  // ── Drop-Mechanik (von SortableJS via dnd.js#onBeatSortEnd aufgerufen) ──────
  // Verschiebt den gezogenen Beat (this._dragBeatId) in die Ziel-Zelle (Akt ×
  // Strang; threadId null = „ohne Strang"), nummeriert Ziel- und Quell-Zelle neu
  // und persistiert nur die betroffenen Zellen. SortableJS' physischer DOM-Move
  // ist vor dem Aufruf bereits revertet — hier mutiert allein das Modell, Alpine
  // x-for rendert daraus neu.
  async _dropBeat(targetActId, targetThreadId, beforeBeatId = null) {
    const beatId = this._dragBeatId;
    if (beatId == null) return;
    // Kein Drop während Undo/Redo oder einer anderen Mutation (Record-Verlust).
    if (this.busy || this._inHistoryFlight) { this._dragBeatId = null; return; }
    const beat = this.beats.find(b => b.id === beatId);
    if (!beat) { this._dragBeatId = null; return; }
    const origActId = beat.act_id;
    const origThreadId = beat.thread_id ?? null;
    const tid = targetThreadId ?? null;
    if (beforeBeatId === beatId) { this._dragBeatId = null; return; }
    // Undo-Ausgangsstand VOR der Mutation — die Beat-Objekte werden unten in place
    // verändert, ein Snapshot danach wäre wertlos.
    const placeBefore = this._snapshotPlacements();

    const target = this.beatsForCell(targetActId, tid).filter(b => b.id !== beatId);
    let insertIdx = target.length;
    if (beforeBeatId != null) {
      const i = target.findIndex(b => b.id === beforeBeatId);
      if (i >= 0) insertIdx = i;
    }
    beat.act_id = targetActId;
    beat.thread_id = tid;
    target.splice(insertIdx, 0, beat);
    target.forEach((b, i) => { b.sort_order = i; });
    // Quell-Zelle (falls verschieden) neu durchnummerieren.
    const sameCell = origActId === targetActId && origThreadId === tid;
    if (!sameCell) {
      this.beats
        .filter(b => b.act_id === origActId && (b.thread_id ?? null) === origThreadId && b.id !== beatId)
        .sort((a, b) => a.sort_order - b.sort_order)
        .forEach((b, i) => { b.sort_order = i; });
    }
    this.beats = [...this.beats];
    this._memos = {};
    this._dragBeatId = null;

    const cells = sameCell
      ? [{ actId: targetActId, threadId: tid }]
      : [{ actId: origActId, threadId: origThreadId }, { actId: targetActId, threadId: tid }];
    this.busy = true;
    try {
      const ok = await this._persistCells(cells);
      if (ok) this._recordBeatPlace(placeBefore);
    } finally { this.busy = false; }
  },

  // true = persistiert (Aufrufer darf den Undo-Record schreiben), false = Fehler,
  // Board wird aus dem Server-Stand neu geladen (das leert auch die Historie).
  async _persistCells(cells) {
    const app = window.__app;
    const order = cells.map(({ actId, threadId }) => ({
      actId,
      threadId: threadId ?? null,
      beatIds: this.beatsForCell(actId, threadId ?? null).map(b => b.id),
    }));
    try {
      await fetchJson('/plot/beats/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: Alpine.store('nav').selectedBookId, order }),
      });
      // Die Reihenfolge ist die Achse der Chronologie-Prüfung.
      this.loadTimeChecks();
      return true;
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
      this.loadBoard(); // Server-Stand wiederherstellen
      return false;
    }
  },
};
