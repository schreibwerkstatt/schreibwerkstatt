# Tagebuch-Rückblick

Rückwärtsgewandte KI-Verdichtung der datierten Einträge eines Zeitraums (Monat `YYYY-MM` oder Jahr `YYYY`) — nur bei Buchtyp `tagebuch`: die Karte über `requiresBuchtyp` in der Feature-Registry, der Job autoritativ über `isTagebuchBook` ([lib/buchtyp.js](../lib/buchtyp.js), sonst `400 NOT_DIARY_BOOK`). Der Rückblick liest, er schreibt nie in den Buchtext.

| Schicht | Ort |
|---|---|
| Job | [routes/jobs/rueckblick.js](../routes/jobs/rueckblick.js) (`POST /jobs/rueckblick`) |
| Datums-Helfer, Coverage, Belegprüfung | [routes/jobs/rueckblick-dates.js](../routes/jobs/rueckblick-dates.js) (pure) |
| Facetten: Namen, Aliase, Textsuche, Map-Reduce-Merge, Verlauf | [routes/jobs/rueckblick-facets.js](../routes/jobs/rueckblick-facets.js) (pure) |
| Prompt + Schema | [public/js/prompts/tagebuch.js](../public/js/prompts/tagebuch.js) |
| Cache + History | [db/rueckblick.js](../db/rueckblick.js) (`tagebuch_rueckblick_cache`, `tagebuch_rueckblicke`) |
| History-/Coverage-Routen | [routes/history/reviews.js](../routes/history/reviews.js) |
| Karte | [public/partials/tagebuch-rueckblick.html](../public/partials/tagebuch-rueckblick.html) (+ Fragmente `-result`, `-overview` = Leiste, `-history-row`, `-verlauf`), [public/js/cards/tagebuch-rueckblick-card.js](../public/js/cards/tagebuch-rueckblick-card.js), [public/js/book/tagebuch-rueckblick.js](../public/js/book/tagebuch-rueckblick.js), [public/js/book/rueckblick-calendar.js](../public/js/book/rueckblick-calendar.js) (Kalender + Zustand des Hauptbereichs), [public/js/book/rueckblick-verlauf.js](../public/js/book/rueckblick-verlauf.js) |
| Overview-Heatmap | [public/partials/bookoverview-rueckblick-heatmap.html](../public/partials/bookoverview-rueckblick-heatmap.html), [public/js/book-overview/diary.js](../public/js/book-overview/diary.js) |

## Ablauf des Jobs

1. Einträge des Zeitraums über den Abschnittsnamen datieren (`entryDate` → `lib/datum-parse`), laden, nach Datum sortieren.
2. Passt der Text ins Single-Pass-Budget → ein Call. Sonst Map-Reduce: Gruppen je Monat (Jahres-Zeitraum) bzw. grössenbasiert (ein überlanger Monat); Themen/Personen/Orte führt `mergeRueckblickFacets` deterministisch zusammen, der Synthese-Call liefert nur bemerkenswerte Tage + Zusammenfassung. **Jahresrückblick aus Monaten:** jeder Monatslauf legt sein geprüftes Ergebnis zusätzlich als Teilergebnis ab (`tagebuch_rueckblick_cache`, Zeitraum `<YYYY-MM>#part`, Signatur = Inhalt + Modell + Prompt, ohne Vor-Rückblick). Liegen für **alle** Monate eines Jahres gültige Teilergebnisse vor, genügt der Synthese-Call — auch wenn der Text in einen Single-Pass passte; sonst übernimmt der Map-Reduce, was da ist, und rechnet nur die übrigen Monate. **Why:** ohne das analysierte ein Jahr jeden Monat neu, obwohl die Monatsrückblicke schon bezahlt waren.
3. Kontext: bekannte Figuren/Orte (kanonische Schreibweise, Info nach Gedankenstrich — **nie in Klammern**, sonst übernimmt das Modell das Muster «Name (Info)» in seine Namen) und der verdichtete Rückblick des Vor-Zeitraums — dieser nur zur Einordnung von Entwicklungen und für stabile Themen-Labels (ein fortgesetztes Thema behält sein Label, darauf baut der Verlauf), nie als Beleg.

   **Was das Modell liefert:** höchstens 8 Themen (`label`, `belege`), Personen/Orte mit `name` (gebräuchlichste Schreibweise, ohne Klammer/Schrägstrich), `aliase` (weitere Schreibweisen, wörtlich im Text) und `belege`. **Keine `haeufigkeit`** — die zählt der Server.
