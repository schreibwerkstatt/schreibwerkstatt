// Buchreihe (Tab «Reihe» der Bucheinstellungen, Partial book-settings-series.html):
// Reihe anlegen/beitreten/verlassen, umbenennen, Bände umordnen, und «Aus Vorband
// übernehmen» (Figuren, Schauplätze, Welt-Fakten als gepflegte Einträge kopieren).
// Server: routes/book-series.js, Doku docs/buchreihen.md.
//
// Jede Aktion speichert sofort (nicht über den Speichern-Knopf im Kartenkopf). Wie im
// Merge-Panel trägt der State das Buch, zu dem er gehört (`seriesBookId`); eine
// Antwort, die nach einem Buchwechsel eintrifft, wird verworfen.

import { fetchJson } from './_shared.js';

const CARRY_KINDS = ['figuren', 'orte', 'fakten'];

export const seriesMethods = {
  get seriesCarryKinds() { return CARRY_KINDS; },

  _seriesIsCurrent(bookId) {
    return String(Alpine.store('nav').selectedBookId) === String(bookId);
  },

  _applySeriesState(bookId, data) {
    if (!this._seriesIsCurrent(bookId)) return;
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
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    this.seriesLoading = true;
    this.seriesError = '';
    try {
      this._applySeriesState(bookId, await fetchJson(`/book-series/${bookId}`));
    } catch (e) {
      console.error('[loadSeries]', e);
      if (this._seriesIsCurrent(bookId)) this.seriesError = window.__app.t('series.loadError');
    } finally {
      if (this._seriesIsCurrent(bookId)) this.seriesLoading = false;
    }
  },

  // Erst laden, wenn der Tab offen ist (Muster onMergeSectionVisible: Guard + Fetch
  // nach dem Effect-Lauf, sonst hinge der x-effect an seinem eigenen State).
  onSeriesTabVisible(tab) {
    if (tab !== 'series') return;
    queueMicrotask(() => {
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId || this.seriesBookId === String(bookId) || this.seriesLoading) return;
      this.loadSeries();
    });
  },

  async _seriesCall(method, path, body) {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.seriesBusy) return null;
    this.seriesBusy = true;
    this.seriesError = '';
    this.seriesMessage = '';
    try {
      const r = await fetch(`/book-series/${bookId}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(window.__app.tError(data));
      return { bookId, data };
    } catch (e) {
      if (this._seriesIsCurrent(bookId)) this.seriesError = e.message || window.__app.t('series.saveError');
      return null;
    } finally {
      if (this._seriesIsCurrent(bookId)) this.seriesBusy = false;
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

  async moveSeriesMember(index, delta) {
    const members = this.seriesData?.members || [];
    const j = index + delta;
    if (j < 0 || j >= members.length) return;
    const ids = members.map(m => m.book_id);
    [ids[index], ids[j]] = [ids[j], ids[index]];
    const r = await this._seriesCall('PUT', '/order', { book_ids: ids });
    if (r) this._applySeriesState(r.bookId, r.data);
  },

  // ── Aus Vorband übernehmen ────────────────────────────────────────────────
  async loadCarryCandidates() {
    const bookId = Alpine.store('nav').selectedBookId;
    const sourceId = this.carrySourceId;
    if (!bookId || !sourceId) return;
    this.carryLoading = true;
    this.carryError = '';
    this.carryMessage = '';
    try {
      const data = await fetchJson(`/book-series/${bookId}/carryover/${sourceId}`);
      if (!this._seriesIsCurrent(bookId) || this.carrySourceId !== sourceId) return;
      this.carryLists = data;
      // Vorauswahl: alles Gepflegte, das im Band noch fehlt.
      this.carrySel = Object.fromEntries(CARRY_KINDS.map(k => [k,
        (data[k] || []).filter(e => e.gepflegt && !e.vorhanden).map(e => e.id)]));
    } catch (e) {
      console.error('[loadCarryCandidates]', e);
      if (this._seriesIsCurrent(bookId)) this.carryError = window.__app.t('series.carry.loadError');
    } finally {
      if (this._seriesIsCurrent(bookId)) this.carryLoading = false;
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
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !this.carrySourceId || !this.carryCount() || this.carryBusy) return;
    this.carryBusy = true;
    this.carryError = '';
    this.carryMessage = '';
    try {
      const r = await fetch(`/book-series/${bookId}/carryover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_book_id: Number(this.carrySourceId), ...this.carrySel }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(window.__app.tError(data));
      if (!this._seriesIsCurrent(bookId)) return;
      this.carryMessage = window.__app.t('series.carry.done', {
        figuren: data.figuren, orte: data.orte, fakten: data.fakten,
      });
      // Kataloge der offenen Entitäten-Karten nachziehen (Muster merge.js).
      window.__app.loadFiguren?.(bookId);
      window.__app.loadOrte?.(bookId);
      await this.loadCarryCandidates();
    } catch (e) {
      if (this._seriesIsCurrent(bookId)) this.carryError = e.message || window.__app.t('series.carry.saveError');
    } finally {
      if (this._seriesIsCurrent(bookId)) this.carryBusy = false;
    }
  },
};
