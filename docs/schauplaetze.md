# Schauplätze

Katalog der Orte eines Buchs: von der Komplettanalyse erkannt, vom Autor korrigiert, ergänzt und hierarchisch geordnet. Karte `orteCard` ([public/js/cards/orte-card.js](../public/js/cards/orte-card.js), Partials `orte*.html`), Routen [routes/locations.js](../routes/locations.js), Tabelle `locations` ([erd.md](erd.md)). Geo-Karte und Verortung: [geocode.md](geocode.md). Analyse-Pipeline: [komplett.md](komplett.md) (P3).

## Was als Schauplatz gilt

Die Extraktion (`ORTE_RULES` in [schema-strings.js](../public/js/prompts/komplett/schema-strings.js)) erfasst grosszügig jeden Ort, an dem sich eine Figur aufhält, etwas geschieht oder den der Text beschreibt — auch einmalige Nebenschauplätze, Fahrzeuge und virtuelle Räume (Chat, Forum). Bloss genannte Orte nimmt sie nicht auf: Herkunft einer Figur, Reiseziel im Nebensatz, Nachrichten- und Weltgeschehen, Vergleiche. **Why:** sonst bestand ein Roman-Katalog zur Hälfte aus Orten ohne Szene und mit einer einzigen Kapitelnennung (Länder aus den Nachrichten, Ferienziele), und die echten Schauplätze gingen darin unter. Ein früher so erfasster Ort wird beim nächsten Lauf nicht mehr gefunden und fällt auf «nicht mehr im Text» (`stale`), gelöscht wird er nicht.

## Zwei Schreibwege

| Weg | Code | Was er schreibt |
|---|---|---|
| Komplettanalyse | [db/locations-write.js](../db/locations-write.js)#`saveOrteToDb` (`matchBy:'name'`, `onMissing:'stale'`, `preserveExistingCoords`) | Name/Typ/Beschreibung/Stimmung/Land, Kapitel (`location_chapters`), Figuren (`location_figures`), erste Erwähnung, `ki_name` |
| Autor | [db/locations-edit.js](../db/locations-edit.js) über `POST /locations/:book_id`, `PATCH /locations/:book_id/:id`, `POST …/:id/restore-analysis`, `DELETE …/:id` | Stammdaten, `parent_id`, Feld-Schutz |

Ein Full-Replace des Katalogs aus dem Client gibt es nicht. **Why:** der Reconcile hängt am ganzen Array (Match, stale-Markierung, Koordinaten-Heuristik); ein Client, der eine veraltete Liste zurückschreibt, verlöre nebenläufige Änderungen. Jeder Edit adressiert genau einen Ort über seine öffentliche `loc_id`; Koordinaten laufen über den eigenen Patch `PATCH …/coords`.

## Was die Analyse respektiert

