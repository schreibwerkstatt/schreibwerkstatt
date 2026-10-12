# Bearbeitungsstand

Wie weit ist ein Abschnitt? Der Autor setzt es selbst, pro Abschnitt, entlang
einer geordneten Kette. Kapitel tragen keinen eigenen Stand.

## Zwei Ketten, eine Mechanik

| Buchtyp | Kette | fertig |
|---|---|---|
| journalistisch (`isJournalisticBook`: `journalismus`, `blog`) | roh → gegengelesen → schlussredigiert → freigegeben | freigegeben |
| alle anderen | Rohfassung → überarbeitet → redigiert → final | final |

Beide Ketten liegen in **derselben** Tabelle `page_editorial_status` und laufen
durch dieselbe Route, denselben Frische-Anker und dieselbe Organizer-Plakette.
Nur die Stufen sind andere: die redaktionellen ergeben in einem Roman kein Bild.
Welche Kette gilt, entscheidet der Buchtyp **beim Schreiben**
(`statusChain(isJournalisticBook(settings))`). Der CHECK-Constraint kennt die
Vereinigung beider Ketten. Eine Stufe der jeweils anderen Kette weist die Route
mit `400 INVALID_VALUE` ab.

Beide Ketten sind gleich lang. Rang (0–3), Farbskala und `statusRank` tragen
darum über beide Ketten.

SSoT: [public/js/redaktion/status.js](../public/js/redaktion/status.js) (ESM).
CJS-Spiegel in [db/redaktion.js](../db/redaktion.js), dazu der CHECK
(Migration 325) und die i18n-Keys `redaktion.status.<key>`. Gegated durch
[tests/unit/redaktion-status.test.mjs](../tests/unit/redaktion-status.test.mjs).

**Neben den Fassungen, nicht in ihnen:** eine Fassung ([fassungen.md](fassungen.md))
ist ein Zustand des TEXTES (Archiv, wiederherstellbar), der Bearbeitungsstand
eine Aussage über den PROZESS («ist das fertig?», «darf das raus?»).

## Kapitelstand = schwächste Stufe

Ein Kapitel ist so weit wie sein schwächster Abschnitt, Unterkapitel
eingeschlossen (`weakestStatus`). Ein Abschnitt ohne Stufe zieht das Kapitel auf
«ohne». **Why:** ein eigener Kapitel-Status liefe neben den Abschnitten
auseinander, und «Kapitel final» hiesse dann nichts. Das Kapitel-Setzen im
Kontextmenü schreibt deshalb die Stufe in jeden Abschnitt darunter
(`PUT /redaktion/chapter/:chapter_id`). Weichen Einzelstände ab, fragt die App
vorher nach.

## Stale-Erkennung ist der Kern

Ein «final» auf einem Text, der sich seither geändert hat, gilt nicht mehr, und
gerade diese Anzeige darf nicht stillschweigend stehen bleiben. Darum hält
`content_updated_at` fest, **worauf** sich die Stufe bezog, und
`db/redaktion.js#_mapRow` berechnet `stale` an **genau einer Stelle**. Eine
geänderte Stufe fällt **nicht** automatisch zurück, sie wird als «seither
bearbeitet» markiert. Den Rückschritt entscheidet der Autor.

**Anker ist `pages.updated_at`, nicht `page_stats.content_sig`.** Den
Signatur-Index schreibt nur der Sync-Cron. Ein vor einer Stunde überarbeiteter
Abschnitt sähe darüber weiterhin «unverändert» aus. Der Anker kommt aus der
Seite, **nie vom Aufrufer**: sonst könnte ein Client eine Stufe auf einen
Textstand stempeln, den es nie gab.

## Verlauf

`page_editorial_status_events` protokolliert jeden **Wechsel** (gleiche Stufe
erneut setzen frischt nur den Anker auf; `status NULL` = entfernt). Die Tabelle
hat kein `book_id`: ein verschobener Abschnitt nimmt seinen Verlauf mit, das
Buch kommt zur Lesezeit aus `pages`. `statusHistory` spielt die Ereignisse nach
und liefert je Kalendertag (App-Zeitzone) die Verteilung **nach** dem letzten
Wechsel des Tages.

## Route ([routes/redaktion.js](../routes/redaktion.js))

| Route | Rolle | Antwort |
|---|---|---|
| `GET /redaktion/:book_id` | viewer | `{ enabled: true, journalistic, stufen, pages: {page_id → Eintrag}, counts }` |
| `GET /redaktion/:book_id/history` | viewer | `{ stufen, daily: [{date, <stufe>: n…}] }` |
| `PUT /redaktion/page/:page_id` | editor | `{ status, note? }`: ohne `note` bleibt die Notiz stehen |
| `PUT /redaktion/chapter/:chapter_id` | editor | alle Abschnitte inkl. Unterkapitel, Buch aus dem Kapitel |

Setzen erst ab `editor`: eine Stufe weiterzuschalten ist eine Entscheidung,
keine Ansicht.

## Oberflächen

