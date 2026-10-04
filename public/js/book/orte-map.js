// Geo-Karten-Methoden der Orte-Karte (View-Mode 'map'). Nur aktiv, wenn das
// Buch auf "Orte real" (book_settings.orte_real) steht. Leaflet laedt lazy.
// Wird in Alpine.data('orteCard') gespreadet; Root-Zugriffe via window.__app.
//
// Marker-Koordinaten leben auf den Orten selbst (o.lat/o.lng). Manuelle Aenderungen
// (Marker-Drag, Undo/Redo, Georeferenz entfernen) persistiert der Koordinaten-Patch
// (app.patchOrtCoords → PATCH /locations/:id/coords) optimistisch: erst In-Memory
// setzen, dann patchen, bei Fehler zuruecksetzen + Status. Die KI-Verortung
// (_geocodeViaAI) persistiert der Geocode-Job serverseitig selbst und spiegelt die
// Werte hier nur in-memory. _map/_markers sind transiente Leaflet-Runtime-Handles
// (wie Timer), kein fachlicher State.

import { fetchJson, escHtml } from '../utils.js';
import { loadLeaflet } from '../lazy-libs.js';
import { countryLabel } from '../country-codes.js';
import { startPoll } from '../cards/job-helpers.js';
import { isSelectedBook } from '../cards/book-guard.js';
import { lsSet } from '../safe-storage.js';

// Fallback-Tile-URL, falls /config noch nicht geladen ist ($store.config.mapTiles
// liefert die konfigurierte URL — self-hosted Tile-Server via app_settings
// geocode.tiles.url).
const OSM_TILES_DEFAULT = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

