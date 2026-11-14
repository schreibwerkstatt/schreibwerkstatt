// Undo/Redo-Records der Plot-Werkstatt. Stack, Deckel, Flight-Schutz, Epoche
// und Fehler-Requeue trägt der Kern [cards/board-history.js] (`historyUndo`,
// `historyRedo`, `canUndo`, `canRedo`); hier steht nur, was fachlich ist: wie
// ein Record aufgezeichnet und in beide Richtungen angewendet wird.
//
// Record-Typen (jeder trägt before UND after, derselbe Record bedient beide
// Richtungen):
//   { kind: 'beat-place',    before: [{id,act_id,thread_id,sort_order}], after: [...] }
//   { kind: 'beat-fields',   id, before: {...}, after: {...} }   — Beat-PATCH-Felder
//   { kind: 'beat-fields-batch', items: [{ id, before, after }] } — EIN Schritt für
//                                  eine Sammel-Änderung (Zeitvorschläge übernehmen)
//   { kind: 'act-fields',    id, before: {...}, after: {...} }   — name / farbe / archiviert
//   { kind: 'act-order',     before: [actIds], after: [actIds] } — PRO Scope
//   { kind: 'thread-fields', id, before: {...}, after: {...} }
//   { kind: 'thread-order',  before: [threadIds], after: [threadIds] }
//   { kind: 'create-beat' | 'create-act' | 'create-thread' | 'create-relation', id }
//   { kind: 'delete-beat',   id, snapshot }  — Beat-Löschen (book/plot/beat-restore.js)
//
// Sonderfall create: Undo löscht das frisch Erzeugte. Danach verwirft der Kern
// den Redo-Stack — ein Redo müsste neu anlegen, der Server vergäbe eine NEUE ID,
// und andere Records im Stack referenzieren die alte. Enthält der Akt/Strang
// inzwischen Beats, fragt das Undo vorher nach (der Server kaskadiert bzw. löst
// die Beats sonst still mit).
//
// Sonderfall delete-beat: das Undo legt den Beat aus dem Snapshot neu an (Felder,
// Platzierung, Beziehungen, Ideen-Verknüpfungen) und schreibt die neue ID per
// `_remapHistory` in alle Records um; das Redo löscht ihn wieder.
//
// Akt-/Strang-Löschen, Beziehung-Löschen, Fork/Unfork und jeder Board-Reload
// rufen `_clearHistory()`: ein Akt kaskadiert all seine Beats samt Kanten (ein
// Snapshot müsste das halbe Board tragen und beim Wiederanlegen jede Beat-ID
// umschreiben), Fork remappt act_id über viele Beats, ein Reload kann fremde
// Änderungen mitbringen — in allen Fällen wäre der Stack danach inkonsistent
// statt bloss unvollständig.
//
// Die `_h*`-Applier sprechen die Routen direkt an und spiegeln lokal, statt die
// interaktiven Methoden (saveEditBeat, moveAct, …) aufzurufen: die zeichnen selbst
// auf, ein Undo würde sich sonst rekursiv in den Stack schreiben.

