# Geocoding & Orte-Karte (Geo-Map realer Schauplätze)

Reale Schauplätze auf einer Leaflet-Karte verorten. Pro Buch via `book_settings.orte_real` aktiviert (Default aus). **KI-first:** Jedes Schauplatz-Label wird zuerst per KI (`POST /jobs/geocode-resolve`, Job-Queue) auf eine präzise reale Anfrage normalisiert (z.B. „Badi Olten" → „Olten"), erst dann geocodet. **Why:** der externe Geocoder ist zu tolerant — auf das rohe Label („Badi Olten") liefert er oft einen falschen Treffer (irgendwo in DE) statt den realen Anker. Die Normalisierung liest bestehende Labels, generiert keinen Buchtext → rein rückwärtsgewandt, passt zur Produkt-Philosophie „KI rückwärtsgewandt". `GET /geocode` (reine Heuristik, kein KI) bleibt als Lookup-Endpoint + ist der Geocoding-Schritt, den der KI-Job nach der Normalisierung intern aufruft.

## Datenmodell

- `book_settings.orte_real` (INTEGER, Default 0) — schaltet den Karten-Tab pro Buch frei.
- `book_settings.schauplatz_land` (TEXT, nullable) — Länder-Hint (Region) fürs Geocoding, schränkt Nominatim/Photon-Treffer ein.
- `locations.lat` / `locations.lng` (REAL, nullable) — Koordinaten. Range-geclampt (lat ∈ [-90,90], lng ∈ [-180,180]) im Koordinaten-Patch (`PATCH /locations/:book_id/coords`) und in `saveOrteToDb`.
- `locations.land` (TEXT, nullable) — pro-Ort-Land (KI-extrahiert/User-kuratiert).
- `locations.geo_query` / `locations.geo_land` (TEXT, nullable) — Geocode-Resolve-Cache: das von der KI aufgelöste Toponym + der Ziel-Ländercode. `geo_query` Semantik: `NULL` = nie aufgelöst, `''` = aufgelöst aber kein realer Anker (rein fiktiv) → kein Geocoder-Call, sonst = Toponym für den Lookup. Bewusst getrennt von `land`.

Migrationen 162 (`orte_real` + `lat`/`lng`), 163 (`schauplatz_land` + `locations.land`) und 181 (`locations.geo_query` + `geo_land`).

## Geocode-Lib (`lib/geocode.js`)

Geteilter Kern für die `GET /geocode`-Route **und** den KI-Resolve-Job (Geocoding-Schritt nach der Normalisierung).

**Zwei Provider**, gewählt via App-Setting `geocode.provider`:
- `nominatim` (Default) — OSM-Nominatim `search`, jsonv2. Public-Instanz hat Rate-Limit (≤1 req/s, Pflicht-`User-Agent`); `_schedule` serialisiert Calls. Self-hosted via `geocode.nominatim.url`.
- `photon` — Komoot-Photon (self-hosted), GeoJSON. Kein Rate-Limit. Braucht zwingend `geocode.photon.url`; fehlt sie → Provider liefert leer + Warn-Log.

Antwort-Normalisierung: `parseNominatimResults` / `parsePhotonResults` → `[{ lat, lng, displayName, countrycode? }]`. Fehler/Timeout → `[]` (non-fatal, nie throw in Request-Pfad).

**Länderfilter pro Provider:** Nominatim filtert hart über den `countrycodes`-Anfrageparameter. Photon kennt keinen solchen Parameter — darum trägt `parsePhotonResults` den `countrycode` (ISO-2) aus den Feature-Properties mit, und `onlyCountry(results, cc)` (pure, unit-getestet) wendet den aufgelösten Ländercode als Post-Filter an, gleich streng wie Nominatim: ohne Treffer im Zielland bleibt die Liste leer. **Why:** ein Index ohne das Zielland (der self-hosted Photon auf Prod enthält nur Europa) lieferte sonst einen gleichnamigen Fehltreffer — «Boston» in England, «Japan» in Montenegro, «Afghanistan» als Restaurant in Paris. Ein falscher blauer Pin ist schlimmer als ein roter ohne Verortung.

**Gemeinde-Prüfung (`geocodeAnchored`):** der KI-Job fragt in der Form «Objekt, Gemeinde» an. `geocodeAnchored` behält nur Treffer, deren Gemeinde/Ortsteil (`area`: name, city, district, locality — **ohne** county, der Bezirk heisst oft wie sein Hauptort) das erste Wort der Gemeinde wortgenau enthält (`splitAnchor`, `inTown`, pure); gibt es keinen, wird die Gemeinde selbst geocodet. **Why:** Photon matcht unscharf — «Hammerstrasse, Olten» ergab eine Hambergstraße in Niedersachsen, «Hauptstrasse, Olten» die in Eppenberg. Ein Pin in der richtigen Gemeinde schlägt einen auf dem falschen Objekt.

**Regions-Bias (nur Photon):** `geocode(q, { bias: { lat, lng } })` setzt `lat`/`lon` mit `location_bias_scale=0` und `zoom=10` — nahe Treffer schlagen prominentere ferne, eindeutige Namen («Zürich», «Bern») bleiben unberührt. Der Job nimmt als Punkt den Median der schon verorteten Orte im Buch-Land (`_regionCenter`, ab 5 Orten) und setzt ihn nur für Orte in diesem Land. **Why:** «Engelberg» in einem Roman aus der Region Olten ist der Weiler bei Dulliken, nicht der Kurort in Obwalden.

**Heuristik-Zwei-Pass:** `geocode()` fragt erst das rohe Label ab; bleibt es leer, schneidet `parseToponym()` einen führenden Beschreibungsteil vor einem lokativen Bindewort ab («Bar in Olten» → «Olten», Bindewörter: in/im/bei/am/an/auf/vor/zu/zur/zum/near/at/on) und fragt den Toponym erneut ab. Pure → unit-getestet. Greift kein Bindewort (z.B. «Marktplatz von Bern»), bleibt die KI-Stufe.

**App-Settings** (`lib/app-settings.js`, ENV-Override in Klammern):
- `geocode.provider` (`GEOCODE_PROVIDER`) — `nominatim` | `photon`
- `geocode.nominatim.url` (`NOMINATIM_URL`)
- `geocode.photon.url` (`PHOTON_URL`)
- `geocode.tiles.url` (`OSM_TILES_URL`) — Tile-Server der Karte im `{z}/{x}/{y}.png`-Schema (Default Public-OSM). Self-hosted Tile-Server (openstreetmap-tile-server / tileserver-gl) hier eintragen — viele liefern unter `/tile/`, Beispiel: `http://tiles.lan:8080/tile/{z}/{x}/{y}.png`. `{s}`-Subdomain optional (Leaflet ignoriert den Platzhalter, wenn die URL ihn nicht enthält). Läuft die App über HTTPS, muss der Tile-Server ebenfalls per `https://` erreichbar sein (sonst Mixed-Content-Block im Browser).
- `geocode.tiles.attribution` (`OSM_TILES_ATTRIBUTION`) — Attribution unten rechts auf der Karte; leer = i18n-Default `orte.map.attribution`.
- `geocode.tiles.satellite.url` (`SATELLITE_TILES_URL`) — optionaler zweiter Hintergrund (Luftbild), in der Karte umschaltbar; leer = kein Umschalter. Nur `https://` (kein Tile-Proxy), Host landet automatisch im CSP-`img-src`. Beispiel Esri World Imagery: `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`.
- `geocode.tiles.satellite.attribution` (`SATELLITE_TILES_ATTRIBUTION`) — Attribution, solange das Luftbild gezeigt wird; leer = keine (der OSM-Default wäre dort falsch).

## Tiles (Karten-Kacheln)

Leaflet holt die Kacheln **direkt im Browser** (kein Server-Proxy), daher liefert `/config` die `mapTiles: { url, attribution, satellite: { url, attribution } | null }` ans Frontend (Quelle: `geocode.tiles.*`). [orte-map.js](../public/js/book/orte-map.js) liest `window.__app.mapTiles` mit Public-OSM als Fallback. **Why:** wer den Geocoder self-hostet, will auch die Public-OSM-Tile-Usage-Policy nicht weiter hämmern — konsistent zur Self-Host-OSS-Philosophie ist der Tile-Server konfigurierbar. Bei leerer Attribution greift der i18n-Default `orte.map.attribution`; ein eigener Server kann sie überschreiben.

**Admin-UI:** Der Geocode-Tab ist in zwei Sub-Sektionen geteilt — *Koordinaten-Ermittlung (Geocoding)* und *Karten-Kacheln (Tiles)* — mit je eigenem Health-Check-Button. **Probe `POST /admin/settings/test-tiles`** lädt die Welt-Kachel `z/x/y = 0/0/0` (existiert auf jedem OSM-kompatiblen Server; `{s}`/`{r}` werden auf konkrete Werte ersetzt) und meldet `ok` bei Status 200 + `image/*`-Content-Type (sonst `HTTP_<status>` / `NOT_IMAGE` / `TIMEOUT`).

## Route: `GET /geocode` (`routes/geocode.js`)

Auth-geschützt (globaler Guard). Params: `q` (Pflicht, ≤200 Zeichen, sonst 400), `lang` (`de`|`en`, Default `de`), `region` (2-Letter-CC). Antwort `{ candidates: [...] }`.

## KI-Normalisierungs-Job: `POST /jobs/geocode-resolve` (`routes/jobs/geocode.js`)

Einziger Verortungspfad der Orte-Karte (KI-first, keine Cron-Auto-Verortung mehr). Input: `{ book_id, items: [{ id, name }] }` (Batch, max 200). `runGeocodeResolveJob` schickt die **noch nicht aufgelösten** Labels in **einem** `aiCall` (Job → Token-/Statistik-Tracking; Prompt/Schema in [public/js/prompts/geocode.js](../public/js/prompts/geocode.js): `buildSystemGeocodeResolve` + `buildGeocodeResolvePrompt` + `SCHEMA_GEOCODE_RESOLVE`), bekommt pro Label `{ ort, land }` (präzise reale Anfrage — Strasse+Stadt wenn das Label sie hergibt, sonst Stadt; nicht-geografische Beschreibungen wie Bar/Badi/Café entfernt; ISO-2-Code; leer = rein fiktiv, kein Anker), geocodet jeden via `geocodeAnchored(ort, { region: land, bias })` und liefert `{ results: [{ id, lat, lng, ort, land }|null] }`.

**Koordinaten-Persistenz im Job (SSoT):** Die gefundenen `lat`/`lng` schreibt der Job **selbst** zurück (`_persistCoords`, gleiches `user_email`/`loc_id`-Scope wie `_persistResolved`), nicht der Client. **Why:** `lat`/`lng` nur zurückzugeben und auf einen nachfolgenden Client-Save zu vertrauen ist fragil — ein fehlender/fehlgeschlagener Save (ACL: Geocoden braucht `lektor`, der Koordinaten-Patch `editor`; Wegnavigieren bei langem Batch) liesse die Verortung verschwinden, obwohl der teure KI- + Geocoder-Lauf schon lief. Das Frontend spiegelt die Werte danach nur in-memory.

**Lookup-Schritt:** dedupliziert identische `(Toponym + effektive Region)` → jeder reale Ort wird nur **einmal** geocodet (viele Szenen teilen denselben Ort; auf Public-Nominatim je ≥1.1 s serialisiert). Vor jedem externen Call wird das Job-Abort-Signal (`jobAbortControllers`) geprüft → ein User-Cancel läuft nicht erst alle Labels durch (`AbortError` → Status `cancelled`).

**Geocode-Resolve-Cache (`locations.geo_query`/`geo_land`):** Vor dem `aiCall` lädt der Job die persistierten Auflösungen der angefragten Orte (`_loadResolved`); nur Labels ohne Cache-Eintrag gehen an die KI, frische Auflösungen werden zurückgeschrieben (`_persistResolved`). Sind alle Labels gecacht, entfällt der `aiCall` ganz (kein Token-Verbrauch). **Why:** ein erneuter „Alle verorten"-Lauf besteht v.a. aus rein fiktiven Orten (geo_query=`''`) und zuvor verfehlten Treffern — ohne Cache fragt jeder Klick die KI erneut. Der Cache ist **labelbasiert**, nicht prompt-gehasht. Invalidierung: bei Umbenennung durch den Autor ([db/locations-edit.js](../db/locations-edit.js)#`updateLocation`) **und** bei jedem Koordinaten-Patch ([db/locations-write.js](../db/locations-write.js)#`patchOrtCoords`: Ziehen, Rückgängig, „Georeferenz entfernen") werden `geo_query`/`geo_land` genullt. Ein Patch ist immer eine Hand-Entscheidung: die Position stammt danach nicht mehr aus dem KI-Treffer (das Popup darf ihn nicht mehr behaupten), und ein gelöschter Ort lässt beim erneuten Verorten die KI frisch laufen. Längengrade rechnet der Patch auf [-180, 180) um statt zu klemmen — Leaflet liefert auf den Welt-Kopien jenseits der Datumsgrenze Werte über 180; der Client wickelt sie schon vorher per `LatLng.wrap()`. Die Komplett-Reextraktion (`preserveExistingCoords`) behält den Cache: zugeordnete Orte behalten ihn auch bei einer Schreibvariante des Namens (der Abgleich hat «derselbe Ort» entschieden), neu angelegte Zeilen übernehmen ihn per normalisiertem Namen — sonst wischte der Nacht-Cron ihn ([schauplaetze.md](schauplaetze.md)). Reine Wortlaut-Änderungen am Resolve-Prompt invalidieren den Cache **nicht** — Auflösung ist labeldeterministisch und niedrig-stakes. Da kein prompt-gateter Cache → **nicht** in `_promptsContentHash`.