4. **Belegprüfung** (`verifyRueckblickBelege`): Belege, die keinem vorgelegten Eintragsdatum entsprechen, fallen. Personen/Orte werden normalisiert (Klammer-Zusatz → `zusatz`, nur Anzeige; «A / B» → Name + Alias), Nennungen mit gemeinsamem Namen/Alias verschmelzen, und ihre Belege werden um die **Textsuche** nach Name + Aliasen ergänzt — **Vereinigung** mit den Modell-Belegen (das Modell erkennt gebeugte Formen, die Suche findet Übersehenes). Gesucht wird ganzwortig, in der geschriebenen Gross-/Kleinschreibung, mit Genitiv-s, ab 3 Zeichen; der Klammer-Zusatz nie (ein «Bar» träfe jedes Vorkommen des Worts). Themen haben keine Textsuche und werden auf 8 gekappt. `haeufigkeit` = Zahl der Belegtage; Facetten ohne Beleg und bemerkenswerte Tage ohne Eintrag entfallen, die Tage stehen chronologisch. Läuft auch über Cache-Treffer (idempotent). **Why:** ein Rückblick-Datum ist ein Sprungziel — ein erfundenes führte beim Klick ins Leere; und die Prüfung allein entfernt nur, sie ergänzt nichts — was das Modell über einen langen Monat übersah, fehlte in der Zählung.
5. Cache-Key: `id` + Inhalts-Hash aller Einträge (nicht `updated_at` — ein Speichern ohne Textänderung kostet keinen Call) + Zeitraum + Modell + Effort + Prompt-Version + Signatur des Vor-Rückblicks. Eine History-Zeile entsteht nur bei inhaltlich neuem Ergebnis; sonst bestätigt der Lauf die jüngste Zeile (`entry_count`-Snapshot + `checked_at`).
6. Modell: Stufe `standard` (Katalog [lib/ai/job-tiers.js](../lib/ai/job-tiers.js)), Effort `ai.claude.effort.rueckblick` (Default `medium`).

## Datierung: Coverage ist die SSoT

`GET /history/rueckblick-coverage/:book_id` (`buildRueckblickCoverage`) liefert je Monat/Jahr `entries`, `newest` (jüngstes `updated_at`, ms) und den jüngsten Rückblick, dazu `days` (Tagesdatum → `page_id`). Rückblick-Karte und Overview-Heatmap lesen **nur** diese Buckets — Zeitraum-Navigation, Kalender (`buildYmHeatRows` in [ymheatmap.js](../public/js/book/ymheatmap.js)), Aktualität und Sprung zum Tag — und parsen Abschnittsnamen nicht selbst. **Why:** der Job datiert über `parseDatum`; Abschnitte mit freier Datumsschreibung landeten sonst im Rückblick, aber nicht in Auswahl und Kalender der Karte.

Die **tagesgenauen** Tagebuch-Ansichten (Sidebar-Kalender, Vor/Zurück-Navigation, «An diesem Tag», Zeitraum-Suche, Overview-Kacheln «Lücken & Konsistenz» und «Wochentag-Rhythmus») datieren dagegen nur über den Namen `YYYY-MM-DD` — SSoT `diaryDayKey` in [diary-date.js](../public/js/book/diary-date.js). **Why:** sie brauchen einen Kalendertag, ein «2020-03 Thema» hat keinen; und jeder Weg, der Einträge anlegt (Kalender, Kontextmenü, Buch-Organizer, Ordner-Import), schreibt genau diese Form. Ein frei datierter Abschnitt zählt also im Rückblick seines Monats mit, erscheint aber nicht im Sidebar-Kalender.

