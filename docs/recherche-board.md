# Recherche-Board

Karte `rechercheCard`, Routen `/research`, Status-SSoT [lib/research-validate.js](../lib/research-validate.js). Der Recherche-Chat daneben: [recherche-chat.md](recherche-chat.md).

- **Das Recherche-Board hat ZWEI Ansichten, EINEN Bestand** (Karte `rechercheCard`, Umschalter `viewMode` = `list`|`status`): die **Liste** zeigt den Bestand (Anriss je Fundstueck), das **Status-Board** den Fortschritt (Kanban ueber `research_items.status`, SSoT der Stufen: [lib/research-validate.js](../lib/research-validate.js)#`RESEARCH_STATUSES` + Frontend-Spiegel [recherche/shared.js](../public/js/book/recherche/shared.js)#`STATUSES`, Drift gegated in [tests/unit/research-status.test.mjs](../tests/unit/research-status.test.mjs)). Pflicht: **beide Ansichten rendern dieselbe `items`-Liste desselben `/research`-Requests** hinter derselben Filterleiste — ein zweiter Lesepfad zeigte bei aktivem Filter zwei verschiedene Bestaende; **`verworfen` ist eine Stufe, nicht `archived`** (archiviert = aus dem Board geraeumt und aus den Seiten-/Kapitel-Indikatoren gefallen, verworfen = geprueft und sichtbar nicht verwendet — als Archiv verschwiege es genau die Information, um derentwillen man es festhaelt); **eine Reihenfolge INNERHALB einer Spalte gibt es nicht** (`research_items` hat keine `sort_order`, die Ordnung kommt aus der gewaehlten Sortierung — darum nimmt [recherche/status.js](../public/js/book/recherche/status.js) den DOM-Move von SortableJS **immer** zurueck und schreibt nur den neuen Status); und **die Stelle im Buch bleibt die bestehende Verknuepfung** (`chapter`/`page` aus `research_item_links`, auf der Karte read-only) — „eingearbeitet" ohne solche Verknuepfung ist ein **Befund** auf der Karte, keine Korrektur (gleiche Bauart wie das Drift-Badge der Beat-Karte). Status setzen: Drag im Board oder der Abschnitt „Status" im geteilten Aktionsmenue ([recherche-item-menu.html](../public/partials/recherche-item-menu.html)) — ein Schreibpfad (`setItemStatus`), drei Oberflaechen.

## Rückrichtung: Pendenzen am Fundstück

Jedes Fundstück zeigt die eigenen Ideen, die darauf zeigen, als
Entitäts-Referenzen vom Typ `idee` (`x-entity-ref`) — geladen über `GET /ideen/links?target_kind=research`
(non-fatal, [ideen-backlinks.js](../public/js/book/ideen-backlinks.js)). Read-only:
kuratiert wird die Kante auf der Ideen-Seite, Klick springt an die Stelle im Buch,
an der die Pendenz hängt.

**Der Lesepfad hängt bewusst NICHT am Fundstück-Payload.** `research_items` ist
buchweit geteilt, `ideen` dagegen user-privat — hingen die Anrisse an der Zeile,
müsste jeder ihrer Schreibpfade (`/capture`, Upload, Scrape, Interview, PATCH …)
die Skopierung mitführen, und der erste, der es vergisst, zeigt dem Mitarbeiter
die privaten Pendenzen des Autors. Details: [ideen-board.md](ideen-board.md).

## Verknüpfungs-Vorschläge (Job `research-link`)

„Verknüpfungen vorschlagen" ([routes/jobs/research-link.js](../routes/jobs/research-link.js)) liefert Vorschläge aus **zwei Quellen**, persistiert nichts (der User übernimmt einzeln über `POST /research/:id/links`):

- **Seiten aus den Embeddings** (`source: 'semantic'`, höchstens drei): die Manuskriptseiten, die dem Fundstück inhaltlich am nächsten stehen — [lib/research-retrieval.js](../lib/research-retrieval.js)#`researchPageHits` (Vektor des Fundstücks, für ein noch nicht indexiertes ersatzweise Freitext aus Titel/Text/PDF-Anfang; dieselbe Auswahl nutzt der Recherche-Abgleich). `grund` ist ein **Auszug der Fundstelle** (Zitat), kein KI-Text. Ohne Embedding-Endpunkt oder bei dessen Ausfall entfallen nur diese Vorschläge. **Warum nicht das Modell:** es sieht die Kandidatenliste, nicht den Text aller Seiten — die Verknüpfung, die „eingearbeitet" belegt, könnte es nur raten.
- **Welt-Entitäten durch das Modell** (Figuren, Orte, Szenen, Beats, Stränge aus dem Katalog des auslösenden Users).

Der Befund „eingearbeitet ohne Stelle" auf der Status-Karte trägt dafür „Stelle vorschlagen": öffnet den Detail-Dialog und startet den Job.

## Mehrfachauswahl (`POST /research/bulk`)

Nur in der Listen-Ansicht: „Auswählen" schaltet Checkboxen und die Aktionsleiste ein ([recherche-bulk-bar.html](../public/partials/recherche-bulk-bar.html), [recherche/bulk.js](../public/js/book/recherche/bulk.js)); ein Klick auf einen Eintrag markiert dann, statt den Dialog zu öffnen. Aktionen: Status setzen, Tag ergänzen, mit einer Stelle/Entität verknüpfen, archivieren/zurückholen, löschen (mit Rückfrage). Server: [routes/research-bulk.js](../routes/research-bulk.js), **eine Transaktion**, Buch-ACL `editor`, Ids werden aufs Buch eingeschränkt (fremde fallen still weg, `count` nennt die tatsächlich betroffenen). Jede Aktion nutzt den Schreibweg der Einzel-Route (`setItemsStatus`, `addItemLink`, Suchindex) — „viele" darf nicht anders schreiben als „eins". Ein Verknüpfungsziel aus fremdem Buch rollt die ganze Aktion zurück. **Gezählt wird nur, was sichtbar ist** (`bulkIds` schneidet auf `items`): ein Filterwechsel darf keine unsichtbare Auswahl mitschleppen, die dann mitgelöscht würde.

## Status-Zuschreibung

`status_at`/`status_by` (Migration 300) halten fest, wer den Status zuletzt gesetzt hat und wann — das Board ist geteilt. Geschrieben **ausschliesslich** über [db/research-items.js](../db/research-items.js)#`setItemsStatus` (Einzel-PATCH, Status-Board-Drag, Mehrfachauswahl); `status_by` nur, wenn das Konto in `app_users` existiert (FK, `ON DELETE SET NULL`, `USER_REF_PLAN`: `anonymize`). Ausgabe mit `status_by_name` (Anzeigename per Subselect zur Lesezeit, `STATUS_SELECT_SQL`); sichtbar als Tooltip der Status-Plakette. Letzter Stand, kein Verlauf.

## Link-Prüfung (Job `research-link-check`)

„Links prüfen" prüft die URLs aller nicht archivierten Fundstücke ([routes/jobs/research-link-check.js](../routes/jobs/research-link-check.js), vier parallel, nie geprüfte bzw. am längsten ungeprüfte zuerst). Jeder Request über [lib/url-check.js](../lib/url-check.js) → `safeFetch` (die URL ist User-Inhalt: SSRF-Guard auf jedem Hop, 10 s, Body nie gelesen). HEAD zuerst, bei 403/404/405/501 ein GET. **401/403/429 gelten als erreichbar** (Paywall/Bot-Sperre, kein toter Link — als „tot" wäre das Dauerrauschen) und erscheinen als „Zugang gesperrt". Ergebnis an der URL-Zeile (`checked_at`, `check_ok`, `check_code`, `check_error`); `replaceUrls` übernimmt den Prüfstand einer beim Bearbeiten stehengebliebenen URL. Tote Links bekommen einen Link „Archivkopie suchen" auf die Wayback Machine — ein reiner Link, kein Server-Request. Kein KI-Call; Job statt Route nur wegen Dauer und Abbrechbarkeit.

