# Buchreihen

Eine Reihe ist ein **Verbund von Bänden**, kein gemeinsamer Katalog. Figuren, Schauplätze, Welt-Fakten und alles, was an ihnen hängt, bleiben je Buch und je User. Die Reihe ordnet nur Bände (Titel, Bandnummer) und erlaubt, gepflegte Einträge aus einem Vorband in den neuen Band zu kopieren.

**Why kein Reihen-Codex:** der Katalog hängt an `(book_id, user_email)` (`UNIQUE(book_id, fig_id, user_email)`, `fig_id` je Analyse-Lauf neu), die Analyse markiert pro Buch, was im Text dieses Bandes fehlt, die Chat-Werkzeuge prüfen, dass angefragte IDs zum aktuellen Buch gehören, und `.swbook`-Export wie Rechteprüfung arbeiten je Buch. Ein geteilter Katalog griffe in jeden dieser Pfade ein.

Code: [db/book-series.js](../db/book-series.js) (Reihe), [db/series-carryover.js](../db/series-carryover.js) (Übernahme), [routes/book-series.js](../routes/book-series.js), UI im Tab «Reihe» der Bucheinstellungen ([book-settings-series.html](../public/partials/book-settings-series.html), [book-settings/series.js](../public/js/book/book-settings/series.js)). Test: [tests/integration/book-series.test.js](../tests/integration/book-series.test.js).

## Datenmodell

- `book_series` (`id`, `name`) — **kein Besitzer-Konto**. Ein Buch kann den Besitzer wechseln; eine Konto-Spalte an der Reihe würde dann veralten.
- `book_series_members` (`series_id`, `book_id` UNIQUE, `position` ≥ 1) — ein Buch steht in höchstens einer Reihe. Positionen sind lückenlos `1..n`; jede Mitglieds-Änderung nummeriert neu. Eine Reihe ohne Band wird gelöscht.
- `figures.origin_figure_id`, `locations.origin_location_id` — Herkunft einer Kopie aus dem Vorband (`SET NULL`: die Kopie ist eigenständige Pflege und überlebt das Löschen des Vorbands).

## Rechte

Leiten sich aus den Bänden ab ([routes/book-series.js](../routes/book-series.js)):

| Aktion | Recht |
|---|---|
| Reihe lesen | `viewer` auf dem aktuellen Buch |
| Reihe anlegen, verlassen | `owner` des aktuellen Buchs |
| Beitreten, umbenennen, umordnen | `owner` des aktuellen Buchs **und jedes Bands** der Reihe — die Reihe bestimmt Titel und Bandnummer im EPUB jedes Bands |
| Aus Vorband übernehmen | `editor` auf dem aktuellen Buch, `viewer` auf dem Vorband; Quelle muss ein Band derselben Reihe mit kleinerer Nummer sein |

## EPUB

Die Reihe ist der **einzige Ort** für Reihentitel und Bandnummer; `book_publication` führt sie nicht. `getMeta` ([db/book-publication.js](../db/book-publication.js)) legt sie per `seriesMetaForBook` als `series`/`series_index` über die Publikations-Metadaten — so lesen EPUB-Export, Fassungs-Capture und Versand sie ohne Sonderweg, und der Tab Publikation zeigt sie nur an (Bearbeiten im Tab «Reihe»). Ein Export aus einer Fassung behält deren eingefrorenen Stand. Bandnummern sind ganze Zahlen (die Position); gebrochene Nummern wie «1.5» gibt es nicht.

## Aus Vorband übernehmen

Kopiert aus dem **eigenen** Katalog des Vorbands (gleiche `user_email`; bei mehreren Mitarbeitenden hat jede Person ihren eigenen) ausgewählte Figuren, Schauplätze und Welt-Fakten. Vorausgewählt ist alles Gepflegte, das im Band noch fehlt. Schon Vorhandenes (gleiche Herkunft oder gleicher Name bzw. gleiche Aussage) wird übersprungen; eine zweite Übernahme legt nichts doppelt an.

Was mitkommt: Stammdaten (keine `stale`-Einträge), Figuren-Aliasse und -Eigenschaften, Beziehungen zwischen übernommenen Figuren (als `origin='manual'`, ohne Belege), die Orts-Hierarchie, soweit der Elternort mitkommt, Koordinaten. Was nicht mitkommt: alles mit Kapitel-/Abschnittsbezug des Vorbands (Vorkommen, erste Erwähnung, Schlüsselzitate, Bogen, Präsenz, Kapitel-Brücke der Fakten, Lebensereignisse, Szenen) — deren IDs gehören zum alten Buch.

**Wie die Analyse die Kopien respektiert** (die Pflicht-Invariante des Features; ohne sie wäre der Katalog nach dem ersten Lauf entwertet, weil am Anfang eines Bandes kaum Text steht):

| Gattung | Markierung der Kopie | Wirkung in der Komplettanalyse |
|---|---|---|
| Figur | `manually_edited = 1`, `ki_name` leer | nie gefunden → bleibt aktiv statt «nicht mehr im Text» ([komplett.md](komplett.md)); einmal gefunden, gilt der normale Abgleich |
| Schauplatz | `manually_edited = 1`, `manually_created = 1` | wird nie `stale` ([schauplaetze.md](schauplaetze.md)) |
| Welt-Fakt | `manually_edited = 1` | überlebt den Full-Replace, bekommt seine Kapitel aus den Funden ([komplett.md](komplett.md#welt-fakten-wer-den-index-liest)) |

Die Kopien dienen der Analyse des neuen Bandes zugleich als Identitäts-Anker (`katalog-anker.js`).