- **Feld-Schutz `manual_fields`** (JSON-Array, [db/location-fields.js](../db/location-fields.js)): genau die Stammdatenfelder (Name, Typ, Beschreibung, Stimmung, Land), die der Autor **tatsächlich geändert** hat, bleiben bei ihm; alle anderen folgen weiter der Analyse. Der Client schickt nur geänderte Felder, und der Server vergleicht zusätzlich mit dem Bestand — ein unverändert mitgeschickter Wert oder ein `PATCH`, der nur den Elternort setzt, schützt nichts. `manually_edited` ist «mindestens ein Feld geschützt». Anlegen schützt alle fünf.
- **Letzte Analysewerte `ki_name`/`ki_typ`/`ki_beschreibung`/`ki_stimmung`/`ki_land`**: jeder Analyse-Lauf schreibt sie, auch für geschützte Felder. Wird ein Feld zum ersten Mal geschützt und fehlt sein Analysewert noch (Altbestand), sichert der aktuelle Wert ihn. «Analyse-Werte übernehmen» im Detail (`POST …/:id/restore-analysis`, Body `{ fields? }`) hebt den Schutz auf und schreibt die bekannten Analysewerte sofort zurück; ohne bekannten Wert bleibt der Text stehen, bis der nächste Lauf liefert. Für einen nie gefundenen, selbst angelegten Ort gibt es nichts zu übernehmen (`NO_ANALYSIS`, 409).
- **`ki_name`** ist zugleich Match-Schlüssel: `planOrteMatch` matcht gegen `COALESCE(ki_name, name)` — ein vom Autor umbenannter Ort wird über seinen Textnamen weiter gefunden, statt als verwaist markiert und neu angelegt zu werden.
- **`manually_created = 1`** (`POST`): die Analyse hat den Ort nie gefunden, also markiert sie ihn auch nie «nicht mehr im Text». Er wird nur aus dem `ort_N`-Namespace geparkt (`loc_id = 'man_<id>'`) und reiht sich hinter die Analyse-Orte (`sort_order` ab n). Findet ein späterer Lauf ihn doch, wird er zugeordnet statt dupliziert und ist ab da ein Analyse-Ort (`manually_created = 0`: kann verwaisen, nur dann löschbar); seine Stammdaten bleiben über den Feld-Schutz beim Autor.
- **Aliasse `location_aliases`** ([db/location-aliases.js](../db/location-aliases.js)): beim Zusammenführen werden Name, `ki_name` und Aliasse der Quelle Aliasse des Ziels. `planOrteMatch` gibt sie als bestätigte Paare in den Abgleich (ein echter Name eines anderen Bestandsorts schlägt den Alias, Katalog-Anker und Judge schlagen beide); liefert ein Lauf Name und Alias zugleich, faltet `foldIncomingAliases` beide vorher zu einem Eintrag.
- **`parent_id`** fasst die Analyse nicht an — die Hierarchie pflegt allein der Autor.
- **Koordinaten** (`preserveExistingCoords`): stammen zuerst vom **zugeordneten** Bestands-Eintrag, erst dann vom Namens-Lookup. Der Abgleich verbindet auch Schreibvarianten; ein Lookup über den neuen Namen verlöre dort die Pins. Den Geocode-Resolve-Cache behält die Analyse ebenfalls — der Abgleich hat «derselbe Ort» entschieden. Eine Umbenennung durch den **Autor** nullt den Cache dagegen (neues Toponym), die Koordinaten bleiben.

## Häufigkeit je Kapitel

Die KI liefert pro Ort nur eine flache Kapitelliste, `location_chapters.haeufigkeit` startet darum bei 1. Nach dem Szenen-Schritt (auch wenn er abgewählt ist) zählt `backfillLocationChaptersFromScenes` die aktiven Szenen je Ort und Kapitel und hebt die Häufigkeit per `MAX` an — nie ab, ein Ort kann im Text stehen, ohne Schauplatz einer erkannten Szene zu sein. Konsumenten: Kapitel-Chip-Zähler, Präsenz-Streifen der Karte, Top-Liste und Präsenz-Matrix der Buchübersicht.

## Hierarchie

`locations.parent_id` (FK `locations(id)` `ON DELETE SET NULL`): Raum → Gebäude → Stadt. Zyklen verhindert der Server (`PARENT_CYCLE`, 409) und die Elternort-Auswahl blendet den Ort und seine Nachfahren aus. Wirkung:
- Liste: Unterorte eingerückt direkt unter ihrem Elternort, sofern der im Filter steht (`orte-card.js#_nestByParent`, Tiefe gedeckelt auf 3). Die Suche trifft auch über die Elternkette («Olten» findet die Zimmer im Hotel in Olten).
- Plot-Werkstatt (Zeit-Messung): `locationParentMap(bookId, userEmail)` — pro Analyse, weil die `loc_id` nur je Analyse eindeutig ist.
- Geo-Karte: ein unverorteter Unterort sitzt mit gestricheltem Pin beim nächsten verorteten Vorfahren (`orte-map.js#inheritedLatLng`); Ziehen setzt eigene Koordinaten.
- Verortung: der Geocode-Job gibt der KI die Elternkette mit («liegt in: Hotel Krone › Olten»), siehe [geocode.md](geocode.md).
- Merge: Unterorte der Quelle wandern ans Ziel ([db/entity-merge.js](../db/entity-merge.js)).

Die Analyse extrahiert die Hierarchie bewusst nicht: ein neues Feld im Orte-Schema invalidierte die Komplett-Caches aller Bücher.

## Löschen und Zusammenführen