import { fetchJson } from '../../utils.js';
import { boardHistoryMethods } from '../../cards/board-history.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export const historyMethods = {
  ...boardHistoryMethods,

  // ── Kern-Hooks ─────────────────────────────────────────────────────────────

  // Während ein Undo/Redo fliegt, steht `busy`: die Buttons sind gesperrt (kein
  // Doppelklick-Doppel-Undo) und jede interaktive Mutation kehrt früh zurück —
  // sonst landete ihr Record zwischen Pop und Gegen-Push.
  _historyBusy() { return !!this.busy; },
  _historySetBusy(flag) { this.busy = flag; },

  // Offenes Beat-Edit-Panel verwerfen, bevor zurückgedreht wird. Sonst gewinnt der
  // Draft: das Panel committet per `@click.outside`, und dieser Document-Listener
  // feuert NACH dem Button-Klick (Bubble nach Target) — die Undo-Änderung würde
  // unmittelbar danach von `commitEditBeat` überschrieben. Wer Undo drückt, will
  // zurückdrehen, nicht speichern. Akt-/Strang-Umbenennen speichert dagegen im
  // `blur` (feuert VOR dem Klick) und landet damit korrekt als eigener Record.
  _historyBeforeApply() {
    if (this.editingBeatId != null) this.cancelEditBeat();
  },

  // ── Aufzeichnen (von den Mutations-Methoden gerufen) ────────────────────────

  // Platzierung aller Beats (Zelle + Reihenfolge). Plain-Objekte, weil die
  // Drop-Mechanik die Beat-Objekte IN PLACE mutiert — eine Referenz-Liste wäre
  // nach der Mutation wertlos.
  _snapshotPlacements() {
    return (this.beats || []).map(b => ({
      id: b.id,
      act_id: b.act_id,
      thread_id: b.thread_id ?? null,
      sort_order: b.sort_order,
    }));
  },

  _recordBeatPlace(before) {
    this._pushUndo({ kind: 'beat-place', before, after: this._snapshotPlacements() });
  },

  _recordBeatFields(id, before, after) {
    this._pushUndo({ kind: 'beat-fields', id, before, after });
  },

  _recordBeatFieldsBatch(items) {
    if (items && items.length) this._pushUndo({ kind: 'beat-fields-batch', items });
  },

  _recordActFields(id, before, after) {
    this._pushUndo({ kind: 'act-fields', id, before, after });
  },

  _recordThreadFields(id, before, after) {
    this._pushUndo({ kind: 'thread-fields', id, before, after });
  },

  _recordActOrder(before, after) {
    this._pushUndo({ kind: 'act-order', before, after });
  },

  _recordThreadOrder(before, after) {
    this._pushUndo({ kind: 'thread-order', before, after });
  },

  // kind: 'beat' | 'act' | 'thread' | 'relation'
  _recordCreate(kind, id) {
    if (id == null) return;
    this._pushUndo({ kind: `create-${kind}`, id });
  },

  // Beat-Felder eines Board-Beats in PATCH-Form (Undo-Ausgangswert). Deckt genau
  // die Felder ab, die saveEditBeat schreibt — figure/draft/motif als Kopien,
  // damit der Record nicht auf lebende Arrays zeigt.
  _beatFieldSnapshot(beat) {
    return {
      titel: beat.titel || '',
      beschreibung: beat.beschreibung || '',
      status: beat.status || 'geplant',
      chapter_id: beat.chapter_id || null,
      intensitaet: beat.intensitaet || null,
      zeit: beat.zeit || null,
      figure_ids: [...(beat.fig_ids || [])],
      draft_figure_ids: [...(beat.draft_fig_ids || [])],
      motif_ids: (beat.motifs || []).map(m => m.id),
      location_ids: (beat.locations || []).map(l => l.id),
    };
  },

  // ── Anwenden ───────────────────────────────────────────────────────────────

  async _applyInverse(rec) {
    if (rec.kind === 'beat-place')     return this._hApplyPlacements(rec.before);
    if (rec.kind === 'beat-fields')    return this._hPatchBeat(rec.id, rec.before);
    if (rec.kind === 'beat-fields-batch') return (await this._hPatchBeats(rec.items.map(i => ({ id: i.id, fields: i.before })))).length === rec.items.length;
    if (rec.kind === 'act-fields')     return this._hPatchAct(rec.id, rec.before);
    if (rec.kind === 'thread-fields')  return this._hPatchThread(rec.id, rec.before);
    if (rec.kind === 'act-order')      return this._hApplyActOrder(rec.before);
    if (rec.kind === 'thread-order')   return this._hApplyThreadOrder(rec.before);
    if (rec.kind === 'create-beat')    return this._hDeleteBeat(rec.id);
    if (rec.kind === 'create-act')     return this._hUndoCreateAct(rec.id);
    if (rec.kind === 'create-thread')  return this._hUndoCreateThread(rec.id);
    if (rec.kind === 'create-relation') return this._hDeleteRelation(rec.id);
    if (rec.kind === 'delete-beat')    return this._hRestoreBeat(rec);
    return false;
  },

  // create-* fehlt hier absichtlich: nach dem Undo eines Create ist der
  // Redo-Stack leer (neue ID beim Wiederanlegen), ein Redo kann nie anliegen.
  async _applyForward(rec) {
    if (rec.kind === 'delete-beat')   return this._hRedeleteBeat(rec);
    if (rec.kind === 'beat-place')    return this._hApplyPlacements(rec.after);
    if (rec.kind === 'beat-fields')   return this._hPatchBeat(rec.id, rec.after);
    if (rec.kind === 'beat-fields-batch') return (await this._hPatchBeats(rec.items.map(i => ({ id: i.id, fields: i.after })))).length === rec.items.length;
    if (rec.kind === 'act-fields')    return this._hPatchAct(rec.id, rec.after);
    if (rec.kind === 'thread-fields') return this._hPatchThread(rec.id, rec.after);
    if (rec.kind === 'act-order')     return this._hApplyActOrder(rec.after);
    if (rec.kind === 'thread-order')  return this._hApplyThreadOrder(rec.after);
    return false;
  },

  // ── Raw-Applier (kein Aufzeichnen, kein Confirm) ────────────────────────────

  // Platzierungs-Snapshot einspielen: nur die Beats anfassen, die wirklich
  // abweichen, danach die betroffenen Zellen (Quelle + Ziel) neu durchnummerieren
  // und über denselben Zell-PUT persistieren wie jeder Drop. Beats, die es zur
  // Snapshot-Zeit noch nicht gab, bleiben unberührt — die Neunummerierung reiht
  // sie hinter den wiederhergestellten ein.
  async _hApplyPlacements(snap) {
    const want = new Map((snap || []).map(p => [p.id, p]));
    const cells = new Map();
    const addCell = (actId, threadId) => {
      cells.set(`${actId}:${threadId == null ? 'null' : threadId}`, { actId, threadId: threadId ?? null });
    };
    for (const b of (this.beats || [])) {
      const p = want.get(b.id);
      if (!p) continue;
      const curThread = b.thread_id ?? null;
      if (b.act_id === p.act_id && curThread === p.thread_id && b.sort_order === p.sort_order) continue;
      addCell(b.act_id, curThread);
      addCell(p.act_id, p.thread_id);
      b.act_id = p.act_id;
      b.thread_id = p.thread_id;
      b.sort_order = p.sort_order;
    }
    if (!cells.size) return true;
    this.beats = [...this.beats];
    this._memos = {};
    // Lokale sort_order auf 0..n-1 ziehen, damit sie dem entspricht, was der
    // Server aus der gesendeten Reihenfolge macht (Index = Position).
    const list = [...cells.values()];
    for (const c of list) this.beatsForCell(c.actId, c.threadId).forEach((b, i) => { b.sort_order = i; });
    this.beats = [...this.beats];
    this._memos = {};
    return await this._persistCells(list);
  },

  async _hPatchBeat(id, fields) {
    const app = window.__app;
    try {
      const updated = await fetchJson(`/plot/beats/${id}`, {
        method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(fields),
      });
      // _replaceBeat merged über _mergeBeatRow (occ_count/occ_top bleiben stehen).
      this._replaceBeat(updated);
      app.refreshPlotBeatCounts?.();
      this.errorMessage = '';
      return true;
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
      return false;
    }
  },

  // Mehrere Beat-PATCHes nacheinander, lokal EINMAL gespiegelt (ein Board-
  // Update, eine Zeit-Messung statt N). Liefert die IDs der erfolgreichen
  // PATCHes — ein Teil-Erfolg bleibt sichtbar im Board, der Aufrufer entscheidet.
  async _hPatchBeats(list) {
    const app = window.__app;
    const rows = [];
    let ok = true;
    for (const { id, fields } of (list || [])) {
      try {
        rows.push(await fetchJson(`/plot/beats/${id}`, {
          method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(fields),
        }));
      } catch (e) { ok = false; }
    }
    if (rows.length) {
      const byId = new Map(rows.map(r => [r.id, this._mergeBeatRow(r)]));
      this.beats = this.beats.map(b => byId.get(b.id) || b);
      this._memos = {};
      this.loadTimeChecks();
    }
    this.errorMessage = ok ? '' : app.t('plot.error.save');
    return rows.map(r => r.id);
  },

  async _hPatchAct(id, fields) {
    const app = window.__app;
    try {
      const updated = await fetchJson(`/plot/acts/${id}`, {
        method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(fields),
      });
      this.acts = (this.acts || []).map(a => (a.id === updated.id ? updated : a));
      this._memos = {};
      this.errorMessage = '';
      return true;
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
      return false;
    }
  },

  async _hPatchThread(id, fields) {
    const app = window.__app;
    try {
      const updated = await fetchJson(`/plot/threads/${id}`, {
        method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(fields),
      });
      this.threads = (this.threads || []).map(t => (t.id === updated.id ? updated : t));
      this._memos = {};
      this.errorMessage = '';
      return true;
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
      return false;
    }
  },

  // Akt-Reihenfolge eines Scopes wiederherstellen (Liste = genau die Akte dieses
  // Scopes, Index = Position — wie moveAct sendet).
  async _hApplyActOrder(ids) {
    const app = window.__app;
    const snapshot = this.acts;
    const pos = new Map((ids || []).map((id, i) => [id, i]));
    this.acts = (this.acts || []).map(a => (pos.has(a.id) ? { ...a, position: pos.get(a.id) } : a));
    this._memos = {};
    try {
      await fetchJson('/plot/acts/order', {
        method: 'PUT', headers: JSON_HEADERS,
        body: JSON.stringify({ book_id: Alpine.store('nav').selectedBookId, order: ids }),
      });
      this.errorMessage = '';
      return true;
    } catch (e) {
      // Lokalen Stand zurückdrehen — der Server hat die Reihenfolge nicht übernommen.
      this.acts = snapshot;
      this._memos = {};
      this.errorMessage = app.t('plot.error.save');
      return false;
    }
  },

  async _hApplyThreadOrder(ids) {
    const app = window.__app;
    const snapshot = this.threads;
    const pos = new Map((ids || []).map((id, i) => [id, i]));
    this.threads = (this.threads || [])
      .map(t => (pos.has(t.id) ? { ...t, position: pos.get(t.id) } : t))
      .sort((a, b) => a.position - b.position);
    this._memos = {};
    try {
      await fetchJson('/plot/threads/order', {
        method: 'PUT', headers: JSON_HEADERS,
        body: JSON.stringify({ book_id: Alpine.store('nav').selectedBookId, order: ids }),
      });
      this.errorMessage = '';
      return true;
    } catch (e) {
      this.threads = snapshot;
      this._memos = {};
      this.errorMessage = app.t('plot.error.save');
      return false;
    }
  },

  async _hDeleteBeat(id) {
    const app = window.__app;
    try {
      await fetchJson(`/plot/beats/${id}`, { method: 'DELETE' });
      // Server kaskadiert die Kanten — _pruneBeatsLocal zieht Beat, Kanten, Edit,
      // Kapitel-Indikator und Zeit-Messung lokal nach (Historie bleibt: Applier).
      this._pruneBeatsLocal([id]);
      this.errorMessage = '';
      return true;
    } catch (e) {
      this.errorMessage = app.t('plot.error.delete');
      return false;
    }
  },

  // Undo eines Akt-Create: der Akt kann inzwischen Beats tragen, die der Server
  // mitlöscht — dann vorher fragen (wie deleteAct selbst).
  async _hUndoCreateAct(id) {
    const app = window.__app;
    const act = (this.acts || []).find(a => a.id === id);
    const beatCount = (this.beats || []).filter(b => b.act_id === id).length;
    if (beatCount > 0) {
      const ok = await app.appConfirm({
        message: app.t('plot.history.undoActWithBeats', { name: act?.name || '', n: beatCount }),
        confirmLabel: app.t('plot.history.undo'),
        danger: true,
      });
      if (!ok) return false;
    }
    try {
      await fetchJson(`/plot/acts/${id}`, { method: 'DELETE' });
      const gone = (this.beats || []).filter(b => b.act_id === id).map(b => b.id);
      this.acts = (this.acts || []).filter(a => a.id !== id);
      if (this.editingActId === id) this.cancelEditAct();
      this._pruneBeatsLocal(gone);
      this.errorMessage = '';
      return true;
    } catch (e) {
      this.errorMessage = app.t('plot.error.delete');
      return false;
    }
  },

  // Undo eines Strang-Create: Beats bleiben (Server setzt thread_id auf NULL),
  // sie fallen in die „ohne Strang"-Lane. Trotzdem fragen, wenn welche dranhängen —
  // die Zuordnung ist Planungsarbeit, die still verschwinden würde.
  async _hUndoCreateThread(id) {
    const app = window.__app;
    const thread = (this.threads || []).find(t => t.id === id);
    const beatCount = (this.beats || []).filter(b => b.thread_id === id).length;
    if (beatCount > 0) {
      const ok = await app.appConfirm({
        message: app.t('plot.history.undoThreadWithBeats', { name: thread?.name || '', n: beatCount }),
        confirmLabel: app.t('plot.history.undo'),
        danger: true,
      });
      if (!ok) return false;
    }
    try {
      await fetchJson(`/plot/threads/${id}`, { method: 'DELETE' });
      this.threads = (this.threads || []).filter(t => t.id !== id);
      this.beats = (this.beats || []).map(b => (b.thread_id === id ? { ...b, thread_id: null } : b));
      this._memos = {};
      if (this.editingThreadId === id) this.editingThreadId = null;
      this.errorMessage = '';
      return true;
    } catch (e) {
      this.errorMessage = app.t('plot.error.delete');
      return false;
    }
  },

  async _hDeleteRelation(id) {
    const app = window.__app;
    try {
      await fetchJson(`/plot/beat-relations/${id}`, { method: 'DELETE' });
      this.relations = (this.relations || []).filter(r => r.id !== id);
      this._memos = {};
      this.errorMessage = '';
      return true;
    } catch (e) {
      this.errorMessage = app.t('plot.relation.error');
      return false;
    }
  },
};