**Disambiguierungs-Kontext** (alles optional, in den Prompt gefaltet): Buch-Land (`schauplatz_land`) + Buch-Kontext-Freitext (`buch_kontext`, auf 400 Zeichen gekappt) als globaler Block; pro Ort die Wohnadressen der verknüpften Figuren (`location_figures` → `figures.wohnadresse`, max 3, via `_figureHints`) und die vom Autor gepflegte Elternkette (`locations.parent_id`, max 3 Ebenen, via `_parentChains` — «liegt in: Hotel Krone › Olten»). Der geografische Anker des Labels selbst hat im Prompt Vorrang — widerspricht das Label dem Hinweis, gewinnt das Label.

**Frontend** ([public/js/book/orte-map-edit.js](../public/js/book/orte-map-edit.js)): `geocodeOrt`/`geocodeAllUnlocated` rufen direkt `_geocodeViaAI` → `POST /jobs/geocode-resolve` + `startPoll` (kein Heuristik-Vorab-Call — der tolerante Geocoder würde sonst das rohe Label auf einen Fehltreffer ziehen). Treffer persistiert der Job selbst (s.o. `_persistCoords`); `_geocodeViaAI` spiegelt `lat`/`lng`/`geo_query`/`geo_land` nur in die In-Memory-Orte. Ein Job nimmt höchstens 200 Orte (`MAX_ITEMS`); «Alle suchen» schickt darum Blöcke zu `GEOCODE_BATCH` nacheinander. Ein gescheiterter Job (Netz, Job-Fehler) wirft und meldet `orte.map.geocodeFailed` — «kein Treffer» bleibt dem fiktiven Ort vorbehalten; Buchwechsel/Teardown brechen die Verortung still ab (`_geocodeCancel`). Bleibt ein Ort unverortet (rein fiktiv / kein Treffer), zeigt der Render-Pfad einen roten Pin in der Kartenmitte; ein unverorteter Unterort sitzt stattdessen mit gestricheltem Pin bei seinem nächsten verorteten Elternort. Der User schiebt zurecht — Drag, Undo/Redo und „Georeferenz entfernen" persistieren über den Koordinaten-Patch (`patchOrtCoords` → `PATCH /locations/:book_id/coords`).