## Recherche-Abgleich (Job `research-crosscheck`)

„Mit Manuskript abgleichen" (Toolbar fürs ganze Board, Detail-Dialog für ein Fundstück) prüft den Buchtext gegen das **gesammelte** Material: widerspricht eine Stelle einem Fakt (`typ: 'widerspruch'`) oder gibt sie ein Zitat abweichend wieder (`typ: 'zitat'`, nur bei Zitat-Fundstücken)? **Nicht** gegen die Wirklichkeit — das ist der Weltfakten-Faktencheck mit Web-Suche ([komplett.md](komplett.md)); darum provider-neutral, ohne Web. Job: [routes/jobs/research-crosscheck.js](../routes/jobs/research-crosscheck.js).

- **Kandidaten:** `fact`/`quote`, nicht archiviert, nicht `verworfen` (geprüft und bewusst nicht verwendet), höchstens 40.
- **Stellen je Kandidat:** verknüpfte Seiten bzw. die ersten Seiten verknüpfter Kapitel ([db/research-findings.js](../db/research-findings.js)#`placePageIds`) — der Autor hat gesagt, wo es hingehört; ohne Verknüpfung die semantisch nächsten Seiten-Chunks (`researchPageHits`). Ohne beides bleibt das Fundstück ungeprüft (`unchecked` im Ergebnis, kein KI-Call).
- **Urteil:** Bündel zu fünf Kandidaten, Prompt `buildSystemResearchCrosscheck`/`buildResearchCrosscheckPrompt` ([prompts/recherche.js](../public/js/prompts/recherche.js)), Pflichtfeld `befunde`. **Halluzinationsschutz** in `validateFindings`: Fundstück und Seite müssen aus dem Bündel stammen, `stelle` muss **wörtlich** (whitespace-/anführungszeichen-normalisiert) im gelieferten Seitentext stehen, `zitat` nur an Zitat-Fundstücken. Was nicht belegt ist, fällt weg.
- **Persistenz:** `research_item_findings` (Migration 301), am Fundstück, nicht am User (das Board ist geteilt). Jeder Lauf ersetzt die Befunde der **geprüften** Fundstücke — auch durch nichts. `page_id` CASCADE: ohne Seite keine Stelle. Ausgabe als `item.findings` (mit Seitennamen) über `attachRelations`; in der Liste als Hinweis-Chip, im Detail-Dialog als Abschnitt mit Sprung zur Seite ([recherche-findings.html](../public/partials/recherche-findings.html)). Ein Befund ist ein Hinweis, keine Korrektur; der Job ändert nie Buchtext.
