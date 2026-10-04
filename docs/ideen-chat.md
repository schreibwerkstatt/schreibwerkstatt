# Ideen-Chat

Chat als **Panel im Ideen-Board** (Markup [public/partials/ideen-chat.html](../public/partials/ideen-chat.html), per `_loadPartials`-Cascade in [ideen-board.html](../public/partials/ideen-board.html); Scope + Methoden aus `ideenBoardCard`). Arbeitet die Ideen und Pendenzen eines Buches im Gespräch durch. Kern sind zwei Aufgaben, die keine andere Funktion übernimmt:

- **Erledigt-Check:** offene Pendenzen gegen den aktuellen Text prüfen. Löst der Text eine ein, schlägt der Chat «erledigt» vor und zitiert die Stelle.
- **Orte finden:** Buch-Ideen ohne Anker einen Abschnitt oder ein Kapitel zuordnen, an dem sie sich einlösen lassen.

Dazu Dubletten zusammenführen, Verknüpfungen zu Beat, Strang, Motiv, Werkstatt-Figur oder Recherche-Fundstück vorschlagen und auf Wunsch neue Ideen festhalten. **Schreibt nie selbst**: Änderungen kommen als Vorschläge, die der User **einzeln** übernimmt oder verwirft. Nie generativ in den Buchtext — eine Idee ist ein Stichpunkt.

**Platzierung:** wie der Plot-Chat — ab 1280px eigene, sticky Spalte rechts neben dem Board (`.ideen-split` in [entities/ideen-chat.css](../public/css/entities/ideen-chat.css)), schmaler steht das Panel per `order: -1` über dem Board. Das leere Gespräch bietet drei Schnellstart-Aufträge (Erledigt-Check, Orte, Dubletten).

## Provider — zwei Pfade

