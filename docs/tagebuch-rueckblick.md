# Tagebuch-Rückblick

Rückwärtsgewandte KI-Verdichtung der datierten Einträge eines Zeitraums (Monat `YYYY-MM` oder Jahr `YYYY`) — nur bei Buchtyp `tagebuch`. Der Rückblick liest, er schreibt nie in den Buchtext.

| Schicht | Ort |
|---|---|
| Job | [routes/jobs/rueckblick.js](../routes/jobs/rueckblick.js) (`POST /jobs/rueckblick`) |
| Datums-Helfer, Coverage, Belegprüfung | [routes/jobs/rueckblick-dates.js](../routes/jobs/rueckblick-dates.js) (pure) |
| Prompt + Schema | [public/js/prompts/tagebuch.js](../public/js/prompts/tagebuch.js) |
| Cache + History | [db/rueckblick.js](../db/rueckblick.js) (`tagebuch_rueckblick_cache`, `tagebuch_rueckblicke`) |
| History-/Coverage-Routen | [routes/history/reviews.js](../routes/history/reviews.js) |
| Karte | [public/partials/tagebuch-rueckblick.html](../public/partials/tagebuch-rueckblick.html), [public/js/cards/tagebuch-rueckblick-card.js](../public/js/cards/tagebuch-rueckblick-card.js), [public/js/book/tagebuch-rueckblick.js](../public/js/book/tagebuch-rueckblick.js) |
| Overview-Heatmap | [public/partials/bookoverview-rueckblick-heatmap.html](../public/partials/bookoverview-rueckblick-heatmap.html), [public/js/book-overview/diary.js](../public/js/book-overview/diary.js) |

## Ablauf des Jobs

1. Einträge des Zeitraums über den Abschnittsnamen datieren (`entryDate` → `lib/datum-parse`), laden, nach Datum sortieren.
2. Passt der Text ins Single-Pass-Budget → ein Call. Sonst Map-Reduce: Gruppen je Monat (Jahres-Zeitraum) bzw. grössenbasiert (ein überlanger Monat); Themen/Personen/Orte führt `mergeRueckblickFacets` deterministisch zusammen, der Synthese-Call liefert nur bemerkenswerte Tage + Zusammenfassung.
3. Kontext: bekannte Figuren/Orte (kanonische Schreibweise) und der verdichtete Rückblick des Vor-Zeitraums — dieser nur zur Einordnung von Entwicklungen, nie als Beleg.
4. **Belegprüfung** (`verifyRueckblickBelege`): Belege, die keinem vorgelegten Eintragsdatum entsprechen, fallen; `haeufigkeit` ist danach die Zahl der verbliebenen Belegtage; Facetten ohne Beleg und bemerkenswerte Tage ohne Eintrag entfallen, die Tage stehen chronologisch. Läuft auch über Cache-Treffer (idempotent). **Why:** ein Rückblick-Datum ist ein Sprungziel — ein erfundenes führte beim Klick ins Leere, eine geschätzte Häufigkeit sortierte die Chips falsch.
5. Cache-Key: `id:updated_at` aller Einträge + Zeitraum + Modell + Prompt-Version + Signatur des Vor-Rückblicks. Eine History-Zeile entsteht nur bei inhaltlich neuem Ergebnis; sonst wird nur der `entry_count`-Snapshot der jüngsten Zeile nachgeführt.

## Datierung: Coverage ist die SSoT

`GET /history/rueckblick-coverage/:book_id` (`buildRueckblickCoverage`) liefert je Monat/Jahr `entries`, `newest` (jüngstes `updated_at`, ms) und den jüngsten Rückblick, dazu `days` (Tagesdatum → `page_id`). Karte und Overview-Heatmap lesen **nur** diese Buckets — Zeitraum-Auswahl, Kalender (`buildYmHeatRows` in [ymheatmap.js](../public/js/book/ymheatmap.js)), Aktualität und Sprung zum Tag. Kein Frontend-Modul parst Abschnittsnamen selbst. **Why:** der Job datiert über `parseDatum`, eine Regex im Browser nur `YYYY-MM-DD`; Abschnitte mit freier Datumsschreibung landeten sonst im Rückblick, aber nicht in Auswahl und Kalender.

## History

- `GET /history/rueckblick/:book_id` → `{ current_model, entries }`: **alle** Läufe als Metadaten (ohne `result_json`, ohne Limit). Das Ergebnis lädt die Karte beim Öffnen über `GET /history/rueckblick-entry/:id`. **Why:** Kalender, Auswahl und Aktualität brauchen alle Zeiträume; mit vollem JSON wäre ein langjähriges Tagebuch eine Megabyte-Antwort pro Kartenöffnen.
- `GET /history/rueckblick-search/:book_id?q=` → `{ ids }`: Inhaltssuche über Zusammenfassung, Facetten-Namen und Begründungen (nicht über das rohe JSON). Den lokalisierten Zeitraum-Namen sucht die Karte selbst.
- Rückblicke sind persönlich: jede Zeile trägt `user_email`, Lesen/Löschen filtert darauf.

## Aktualität — Hinweis, keine Sperre

`rueckblickFreshness()` bezieht sich auf den jüngsten Rückblick des Zeitraums: `changed` (Eintrag jünger als der Rückblick oder Anzahl ≠ `entry_count`), `model` (Einträge unverändert, aber mit anderem Modell erstellt als `current_model`), `orphan` (keine Einträge mehr), `current`. „Neu erstellen" bleibt in jedem Zustand möglich. **Why:** eine Sperre auf „Einträge unverändert" hielt Rückblicke älterer Modelle für immer fest; ein unveränderter Lauf kostet dank Server-Cache ohnehin keinen KI-Call.

## Karte

Zeitraum-Leiste (‹ Zeitraum ›, Kennzahlen, Aktionen, Aktualität) über zwei Zuständen: **Übersicht** (Erstellen-Aufruf, Kalender/Liste früherer Rückblicke) und **Rückblick** (Betrachtung als Lesetext, bemerkenswerte Tage, Facetten). Ein Facetten-Chip öffnet die Belegleiste mit Zeitleiste über den Zeitraum; Personen und Orte, die einer Figur bzw. einem Schauplatz entsprechen, erscheinen dort zusätzlich als `x-entity-ref`. Tage ohne auffindbaren Abschnitt sind sichtbar, aber nicht klickbar. Permalink `#book/<id>/rueckblick/<entryId>` über `Alpine.store('nav').rueckblickEntryId`.

## Tests

[tests/unit/rueckblick-coverage.test.js](../tests/unit/rueckblick-coverage.test.js) (Coverage, Belegprüfung) · [tests/unit/rueckblick-history.test.mjs](../tests/unit/rueckblick-history.test.mjs) (Karten-Methoden) · [tests/unit/rueckblick-prompt.test.mjs](../tests/unit/rueckblick-prompt.test.mjs) · [tests/integration/rueckblick.test.js](../tests/integration/rueckblick.test.js) (Job) · [tests/integration/rueckblick-history-routes.test.js](../tests/integration/rueckblick-history-routes.test.js) (Routen) · [tests/e2e/tagebuch-rueckblick.spec.js](../tests/e2e/tagebuch-rueckblick.spec.js) (Harness).
