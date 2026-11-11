// Koordinaten-Änderungen der Geo-Karte (Orte-Karte, View-Mode 'map'): Verlauf
// (Rückgängig/Wiederholen), KI-Verortung, Georeferenz löschen. Gespreadet über
// orteMapMethods (orte-map.js) in Alpine.data('orteCard').
//
// Jede Koordinaten-Mutation läuft über `_setOrtCoords` — sie zählt `_geoRev`
// hoch, an dem die memoisierten Listen (orteMapped, unlocatedOrte, Erb-Positionen)
// hängen; die Orte selbst werden in place geändert, die Array-Referenz bleibt.
//
// Verlauf: ein Eintrag ist eine LISTE von Snapshots [{ id, lat, lng }] (lat/lng
// null = unverortet) — Einzel-Drag, Georeferenz löschen, «Alle löschen» und eine
// KI-Verortung sind je ein Schritt. Manuelle Änderungen persistiert der
// Koordinaten-Patch (app.patchOrtCoords) optimistisch; der Server nullt dabei die
// KI-Herkunft (geo_query/geo_land), der Browser spiegelt das.

import { fetchJson } from '../utils.js';
import { loadLeaflet } from '../lazy-libs.js';
import { startPoll } from '../cards/job-helpers.js';
import { isSelectedBook } from '../cards/book-guard.js';

const GEO_HISTORY_MAX = 10;
// = MAX_ITEMS in routes/jobs/geocode.js: mehr Orte nimmt ein Job nicht an.
export const GEOCODE_BATCH = 200;

function abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