export const orteMapMethods = {
  // Liest orte_real + Sprache aus den Buch-Einstellungen. Schaltet bei
  // deaktiviertem Feature einen evtl. offenen Karten-Tab zurueck auf Liste.
  async loadOrteReal() {
    const id = Alpine.store('nav').selectedBookId;
    if (!id) { this.orteRealEnabled = false; return; }
    try {
      const s = await fetchJson('/booksettings/' + id);
      if (!isSelectedBook(id)) return;
      this.orteRealEnabled = !!s?.orte_real;
      this._geoLang = s?.language || 'de';
      this._bookLand = s?.schauplatz_land || null;
    } catch {
      if (!isSelectedBook(id)) return;
      this.orteRealEnabled = false;
    }
    if (!this.orteRealEnabled && this.viewMode === 'map') this.viewMode = 'list';
  },

  // Lokalisiertes Land-Label für einen ISO-2-Code (Badge in Liste/Grid).
  landLabel(code) {
    return countryLabel(code, this._geoLang || 'de');
  },

  // Gefilterte Orte mit gesetzten Koordinaten (Marker-Quelle).
  orteMapped() {
    return this.orteFiltered.filter(o => o.lat != null && o.lng != null);
  },

  // Karten-Status setzen. Abschluss-/Fehlermeldungen leeren sich nach kurzer Zeit
  // selbst (kein dauerhaftes Stehenbleiben); `persist=true` für Status, die bis
  // zum nächsten Schritt sichtbar bleiben sollen (laufende Operation).
  setOrteMapStatus(msg, persist = false) {
    this.orteMapStatus = msg;
    clearTimeout(this._orteMapStatusTimer);
    if (msg && !persist) {
      this._orteMapStatusTimer = setTimeout(() => { this.orteMapStatus = ''; }, 6000);
    }
  },

  // Grid-Zeilen: orteFiltered mit vorab aufgelösten Labels (Land, Typ, Elternort),
  // damit die sortierbare Tabelle nach dem sichtbaren Text sortiert (nicht nach
  // ISO-Code, Typ-Key oder loc_id). Memoized auf die orteFiltered-Referenz (stabil
  // dank Getter-Memo) + Sprache → keine neue Array-/Objekt-Allokation pro Render.
  orteGridRows() {
    const list = this.orteFiltered;
    const lang = this._geoLang || 'de';
    const uiLocale = Alpine.store('shell')?.uiLocale;
    const c = this._gridRowsCache;
    if (c && c.list === list && c.lang === lang && c.uiLocale === uiLocale) return c.val;
    const byId = window.__app.orteById;
    const val = list.map(o => ({
      ...o,
      landLabelText: o.land ? this.landLabel(o.land) : '',
      typLabelText: this.ortTypLabel(o.typ),
      parentName: o.parent ? (byId.get(o.parent)?.name || '') : '',
    }));
    this._gridRowsCache = { list, lang, uiLocale, val };
    return val;
  },

  // Position, die ein unverorteter Ort von seinem nächsten verorteten Elternort
  // erbt (Raum im Hotel → Pin beim Hotel). null, wenn keine Kette verortet ist.
  inheritedLatLng(o) {
    const byId = window.__app.orteById;
    const seen = new Set([o.id]);
    for (let p = o.parent ? byId.get(o.parent) : null; p && !seen.has(p.id); p = p.parent ? byId.get(p.parent) : null) {
      if (p.lat != null && p.lng != null) return { lat: p.lat, lng: p.lng };
      seen.add(p.id);
    }
    return null;
  },

  // Map lazy aufbauen + Marker rendern. Idempotent — mehrfaches Aufrufen
  // (Tab-Wechsel) erzeugt genau eine Instanz.
  async ensureOrteMap() {
    if (!this.orteRealEnabled) return;
    const L = await loadLeaflet();
    const el = this.$refs.orteMapEl;
    if (!el) return;
    if (!this._map) {
      // zoomAnimation aus: der Karten-Tab lebt in einem x-show-Container, der
      // beim Tab-/Buchwechsel auf display:none geht. Eine laufende Zoom-Anim
      // feuert dann ihr zoomanim-rAF auf Marker, deren Map-Panes schon weg sind
      // (_animateZoom liest null) → Crash. Instant-Zoom umgeht den Pfad ganz.
      this._map = L.map(el, { scrollWheelZoom: true, zoomAnimation: false }).setView([20, 0], 2);
      const tiles = this.$store.config.mapTiles || {};
      L.tileLayer(tiles.url || OSM_TILES_DEFAULT, {
        maxZoom: 19,
        attribution: tiles.attribution || window.__app.t('orte.map.attribution'),
      }).addTo(this._map);
      this._markers = L.layerGroup().addTo(this._map);
    }
    this._renderOrteMarkers(L);
    // Container wird erst mit dem Tab sichtbar → Groesse nach Layout neu messen.
    setTimeout(() => this._map?.invalidateSize(), 0);
  },

  // Marker nach einer Filteraenderung neu zeichnen (nur im Karten-Tab, Map muss
  // stehen). Leaflet ist dann garantiert geladen (this._map existiert ⇒ window.L
  // gesetzt), darum kein loadLeaflet-await noetig. Gekoppelt via $watch in
  // orte-card.js — ohne diesen Pfad bleiben die Marker nach Such-/Filter-Reset
  // stehen, waehrend die Locate-Liste (x-for orteFiltered) schon gefiltert ist.
  refreshOrteMarkersForFilter() {
    if (this.viewMode !== 'map' || !this._map) return;
    this._renderOrteMarkers(window.L);
  },

  // `fit` nur beim Erstaufbau / Filterwechsel / Batch-Geocode (zeigt bewusst den
  // ganzen Treffer-Satz). In-Place-Updates (Einzel-Drag, Einzel-Geocode, Georef
  // löschen, Undo/Redo) rendern mit fit=false → der vom User eingestellte Zoom/
  // Pan bleibt erhalten, statt bei jeder Mikro-Änderung zurückzuspringen.
  _renderOrteMarkers(L, fit = true) {
    if (!this._map || !this._markers) return;
    this._markers.clearLayers();
    this._markerById = {};
    const pts = [];
    for (const o of this.orteMapped()) {
      this._addOrtMarker(L, o, [o.lat, o.lng], false);
      pts.push([o.lat, o.lng]);
    }
    // Verortete Marker einpassen → die Pixel-Mitte liefert danach den
    // Ankerpunkt für die Orte ohne Georeferenz.
    if (fit && pts.length) this._map.fitBounds(pts, { padding: [30, 30], maxZoom: 13 });
    // Unverortete Orte als Raster UNTER der Kartenmitte verteilen (Pixel-Offsets,
    // zoom-unabhängig). Niemals alle auf denselben Punkt stapeln: gestapelte
    // draggable-Marker fangen den mousedown ab und blockieren das Map-Panning
    // (die Kartenmitte ist genau der natürliche Greifpunkt zum Verschieben).
    // Einmal vergebene Pin-Positionen je Ort cachen (_unlocatedLatLng), damit ein
    // bereits platzierter Pin beim nächsten Render nicht wegspringt, nur weil ein
    // anderer Ort verortet wurde — nur neue Orte bekommen einen frischen Slot.
    // Unverortete Unterorte mit verortetem Elternort sitzen bei diesem (eigener,
    // gestrichelter Pin, leicht versetzt, damit er den Eltern-Marker nicht verdeckt).
    // Ziehen setzt wie bei jedem Pin eigene Koordinaten.
    const unlocated = [];
    let inheritedSlot = 0;
    for (const o of this.unlocatedOrte()) {
      const ll = this.inheritedLatLng(o);
      if (!ll) { unlocated.push(o); continue; }
      const p = this._map.latLngToContainerPoint([ll.lat, ll.lng]);
      const q = this._map.containerPointToLatLng([p.x + 14 + (inheritedSlot % 4) * 10, p.y + 14 + Math.floor(inheritedSlot / 4) * 10]);
      inheritedSlot++;
      this._addOrtMarker(L, o, [q.lat, q.lng], true, true);
    }
    if (unlocated.length) {
      const size = this._map.getSize();
      const gap = 26;
      const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(unlocated.length))));
      let slot = 0;
      for (const o of unlocated) {
        let ll = this._unlocatedLatLng[o.id];
        if (!ll) {
          const col = slot % cols, row = Math.floor(slot / cols);
          const px = size.x / 2 + (col - (cols - 1) / 2) * gap;
          const py = size.y / 2 + 48 + row * gap;
          const p = this._map.containerPointToLatLng([px, py]);
          ll = { lat: p.lat, lng: p.lng };
          this._unlocatedLatLng[o.id] = ll;
          slot++;
        }
        this._addOrtMarker(L, o, [ll.lat, ll.lng], true);
      }
    }
  },

  // --- Undo/Redo der Pin-Positionen (max 10 Schritte) ----------------------
  // Eine Marker-Verschiebung legt die vorherige Position auf _geoUndoStack.
  // Stacks halten Snapshots { id, lat, lng } (lat/lng=null = unverortet).

  // Vorherige Position vor einer Verschiebung sichern. Neuer Zug verwirft den
  // Redo-Stack (klassische Undo/Redo-Semantik); Stack auf 10 Einträge gekappt.
  _pushGeoHistory(snap) {
    this._geoUndoStack.push(snap);
    if (this._geoUndoStack.length > 10) this._geoUndoStack.shift();
    this._geoRedoStack = [];
  },

  // Snapshot anwenden: gespeicherte Koordinaten zurückschreiben + patchen + neu
  // rendern. Schlägt der Patch fehl, Änderung verwerfen und den Gegen-Stack NICHT
  // befüllen, damit Undo/Redo konsistent zum Serverstand bleiben.
  async _applyGeoSnapshot(snap, counterStack) {
    const app = window.__app;
    const target = app.$store.catalog.orte.find(x => x.id === snap.id);
    if (!target) return; // Ort gelöscht → Eintrag verfällt still
    const cur = { id: snap.id, lat: target.lat, lng: target.lng };
    target.lat = snap.lat;
    target.lng = snap.lng;
    const ok = await app.patchOrtCoords([{ id: snap.id, lat: snap.lat, lng: snap.lng }]);
    if (!ok) {
      target.lat = cur.lat;
      target.lng = cur.lng;
      this.setOrteMapStatus(app.t('orte.map.saveFailed'));
      return;
    }
    counterStack.push(cur);
    if (this.viewMode === 'map') {
      const L = await loadLeaflet();
      this._renderOrteMarkers(L, false);
    }
  },

  async undoGeoMove() {
    const snap = this._geoUndoStack.pop();
    if (snap) await this._applyGeoSnapshot(snap, this._geoRedoStack);
  },

  async redoGeoMove() {
    const snap = this._geoRedoStack.pop();
    if (snap) await this._applyGeoSnapshot(snap, this._geoUndoStack);
  },

  // History leeren (Buchwechsel / View-Reset / Teardown).
  _resetGeoHistory() {
    this._geoUndoStack = [];
    this._geoRedoStack = [];
  },

  // Einen Marker bauen + verdrahten. `unlocated` → roter Pin in der Kartenmitte
  // (kein lat/lng am Ort); `inherited` → gestrichelter Pin beim Elternort.
  // Dragend setzt echte Koordinaten → wird blau.
  _addOrtMarker(L, o, latlng, unlocated, inherited = false) {
    const opts = { draggable: true };
    if (unlocated) {
      const cls = inherited ? 'ort-marker-pin ort-marker-pin--inherited' : 'ort-marker-pin ort-marker-pin--unlocated';
      opts.icon = L.divIcon({ className: cls, iconSize: [18, 18] });
    }
    const marker = L.marker(latlng, opts);
    marker.bindPopup(this._buildPopupHtml(o), { minWidth: 160, maxWidth: 240, maxHeight: 300 });
    // Popup-Inhalt lebt als HTML-String in Leaflet; die Referenz-Knöpfe darin
    // (`x-entity-ref`) beim Öffnen von Alpine initialisieren lassen.
    marker.on('popupopen', (e) => this._initPopupRefs(e.popup.getElement()));
    // Marker-Klick spiegelt die Selektion in die Locate-Liste (Cross-Highlight).
    marker.on('click', () => this._selectFromMap(o.id));
    marker.on('dragend', async () => {
      const ll = marker.getLatLng();
      const app = window.__app;
      const target = app.$store.catalog.orte.find(x => x.id === o.id);
      if (!target) return;
      const prev = { lat: target.lat, lng: target.lng };
      // Vorherige Position auf den Undo-Stack legen, BEVOR sie überschrieben
      // wird (bei „unlocated" Pins lat/lng=null → Undo macht ihn wieder rot).
      this._pushGeoHistory({ id: o.id, lat: prev.lat, lng: prev.lng });
      target.lat = ll.lat;
      target.lng = ll.lng;
      const ok = await app.patchOrtCoords([{ id: o.id, lat: ll.lat, lng: ll.lng }]);
      if (!ok) {
        // Patch fehlgeschlagen → Position + History-Eintrag zurücknehmen, Marker
        // an die alte Stelle zurücksetzen (Re-Render bewahrt den Viewport).
        this._geoUndoStack.pop();
        target.lat = prev.lat;
        target.lng = prev.lng;
        this.setOrteMapStatus(app.t('orte.map.saveFailed'));
        this._renderOrteMarkers(L, false);
        return;
      }
      // War der Pin „unlocated" (rot), wird er durch das Speichern verortet →
      // neu rendern, damit er als regulärer (blauer) Marker erscheint.
      if (unlocated) this._renderOrteMarkers(L, false);
    });
    marker.addTo(this._markers);
    this._markerById[o.id] = marker;
    // Verortete Marker respektieren die Lock-Sperre (Schutz gegen
    // versehentliches Ziehen). Unverortete Pins bleiben immer ziehbar — ihr
    // Zweck ist gerade, vom User platziert zu werden. Marker werden bewusst
    // immer mit draggable:true erzeugt, damit der Drag-Handler existiert und
    // sich später per disable()/enable() umschalten lässt.
    if (!unlocated && this.geoLocked) marker.dragging?.disable();
  },

  // Lock-Sperre umschalten: schützt verortete Marker vor versehentlichem
  // Ziehen. Persistiert die Wahl + schaltet die Drag-Handler bestehender
  // Marker live um (kein Re-Render → Popup/Position bleiben erhalten).
  toggleGeoLock() {
    this.geoLocked = !this.geoLocked;
    lsSet('orte.geoLocked', this.geoLocked ? '1' : '0');
    this._applyGeoLock();
  },

  _applyGeoLock() {
    if (!this._map) return;
    for (const o of this.orteMapped()) {
      const m = this._markerById?.[o.id];
      if (!m?.dragging) continue;
      if (this.geoLocked) m.dragging.disable(); else m.dragging.enable();
    }
  },

  // Reicher Marker-Popup: Stammdaten + Referenzen (Figuren/Kapitel/Seite) als
  // `x-entity-ref`-Knöpfe — Label, Typ-Präfix und Sprungziel liefert die
  // Komponente. Alle KI-/User-Felder via escHtml — Popup ist ein HTML-Sink; die
  // Spec steht als JSON-Literal (escaped) im Attribut, nie als User-Ausdruck.
  _buildPopupHtml(o) {
    const app = window.__app;
    const esc = (v) => escHtml(v == null ? '' : String(v));
    const ref = (spec) => `<button type="button" class="entity-ref" x-entity-ref="${esc(JSON.stringify(spec))}"></button>`;
    let h = `<div class="ort-popup"><strong class="ort-popup__name">${esc(o.name)}</strong>`;
    const sub = [o.typ ? this.ortTypLabel(o.typ) : '', o.stimmung].filter(Boolean).map(esc).join(' · ');
    if (sub) h += `<div class="ort-popup__sub">${sub}</div>`;
    // Match-Konfidenz: als was hat der Geocoder den Ort verortet (Toponym + Land)?
    // Nur bei KI-verorteten Orten gesetzt; deckt Fehltreffer auf (z.B. falsches Land).
    if (o.geo_query) {
      const landLbl = o.geo_land ? countryLabel(o.geo_land, this._geoLang || 'de') : '';
      const resolvedTxt = landLbl ? `${o.geo_query} (${landLbl})` : o.geo_query;
      h += `<div class="ort-popup__resolved">${esc(app.t('orte.map.resolvedAs', { ort: resolvedTxt }))}</div>`;
    }
    if (o.beschreibung) {
      const t = o.beschreibung.length > 160 ? o.beschreibung.slice(0, 160) + '…' : o.beschreibung;
      h += `<p class="ort-popup__desc">${esc(t)}</p>`;
    }
    const figIds = [...new Set((o.figuren || []).filter(Boolean))];
    if (figIds.length) {
      h += `<div class="entity-refs ort-popup__row">` + figIds.map((id) => ref({ type: 'figur', id })).join('') + `</div>`;
    }
    const kapSeen = new Set();
    const kapitel = (o.kapitel || []).filter((k) => {
      const key = k.chapter_id != null ? `id:${k.chapter_id}` : `name:${(k.name || '').trim()}`;
      if (key === 'name:' || kapSeen.has(key)) return false;
      kapSeen.add(key);
      return true;
    });
    if (kapitel.length) {
      h += `<div class="entity-refs ort-popup__row">`
        + kapitel.map((k) => ref({ type: 'kapitel', id: k.chapter_id ?? null, name: (k.name || '').trim() })).join('')
        + `</div>`;
    }
    if (o.erste_erwaehnung && o.erste_erwaehnung_page_id) {
      h += `<div class="entity-refs ort-popup__row">${ref({ type: 'seite', id: Number(o.erste_erwaehnung_page_id), name: o.erste_erwaehnung })}</div>`;
    }
    return h + `</div>`;
  },

  // Referenz-Knöpfe im geöffneten Popup initialisieren. `initTree` überspringt
  // bereits initialisierte Knoten (Alpine-Marker) — ein zweites Öffnen bzw. der
  // MutationObserver bindet also nichts doppelt.
  _initPopupRefs(root) {
    if (root) window.Alpine?.initTree(root);
  },

  // Marker-Klick → Locate-Row markieren (kein Scroll).
  _selectFromMap(id) {
    this.highlightOrtId = id;
  },

  // Locate-Row-Hover → Marker zentrieren + Popup öffnen (Gegenrichtung).
  focusMapMarker(id) {
    this.highlightOrtId = id;
    const marker = this._markerById?.[id];
    if (!marker || !this._map) return;
    this._map.panTo(marker.getLatLng(), { animate: true });
    marker.openPopup();
  },

  // Orte ohne Koordinaten (im aktuellen Filter) — Quelle für Batch-Geocode + Zähler.
  unlocatedOrte() {
    return this.orteFiltered.filter(o => o.lat == null || o.lng == null);
  },

  // KI-first-Verortung für eine Liste von Orten. Der Server normalisiert jedes
  // Label zuerst auf eine präzise reale Anfrage („Badi Olten" → „Olten") und
  // geocodet sie dann — verhindert, dass der tolerante Geocoder das rohe Label
  // auf einen falschen Treffer (z.B. in DE) zieht. Resolved → Set der ids mit
  // Treffer. Koordinaten (und geo_query/geo_land) persistiert der Job selbst;
  // hier werden sie nur in-memory gespiegelt. Misses bleiben unverortet (roter
  // Pin, User schiebt zurecht).
  async _geocodeViaAI(items) {
    const app = window.__app;
    const hitIds = new Set();
    if (!items.length || !Alpine.store('nav').selectedBookId) return hitIds;
    let resp;
    try {
      resp = await fetchJson('/jobs/geocode-resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: Alpine.store('nav').selectedBookId,
          items: items.map(o => ({ id: o.id, name: (o.name || '').trim() })),
        }),
      });
    } catch (e) { console.error('[geocodeViaAI]', e); return hitIds; }
    if (!resp?.jobId) return hitIds;

    const results = await new Promise((resolve) => {
      startPoll(this, {
        timerProp: '_geocodeJobTimer',
        jobId: resp.jobId,
        onDone: (job) => resolve(Array.isArray(job?.result?.results) ? job.result.results : []),
        onError: () => resolve([]),
        onNotFound: () => resolve([]),
      });
    });

    // Der Job hat lat/lng + geo_query/geo_land bereits serverseitig persistiert.
    // Hier nur die In-Memory-Orte spiegeln (Marker/Popup ohne Reload korrekt).
    for (const r of results) {
      if (!r || r.lat == null || r.lng == null) continue;
      const t = app.$store.catalog.orte.find(x => x.id === r.id);
      if (t) {
        t.lat = r.lat;
        t.lng = r.lng;
        t.geo_query = r.ort || null;
        t.geo_land = r.land || null;
      }
      hitIds.add(r.id);
    }
    return hitIds;
  },

  // Einen Ort verorten (KI-first): das Label wird serverseitig auf eine präzise
  // reale Anfrage normalisiert und dann geocodet. Bleibt der Ort danach
  // unverortet (rein fiktiv / kein Treffer), zeigt der Render-Pfad einen roten
  // Pin in der Kartenmitte (User korrigiert per Drag).
  async geocodeOrt(o) {
    if (this.geocodingId || this.geocodingAll) return;
    const app = window.__app;
    this.geocodingId = o.id;
    this.setOrteMapStatus(app.t('orte.map.aiResolving', { name: o.name }), true);
    try {
      const hit = (await this._geocodeViaAI([o])).has(o.id);
      this.setOrteMapStatus(app.t(hit ? 'orte.map.geocoded' : 'orte.map.unresolved', { name: o.name }));
      if (this.viewMode === 'map') {
        const L = await loadLeaflet();
        this._renderOrteMarkers(L, false);
        // Treffer → auf die neue Position zoomen. Kein Treffer → der rote
        // Mitte-Pin liegt bereits sichtbar in der Kartenmitte, kein setView.
        const target = app.$store.catalog.orte.find(x => x.id === o.id);
        if (hit && target) this._map?.setView([target.lat, target.lng], Math.max(this._map.getZoom(), 6));
      }
    } catch (e) {
      console.error('[geocodeOrt]', e);
    } finally {
      this.geocodingId = null;
    }
  },

  // Batch (KI-first): alle gefilterten Orte ohne Koordinaten gehen in EINEN
  // KI-Job, der jedes Label normalisiert + geocodet. Rest bleibt unverortet.
  async geocodeAllUnlocated() {
    if (this.geocodingId || this.geocodingAll) return;
    const app = window.__app;
    const todo = this.unlocatedOrte();
    if (!todo.length) return;
    this.geocodingAll = true;
    this.setOrteMapStatus(app.t('orte.map.batchAi', { n: todo.length }), true);
    try {
      const hits = (await this._geocodeViaAI(todo)).size;
      if (this.viewMode === 'map') {
        const L = await loadLeaflet();
        // Batch: fit=true zeigt bewusst den ganzen frisch verorteten Satz.
        this._renderOrteMarkers(L, true);
      }
      this.setOrteMapStatus(app.t('orte.map.batchDone', { hits, total: todo.length }));
    } finally {
      this.geocodingAll = false;
    }
  },

  // Falsch gesetzte Georeferenz löschen — Schauplatz bleibt, nur lat/lng raus.
  // Marker verschwindet, Ort wird wieder geocodierbar.
  async clearGeoref(o) {
    const app = window.__app;
    const target = app.$store.catalog.orte.find(x => x.id === o.id);
    if (!target || (target.lat == null && target.lng == null)) return;
    const prev = { lat: target.lat, lng: target.lng };
    target.lat = null;
    target.lng = null;
    const ok = await app.patchOrtCoords([{ id: o.id, lat: null, lng: null }]);
    if (!ok) {
      target.lat = prev.lat;
      target.lng = prev.lng;
      this.setOrteMapStatus(app.t('orte.map.saveFailed'));
      return;
    }
    this.setOrteMapStatus(app.t('orte.map.georefCleared', { name: o.name }));
    if (this.viewMode === 'map') {
      const L = await loadLeaflet();
      this._renderOrteMarkers(L, false);
    }
  },

  // Alle Georeferenzen des Buchs auf einmal entfernen (lat/lng raus, Schauplätze
  // bleiben). Operiert auf allen Orten, nicht nur dem aktuellen Filter. Marker
  // verschwinden, alles wird wieder geocodierbar. Destruktiv → Bestätigung.
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
    for (const o of located) { o.lat = null; o.lng = null; }
    const saved = await app.patchOrtCoords(located.map(o => ({ id: o.id, lat: null, lng: null })));
    if (!saved) {
      for (const p of prev) {
        const t = app.$store.catalog.orte.find(x => x.id === p.id);
        if (t) { t.lat = p.lat; t.lng = p.lng; }
      }
      this.setOrteMapStatus(app.t('orte.map.saveFailed'));
      return;
    }
    this.setOrteMapStatus(app.t('orte.map.allGeorefsCleared', { n: located.length }));
    if (this.viewMode === 'map') {
      const L = await loadLeaflet();
      this._renderOrteMarkers(L, false);
    }
  },

  _teardownMap() {
    this._resetGeoHistory();
    this._unlocatedLatLng = {};
    this._gridRowsCache = null;
    clearTimeout(this._orteMapStatusTimer);
    if (this._map) {
      // Laufende Pan/Zoom-Anim hart stoppen + Marker abräumen, bevor remove()
      // die Panes nullt — sonst feuert ein queued Anim-Callback ins Leere.
      this._map.stop();
      this._markers?.clearLayers();
      this._map.remove();
      this._map = null;
      this._markers = null;
      this._markerById = {};
    }
  },
};
