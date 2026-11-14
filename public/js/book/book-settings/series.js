// Buchreihe (Tab «Reihe» der Bucheinstellungen, Partial book-settings-series.html):
// Reihe anlegen/beitreten/verlassen, umbenennen, Bände umordnen, und «Aus Vorband
// übernehmen» (Figuren, Schauplätze, Welt-Fakten als gepflegte Einträge kopieren).
// Server: routes/book-series.js, Doku docs/buchreihen.md.
//
// Jede Aktion speichert sofort (nicht über den Speichern-Knopf im Kartenkopf). Wie im
// Merge-Panel trägt der State das Buch, zu dem er gehört (`seriesBookId`); eine
// Antwort, die nach einem Buchwechsel eintrifft, wird verworfen.

import { fetchJson, sendJson } from './_shared.js';
import { tFetchError } from '../../i18n.js';
import { loadSortable } from '../../lazy-libs.js';
import { patchSortableOnce, revertSortable, markDragIgnore, unmarkDragIgnore, BASE_SORTABLE_OPTS } from '../../sortable-dnd.js';

const CARRY_KINDS = ['figuren', 'orte', 'fakten'];

export const seriesMethods = {
  get seriesCarryKinds() { return CARRY_KINDS; },

  _applySeriesState(bookId, data) {
    if (!this._isSelectedBook(bookId)) return;
    this.seriesData = data?.series || null;
    this.seriesJoinable = data?.joinable || [];
    this.seriesPrequels = data?.prequels || [];
    this.seriesNameDraft = this.seriesData?.name || '';
    this.seriesBookId = String(bookId);
    // Anzeige im Tab Publikation (GET /publication liefert sie ebenfalls aus der Reihe).
    this.bookPublication.series = this.seriesData?.name || '';
    this.bookPublication.series_index = this.seriesData ? String(this.seriesData.position) : '';
    if (!this.seriesPrequels.some(p => String(p.book_id) === String(this.carrySourceId))) {
      this.carrySourceId = this.seriesPrequels[0] ? String(this.seriesPrequels[0].book_id) : '';
      this.carryLists = null;
    }
  },

  async loadSeries() {
    const bookId = this._selectedBookId();
    if (!bookId) return;
    this.seriesLoading = true;
    this.seriesError = '';
    try {
      this._applySeriesState(bookId, await fetchJson(`/book-series/${bookId}`));
    } catch (e) {
      console.error('[loadSeries]', e);
      if (this._isSelectedBook(bookId)) this.seriesError = window.__app.t('series.loadError');
    } finally {
      if (this._isSelectedBook(bookId)) this.seriesLoading = false;
    }
  },

  // Erst laden, wenn der Tab offen ist (Muster onMergeSectionVisible: Guard + Fetch
  // nach dem Effect-Lauf, sonst hinge der x-effect an seinem eigenen State).
  onSeriesTabVisible(tab) {
    if (tab !== 'series') return;
    queueMicrotask(() => {
      const bookId = this._selectedBookId();
      if (!bookId || this.seriesBookId === String(bookId) || this.seriesLoading) return;
      this.loadSeries();
    });
  },

  async _seriesCall(method, path, body) {
    const bookId = this._selectedBookId();
    if (!bookId || this.seriesBusy) return null;
    this.seriesBusy = true;
    this.seriesError = '';
    this.seriesMessage = '';
    try {
      const data = await sendJson(`/book-series/${bookId}${path}`, method, body);
      return { bookId, data };
    } catch (e) {
      if (this._isSelectedBook(bookId)) this.seriesError = tFetchError(e);
      return null;
    } finally {
      if (this._isSelectedBook(bookId)) this.seriesBusy = false;
    }
  },

  async createSeries() {
    const name = this.seriesNewName.trim();
    if (!name) return;
    const r = await this._seriesCall('POST', '', { name });
    if (!r) return;
    this._applySeriesState(r.bookId, r.data);
    this.seriesNewName = '';
  },

  async joinSeries() {
    if (!this.seriesJoinId) return;
    const r = await this._seriesCall('POST', '/join', { series_id: Number(this.seriesJoinId) });
    if (!r) return;
    this._applySeriesState(r.bookId, r.data);
    this.seriesJoinId = '';
  },

  async leaveSeries() {
    if (!this.seriesData) return;
    if (!await window.__app.appConfirm({
      message: window.__app.t('series.leaveConfirm', { name: this.seriesData.name }),
      confirmLabel: window.__app.t('series.leave'),
    })) return;
    const r = await this._seriesCall('POST', '/leave');
    if (r) this._applySeriesState(r.bookId, r.data);
  },

  async renameSeries() {
    const name = this.seriesNameDraft.trim();
    if (!name || name === this.seriesData?.name) return;
    const r = await this._seriesCall('PATCH', '', { name });
    if (!r) return;
    this._applySeriesState(r.bookId, r.data);
    this.seriesMessage = window.__app.t('series.renamed');
  },

  // Pfeil-Knöpfe: Tastatur-Alternative zum Ziehen am Griff.
  async moveSeriesMember(index, delta) {
    const members = this.seriesData?.members || [];
    const j = index + delta;
    if (j < 0 || j >= members.length) return;
    const ids = members.map(m => m.book_id);
    [ids[index], ids[j]] = [ids[j], ids[index]];
    await this._saveSeriesOrder(ids);
  },

  // Bände ziehen (SortableJS am `.drag-grip`). x-init an der Liste; die Liste
  // hängt an `x-if="seriesData"` und wird bei jedem Wechsel neu gerendert —
  // darum die alte Instanz vorher abräumen.
  async initSeriesSortable(el) {
    this._destroySeriesSortable();
    let Sortable = null;
    try { Sortable = await loadSortable(); } catch { return; /* ohne Lib bleiben die Pfeile */ }
    if (!Sortable || !el?.isConnected) return;
    patchSortableOnce(Sortable);
    this._seriesSortable = new Sortable(el, {
      ...BASE_SORTABLE_OPTS,
      draggable: '.series-member',
      handle: '.series-member-grip',
      onChoose: markDragIgnore,
      onUnchoose: unmarkDragIgnore,
      onEnd: (evt) => { unmarkDragIgnore(evt); this.onSeriesSortEnd(evt); },
    });
  },

  _destroySeriesSortable() {
    if (this._seriesSortable) { try { this._seriesSortable.destroy(); } catch {} this._seriesSortable = null; }
  },

  async onSeriesSortEnd(evt) {
    if (evt.oldIndex === evt.newIndex) return;
    const ids = [...evt.to.querySelectorAll('.series-member')].map(li => Number(li.dataset.bookId));
    revertSortable(evt);
    await this._saveSeriesOrder(ids);
  },

  // Optimistisch (DESIGN.md „Board-Drag"): Reihenfolge und Bandnummern sofort,
  // bei Fehler zurück auf den Stand davor.
  async _saveSeriesOrder(ids) {
    const data = this.seriesData;
    const members = data?.members || [];
    if (!data || this.seriesBusy || ids.length !== members.length) return;
    const byId = new Map(members.map(m => [m.book_id, m]));
    const reordered = ids.map(id => byId.get(id)).filter(Boolean);
    if (reordered.length !== members.length) return;
    const prev = data;
    const currentId = members.find(m => m.position === data.position)?.book_id;
    const next = reordered.map((m, i) => ({ ...m, position: i + 1 }));
    this.seriesData = { ...data, members: next, position: next.find(m => m.book_id === currentId)?.position ?? data.position };
    const r = await this._seriesCall('PUT', '/order', { book_ids: ids });
    if (r) this._applySeriesState(r.bookId, r.data);
    else if (this.seriesData?.id === prev.id) this.seriesData = prev;
  },

  // ── Aus Vorband übernehmen ────────────────────────────────────────────────
  async loadCarryCandidates() {
    const bookId = this._selectedBookId();
    const sourceId = this.carrySourceId;
    if (!bookId || !sourceId) return;
    this.carryLoading = true;
    this.carryError = '';
    this.carryMessage = '';
    try {
      const data = await fetchJson(`/book-series/${bookId}/carryover/${sourceId}`);
      if (!this._isSelectedBook(bookId) || this.carrySourceId !== sourceId) return;
      this.carryLists = data;
      // Vorauswahl: alles Gepflegte, das im Band noch fehlt.
      this.carrySel = Object.fromEntries(CARRY_KINDS.map(k => [k,
        (data[k] || []).filter(e => e.gepflegt && !e.vorhanden).map(e => e.id)]));
    } catch (e) {
      console.error('[loadCarryCandidates]', e);
      if (this._isSelectedBook(bookId)) this.carryError = window.__app.t('series.carry.loadError');
    } finally {
      if (this._isSelectedBook(bookId)) this.carryLoading = false;
    }
  },

  carryLabel(kind, e) {
    if (kind === 'fakten') return e.subjekt ? `${e.subjekt}: ${e.fakt}` : e.fakt;
    return e.typ ? `${e.name} · ${e.typ}` : e.name;
  },

  carrySelectAll(kind, onlyCurated) {
    this.carrySel[kind] = (this.carryLists?.[kind] || [])
      .filter(e => !e.vorhanden && (!onlyCurated || e.gepflegt)).map(e => e.id);
  },

  carrySelectNone(kind) { this.carrySel[kind] = []; },

  carryCount() {
    return CARRY_KINDS.reduce((n, k) => n + (this.carrySel[k]?.length || 0), 0);
  },

  async runCarryover() {
    const bookId = this._selectedBookId();
    if (!bookId || !this.carrySourceId || !this.carryCount() || this.carryBusy) return;
    this.carryBusy = true;
    this.carryError = '';
    this.carryMessage = '';
    try {
      const data = await sendJson(`/book-series/${bookId}/carryover`, 'POST', { source_book_id: Number(this.carrySourceId), ...this.carrySel });
      if (!this._isSelectedBook(bookId)) return;
      this.carryMessage = window.__app.t('series.carry.done', {
        figuren: data.figuren, orte: data.orte, fakten: data.fakten,
      });
      // Kataloge der offenen Entitäten-Karten nachziehen (Muster merge.js).
      window.__app.loadFiguren?.(bookId);
      window.__app.loadOrte?.(bookId);
      await this.loadCarryCandidates();
    } catch (e) {
      if (this._isSelectedBook(bookId)) this.carryError = tFetchError(e);
    } finally {
      if (this._isSelectedBook(bookId)) this.carryBusy = false;
    }
  },
};
