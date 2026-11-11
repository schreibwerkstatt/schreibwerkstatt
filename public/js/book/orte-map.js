// Geo-Karten-Methoden der Orte-Karte (View-Mode 'map'): Aufbau, Marker, Popup,
// Sperre. Nur aktiv, wenn das Buch auf "Orte real" (book_settings.orte_real)
// steht. Leaflet laedt lazy. Wird in Alpine.data('orteCard') gespreadet;
// Root-Zugriffe via window.__app.
//
// Marker-Koordinaten leben auf den Orten selbst (o.lat/o.lng). Alles, was sie
// aendert (Drag, Verlauf, KI-Verortung, Georeferenz loeschen), steht in
// orte-map-edit.js. _map/_markers/_tileLayer sind transiente Leaflet-Runtime-
// Handles (wie Timer), kein fachlicher State.

import { fetchJson, escHtml } from '../utils.js';
import { loadLeaflet } from '../lazy-libs.js';
import { countryLabel, countryView } from '../country-codes.js';
import { isSelectedBook } from '../cards/book-guard.js';
import { lsSet } from '../safe-storage.js';
import { orteMapEditMethods } from './orte-map-edit.js';
import { orteMapPlaceMethods } from './orte-map-place.js';

// Fallback-Tile-URL, falls /config noch nicht geladen ist ($store.config.mapTiles
// liefert die konfigurierte URL — self-hosted Tile-Server via app_settings
// geocode.tiles.url).
const OSM_TILES_DEFAULT = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

