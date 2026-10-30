# Ideen-Chat

Chat als **Panel im Ideen-Board** (Markup [public/partials/ideen-chat.html](../public/partials/ideen-chat.html), per `_loadPartials`-Cascade in [ideen-board.html](../public/partials/ideen-board.html); Scope + Methoden aus `ideenBoardCard`). Arbeitet die Ideen und Pendenzen eines Buches im Gespräch durch. Kern sind zwei Aufgaben, die keine andere Funktion übernimmt:

- **Erledigt-Check:** offene Pendenzen gegen den aktuellen Text prüfen. Löst der Text eine ein, schlägt der Chat «erledigt» vor und zitiert die Stelle.
- **Orte finden:** Buch-Ideen ohne Anker einen Abschnitt oder ein Kapitel zuordnen, an dem sie sich einlösen lassen.

Dazu Dubletten zusammenführen, Verknüpfungen zu Beat, Strang, Motiv, Werkstatt-Figur oder Recherche-Fundstück vorschlagen und auf Wunsch neue Ideen festhalten. **Schreibt nie selbst**: Änderungen kommen als Vorschläge, die der User **einzeln** übernimmt oder verwirft. Nie generativ in den Buchtext — eine Idee ist ein Stichpunkt.

**Platzierung:** wie der Plot-Chat — ab 1280px eigene, sticky Spalte rechts neben dem Board (`.ideen-split` in [entities/ideen-chat.css](../public/css/entities/ideen-chat.css)), schmaler steht das Panel per `order: -1` über dem Board. Das leere Gespräch bietet drei Schnellstart-Aufträge (Erledigt-Check, Orte, Dubletten). Hängen mindestens `IDEEN_CHECK_MIN` (5, [ideen-shared.js](../public/js/book/ideen-shared.js)) offene Ideen an Abschnitten oder Kapiteln und ist das Panel zu, steht über der Board-Toolbar ein [Feature-Tipp](../DESIGN.md#feature-tipp), der das Panel öffnet und den Erledigt-Check in einem neuen Gespräch startet (`startIdeenErledigtCheck`). **Why:** wer Ideen als Szenenplan pro Kapitel führt, hakt sie selten von Hand ab — gerade dort lohnt der Abgleich mit dem Text.

Gliederung und Ideenliste im Prompt tragen den Bearbeitungsstand je Abschnitt; offene Pendenzen an fertigen Abschnitten prüft der Chat zuerst ([bearbeitungsstand.md](bearbeitungsstand.md#fertig-aber-offene-pendenzen)).

## Provider — zwei Pfade

Gleiche Aufteilung wie im Plot-Chat ([plot-chat.md](plot-chat.md#provider--zwei-pfade)): `runIdeenChatJobDispatch` ([routes/jobs/ideen-chat.js](../routes/jobs/ideen-chat.js)) wählt am effektiven Provider. **Agentisch** mit Lese-Werkzeugen + `propose_*`, lokale Provider mit dem kleineren Satz (Spalte `ideen` = `slim` in [prompts/chat-tools/access.js](../public/js/prompts/chat-tools/access.js)) und dem lokalen Iterationsdeckel des Buch-Chats. **Klassisch** (`runClassic` aus dem gemeinsamen Gerüst [proposal-chat.js](../routes/jobs/proposal-chat.js), auch als `fallbackJob` bei `AI_TOOLS_UNSUPPORTED`): ein JSON-Call `{ antwort, vorschlaege: [{ werkzeug, …Felder }] }` (`SCHEMA_IDEEN_CHAT_CLASSIC`), jeder Eintrag läuft durch dieselben Handler; Abgelehntes fällt still heraus und zählt in `context_info.rejected`. Leere Werte (`""`, `0`, `null`, `[]`) heissen in **beiden** Pfaden «nicht angegeben» (`cleanProposalInput`, [proposal-chat-shared.js](../routes/jobs/proposal-chat-shared.js)); einen Ort entfernt nur `anker_loesen`. Vor dem Call prüft der klassische Pfad das Input-Budget: erst fallen die Textpassagen, dann der älteste Verlauf. Ohne Werkzeuge sieht das Modell nur die semantisch nächsten Passagen zur Frage — der Prompt erlaubt «erledigt» dort nur, wenn die einlösende Stelle in diesen Passagen steht.

## Datenmodell

Keine neue Tabelle: Sessions in `chat_sessions` mit **`kind='ideen'`** (Migration 319, buchweit, `page_id IS NULL`), Nachrichten in `chat_messages`, Vorschläge samt Status in `context_info.proposals`. Buch-ACL **editor** (wie das Ideen-Board) für Session, Job und Status-Route. Ideen sind user-privat — der Chat sieht ausschliesslich die Ideen des fragenden Users (alle Lesungen laufen über [db/ideen.js](../db/ideen.js), das `user_email` erzwingt).

## Agentischer Job

Geteilter Loop [agentic-chat/](../routes/jobs/agentic-chat/) (`makeAgenticChatJob`). Cap `jobs.ideen_chat.max_tool_iter` (Default 8, Admin → Jobs) — Vorschlags-Aufrufe zählen mit.

**Prompt** ([prompts/ideen-chat.js](../public/js/prompts/ideen-chat.js)#`buildIdeenChatSystemPrompt`), zwei Blöcke — Aufteilung wie im Plot-Chat ([plot-chat.md](plot-chat.md#agentischer-job-routesjobsplot-chatjs)):
- **System-Prompt** (`ttl: '1h'`): Rolle, die vier Aufgaben, Beleg-Pflicht, Werkzeug-Strategie, Sprachnorm + Buch-Kontext.
- **Vorspann der Frage** (`preamble: true`, steht vor der Frage in der aktuellen User-Nachricht, persistiert wird nur die Frage): aktive Stufen des Buches, **die Ideen** in Buch-Reihenfolge mit `[#id]` (Buch-Ideen zuerst, dann je Kapitel seine und die seiner Abschnitte; was der Baum nicht kennt, steht in einer Sammelgruppe — nie verschwindet eine still), die **Gliederung** mit `chapter#`/`page#`-ids, die **verknüpfbaren Ziele** (je Art gedeckelt, Kappung ausgewiesen), das Gedächtnis früherer Vorschläge und — mit Embedding-Endpunkt — der Erst-Kontext `TEXTPASSAGEN` (Kopfzeilen mit `kind`, `entity_id` = page_id, Kapitelpfad, Rang + Ähnlichkeit, Status-Hinweis bei unvollständigem Index — wie im Plot-Chat, [prompts/chat-pre-context.js](../public/js/prompts/chat-pre-context.js)). Kontext-Bau: [ideen-chat-context.js](../routes/jobs/ideen-chat-context.js). Gliederung nur über die Content-Store-Facade (`loadOrderedBookContents`, inkl. ausgeschlossener Kapitel).

**Deckel der Ideenliste** (`fitIdeenOutline`): 15 % des Input-Budgets des effektiven Providers (mindestens 6000 Zeichen). Passt die volle Liste nicht, stufenweise kürzere Vorschau der offenen Ideen, abgeschlossene (erledigt/verworfen) nur noch als Zahl je Gruppe; reicht auch das nicht, harter Schnitt mit Hinweis. Ist die Liste gekürzt, sagt der Vorspann das (Werkzeug-Hinweis nur, wenn eines angeboten wird).

**Warum die Ideen im Vorspann stehen:** jeder Vorschlag braucht eine Ideen-id; eine Pflicht-Runde `list_ideen` wäre reine Verschwendung. `list_ideen` wird darum gar nicht angeboten.

**Lese-Werkzeuge:** aus dem gemeinsamen Katalog ([chat-tools.md](chat-tools.md), Spalte `ideen` in [prompts/chat-tools/access.js](../public/js/prompts/chat-tools/access.js)) — Schwerpunkt Text (`get_pages`, `get_chapter_text`, `search_similar`, `search_passages`, `quote_passage` zum Absichern eines Belegs, `get_figure_mentions`/`list_locations` für erste und letzte Erwähnung), dazu die planenden Kataloge, an denen eine Idee hängen kann (Plot-Board, Motive, Werkstatt, Recherche-Archiv inkl. Passagen-Suche) und Figuren/Szenen/Zeitstrahl/Weltregeln, dazu die schon erhobenen Befunde (Kontinuität, Bewertung, Doppelungen aus `list_redundancies`). Was im Buch keine Daten hat, wird nicht angeboten; ein Name ausserhalb der angebotenen Liste wirft.

## Vorschlags-Werkzeuge ([routes/jobs/ideen-chat-tools.js](../routes/jobs/ideen-chat-tools.js))

| Werkzeug | gespeicherter `type` | Inhalt |
|---|---|---|
| `propose_idee` ohne `idee_id` | `idee_create` | `content`, optional `page_id` **oder** `chapter_id` (sonst Buch-Idee); startet als «offen» |
| `propose_idee` mit `idee_id` | `idee_update` | nur geänderte Felder aus `content`, `status`, `page_id`/`chapter_id` + `before`; bei Stufen-Änderung optional `beleg` |
| `propose_idee` mit `idee_id` + `anker_loesen` | `idee_update` | «Anker lösen»: `page_id` **und** `chapter_id` = `null` — die offene Idee wird wieder Buch-Idee |
| `propose_idee_link` | `link_create` | `idee_id` oder `idee_ref` (neue Idee derselben Antwort), `target_kind`, `target_id` |
| `final_answer` | — | Pflicht-Endpunkt, nur `antwort` |

Regeln, die der Handler durchsetzt (Fehler gehen als `{ error }` ans Modell zurück, damit es korrigiert):
- **Nichts wird geschrieben.** Der Handler validiert gegen den Ideen-Stand der Antwort und hängt einen normalisierten Vorschlag an `ctx.proposals`.
- **Beleg-Pflicht für «erledigt»:** ohne `beleg` + `beleg_page_id` abgelehnt. **Jeder Beleg wird gegen den Abschnittstext geprüft** ([lib/quote-verify.js](../lib/quote-verify.js)#`quoteFoundIn`, tolerant gegenüber Anführungs-/Strich-/Whitespace-Varianten, «…» als Platzhalter). Heuhaufen ist **derselbe Text, den das Modell liest** (`pageQuoteHaystack` = `htmlToText` wie in `get_pages`/`get_chapter_text`: Satzzeichen hinter Inline-Tags ohne Leerzeichen, Tabellen als Kurzform mit Kopf, Nachrichtenverläufe mit Marken) — sonst fiele ein wörtlich übernommenes Zitat durch. Ein Zitat, das dort nicht steht, wird abgelehnt — im klassischen Pfad fällt der Vorschlag heraus. **Why:** ein «erledigt» schliesst eine Pendenz, und ein halluzinierter Beleg sähe in der Vorschlagskarte genauso überzeugend aus wie ein echter.
- **Spiegel von [routes/ideen.js](../routes/ideen.js):** nur aktive Stufen des Buches; höchstens ein Anker; Anker im selben Buch; eine abgeschlossene Idee (erledigt/verworfen) bekommt keinen neuen Ort; eine offene Idee zieht an jeden Abschnitt oder jedes Kapitel um, auch quer zwischen beiden (der neue Anker leert den alten). Die Route prüft beim Übernehmen erneut — der Vorschlag ist kein Schreibrecht.
- **Ziele nur aus der Zielliste** (`listIdeaLinkTargets` — verworfene Beats und archivierte Fundstücke fallen dort schon heraus); eine bestehende Kante wird nicht nochmals vorgeschlagen.
- **Anker lösen** nur für eine offene Idee mit Ort, nie zusammen mit einem neuen Ort und nie für eine neue Idee.
- **Kein No-Op, kein Löschen.** Statt zu löschen schlägt das Modell «verworfen» vor.
- **Keine Dublette in einer Antwort:** dieselbe neue Idee (Ort + Text ohne Gross/Klein, `ideeProposalKey` aus [lib/chat-idee-proposals.js](../lib/chat-idee-proposals.js), wie bei den Ideen-Vorschlägen aus Abschnitts- und Buch-Chat) wird nur einmal gesammelt; der zweite Aufruf bekommt den `ref` des ersten.
- Höchstens 40 Vorschläge pro Antwort.

Leere Antwort trotz Vorschlägen ist kein Abbruch: `__i18n:ideenBoard.chat.proposalsOnly__`. Endet der Lauf ohne `final_answer` (Iterationen erschöpft, Synthese ohne Antwort), stehen die gesammelten Vorschläge mit `__i18n:ideenBoard.chat.proposalsCut__` da statt hinter einer Fehlermeldung.

**Gedächtnis** früherer Vorschläge (`sessionIdeenProposalMemory`, geteilte Logik in [proposal-chat-shared.js](../routes/jobs/proposal-chat-shared.js), Textform [prompts/proposal-memory.js](../public/js/prompts/proposal-memory.js)): übernommen / verworfen / offen — und «übernommen, danach gelöscht», wenn die mit einem `idee_create` angelegte Idee nicht mehr existiert.

## Übernehmen ([public/js/chat/ideen-chat-proposals.js](../public/js/chat/ideen-chat-proposals.js))

**Jeder Vorschlag einzeln**, gleiche Karte `.chat-vorschlag*` wie Abschnitts- und Plot-Chat, ohne „alle übernehmen". Je Karte: Übernehmen · Verwerfen/Wieder öffnen. Ein `beleg` steht als Zitat mit Sprung in den Abschnitt (`x-entity-ref` Typ `seite`) unter der Änderung, beschriftet «beim Vorschlag geprüft».

- **Gleicher Schreibweg wie jede Board-Bearbeitung:** `POST /ideen`, `PATCH /ideen/:id` (Stufe, Text und Ort in **einem** Request, damit eine Idee nie halb umgezogen dasteht), `POST /ideen/:id/links`. Danach dieselben Folgeschritte wie im Board (`_replaceIdee`, `_publishCounts` für die Sidebar-Plaketten, Sortable-Neubindung).
- **Beleg beim Übernehmen erneut prüfen:** vor einem «erledigt» fragt das Frontend `POST /ideen/chat-proposal/beleg-check` (`{ message_id, index }` → `{ checked, found }`, [routes/ideen-chat-proposals.js](../routes/ideen-chat-proposals.js), nur `kind='ideen'`, Buch-ACL editor). Der Server lädt den Abschnitt frisch und prüft mit derselben Normalisierung wie beim Vorschlagen (`belegInPage`). Steht das Zitat nicht mehr im Text, trägt die Karte statt «beim Vorschlag geprüft» den Hinweis «Beleg nicht mehr im Text» (transient `_belegMissing`) und übernommen wird nur nach `appConfirm`. Scheitert die Prüfung (offline, Server), wird nicht übernommen.
- **Anker lösen** schreibt `PATCH /ideen/:id` mit `page_id: null, chapter_id: null`; die Route macht daraus eine Buch-Idee.
- **Status persistieren:** `PATCH /ideen/chat-proposal`, Body und Semantik wie beim Plot-Chat — beide Routen kommen aus derselben Fabrik [routes/chat-proposal-status.js](../routes/chat-proposal-status.js), die Besitz über die Session **und** deren `kind` prüft (ein Plot-Vorschlag ist über die Ideen-Route nicht erreichbar). Montiert über [routes/ideen-chat-proposals.js](../routes/ideen-chat-proposals.js) in [routes/ideen.js](../routes/ideen.js) **vor** `PATCH /:id`. Ein schon übernommener Vorschlag → `409 PROPOSAL_ALREADY_APPLIED` mit dem gespeicherten Vorschlag im Body, ausser die mit einem `idee_create` angelegte Idee existiert nicht mehr (`ideenAppliedExists`) — dann ist erneutes Übernehmen erlaubt. Gilt genauso für die Ideen-Vorschläge aus Abschnitts- und Buch-Chat ([public/js/chat/chat-idee-proposals.js](../public/js/chat/chat-idee-proposals.js)).
- **Kein Doppel-Schreiben:** Übernehmen läuft über `applyProposalOnce` ([public/js/chat/proposal-status.js](../public/js/chat/proposal-status.js), geteilt mit Plot-Chat und den Ideen-Vorschlägen aus Abschnitts- und Buch-Chat). Scheitert nur der Status-PATCH, merkt sich der Vorschlag das Geschriebene (transient `_written`/`_appliedId`) und der nächste Klick holt nur den Status nach. Ein 409 `PROPOSAL_ALREADY_APPLIED` gilt als Stand: der gespeicherte Vorschlag wird übernommen.
- **Zustand wird gegen das Board berechnet** (`ideenProposalStatus`, pure, unit-getestet):
  - übernommen, aber die angelegte Idee ist gelöscht → wieder offen, „Erneut übernehmen";
  - Idee gelöscht, Stufe inzwischen abgeschaltet, Idee inzwischen abgeschlossen (bei Ortswechsel), Kante schon vorhanden, `idee_ref` noch nicht übernommen → blockiert mit Grund;
  - Idee seit dem Vorschlag geändert (`before` ≠ Board) → Hinweis, kein Block.

## Pflicht-Invarianten

- **Vorschläge schreiben nie** — nur der Klick des Users, über die regulären `/ideen`-Routen.
- **Kein «erledigt» ohne verifizierten Beleg** — beim Vorschlagen und beim Übernehmen gegen denselben Text, den das Modell liest.
- **Nur eigene Ideen** — jede Lesung trägt die E-Mail des Users.
- **Nie Prosa**, **kein „alle übernehmen"**.
- **Lese-Werkzeuge nur aus dem gemeinsamen Katalog** ([routes/jobs/chat-tools/CLAUDE.md](../routes/jobs/chat-tools/CLAUDE.md)); Gliederung nur über die Content-Store-Facade; Ideen nur über [db/ideen.js](../db/ideen.js).

Tests: [tests/unit/ideen-chat-tools.test.mjs](../tests/unit/ideen-chat-tools.test.mjs) (Handler, Kontext, klassischer Pfad), [tests/unit/ideen-chat-job.test.js](../tests/unit/ideen-chat-job.test.js) (Job beider Pfade mit gemocktem Provider), [tests/unit/ideen-chat-proposals.test.mjs](../tests/unit/ideen-chat-proposals.test.mjs) (Frontend-Zustand, Prompt), [tests/unit/chat-idee-proposals-apply.test.mjs](../tests/unit/chat-idee-proposals-apply.test.mjs) (Übernehmen ohne Duplikat, 409, Vorspann-Form), [tests/integration/ideen-chat-routes.test.js](../tests/integration/ideen-chat-routes.test.js) (Session, ACL, Status-Route, Beleg-Prüfung).
