// Plot-Werkstatt: Strang-CRUD (Swimlanes) — Anlegen, Bearbeiten inkl.
// exklusiver Figuren-Bindung, Farb-Picker, Löschen, Reihenfolge.

import { fetchJson } from '../../utils.js';
import { ACT_PALETTE } from './constants.js';

export const threadsMethods = {
  async addThread() {
    const app = window.__app;
    const name = (this.newThreadName || '').trim();
    if (!name) { this.errorMessage = app.t('plot.error.nameRequired'); return; }
    if (this.busy || this._inHistoryFlight) return;
    this.busy = true;
    try {
      const thread = await fetchJson('/plot/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: Alpine.store('nav').selectedBookId, name }),
      });
      this.threads = [...this.threads, thread];
      this._memos = {};
      this._recordCreate('thread', thread?.id);
      this.newThreadName = '';
      this.addingThread = false;
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    } finally { this.busy = false; }
  },

  startEditThread(thread) {
    this.editingThreadId = thread.id;
    this.threadColorPickerId = null;
    this.threadDraft = {
      name: thread.name || '',
      farbe: thread.farbe || null,
      // Katalog-Bindung wird als TEXT-fig_id geführt (matcht $store.catalog.figuren),
      // Werkstatt-Bindung als INTEGER draft_figures.id.
      figure_id: thread.fig_id || '',
      draft_figure_id: thread.draft_figure_id || '',
      chapter_id: thread.chapter_id || '',
    };
    this.$nextTick(() => { this.$root?.querySelector('.plot-thread-name-input')?.focus(); });
  },
  cancelEditThread() { this.editingThreadId = null; },

  // Enter, Cmd/Ctrl+S (`$editKeys`) und Klick ausserhalb: speichern und schliessen.
  // Guard: der Klick, der einen anderen Strang öffnet, darf diesen nicht mehr
  // speichern; leerer Name → verwerfen statt mit Fehler offen bleiben.
  commitEditThread(thread) {
    if (this.editingThreadId !== thread.id || this.busy) return;
    if (!(this.threadDraft.name || '').trim()) { this.cancelEditThread(); return; }
    return this.saveEditThread(thread);
  },

  async saveEditThread(thread) {
    const app = window.__app;
    const name = (this.threadDraft.name || '').trim();
    if (!name) { this.errorMessage = app.t('plot.error.nameRequired'); return; }
    // Wie saveEditAct: im Undo/Redo-Flight nicht dazwischen schreiben.
    if (this.busy || this._inHistoryFlight) return;
    // Undo-Ausgangsstand in PATCH-Form: die Katalog-Bindung wird nach aussen als
    // TEXT-fig_id geführt (thread.fig_id), der Server erwartet sie als figure_id.
    const before = {
      name: thread.name || '',
      farbe: thread.farbe || null,
      figure_id: thread.fig_id || null,
      draft_figure_id: thread.draft_figure_id || null,
      chapter_id: thread.chapter_id || null,
    };
    const after = {
      name,
      farbe: this.threadDraft.farbe || null,
      figure_id: this.threadDraft.figure_id || null,
      draft_figure_id: this.threadDraft.draft_figure_id || null,
      chapter_id: this.threadDraft.chapter_id ? parseInt(this.threadDraft.chapter_id) : null,
    };
    // Unverändert → kein PATCH, kein Record (der leerte sonst den Redo-Stack
    // und das nächste Strg+Z täte sichtbar nichts) — wie saveEditAct/beatFieldsEqual.
    if (Object.keys(after).every(k => after[k] === before[k])) { this.cancelEditThread(); return; }
    this.busy = true;
    try {
      const updated = await fetchJson(`/plot/threads/${thread.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(after),
      });
      this.threads = this.threads.map(t => (t.id === updated.id ? updated : t));
      this._memos = {};
      this._recordThreadFields(thread.id, before, after);
      this.editingThreadId = null;
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    } finally { this.busy = false; }
  },

  toggleThreadColorPicker(threadId) {
    this.threadColorPickerId = this.threadColorPickerId === threadId ? null : threadId;
  },

  // Lane-Aktionsmenü (⋯-Knopf, Rechtsklick/Long-Press auf den Lane-Kopf):
  // einzelnes, nach .card--plot teleportiertes .context-menu, Mechanik aus
  // action-menu.js — die Lane sitzt in einem overflow-x/will-change-Scroll-
  // container, in dem ein am Trigger verankertes Popover geclippt würde.
  openThreadMenu(ev, laneId) {
    this.openActionMenu(ev, `thread:${laneId}`, laneId);
  },

  // Die offene Lane (für das teleportierte Menü außerhalb der gridRows-Schleife).
  threadMenuLane() {
    if (this.actionMenuTarget == null) return null;
    return (this.threadLanes() || []).find(l => l.id === this.actionMenuTarget) || null;
  },


  async setThreadColor(thread, key) {
    const app = window.__app;
    this.threadColorPickerId = null;
    const farbe = ACT_PALETTE.includes(key) ? key : null;
    if (farbe === (thread.farbe || null)) return;
    // Kein Schreiben während Undo/Redo/anderer Mutation (Record-Verlust).
    if (this.busy || this._inHistoryFlight) return;
    this.busy = true;
    try {
      const updated = await fetchJson(`/plot/threads/${thread.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ farbe }),
      });
      this.threads = this.threads.map(t => (t.id === updated.id ? updated : t));
      this._memos = {};
      this._recordThreadFields(thread.id, { farbe: thread.farbe || null }, { farbe });
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    } finally { this.busy = false; }
  },

  async deleteThread(thread) {
    const app = window.__app;
    const beatCount = (this.beats || []).filter(b => b.thread_id === thread.id).length;
    if (!await app.appConfirm({
      message: app.t('plot.thread.confirmDelete', { name: thread.name, n: beatCount }),
      confirmLabel: app.t('common.delete'),
      danger: true,
    })) return;
    // Eigene Aktstruktur? Dann hängt der Server die Beats auf die geteilten Akte
    // um bzw. befördert die eigenen Akte zu geteilten (act_id-Remap über viele
    // Beats) — wie beim Fork neu laden statt lokal raten.
    const hadOwnActs = this._threadHasOwn(thread.id);
    this.busy = true;
    try {
      await fetchJson(`/plot/threads/${thread.id}`, { method: 'DELETE' });
      // Löschen ist nicht reversibel (siehe plot/history.js) → Historie leeren.
      this._clearHistory();
      if (this.editingThreadId === thread.id) this.editingThreadId = null;
      if (this.actionMenuTarget === thread.id) this.closeActionMenu();
      if (hadOwnActs) {
        await this.loadBoard();
      } else {
        this.threads = this.threads.filter(t => t.id !== thread.id);
        // Server setzt thread_id der Beats auf NULL (SET NULL) — lokal spiegeln,
        // die Beats fallen in die „ohne Strang"-Lane.
        this.beats = this.beats.map(b => (b.thread_id === thread.id ? { ...b, thread_id: null } : b));
        this._memos = {};
      }
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.delete');
    } finally { this.busy = false; }
  },

  // Strang-Reihenfolge per Pfeil-Button (a11y, analog moveAct).
  async moveThread(thread, dir) {
    const app = window.__app;
    if (this.busy || this._inHistoryFlight) return;
    const ordered = [...this.threads].sort((a, b) => a.position - b.position);
    const idx = ordered.findIndex(t => t.id === thread.id);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= ordered.length) return;
    const orderBefore = ordered.map(t => t.id); // Undo-Ziel
    const orderAfter = [...orderBefore];
    [orderAfter[idx], orderAfter[swap]] = [orderAfter[swap], orderAfter[idx]];
    // Unveränderlich (neue Objekte), damit der Snapshot beim PUT-Fehler zurückrollt.
    const snapshot = this.threads;
    const pos = new Map(orderAfter.map((id, i) => [id, i]));
    this.threads = ordered
      .map(t => ({ ...t, position: pos.get(t.id) }))
      .sort((a, b) => a.position - b.position);
    this._memos = {};
    this.busy = true;
    try {
      await fetchJson('/plot/threads/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: Alpine.store('nav').selectedBookId, order: orderAfter }),
      });
      this._recordThreadOrder(orderBefore, orderAfter);
      this.errorMessage = '';
    } catch (e) {
      this.threads = snapshot;
      this._memos = {};
      this.errorMessage = app.t('plot.error.save');
    } finally { this.busy = false; }
  },
};