**Verlauf (Rückgängig/Wiederholen, max. 10 Schritte):** ein Schritt ist eine Liste von Snapshots `{ id, lat, lng }` — Einzel-Drag, „Georeferenz entfernen", „Alle Georeferenzen löschen" und eine KI-Verortung (Einzel oder Batch) sind je ein Schritt. Während ein Schritt speichert, sind die Knöpfe gesperrt (`geoHistoryBusy`); scheitert das Speichern, kehrt der Schritt auf seinen Stapel zurück.

**Pins ohne Koordinaten:** rote Pins liegen als Raster unter der Kartenmitte; ihre Positionen sind je Ort gemerkt, damit sie nicht springen. Passt die Karte den Ausschnitt neu ein (Erstaufbau, Filter, Batch-Verortung), werden sie neu verteilt — die gemerkten Positionen gehörten zum alten Ausschnitt. Erbende Unterort-Pins sitzen beim Elternort, um feste Pixel per `iconAnchor` versetzt (zoomfest); beim Ablegen zählt die sichtbare Pin-Stelle. Ohne einen einzigen verorteten Ort startet die Karte auf dem Schauplatz-Land des Buchs (`countryView` in [country-codes.js](../public/js/country-codes.js)) statt in der Weltansicht.

**Match-Konfidenz im Popup:** das Marker-Popup zeigt für KI-verortete Orte eine „Verortet als: {Toponym} ({Land})"-Zeile (`.ort-popup__resolved`, Quelle `geo_query`/`geo_land`). **Why:** ein falscher Auto-Pin sieht sonst aus wie ein richtiger (beide blau) — die Zeile deckt Fehltreffer (falsches Land/Ort) auf. Direkt nach dem Job kommen die Werte aus dem Job-Result (`ort`/`land`) in den In-Memory-Ort, nach einem Reload aus `GET /locations` (DB-`geo_query`/`geo_land`) — identischer Text.

