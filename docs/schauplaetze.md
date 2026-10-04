# Schauplätze

Katalog der Orte eines Buchs: von der Komplettanalyse erkannt, vom Autor korrigiert, ergänzt und hierarchisch geordnet. Karte `orteCard` ([public/js/cards/orte-card.js](../public/js/cards/orte-card.js), Partials `orte*.html`), Routen [routes/locations.js](../routes/locations.js), Tabelle `locations` ([erd.md](erd.md)). Geo-Karte und Verortung: [geocode.md](geocode.md). Analyse-Pipeline: [komplett.md](komplett.md) (P3).

## Zwei Schreibwege

| Weg | Code | Was er schreibt |
|---|---|---|
| Komplettanalyse | [db/locations-write.js](../db/locations-write.js)#`saveOrteToDb` (`matchBy:'name'`, `onMissing:'stale'`, `preserveExistingCoords`) | Name/Typ/Beschreibung/Stimmung/Land, Kapitel (`location_chapters`), Figuren (`location_figures`), erste Erwähnung, `ki_name` |
| Autor | [db/locations-edit.js](../db/locations-edit.js) über `POST /locations/:book_id`, `PATCH /locations/:book_id/:id`, `DELETE …/:id` | Stammdaten, `parent_id`, Flags |

Ein Full-Replace des Katalogs aus dem Client gibt es nicht. **Why:** der Reconcile hängt am ganzen Array (Match, stale-Markierung, Koordinaten-Heuristik); ein Client, der eine veraltete Liste zurückschreibt, verlöre nebenläufige Änderungen. Jeder Edit adressiert genau einen Ort über seine öffentliche `loc_id`; Koordinaten laufen über den eigenen Patch `PATCH …/coords`.

## Was die Analyse respektiert

- **`manually_edited = 1`** (jeder `PATCH` setzt es): Name, Typ, Beschreibung, Stimmung und Land bleiben beim Autor; die Analyse liefert nur noch Kapitel, Figuren und erste Erwähnung nach.
- **`ki_name`**: der zuletzt von der Analyse gelieferte Name. `planOrteMatch` matcht gegen `COALESCE(ki_name, name)` — ein vom Autor umbenannter Ort wird über seinen Textnamen weiter gefunden, statt als verwaist markiert und neu angelegt zu werden.
- **`manually_created = 1`** (`POST`): die Analyse hat den Ort nie gefunden, also markiert sie ihn auch nie «nicht mehr im Text». Er wird nur aus dem `ort_N`-Namespace geparkt (`loc_id = 'man_<id>'`). Findet ein späterer Lauf ihn doch, wird er zugeordnet statt dupliziert.
- **`parent_id`** fasst die Analyse nicht an — die Hierarchie pflegt allein der Autor.
- **Koordinaten** (`preserveExistingCoords`): stammen zuerst vom **zugeordneten** Bestands-Eintrag, erst dann vom Namens-Lookup. Der Abgleich verbindet auch Schreibvarianten; ein Lookup über den neuen Namen verlöre dort die Pins. Den Geocode-Resolve-Cache behält die Analyse ebenfalls — der Abgleich hat «derselbe Ort» entschieden. Eine Umbenennung durch den **Autor** nullt den Cache dagegen (neues Toponym), die Koordinaten bleiben.

## Häufigkeit je Kapitel

Die KI liefert pro Ort nur eine flache Kapitelliste, `location_chapters.haeufigkeit` startet darum bei 1. Nach dem Szenen-Schritt (auch wenn er abgewählt ist) zählt `backfillLocationChaptersFromScenes` die aktiven Szenen je Ort und Kapitel und hebt die Häufigkeit per `MAX` an — nie ab, ein Ort kann im Text stehen, ohne Schauplatz einer erkannten Szene zu sein. Konsumenten: Kapitel-Chip-Zähler, Präsenz-Streifen der Karte, Top-Liste und Präsenz-Matrix der Buchübersicht.

## Hierarchie

`locations.parent_id` (FK `locations(id)` `ON DELETE SET NULL`): Raum → Gebäude → Stadt. Zyklen verhindert der Server (`PARENT_CYCLE`, 409) und die Elternort-Auswahl blendet den Ort und seine Nachfahren aus. Wirkung:
- Liste: Unterorte eingerückt direkt unter ihrem Elternort, sofern der im Filter steht (`orte-card.js#_nestByParent`, Tiefe gedeckelt auf 3).
- Geo-Karte: ein unverorteter Unterort sitzt mit gestricheltem Pin beim nächsten verorteten Vorfahren (`orte-map.js#inheritedLatLng`); Ziehen setzt eigene Koordinaten.
- Verortung: der Geocode-Job gibt der KI die Elternkette mit («liegt in: Hotel Krone › Olten»), siehe [geocode.md](geocode.md).
- Merge: Unterorte der Quelle wandern ans Ziel ([db/entity-merge.js](../db/entity-merge.js)).

Die Analyse extrahiert die Hierarchie bewusst nicht: ein neues Feld im Orte-Schema invalidierte die Komplett-Caches aller Bücher.

## Löschen und Zusammenführen

- Löschen nur für verwaiste (`stale`) und selbst angelegte Orte (`NOT_DELETABLE`, 409 sonst) — ein aktiver Analyse-Ort käme mit dem nächsten Lauf zurück.
- Dubletten führt der Autor im Detail einer Zeile zusammen («Zusammenführen mit …», `POST …/merge`); dasselbe Panel steht in den Bucheinstellungen → Danger-Zone. Merge-Kern und seine Grenze (kein persistenter Alias): [komplett.md](komplett.md) „Manuelles Zusammenführen".

## Auswertung im Detail

Deterministisch aus dem geladenen Katalog ([public/js/book/orte-insights.js](../public/js/book/orte-insights.js), kein KI-Call): Präsenz-Streifen über die Kapitel (Intensität = Häufigkeit), Hinweis «nur am Anfang Schauplatz» mit denselben Schwellen wie die Schauplatz-Nutzung im Erzählprofil (`NARRATIVE_REPORT_THRESHOLDS`), Begegnungen = Figurenpaare, die sich hier in derselben aktiven Szene treffen.

## Typen

`locations.typ` ist Freitext; die bekannten Werte und ihre Labels stehen in [public/js/book/ort-typen.js](../public/js/book/ort-typen.js) (`orte.typ.<key>` in beiden Locales). Die Liste muss das Typ-Enum des Analyse-Schemas decken — gegated durch [tests/unit/ort-typen.test.mjs](../tests/unit/ort-typen.test.mjs). Unbekannte Werte erscheinen als Rohwert. Ein Typ-Key ist eine Persistenz-Konstante: ergänzen ja, umbenennen nein.

Tests: [tests/integration/locations-manual.test.js](../tests/integration/locations-manual.test.js), [tests/unit/orte-insights.test.mjs](../tests/unit/orte-insights.test.mjs), Merge in [tests/unit/entity-merge.test.js](../tests/unit/entity-merge.test.js).
