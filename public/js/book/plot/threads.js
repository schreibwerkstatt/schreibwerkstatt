// Plot-Werkstatt: Strang-CRUD (Swimlanes) — Anlegen, Bearbeiten inkl.
// exklusiver Figuren-Bindung, Farb-Picker, Löschen, Reihenfolge.

import { fetchJson } from '../../utils.js';
import { ACT_PALETTE } from './constants.js';
import { EVT } from '../../events.js';
import { computePopoverPos, refinePopoverPos } from '../../popover-anchor.js';
import { attachDismiss, detachDismiss } from '../../cards/dismiss.js';

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

  // Lane-Aktions-Dropdown (Kebab). Einzelnes, nach .card--plot teleportiertes
  // .context-menu — die Lane sitzt in einem overflow-x/will-change-Scrollcontainer,
  // in dem ein am Trigger verankertes Popover geclippt bzw. eingesperrt würde.
  // JS-positioniert aus dem Trigger-Rect (Pattern wie das Ideen-Meatball-Menü).
  openThreadMenu(ev, laneId) {
    if (this.threadActionsOpenId === laneId) { this.closeThreadMenu(); return; }
    // Hover-Tooltip des Triggers wegblenden — er hinge sonst über dem Menü.
    window.dispatchEvent(new CustomEvent(EVT.TOOLTIP_HIDE));
    this._threadTriggerRect = ev.currentTarget.getBoundingClientRect();
    // Schätzung vor dem Render; danach mit der echten Popover-Grösse nachjustieren,
    // damit das Menü beim Hochklappen nicht mit einer festen Höhe über den Button
    // geschoben wird (Pattern wie das Ideen-Meatball-Menü).
    this.threadMenuPos = computePopoverPos(this._threadTriggerRect, 220, 240);
    this.threadActionsOpenId = laneId;
    this._attachThreadMenuListeners();
    this.$nextTick(() => {
      const pos = refinePopoverPos(this.$refs.threadMenu, this._threadTriggerRect);
      if (pos) this.threadMenuPos = pos;
    });
  },

  closeThreadMenu() {
    this.threadActionsOpenId = null;
    this._detachThreadMenuListeners();
  },

  // Die offene Lane (für das teleportierte Menü außerhalb der gridRows-Schleife).
  threadMenuLane() {
    if (this.threadActionsOpenId == null) return null;
    return (this.threadLanes() || []).find(l => l.id === this.threadActionsOpenId) || null;
  },

  _attachThreadMenuListeners() {
    this._threadMenuCloseHandler ??= attachDismiss(() => this.closeThreadMenu());
  },

  _detachThreadMenuListeners() {
    detachDismiss(this, '_threadMenuCloseHandler');
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
      if (this.threadActionsOpenId === thread.id) this.closeThreadMenu();
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