Alle lesen **eine** Map: `$store.badges.editStatus` (+ `editStatusChain`). Sie
wird mit den Sidebar-Plaketten geladen
([tree/build.js](../public/js/book/tree/build.js)#`_loadSidebarBadges`) und
nach jedem Setzen mit der Server-Antwort ersetzt. Nichts ist optimistisch: die
Antwort trägt `stale` und den Anker, die der Client nicht selbst bilden kann.

- **Seitenbaum** ([tree/edit-status.js](../public/js/book/tree/edit-status.js)):
  vier Segmente hinter dem Namen, gefüllt bis zur Stufe, gedämpft bei `stale`.
  Am Kapitelkopf steht der abgeleitete Kapitelstand. Gesetzt wird per
  Rechtsklick (Abschnitt: Klick auf die aktive Stufe nimmt sie zurück; Kapitel:
  alle darunter). Der Status-Tooltip nennt die Stufe in der ersten Zeile.
- **Buchorganizer** ([book-organizer/redaktion.js](../public/js/book-organizer/redaktion.js)):
  Plakette + Combobox je Zeile, siehe [buchorganizer.md](buchorganizer.md).
- **Buchübersicht** (Kachel «Bearbeitungsstand»,
  [book-overview/edit-status.js](../public/js/book-overview/edit-status.js)):
  Verteilung, fertige Kapitel (oberste Ebene), Zahl der seither bearbeiteten.
  Ohne jede Stufe zeigt sie, wie man eine setzt.
- **Buchstatistik** ([bookstats.js](../public/js/book/bookstats.js)): Metriken
  «Abschnitte fertig» / «Abschnitte mit Bearbeitungsstand» aus dem Verlauf
  (eigene Zeitachse, nur Tage mit Wechsel) und eine Plakette mit dem aktuellen
  Stand.
- **Notebook-Editor** ([editor-page-status.html](../public/partials/editor-page-status.html)):
  Plakette im Kopf zeigt die Stufe und öffnet die Auswahl.
- **Kapitelbewertung / Bucheditor / Kapitel-Dashboard**: Segmente am
  Kapitelnamen bzw. an Abschnitt- und Kapitelköpfen des Manuskript-Streams
  (Klasse `.edit-status-meter`); die Kachel «Fortschritt» zeigt die Verteilung
  im Kapitel.
- **Seitenbaum-Filter** (`treeEditFilter`, Knopf neben Auf-/Zuklappen): nur
  Abschnitte, die nicht auf der letzten Stufe stehen oder seither bearbeitet
  wurden; wirkt zusammen mit der Suche.
- **Buch-Chat**: Werkzeug `get_edit_status` ([buchchat-tools.md](buchchat-tools.md)),
  nur lesend, dazu eine Routing-Zeile im System-Prompt. Den Stand setzt der
  Autor, nicht die KI. **Plot-Chat**: dasselbe Werkzeug (ein Beat in einem
  fertigen Kapitel heisst Umbau).
- **Abschnitts-Chat**: die Stufe des offenen Abschnitts steht im Seiten-Block
  des System-Prompts ([edit-status-block.js](../public/js/prompts/edit-status-block.js)):
  frühe Stufen → Inhalt und Aufbau zuerst, die letzten beiden → nur Feinschliff.
- **Ideen-Chat**: Gliederung und Ideenliste tragen «— Stand: …» an jedem
  Abschnitt; eine offene Pendenz an einem fertigen Abschnitt prüft er zuerst.
- **Share-Leseansicht** (öffentlich, Leser-Sicht, [share-link.md](share-link.md)):
  leiser Hinweis «Stand: …» — bei Buch-/Kapitel-Share unter jeder
  Abschnitts-Überschrift (auch wenn die Überschrift wegen Gleichnamigkeit mit
  dem Kapitel entfällt), beim Abschnitts-Share im Masthead neben Umfang und
  Lesezeit. Server-gerendert in [lib/share-helpers.js](../lib/share-helpers.js)
  (`_statusLookup`, nur Stufen der Buch-Kette); `stale` zeigt der Leser nicht.
  Der Block zählt nicht zum Umfang und wird nicht vorgelesen
  (`TTS_SKIP_BLOCK_SEL`).

## Fertig, aber offene Pendenzen

Ein Abschnitt auf der letzten Stufe mit offenen Ideen ist ein Widerspruch:
entweder ist die Pendenz eingelöst, oder der Abschnitt ist nicht fertig. Er
wird sichtbar im Baum-Tooltip, in der Übersichtskachel (Klick öffnet das
Ideen-Board), an der Bahn im Ideen-Board (Plakette «fertig, aber offen»,
[ideen-board/edit-status.js](../public/js/book/ideen-board/edit-status.js)) und
im Ideen-Chat. Quelle der offenen Ideen ist `$store.badges.ideenCounts`.

## Serien-Lektorat

`POST /jobs/batch-check` mit `skip_final: true` (setzt die App immer) lässt
Abschnitte aus, die auf der letzten Stufe stehen und seither unverändert sind
(`doneUnchangedPageIds`). Ein seither bearbeiteter fertiger Abschnitt läuft
wieder mit. Die Rückfrage nennt die Zahl, das Ergebnis `skippedFinal`.

## Fassung beim Abschluss

Wird durch eine Änderung ein Kapitel der obersten Ebene oder das ganze Buch
vollständig fertig, bietet die App an, den Stand als Fassung zu speichern
(`_offerSnapshot`, `POST /snapshots/:bookId`). Nur beim Übergang, nicht bei
jedem Setzen.

Der Lektorats-Punkt im Baum ist eine **andere** Achse (wann zuletzt geprüft,
abgeleitet). Dasselbe gilt für die Kachel «Fortschritt» im Kapitel-Dashboard.
Geprüft heisst nicht fertig.

## Tests

- Unit: [redaktion-status.test.mjs](../tests/unit/redaktion-status.test.mjs).
  Ketten-Drift, CHECK, i18n, Kapitel-Ableitung, Verteilung, Stale.
- Integration: [bearbeitungsstand.test.js](../tests/integration/bearbeitungsstand.test.js).
  Kette je Buchtyp, Kapitel-Setzen inkl. Unterkapitel, ACL, Verlauf.