## Frontend

- **Orte-Karte** (`orte-card.js` + `public/js/book/orte-map.js` (Aufbau, Marker, Popup) + `orte-map-edit.js` (Koordinaten-Änderungen) + `orte-map-view.html`): dritter View-Mode `map`, Tab nur sichtbar bei `book_settings.orte_real`. Leaflet lazy via `loadLeaflet()` ([public/js/lazy-libs.js](../public/js/lazy-libs.js), vendored `public/vendor/leaflet-1.9.4/`). Map-Instanz als transienter Handle (`_map`/`_markers`), Teardown via `map.remove()` in `destroy` + auf `book:changed`/`view:reset`. Pro Ort „Geocodieren"-Button → KI-Resolve-Job (`POST /jobs/geocode-resolve`), Marker draggable, `dragend` schreibt über den Koordinaten-Patch zurück. Marker-Popup-HTML via `escHtml()`. Klick auf einen Ortsnamen der Liste unter der Karte zentriert dessen Pin und öffnet das Popup (Klick statt Hover: Überfahren der Liste schwenkte sonst die Karte); die Liste rendert schrittweise (`listWindowed`).
- **Manuelles Platzieren** ([orte-map-place.js](../public/js/book/orte-map-place.js), gespreadet über `orteMapMethods`):
  - *Klick-Platzieren:* «Platzieren» (Locate-Zeile oder Marker-Popup) schaltet den Platzier-Modus ein (Leiste über der Karte, Fadenkreuz); der nächste Karten-Klick legt den Ort dort ab — derselbe Speicherweg wie ein Drag (`_onMarkerDropped`: Patch + ein Verlaufsschritt). Esc oder «Abbrechen» beenden ihn. Gilt auch für gesperrte verortete Orte: die Sperre schützt vor versehentlichem Ziehen, Platzieren ist eine ausdrückliche Wahl.
  - *Zoom-Anker:* nach Drag oder Platzieren zoomen Mausrad und +/− um den gesetzten Pin statt um Mauszeiger/Kartenmitte (`_installZoomAnchor` in orte-map.js, über Leaflets Wheel-Handler und die Instanz-Methoden `zoomIn`/`zoomOut`) — der Pin bleibt an seiner Bildschirmstelle. Der Anker fällt beim Verschieben der Karte, einem Karten-Klick oder wenn der Pin aus dem Bild fällt.
  - *Rand-Mitnahme:* Marker tragen `autoPan` — ein an den Rand gezogener Pin schiebt die Karte mit.
  - *Ortssuche:* Feld links in der Aktionszeile, `GET /geocode` mit Buchsprache und `schauplatz_land` als Region (kein KI-Call). Der erste Treffer zentriert die Karte auf Zoom 16 (nicht klickbarer Ring am Treffer), weitere stehen als Knöpfe darunter. Die Suche setzt nie einen Ort — das bleibt Klick oder Drag.
  - *Tastatur:* Cmd/Ctrl+Z, Cmd/Ctrl+Umschalt+Z und Ctrl+Y im Kartenbereich (nicht im Suchfeld) bedienen den Koordinaten-Verlauf (`matchHistoryCommand` aus `editor/shared/shortcuts.js`); fällt der Fokus dabei von einem gesperrten Knopf, holt der Handler ihn auf die Karte zurück.
  - *Hintergrund:* Knopf Karte/Luftbild, nur sichtbar mit `geocode.tiles.satellite.url`; Wahl je Browser (`orte.mapLayer`).
- **BookSettings** (`book-settings-card.js`): Toggle `orte_real` + Feld `schauplatz_land`.
- UI-Pattern + CSS-Inventar: [DESIGN.md](../DESIGN.md) „Geo-Karte (Leaflet)". CSS [public/css/entities/orte-map.css](../public/css/entities/orte-map.css).

## Tests

- [tests/unit/geocode.test.mjs](../tests/unit/geocode.test.mjs) — Response-Parsing (beide Provider) + Range-Clamp + `parseToponym`-Heuristik + Länderfilter + Gemeinde-Prüfung.
- Migrationen via `squash-drift` + `erd-drift` gegated.
- [tests/e2e-app/orte-map.spec.js](../tests/e2e-app/orte-map.spec.js) — gebootete Karte: Startansicht, Pin-Raster, erbende Pins, Popup, Löschen rückgängig; Ortssuche, Platzieren per Klick + Esc, Zoom-Anker (mutationsgeprüft), Ctrl+Z/Umschalt+Ctrl+Z.