Gleiche Aufteilung wie im Plot-Chat ([plot-chat.md](plot-chat.md#provider--zwei-pfade)): `runIdeenChatJobDispatch` ([routes/jobs/ideen-chat.js](../routes/jobs/ideen-chat.js)) wählt am effektiven Provider. **Agentisch** mit Lese-Werkzeugen + `propose_*`, lokale Provider mit dem kleineren Satz `IDEEN_CHAT_SLIM_READ_TOOL_NAMES` und dem lokalen Iterationsdeckel des Buch-Chats. **Klassisch** ([ideen-chat-classic.js](../routes/jobs/ideen-chat-classic.js), auch als `fallbackJob` bei `AI_TOOLS_UNSUPPORTED`): ein JSON-Call `{ antwort, vorschlaege: [{ werkzeug, …Felder }] }` (`SCHEMA_IDEEN_CHAT_CLASSIC`), jeder Eintrag läuft durch dieselben Handler; Abgelehntes fällt still heraus und zählt in `context_info.rejected`. Ohne Werkzeuge sieht das Modell nur die semantisch nächsten Passagen zur Frage — der Prompt erlaubt «erledigt» dort nur, wenn die einlösende Stelle in diesen Passagen steht.

## Datenmodell

Keine neue Tabelle: Sessions in `chat_sessions` mit **`kind='ideen'`** (Migration 319, buchweit, `page_id IS NULL`), Nachrichten in `chat_messages`, Vorschläge samt Status in `context_info.proposals`. Buch-ACL **editor** (wie das Ideen-Board) für Session, Job und Status-Route. Ideen sind user-privat — der Chat sieht ausschliesslich die Ideen des fragenden Users (alle Lesungen laufen über [db/ideen.js](../db/ideen.js), das `user_email` erzwingt).

## Agentischer Job

Geteilter Loop [agentic-chat.js](../routes/jobs/agentic-chat.js) (`makeAgenticChatJob`). Cap `jobs.ideen_chat.max_tool_iter` (Default 8, Admin → Jobs) — Vorschlags-Aufrufe zählen mit.

**System-Prompt** ([prompts/ideen-chat.js](../public/js/prompts/ideen-chat.js)#`buildIdeenChatSystemPrompt`), zwei Cache-Blöcke:
- Block 1 (`ttl: '1h'`): Rolle, die vier Aufgaben, Beleg-Pflicht, Werkzeug-Strategie, Sprachnorm + Buch-Kontext.
- Block 2 (`cache: false`): aktive Stufen des Buches, **alle Ideen** in Buch-Reihenfolge mit `[#id]` (Buch-Ideen zuerst, dann je Kapitel seine und die seiner Abschnitte; was der Baum nicht kennt, steht in einer Sammelgruppe — nie verschwindet eine still), die **Gliederung** mit `chapter#`/`page#`-ids, die **verknüpfbaren Ziele** (je Art gedeckelt, Kappung ausgewiesen), das Gedächtnis früherer Vorschläge und — mit Embedding-Endpunkt — der Erst-Kontext `TEXTPASSAGEN`. Kontext-Bau: [ideen-chat-context.js](../routes/jobs/ideen-chat-context.js). Gliederung nur über die Content-Store-Facade (`loadOrderedBookContents`, inkl. ausgeschlossener Kapitel).

**Warum die Ideen im Prompt stehen:** jeder Vorschlag braucht eine Ideen-id; eine Pflicht-Runde `list_ideen` wäre reine Verschwendung. `list_ideen` wird darum gar nicht angeboten.

**Lese-Werkzeuge:** Teilmenge von `BOOK_CHAT_TOOLS` (`IDEEN_CHAT_READ_TOOL_NAMES`) mit den Handlern des Buch-Chats — Schwerpunkt Text (`get_pages`, `get_chapter_text`, `search_similar`, `search_passages`, `find_first_last_mention`), dazu die planenden Kataloge, an denen eine Idee hängen kann (Plot-Board, Motive, Werkstatt, Recherche) und Figuren/Szenen/Zeitstrahl/Weltregeln. Ein Name ausserhalb der Liste wirft.

## Vorschlags-Werkzeuge ([routes/jobs/ideen-chat-tools.js](../routes/jobs/ideen-chat-tools.js))

| Werkzeug | gespeicherter `type` | Inhalt |
|---|---|---|
| `propose_idee` ohne `idee_id` | `idee_create` | `content`, optional `page_id` **oder** `chapter_id` (sonst Buch-Idee); startet als «offen» |
| `propose_idee` mit `idee_id` | `idee_update` | nur geänderte Felder aus `content`, `status`, `page_id`/`chapter_id` + `before`; bei Stufen-Änderung optional `beleg` |
| `propose_idee_link` | `link_create` | `idee_id` oder `idee_ref` (neue Idee derselben Antwort), `target_kind`, `target_id` |
| `final_answer` | — | Pflicht-Endpunkt, nur `antwort` |

Regeln, die der Handler durchsetzt (Fehler gehen als `{ error }` ans Modell zurück, damit es korrigiert):
- **Nichts wird geschrieben.** Der Handler validiert gegen den Ideen-Stand der Antwort und hängt einen normalisierten Vorschlag an `ctx.proposals`.
- **Beleg-Pflicht für «erledigt»:** ohne `beleg` + `beleg_page_id` abgelehnt. **Jeder Beleg wird gegen den Abschnittstext geprüft** ([lib/quote-verify.js](../lib/quote-verify.js)#`quoteFoundIn`, tolerant gegenüber Anführungs-/Strich-/Whitespace-Varianten, «…» als Platzhalter). Ein Zitat, das dort nicht steht, wird abgelehnt — im klassischen Pfad fällt der Vorschlag heraus. **Why:** ein «erledigt» schliesst eine Pendenz, und ein halluzinierter Beleg sähe in der Vorschlagskarte genauso überzeugend aus wie ein echter.
- **Spiegel von [routes/ideen.js](../routes/ideen.js):** nur aktive Stufen des Buches; höchstens ein Anker; Anker im selben Buch; eine abgeschlossene Idee (erledigt/verworfen) bekommt keinen neuen Ort; eine Abschnitts-Idee zieht nur in einen Abschnitt um, eine Kapitel-Idee nur in ein Kapitel, eine Buch-Idee in beides. Die Route prüft beim Übernehmen erneut — der Vorschlag ist kein Schreibrecht.
- **Ziele nur aus der Zielliste** (`listIdeaLinkTargets` — verworfene Beats und archivierte Fundstücke fallen dort schon heraus); eine bestehende Kante wird nicht nochmals vorgeschlagen.
- **Kein No-Op, kein Löschen.** Statt zu löschen schlägt das Modell «verworfen» vor.
- Höchstens 40 Vorschläge pro Antwort.

Leere Antwort trotz Vorschlägen ist kein Abbruch: `__i18n:ideenBoard.chat.proposalsOnly__`.

## Übernehmen ([public/js/chat/ideen-chat-proposals.js](../public/js/chat/ideen-chat-proposals.js))

**Jeder Vorschlag einzeln**, gleiche Karte `.chat-vorschlag*` wie Abschnitts- und Plot-Chat, ohne „alle übernehmen". Je Karte: Übernehmen · Verwerfen/Wieder öffnen. Ein `beleg` steht als Zitat mit Sprung in den Abschnitt (`x-entity-ref` Typ `seite`) unter der Änderung.

- **Gleicher Schreibweg wie jede Board-Bearbeitung:** `POST /ideen`, `PATCH /ideen/:id` (Stufe, Text und Ort in **einem** Request, damit eine Idee nie halb umgezogen dasteht), `POST /ideen/:id/links`. Danach dieselben Folgeschritte wie im Board (`_replaceIdee`, `_publishCounts` für die Sidebar-Plaketten, Sortable-Neubindung).
- **Status persistieren:** `PATCH /ideen/chat-proposal`, Body und Semantik wie beim Plot-Chat — beide Routen kommen aus derselben Fabrik [routes/chat-proposal-status.js](../routes/chat-proposal-status.js), die Besitz über die Session **und** deren `kind` prüft (ein Plot-Vorschlag ist über die Ideen-Route nicht erreichbar). Die Route ist in [routes/ideen.js](../routes/ideen.js) **vor** `PATCH /:id` registriert.
- **Zustand wird gegen das Board berechnet** (`ideenProposalStatus`, pure, unit-getestet):
  - übernommen, aber die angelegte Idee ist gelöscht → wieder offen, „Erneut übernehmen";
  - Idee gelöscht, Stufe inzwischen abgeschaltet, Idee inzwischen abgeschlossen (bei Ortswechsel), Kante schon vorhanden, `idee_ref` noch nicht übernommen → blockiert mit Grund;
  - Idee seit dem Vorschlag geändert (`before` ≠ Board) → Hinweis, kein Block.

## Pflicht-Invarianten

- **Vorschläge schreiben nie** — nur der Klick des Users, über die regulären `/ideen`-Routen.
- **Kein «erledigt» ohne verifizierten Beleg.**
- **Nur eigene Ideen** — jede Lesung trägt die E-Mail des Users.
- **Nie Prosa**, **kein „alle übernehmen"**.
- **Lese-Werkzeuge nur aus `BOOK_CHAT_TOOLS`**; Gliederung nur über die Content-Store-Facade; Ideen nur über [db/ideen.js](../db/ideen.js).

Tests: [tests/unit/ideen-chat-tools.test.mjs](../tests/unit/ideen-chat-tools.test.mjs) (Handler, Kontext, klassischer Pfad), [tests/unit/ideen-chat-job.test.js](../tests/unit/ideen-chat-job.test.js) (Job beider Pfade mit gemocktem Provider), [tests/unit/ideen-chat-proposals.test.mjs](../tests/unit/ideen-chat-proposals.test.mjs) (Frontend-Zustand, Prompt), [tests/integration/ideen-chat-routes.test.js](../tests/integration/ideen-chat-routes.test.js) (Session, ACL, Status-Route).