## History

- `GET /history/rueckblick/:book_id` → `{ current_model, entries }`: **alle** Läufe als Metadaten (ohne `result_json`, ohne Limit). Das Ergebnis lädt die Karte beim Öffnen über `GET /history/rueckblick-entry/:id`. **Why:** Kalender, Auswahl und Aktualität brauchen alle Zeiträume; mit vollem JSON wäre ein langjähriges Tagebuch eine Megabyte-Antwort pro Kartenöffnen.
- `GET /history/rueckblick-search/:book_id?q=` → `{ ids }`: Inhaltssuche über Zusammenfassung, Facetten-Namen samt Aliasen und Begründungen (nicht über das rohe JSON). Den lokalisierten Zeitraum-Namen sucht die Karte selbst.
- Rückblicke sind persönlich: jede Zeile trägt `user_email`, Lesen/Löschen filtert darauf.
- Der History-Reset eines Buchs (`DELETE /history/book/:book_id`) löscht die Rückblicke **und** den Endergebnis-Cache des Users — sonst lieferte der nächste Lauf wortgleich das alte Ergebnis.

## Aktualität — Hinweis, keine Sperre

«Veraltet» rechnet der Server in der Coverage (`rueckblickStale` → `bucket.rueckblick.stale`): ein Eintrag wurde nach `max(created_at, checked_at)` bearbeitet, oder die Anzahl weicht vom `entry_count`-Snapshot ab. Kalender (Karte **und** Overview-Heatmap) zeigen das als «!» mit Warnrahmen (`.ymheat-cell--stale`), die Karte als Hinweis. `rueckblickFreshness()` der Karte: `changed` (stale), `model` (mit anderem Modell als `current_model` erstellt — **kein** eigener Hinweis, nur Tooltip an der Meta-Zeile, die das Modell schon nennt: ein Modellwechsel macht den Inhalt nicht falsch), `orphan` (keine Einträge mehr), `current`. „Neu erstellen" bleibt in jedem Zustand möglich. **Why:** eine Sperre auf „Einträge unverändert" hielt Rückblicke älterer Modelle für immer fest; ein unveränderter Lauf kostet dank Server-Cache keinen KI-Call und setzt `checked_at`, der Hinweis verschwindet danach.

## Karte