export const orteMapEditMethods = {
  // Koordinaten eines Orts in place setzen. `manual` = Hand-Entscheidung (Patch):
  // die KI-Herkunft gilt nicht mehr, wie serverseitig in patchOrtCoords.
  _setOrtCoords(t, lat, lng, { manual = true } = {}) {
    t.lat = lat;
    t.lng = lng;
    if (manual) { t.geo_query = null; t.geo_land = null; }
    this._geoRev++;
  },

  _coordState(t) {
    return { lat: t.lat, lng: t.lng, geo_query: t.geo_query ?? null, geo_land: t.geo_land ?? null };
  },

  _restoreCoordState(t, s) {
    t.lat = s.lat;
    t.lng = s.lng;
    t.geo_query = s.geo_query;
    t.geo_land = s.geo_land;
    this._geoRev++;
  },

  async _rerenderMarkers(fit = false) {
    if (this.viewMode !== 'map' || !this._map) return;
    const L = await loadLeaflet();
    this._renderOrteMarkers(L, fit);
  },

  // Patches optimistisch anwenden: In-Memory setzen, speichern, bei Fehler den
  // vollständigen Vorzustand (inkl. KI-Herkunft) zurück. Liefert true/false.
  async _patchCoordsOptimistic(patches) {
    const app = window.__app;
    const byId = new Map(app.$store.catalog.orte.map(o => [o.id, o]));
    const live = patches.filter(p => byId.has(p.id));
    if (!live.length) return true;
    const before = live.map(p => [byId.get(p.id), this._coordState(byId.get(p.id))]);
    for (const p of live) this._setOrtCoords(byId.get(p.id), p.lat, p.lng);
    const ok = await app.patchOrtCoords(live.map(p => ({ id: p.id, lat: p.lat, lng: p.lng })));
    if (!ok) {
      for (const [t, s] of before) this._restoreCoordState(t, s);
      this.setOrteMapStatus(app.t('orte.map.saveFailed'));
    }
    return ok;
  },

  // --- Verlauf ---------------------------------------------------------------

  // Vorzustand vor einer Änderung sichern. Neuer Schritt verwirft den Redo-Stack.
  _pushGeoHistory(items) {
    if (!items?.length) return;
    this._geoUndoStack.push(items);
    if (this._geoUndoStack.length > GEO_HISTORY_MAX) this._geoUndoStack.shift();
    this._geoRedoStack = [];
  },

  // Eintrag anwenden; der aktuelle Stand der betroffenen Orte wandert auf den
  // Gegen-Stack. Gelöschte Orte fallen still heraus. false = Speichern scheiterte.
  async _applyGeoSnapshot(items, counterStack) {
    const orte = window.__app.$store.catalog.orte;
    const live = items.filter(s => orte.some(o => o.id === s.id));
    if (!live.length) return true;
    const cur = live.map(s => {
      const t = orte.find(o => o.id === s.id);
      return { id: s.id, lat: t.lat, lng: t.lng };
    });
    if (!await this._patchCoordsOptimistic(live)) return false;
    counterStack.push(cur);
    await this._rerenderMarkers(false);
    return true;
  },

  // Undo/Redo nie verschachtelt: der Knopf ist während des Speicherns gesperrt,
  // ein gescheiterter Schritt kehrt auf seinen Stack zurück.
  async _stepGeoHistory(from, to) {
    if (this.geoHistoryBusy) return;
    const snap = from.pop();
    if (!snap) return;
    this.geoHistoryBusy = true;
    try {
      if (!await this._applyGeoSnapshot(snap, to)) from.push(snap);
    } finally {
      this.geoHistoryBusy = false;
    }
  },

  undoGeoMove() { return this._stepGeoHistory(this._geoUndoStack, this._geoRedoStack); },
  redoGeoMove() { return this._stepGeoHistory(this._geoRedoStack, this._geoUndoStack); },

  _resetGeoHistory() {
    this._geoUndoStack = [];
    this._geoRedoStack = [];
  },

  // Marker abgelegt: Position speichern (ein Verlaufsschritt).
  async _onMarkerDropped(id, lat, lng) {
    const t = window.__app.$store.catalog.orte.find(x => x.id === id);
    if (!t) return;
    const prev = { id, lat: t.lat, lng: t.lng };
    if (await this._patchCoordsOptimistic([{ id, lat, lng }])) this._pushGeoHistory([prev]);
    await this._rerenderMarkers(false);
  },

  // --- KI-Verortung ----------------------------------------------------------

  // KI-first-Verortung für bis zu GEOCODE_BATCH Orte. Der Server normalisiert
  // jedes Label auf eine präzise reale Anfrage («Badi Olten» → «Olten») und
  // geocodet sie; Koordinaten und KI-Herkunft persistiert der Job selbst, hier
  // werden sie nur gespiegelt. Liefert das Set der ids mit Treffer. Wirft bei
  // Fehler (Netz, Job gescheitert) — «kein Treffer» und «Fehler» sind verschieden —
  // und mit AbortError, wenn Buch gewechselt oder Karte abgeräumt wurde.
  async _geocodeViaAI(items) {
    const app = window.__app;
    const hitIds = new Set();
    const bookId = Alpine.store('nav').selectedBookId;
    if (!items.length || !bookId) return hitIds;
    const resp = await fetchJson('/jobs/geocode-resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        book_id: bookId,
        items: items.map(o => ({ id: o.id, name: (o.name || '').trim() })),
      }),
    });
    if (!resp?.jobId) throw new Error('geocode-resolve: no jobId');
    if (!isSelectedBook(bookId)) throw abortError();

    const results = await new Promise((resolve, reject) => {
      // Teardown (Buchwechsel, Karte zu) räumt den Poll-Timer ab, ohne dass
      // startPoll einen Handler ruft — sonst hinge das Promise für immer.
      this._geocodeCancel = () => reject(abortError());
      startPoll(this, {
        timerProp: '_geocodeJobTimer',
        jobId: resp.jobId,
        onDone: (job) => resolve(Array.isArray(job?.result?.results) ? job.result.results : []),
        onError: () => reject(new Error('geocode-resolve: job failed')),
        onNotFound: () => reject(new Error('geocode-resolve: job not found')),
      });
    }).finally(() => { this._geocodeCancel = null; });
    if (!isSelectedBook(bookId)) throw abortError();

    for (const r of results) {
      if (!r || r.lat == null || r.lng == null) continue;
      const t = app.$store.catalog.orte.find(x => x.id === r.id);
      if (t) {
        this._setOrtCoords(t, r.lat, r.lng, { manual: false });
        t.geo_query = r.ort || null;
        t.geo_land = r.land || null;
      }
      hitIds.add(r.id);
    }
    return hitIds;
  },

  // Verortete Treffer als einen Verlaufsschritt sichern (Rückgängig = wieder
  // unverortet). Vorher waren alle angefragten Orte ohne Koordinaten.
  _pushGeocodeHistory(hitIds) {
    this._pushGeoHistory([...hitIds].map(id => ({ id, lat: null, lng: null })));
  },

  _reportGeocodeError(e) {
    if (e?.name === 'AbortError') { this.setOrteMapStatus(''); return; }
    console.error('[geocode]', e);
    this.setOrteMapStatus(window.__app.t('orte.map.geocodeFailed'));
  },

  // Einen Ort verorten. Bleibt er unverortet (rein fiktiv / kein Treffer), zeigt
  // der Render-Pfad einen roten Pin in der Kartenmitte (User korrigiert per Drag).
  async geocodeOrt(o) {
    if (this.geocodingId || this.geocodingAll) return;
    const app = window.__app;
    this.geocodingId = o.id;
    this.setOrteMapStatus(app.t('orte.map.aiResolving', { name: o.name }), true);
    try {
      const hits = await this._geocodeViaAI([o]);
      const hit = hits.has(o.id);
      this._pushGeocodeHistory(hits);
      this.setOrteMapStatus(app.t(hit ? 'orte.map.geocoded' : 'orte.map.unresolved', { name: o.name }));
      await this._rerenderMarkers(false);
      const t = app.$store.catalog.orte.find(x => x.id === o.id);
      if (hit && t && this._map) this._map.setView([t.lat, t.lng], Math.max(this._map.getZoom(), 6));
    } catch (e) {
      this._reportGeocodeError(e);
    } finally {
      this.geocodingId = null;
    }
  },

  // Alle gefilterten Orte ohne Koordinaten verorten, in Blöcken zu GEOCODE_BATCH
  // (ein Job je Block, nacheinander). Scheitert ein Block, bleiben die Treffer
  // der vorherigen erhalten (der Job hat sie schon gespeichert) und landen im Verlauf.
  async geocodeAllUnlocated() {
    if (this.geocodingId || this.geocodingAll) return;
    const app = window.__app;
    const todo = this.unlocatedOrte();
    if (!todo.length) return;
    this.geocodingAll = true;
    this.setOrteMapStatus(app.t('orte.map.batchAi', { n: todo.length }), true);
    const hits = new Set();
    let failure = null;
    try {
      for (let i = 0; i < todo.length; i += GEOCODE_BATCH) {
        if (i > 0) this.setOrteMapStatus(app.t('orte.map.batchAiProgress', { done: i, total: todo.length }), true);
        try {
          for (const id of await this._geocodeViaAI(todo.slice(i, i + GEOCODE_BATCH))) hits.add(id);
        } catch (e) { failure = e; break; }
      }
      if (failure?.name === 'AbortError') { this.setOrteMapStatus(''); return; }
      this._pushGeocodeHistory(hits);
      // fit=true zeigt bewusst den ganzen frisch verorteten Satz.
      await this._rerenderMarkers(true);
      if (failure) this._reportGeocodeError(failure);
      else this.setOrteMapStatus(app.t('orte.map.batchDone', { hits: hits.size, total: todo.length }));
    } finally {
      this.geocodingAll = false;
    }
  },

  // --- Georeferenz löschen ---------------------------------------------------

  // Falsch gesetzte Georeferenz löschen — Schauplatz bleibt, nur lat/lng raus.
  async clearGeoref(o) {
    const app = window.__app;
    const t = app.$store.catalog.orte.find(x => x.id === o.id);
    if (!t || (t.lat == null && t.lng == null)) return;
    const prev = { id: t.id, lat: t.lat, lng: t.lng };
    if (!await this._patchCoordsOptimistic([{ id: t.id, lat: null, lng: null }])) return;
    this._pushGeoHistory([prev]);
    this.setOrteMapStatus(app.t('orte.map.georefCleared', { name: o.name }));
    await this._rerenderMarkers(false);
  },

  // Alle Georeferenzen des Buchs entfernen (nicht nur der aktuelle Filter).
  // Destruktiv → Bestätigung; als ein Verlaufsschritt rückgängig machbar.
  async clearAllGeorefs() {
    if (this.geocodingId || this.geocodingAll) return;
    const app = window.__app;
    const located = app.$store.catalog.orte.filter(o => o.lat != null || o.lng != null);
    if (!located.length) return;
    const ok = await app.appConfirm({
      message: app.t('orte.map.clearAllConfirm', { n: located.length }),
      confirmLabel: app.t('orte.map.clearAll'),
      danger: true,
    });
    if (!ok) return;
    const prev = located.map(o => ({ id: o.id, lat: o.lat, lng: o.lng }));
    if (!await this._patchCoordsOptimistic(located.map(o => ({ id: o.id, lat: null, lng: null })))) return;
    this._pushGeoHistory(prev);
    this.setOrteMapStatus(app.t('orte.map.allGeorefsCleared', { n: located.length }));
    await this._rerenderMarkers(false);
  },
};