- Löschen nur für verwaiste (`stale`) und selbst angelegte Orte (`NOT_DELETABLE`, 409 sonst) — ein aktiver Analyse-Ort käme mit dem nächsten Lauf zurück.
- Beide Wege gibt es einzeln (Papierkorb an der Zeile) und gesammelt: `DELETE /locations/:book_id/stale` löscht alle verwaisten Orte des Buchs. Die Karte zeigt sie als `.stale-cleanup-row` unter der Filterleiste (Hinweis + Knopf, geteiltes Vokabular mit der Szenen-Karte, CSS `card-blocks.css`) und lädt den Katalog danach **neu**, statt lokal zu filtern — Kinder eines gelöschten Ortes fallen per `SET NULL` auf die Wurzel zurück. Selbst angelegte Orte sind nie `stale` und bleiben unangetastet. Denselben Endpunkt nutzt die Danger-Zone der Bucheinstellungen.
- Dubletten führt der Autor über den Eintrag «Zusammenführen mit …» im Aktionsmenü der Zeile zusammen (⋯, Rechtsklick, Long-Press — [orte-menu.html](../public/partials/orte-menu.html)), für aktive und verwaiste Orte gleich: er öffnet den geteilten Merge-Picker ([book/entity-merge-picker.js](../public/js/book/entity-merge-picker.js), `POST …/merge`); verwaiste Zeilen tragen zusätzlich den Zeilen-Knopf «zusammenführen mit…» als Abkürzung. Dasselbe Panel steht in den Bucheinstellungen → Danger-Zone. **Ziel ist immer ein aktiver Ort:** ein verwaistes Ziel lehnt der Server ab (`TARGET_STALE`, 409), die Auswahllisten bieten keins an — das Ergebnis stünde sonst samt allen übertragenen Verknüpfungen als «nicht mehr im Text» da und fiele beim Aufräumen weg. Merge-Kern: [komplett.md](komplett.md) „Manuelles Zusammenführen".

## Auswertung im Detail

Deterministisch aus dem geladenen Katalog ([public/js/book/orte-insights.js](../public/js/book/orte-insights.js), kein KI-Call): Präsenz-Streifen über die Kapitel (Intensität = Häufigkeit), Hinweis «nur am Anfang Schauplatz» mit denselben Schwellen wie die Schauplatz-Nutzung im Erzählprofil (`NARRATIVE_REPORT_THRESHOLDS`), Begegnungen = Figurenpaare, die sich hier in derselben aktiven Szene treffen.

## Typen

`locations.typ` ist Freitext; die bekannten Werte und ihre Labels stehen in [public/js/book/ort-typen.js](../public/js/book/ort-typen.js) (`orte.typ.<key>` in beiden Locales). Die Liste muss das Typ-Enum des Analyse-Schemas decken — gegated durch [tests/unit/ort-typen.test.mjs](../tests/unit/ort-typen.test.mjs). Unbekannte Werte erscheinen als Rohwert. Ein Typ-Key ist eine Persistenz-Konstante: ergänzen ja, umbenennen nein.

## Analyse-Lauf (Phase 3)

Single-Pass und beide Multi-Pass-Wege (KI-Konsolidierung, regelbasierter Fallback) laufen durch denselben Varianten-Dedup (`dedupeLocationsWithinRun`), bevor IDs vergeben werden — sonst ordnet der Abgleich von zwei Einträgen desselben Orts nur einen dem Bestand zu, und der andere wird eine neue Zeile. Der Kollaps-Riegel (Lauf liefert gegen den Bestand fast nichts → Bestand bleibt) zählt nur Orte, die die Analyse liefern kann: ein nie gefundener, selbst angelegter Ort zählt nicht.

Tests: [tests/integration/locations-manual.test.js](../tests/integration/locations-manual.test.js), [tests/unit/komplett-orte-phase3.test.js](../tests/unit/komplett-orte-phase3.test.js), [tests/unit/orte-insights.test.mjs](../tests/unit/orte-insights.test.mjs), Karte + Pflege in [tests/e2e-app/orte-pflege.spec.js](../tests/e2e-app/orte-pflege.spec.js), Merge in [tests/unit/entity-merge.test.js](../tests/unit/entity-merge.test.js).