**Split mit Leiste** ([DESIGN.md](../DESIGN.md#split-mit-leiste-aside-split)): links der gewählte Zeitraum, rechts die Navigation; schmal steht die Navigation darüber (`--aside-first`), und eine Wahl springt zum Hauptbereich. Die Leiste erscheint, sobald das Buch datierte Einträge hat.

- **Leiste: Kalender | Liste.** Kalender = Jahr×Monat aus der Coverage plus Jahres-Spalte ([DESIGN.md](../DESIGN.md#jahrmonat-heatmap)): Rückblick vorhanden = Akzentfläche mit Häkchen, veraltet = «!», Dichte der Einträge in Grau, darüber «X von Y Monaten mit Rückblick». Das Jahr wird über seine Zelle gewählt wie ein Monat — es gibt keinen Monat/Jahr-Umschalter und keine Zeitraum-Auswahlliste. Liste = je Zeitraum der jüngste Lauf, ältere einklappbar; Suche über Zeitraum + Inhalt.
- **Hauptbereich: Rückblick | Verlauf** (Reiter erst ab zwei Monatsrückblicken). Zeitraum-Leiste ‹ Zeitraum › mit Kennzahlen und «Neu erstellen» (nur wo schon ein Rückblick existiert), darunter der Zustand des Zeitraums (`rbPeriodState`):
  - `result` — Betrachtung als Lesetext, bemerkenswerte Tage, Facetten. Personen/Orte mit nur einem Beleg stehen hinter «+N weitere», solange es Mehrfachnennungen gibt. Ein Chip öffnet die Belegleiste: Schreibvarianten («auch: …»), Zeitleiste über den Zeitraum (Belegtage klickbar), Tage als Kurz-Chips (ohne Jahr). Personen und Orte, deren Name oder Alias einer Figur bzw. einem Schauplatz entspricht, erscheinen zusätzlich als `x-entity-ref`. Tage ohne auffindbaren Abschnitt sind sichtbar, aber nicht klickbar.
  - `create` — Leerzustand mit Erklärung und **Rückblick erstellen**: der Aufruf steht dort, wo das Ergebnis erscheinen wird.
  - `hidden` — Rückblick vorhanden, aber geschlossen (Browser-Zurück vom Permalink): **Anzeigen**.
  - `empty` / `noDated` — keine Einträge im Zeitraum bzw. im Buch.
- **Verlauf** — Personen, Orte oder Themen × Monate, Zelle = Belegtage, Stufe nach Anteil an den Einträgen des Monats (`GET /history/rueckblick-verlauf/:book_id`, zusammengeführt über Namen + Aliase in `buildRueckblickVerlauf`, kein KI-Call). Eine Zelle öffnet den Monat im Hauptbereich und klappt die Belege des Eintrags auf.

**Why — ein Klick, eine Folge:** Kalender und Liste wählen immer nur den Zeitraum; was dann erscheint, hängt allein am Zustand des Zeitraums, und der Erstellen-Aufruf steht am Ort des Ergebnisses. Ein Tagebuch über viele Jahre hat einen hohen Kalender — eine Aktion über dem Raster liegt beim Klick in eine untere Zeile ausserhalb des Bildes, und ein Klick, der je nach Monat die Ansicht wechselt oder nur eine Überschrift ändert, ist nicht vorhersehbar.

**Während eines Laufs** sind Kalender, Liste und Nachbar-Pfeile gesperrt; das Ergebnis gehört immer dem Zeitraum des Laufs (`job.result.zeitraum` in `rueckblickOnDone`), auch nach Schliessen und Wiederöffnen der Karte, und erscheint im Hauptbereich (auch wenn der Verlauf offen war). Permalink `#book/<id>/rueckblick/<entryId>` über `Alpine.store('nav').rueckblickEntryId`.

## Tests

[tests/unit/rueckblick-coverage.test.js](../tests/unit/rueckblick-coverage.test.js) (Coverage, Aktualität, Belegprüfung) · [tests/unit/rueckblick-facets.test.js](../tests/unit/rueckblick-facets.test.js) (Namen, Aliase, Textsuche, Merge, Verlauf) · [tests/unit/rueckblick-history.test.mjs](../tests/unit/rueckblick-history.test.mjs) (Karten-Methoden, Zustand des Hauptbereichs, Verlauf-Matrix) · [tests/unit/ymheatmap.test.mjs](../tests/unit/ymheatmap.test.mjs) + [tests/unit/rueckblick-heatmap.test.mjs](../tests/unit/rueckblick-heatmap.test.mjs) (Kalender-Zeilen, Jahres-Spalte, Zellklassen) · [tests/unit/rueckblick-card-ondone.test.mjs](../tests/unit/rueckblick-card-ondone.test.mjs) (Ergebnis am Zeitraum des Laufs) · [tests/unit/rueckblick-prompt.test.mjs](../tests/unit/rueckblick-prompt.test.mjs) · [tests/integration/rueckblick.test.js](../tests/integration/rueckblick.test.js) (Job) · [tests/integration/rueckblick-history-routes.test.js](../tests/integration/rueckblick-history-routes.test.js) (Routen) · [tests/e2e/tagebuch-rueckblick.spec.js](../tests/e2e/tagebuch-rueckblick.spec.js) (Harness).