// Pixel-Versatz eines erbenden Unterort-Pins zu seinem Elternort (je weiteres
// Kind am selben Elternort eine Stufe weiter, vier pro Reihe).
export function inheritedPinOffset(slot) {
  return [14 + (slot % 4) * 10, 14 + Math.floor(slot / 4) * 10];
}

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

  // Gefilterte Orte mit gesetzten Koordinaten (Marker-Quelle). Memo auf die
  // orteFiltered-Referenz + `_geoRev` (Koordinaten ändern sich in place).
  orteMapped() {
    const list = this.orteFiltered;
    return this._memo('orteMapped', [list, this._geoRev], () => list.filter(o => o.lat != null && o.lng != null));
  },

  // Orte ohne Koordinaten (im aktuellen Filter) — Quelle für Batch-Geocode + Zähler.
  unlocatedOrte() {
    const list = this.orteFiltered;
    return this._memo('unlocatedOrte', [list, this._geoRev], () => list.filter(o => o.lat == null || o.lng == null));
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
  // Eine Map über alle Orte, memoisiert — das Template fragt je Zeile.
  inheritedLatLng(o) {
    const orte = window.__app.$store.catalog.orte;
    const map = this._memo('inheritedLatLng', [orte, this._geoRev], () => {
      const byId = window.__app.orteById;
      const out = new Map();
      for (const c of orte) {
        if (c.lat != null && c.lng != null) continue;
        const seen = new Set([c.id]);
        for (let p = c.parent ? byId.get(c.parent) : null; p && !seen.has(p.id); p = p.parent ? byId.get(p.parent) : null) {
          if (p.lat != null && p.lng != null) { out.set(c.id, { lat: p.lat, lng: p.lng }); break; }
          seen.add(p.id);
        }
      }
      return out;
    });
    return map.get(o.id) || null;
  },

  // Map lazy aufbauen + Marker rendern. Idempotent — mehrfaches Aufrufen
  // (Tab-Wechsel) erzeugt genau eine Instanz. Nach dem Laden von Leaflet erneut
  // prüfen, ob Buch und Karten-Tab noch dieselben sind (schneller Wechsel).
  async ensureOrteMap() {
    if (!this.orteRealEnabled) return;
    const bookId = Alpine.store('nav').selectedBookId;
    const L = await loadLeaflet();
    await this.$nextTick();
    if (!isSelectedBook(bookId) || !this.orteRealEnabled || this.viewMode !== 'map') return;
    const el = this.$refs.orteMapEl;
    if (!el) return;
    if (!this._map) {
      // zoomAnimation aus: der Karten-Tab lebt in einem x-show-Container, der
      // beim Tab-/Buchwechsel auf display:none geht. Eine laufende Zoom-Anim
      // feuert dann ihr zoomanim-rAF auf Marker, deren Map-Panes schon weg sind
      // (_animateZoom liest null) → Crash. Instant-Zoom umgeht den Pfad ganz.
      this._map = L.map(el, { scrollWheelZoom: true, zoomAnimation: false }).setView([20, 0], 2);
      this._markers = L.layerGroup().addTo(this._map);
      this._installZoomAnchor();
      this._installMapPlace();
    }
    this._syncTileLayer(L);
    // Grösse VOR dem Zeichnen neu messen: Einpassen und das Pin-Raster rechnen in
    // Pixeln, und der Container war bis eben versteckt (bzw. hat seit dem letzten
    // Besuch evtl. eine andere Breite).
    this._map.invalidateSize({ pan: false });
    this._renderOrteMarkers(L);
  },

  // Tile-Layer an die konfigurierte URL und den gewählten Hintergrund (mapLayer:
  // Karte/Luftbild, orte-map-place.js) angleichen. /config kann nach dem ersten
  // Kartenaufbau eintreffen — dann beim nächsten Öffnen tauschen.
  _syncTileLayer(L) {
    const tiles = this.$store.config.mapTiles || {};
    const sat = this.mapLayer === 'satellite' && tiles.satellite?.url ? tiles.satellite : null;
    const url = sat ? sat.url : (tiles.url || OSM_TILES_DEFAULT);
    if (this._tileLayer && this._tileUrl === url) return;
    this._tileLayer?.remove();
    this._tileLayer = L.tileLayer(url, {
      maxZoom: 19,
      // Luftbild: nur die eigene Attribution — der OSM-Default wäre dort falsch.
      attribution: sat ? (sat.attribution || '') : (tiles.attribution || window.__app.t('orte.map.attribution')),
    }).addTo(this._map);
    // Kacheln unter die Marker legen (ein später getauschter Layer käme sonst obenauf).
    this._tileLayer.bringToBack();
    this._tileUrl = url;
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

  // Ausschnitt einpassen: auf die verorteten Marker, sonst aufs Schauplatz-Land
  // des Buchs. Wechselt der Ausschnitt, werden die geparkten roten Pins neu in
  // der Mitte verteilt — ihre gemerkten Positionen gehörten zum alten Ausschnitt
  // und lägen jetzt ausserhalb des Bilds.
  _fitOrteView(pts) {
    if (pts.length) {
      this._map.fitBounds(pts, { padding: [30, 30], maxZoom: 13 });
    } else {
      const v = countryView(this._bookLand);
      if (!v) return;
      this._map.setView(v.center, v.zoom);
    }
    this._unlocatedLatLng = {};
  },

  // Zoom-Anker: nach dem Ziehen eines Markers zoomen Mausrad und +/− um genau
  // diesen Punkt statt um Mauszeiger bzw. Kartenmitte — der frisch gesetzte Pin
  // bleibt an seiner Bildschirmstelle stehen, der User kann ihn reinzoomen und
  // nachjustieren, ohne ihn zu suchen. Der Anker fällt weg, sobald der User die
  // Karte selbst verschiebt oder in die Karte klickt (dann gilt wieder das
  // normale Verhalten). Eingehängt über Leaflets Wheel-Handler (`_lastMousePos`
  // ist der Zoompunkt von `_performZoom`) und die Instanz-Methoden zoomIn/Out.
  _installZoomAnchor() {
    const map = this._map;
    this._zoomAnchor = null;
    const anchorPoint = () => {
      const a = this._zoomAnchor;
      if (!a) return null;
      // Anker ausserhalb des sichtbaren Ausschnitts → nicht mehr sinnvoll.
      if (!map.getBounds().contains(a)) { this._zoomAnchor = null; return null; }
      return a;
    };
    const wheel = map.scrollWheelZoom;
    if (wheel && typeof wheel._performZoom === 'function') {
      const perform = wheel._performZoom;
      wheel._performZoom = function () {
        const a = anchorPoint();
        if (a) this._lastMousePos = map.latLngToContainerPoint(a);
        return perform.call(this);
      };
    }
    const zoomBy = (orig, sign) => function (delta, options) {
      const a = anchorPoint();
      if (!a) return orig.call(map, delta, options);
      const d = delta || (window.L.Browser.any3d ? map.options.zoomDelta : 1);
      return map.setZoomAround(a, map.getZoom() + sign * d, options);
    };
    map.zoomIn = zoomBy(map.zoomIn, 1);
    map.zoomOut = zoomBy(map.zoomOut, -1);
    map.on('dragstart click', () => { this._zoomAnchor = null; });
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
      this._addOrtMarker(L, o, [o.lat, o.lng], 'located');
      pts.push([o.lat, o.lng]);
    }
    // Erst einpassen → die Pixel-Mitte liefert danach den Ankerpunkt für die
    // Orte ohne Georeferenz.
    if (fit) this._fitOrteView(pts);
    // Unverortete Unterorte mit verortetem Elternort sitzen bei diesem: eigener,
    // gestrichelter Pin, per iconAnchor um feste Pixel versetzt (zoomfest — ein
    // Versatz in Koordinaten liefe beim Herauszoomen vom Elternort weg).
    // Ganz unverortete Orte als Raster UNTER der Kartenmitte verteilen. Niemals
    // alle auf denselben Punkt stapeln: gestapelte draggable-Marker fangen den
    // mousedown ab und blockieren das Map-Panning (die Kartenmitte ist genau der
    // natürliche Greifpunkt zum Verschieben). Vergebene Pin-Positionen je Ort
    // cachen (_unlocatedLatLng), damit ein platzierter Pin nicht wegspringt, nur
    // weil ein anderer Ort verortet wurde — nur neue Orte bekommen einen Slot.
    const unlocated = [];
    const slotsAt = new Map();
    for (const o of this.unlocatedOrte()) {
      const ll = this.inheritedLatLng(o);
      if (!ll) { unlocated.push(o); continue; }
      const key = `${ll.lat},${ll.lng}`;
      const slot = slotsAt.get(key) || 0;
      slotsAt.set(key, slot + 1);
      this._addOrtMarker(L, o, [ll.lat, ll.lng], 'inherited', inheritedPinOffset(slot));
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
        this._addOrtMarker(L, o, [ll.lat, ll.lng], 'unlocated');
      }
    }
  },

  // Einen Marker bauen + verdrahten. kind: 'located' (Standard-Marker),
  // 'unlocated' (roter Pin in der Kartenmitte), 'inherited' (gestrichelter Pin
  // beim Elternort, um `offset` Pixel versetzt). Ablegen speichert echte
  // Koordinaten — beim versetzten Pin die Stelle, an der der Pin sichtbar liegt,
  // nicht sein Anker; Längengrade auf die Hauptwelt umgerechnet (Welt-Kopien
  // jenseits der Datumsgrenze liefern sonst lng > 180).
  _addOrtMarker(L, o, latlng, kind, offset = null) {
    // autoPan: zieht man einen Pin an den Kartenrand, schiebt die Karte mit.
    const opts = { draggable: true, autoPan: true };
    if (kind !== 'located') {
      const [dx, dy] = offset || [0, 0];
      opts.icon = L.divIcon({
        className: `ort-marker-pin ort-marker-pin--${kind}`,
        iconSize: [18, 18],
        iconAnchor: [9 - dx, 9 - dy],
        popupAnchor: [dx, dy - 9],
      });
    }
    const marker = L.marker(latlng, opts);
    marker.bindPopup(this._buildPopupHtml(o), { minWidth: 160, maxWidth: 240, maxHeight: 300 });
    // Popup-Inhalt lebt als HTML-String in Leaflet; die Referenz-Knöpfe darin
    // (`x-entity-ref`) beim Öffnen von Alpine initialisieren lassen.
    marker.on('popupopen', (e) => this._initPopupRefs(e.popup.getElement()));
    // Marker-Klick spiegelt die Selektion in die Locate-Liste (Cross-Highlight).
    marker.on('click', () => this._selectFromMap(o.id));
    marker.on('dragend', () => {
      let ll = marker.getLatLng();
      if (offset && this._map) {
        const p = this._map.latLngToContainerPoint(ll);
        ll = this._map.containerPointToLatLng([p.x + offset[0], p.y + offset[1]]);
      }
      // Zoom-Anker vor wrap(): die sichtbare Stelle in der aktuellen Welt-Kopie.
      this._zoomAnchor = L.latLng(ll.lat, ll.lng);
      ll = ll.wrap();
      this._onMarkerDropped(o.id, ll.lat, ll.lng);
    });
    marker.addTo(this._markers);
    this._markerById[o.id] = marker;
    // Verortete Marker respektieren die Lock-Sperre (Schutz gegen
    // versehentliches Ziehen). Unverortete Pins bleiben immer ziehbar — ihr
    // Zweck ist gerade, vom User platziert zu werden. Marker werden bewusst
    // immer mit draggable:true erzeugt, damit der Drag-Handler existiert und
    // sich später per disable()/enable() umschalten lässt.
    if (kind === 'located' && this.geoLocked) marker.dragging?.disable();
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
    // Klick-Platzieren (orte-map-place.js; Klick per Delegation in _installMapPlace).
    h += `<div class="ort-popup__actions"><button type="button" class="btn-compact" data-place-ort="${esc(o.id)}">${esc(app.t('orte.map.place'))}</button></div>`;
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

  // Klick auf einen Ortsnamen der Locate-Liste → Marker zentrieren + Popup
  // öffnen (Gegenrichtung). Auch rote und erbende Pins — die Liste zeigt, wo sie
  // liegen. Bewusst Klick statt Hover: Überfahren der Liste schwenkte sonst die
  // Karte bei jeder Zeile.
  focusMapMarker(id) {
    this.highlightOrtId = id;
    const marker = this._markerById?.[id];
    if (!marker || !this._map) return;
    this._map.panTo(marker.getLatLng(), { animate: true });
    marker.openPopup();
  },

  _teardownMap() {
    // Laufende KI-Verortung loslassen (ihr Poll-Timer räumt der Lifecycle ab).
    this._geocodeCancel?.();
    this._teardownMapPlace();
    this._resetGeoHistory();
    this._unlocatedLatLng = {};
    this._zoomAnchor = null;
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
      this._tileLayer = null;
      this._tileUrl = null;
    }
  },

  ...orteMapEditMethods,
  ...orteMapPlaceMethods,
};
