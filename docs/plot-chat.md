# Plot-Chat

Agentischer Chat als **Panel in der Plot-Werkstatt** (Markup [public/partials/plot-chat.html](../public/partials/plot-chat.html), per `_loadPartials`-Cascade in [plot.html](../public/partials/plot.html); Scope + Methoden aus `plotCard`). Entwickelt das Beat-Board im Gespräch — Akte, Beats, Stränge — und gründet dabei jeden Vorschlag im Board, in den Figuren (Katalog + Werkstatt mit Want/Need/Wound/Lie), im geschriebenen Text, in Szenen, Zeitstrahl und Weltregeln. **Schreibt nie selbst**: Änderungen kommen als Vorschläge, die der User **einzeln** übernimmt oder verwirft. Nie generativ in den Buchtext — Beats sind Struktur-Stichpunkte, keine Prosa (gleiche Invariante wie Brainstorm/Consistency, [plot.md](plot.md)).

**Platzierung:** ab 1280px eigene, sticky Spalte rechts neben dem Board (`.plot-split` in [book/plot/chat.css](../public/css/book/plot/chat.css)); schmaler klappt das Panel per `order: -1` über das Board. Das Board behält seinen horizontalen Scroll.

## Provider — zwei Pfade

**Jeder Provider.** `runPlotChatJobDispatch` ([routes/jobs/plot-chat.js](../routes/jobs/plot-chat.js)) wählt am effektiven Provider (`providerSupportsTools`, [lib/ai/config.js](../lib/ai/config.js)):
- **Agentisch** (Claude, openai-compat mit Werkzeugen): Tool-Loop mit Lese-Werkzeugen + `propose_*` (unten). Lokale Provider bekommen den kleineren Lese-Werkzeugsatz (`PLOT_CHAT_SLIM_READ_TOOL_NAMES`) und denselben lokalen Iterationsdeckel wie der Buch-Chat (`jobs.book_chat.max_tool_iter_local`).
- **Klassisch** (Ollama, openai-compat mit `ai.openai-compat.tools = false`, und als `fallbackJob`, wenn ein Endpunkt Function-Calling erst zur Laufzeit ablehnt — `AI_TOOLS_UNSUPPORTED`): **ein** JSON-Call ([plot-chat-classic.js](../routes/jobs/plot-chat-classic.js)). Board, Figuren und Gedächtnis stehen im Prompt wie im agentischen Pfad, dazu als Text-Grundierung die semantisch nächsten Passagen zur Frage + letzten Runde (`preContextPassages` + `retrievalQuery`, dieselbe Pipeline wie der Erst-Kontext des Buch-Chats; ohne Embedding-Index nur Board + Figuren — der Prompt sagt das). Die Antwort ist `{ antwort, vorschlaege: [{ werkzeug, …Felder }] }` (`SCHEMA_PLOT_CHAT_CLASSIC`, Feldnamen aus den Werkzeug-Schemas abgeleitet), und **jeder Eintrag läuft durch dieselben Handler** wie ein Werkzeug-Aufruf. Was dort abgelehnt würde, fällt still heraus (`context_info.rejected` zählt es) — es gibt keine Runde zum Korrigieren. Leere Werte (`""`, `0`, `null`), die Constrained Decoding gern mitschickt, werden vorher entfernt.

Beide Pfade schreiben dasselbe `context_info.proposals`; das Frontend unterscheidet sie nicht.

## Datenmodell

Keine neue Tabelle: Sessions in `chat_sessions` mit **`kind='plot'`** (Migration 297, buchweit, `page_id IS NULL`), Nachrichten in `chat_messages`. `context_info.proposals` trägt die Vorschläge samt Status. Buch-ACL **editor** (wie die Plot-Werkstatt) für Session, Job und Status-Route.

## Agentischer Job ([routes/jobs/plot-chat.js](../routes/jobs/plot-chat.js))

Geteilter agentischer Loop ([agentic-chat.js](../routes/jobs/agentic-chat.js), `makeAgenticChatJob`). Cap `jobs.plot_chat.max_tool_iter` (Default 8, Admin → Jobs) — Vorschlags-Aufrufe zählen als Runden mit.

**System-Prompt** ([prompts/plot-chat.js](../public/js/prompts/plot-chat.js)#`buildPlotChatSystemPrompt`), zwei Cache-Blöcke:
- Block 1 (`ttl: '1h'`): Dramaturgen-Rolle, Vorschlags-Regeln, Werkzeug-Strategie, Sprachnorm + Buch-Kontext (`getResearchPromptContext`: Buchtyp, Autoren-Angaben, Hauptland).
- Block 2 (`cache: false`): **das ganze Board als Text-Gliederung** mit `[#id]`-Markern (`boardOutline`, [plot-chat-context.js](../routes/jobs/plot-chat-context.js)), die Figurenliste mit `fig_id` bzw. Werkstatt-Kennung, der Gedächtnis-Block früherer Vorschläge (übernommen / verworfen / offen) und — mit Embedding-Endpunkt — der **Erst-Kontext** `TEXTPASSAGEN`: die semantisch nächsten Stellen zur Frage + letzten Runde (`agentPreContext` in [book-chat-retrieval.js](../routes/jobs/chat/book-chat-retrieval.js), dieselben Settings `jobs.book_chat.pre_rag_*` wie der Buch-Chat, Nachbar-Chunks inklusive). Volatil, weil jede Übernahme und jede Frage ihn ändert — darum ohne Breakpoint und am Ende, damit Werkzeuge + Block 1 ein stabiler Cache-Präfix bleiben. `context_info.pre_context = {count, chars}`.

**Warum das Board im Prompt steht:** der Chat lebt neben dem Board, und jeder Vorschlag braucht ids. Eine Pflicht-Runde `get_plot_board` pro Frage wäre reine Verschwendung; das Werkzeug bleibt für Rückfragen angeboten.

**Lese-Werkzeuge:** Teilmenge von `BOOK_CHAT_TOOLS` (`PLOT_CHAT_READ_TOOL_NAMES`) mit den Handlern des Buch-Chats ([routes/jobs/book-chat-tools/](../routes/jobs/book-chat-tools/)) — Board, Kapitel, Figuren + Beziehungen, Szenen, Orte, Zeitstrahl, Alter, Welt-Fakten, Werkstatt-Figuren, Motive, Text-Suche (`search_similar` nur mit Embedding-Endpunkt), Kapitel-/Seitentext, Ideen, Kontinuitätsbefunde, Reviews. Ohne Stil-/Lektorat-/Revisions-/Bild-Werkzeuge. Ein Name ausserhalb der angebotenen Liste wirft (`executePlotChatTool`).

## Vorschlags-Werkzeuge ([routes/jobs/plot-chat-tools.js](../routes/jobs/plot-chat-tools.js))

| Werkzeug | gespeicherter `type` | Inhalt |
|---|---|---|
| `propose_beat` ohne `beat_id` | `beat_create` | Akt (`act_id` oder `act_ref`), Strang (`thread_id`/`thread_ref`/keiner), Position (`after_beat_id`/`at_start`), Felder Titel, Beschreibung, Spannung, Zeit, Kapitel, Figuren |
| `propose_beat` mit `beat_id` | `beat_update` | nur geänderte Felder (inkl. `verworfen`) + `before` (Vorher-Werte) |
| `propose_beat_move` | `beat_move` | Ziel-Akt/-Strang (`ohne_strang`), Position, `before` (alte Zelle) |
| `propose_act` | `act_create` / `act_update` | Name, optional strang-eigener Akt, Position (`after_act_id`/`at_start`) bzw. Umbenennung |
| `propose_thread` | `thread_create` / `thread_update` | Name, Hauptfigur (Katalog oder Werkstatt) |
| `final_answer` | — | Pflicht-Endpunkt, nur `antwort` |

Regeln, die der Handler durchsetzt (Fehler kommen als `{ error }` ans Modell zurück, damit es korrigiert — das Frontend sieht nur Vorschläge, die beim Erzeugen gültig waren):
- **Nichts wird geschrieben.** Der Handler validiert gegen den Board-Stand der Antwort und hängt einen normalisierten Vorschlag an `ctx.proposals`.
- **ids gegen (Buch, User):** Akt, Strang, Beat, Kapitel (aus der Content-Store-Facade, inkl. ausgeschlossener Kapitel), Figuren (Name, Kurzname oder `fig_id`; Werkstatt-Figur über den Namen). Unbekanntes → Fehler, kein stilles Weglassen.
- **Hybrid-Akt-Regel** wie in [routes/plot.js](../routes/plot.js)#`_actFitsThread`: ein Beat sitzt auf einem geteilten Akt oder einem Akt seines Strangs — auch gegen den vorgeschlagenen `thread_id` eines neuen Akts.
- **`after_beat_id` muss in der Zielzelle liegen.**
- **Kein No-Op:** eine Änderung, die nichts ändert, oder eine Verschiebung ohne Bewegung wird abgelehnt. `propose_beat` mit `beat_id` verschiebt nie (dafür `propose_beat_move`).
- **Kein Löschen.** Statt zu löschen schlägt das Modell „verwerfen" vor.
- **Referenzen innerhalb einer Antwort:** jeder Vorschlag bekommt `ref` (= Index + 1); `act_ref`/`thread_ref` zeigen auf einen `act_create`/`thread_create` derselben Antwort. So entsteht eine neue Aktstruktur samt Beats in einem Zug.
- Höchstens 30 Vorschläge pro Antwort.

Leere Antwort trotz Vorschlägen ist kein Abbruch: `__i18n:plot.chat.proposalsOnly__`.

## Übernehmen ([public/js/chat/plot-chat-proposals.js](../public/js/chat/plot-chat-proposals.js))

**Jeder Vorschlag einzeln** — wie die Änderungsvorschläge des Abschnitts-Chats (gleiche Karte `.chat-vorschlag*`), bewusst ohne „alle übernehmen". Je Karte: Übernehmen · Verwerfen/Wieder öffnen · nach dem Übernehmen „Im Board zeigen".

- **Gleicher Schreibweg wie jede Board-Bearbeitung:** die Übernahme ruft die normalen `/plot`-Routen (`POST /plot/beats`, `PATCH /plot/beats/:id`, `PUT /plot/beats/order`, `POST /plot/acts`, …) und schreibt dieselben Undo-Records ([book/plot/history.js](../public/js/book/plot/history.js)): neu angelegt → `create-*`, geändert → `*-fields`, verschoben → `beat-place`. **Cmd/Ctrl+Z macht eine Übernahme rückgängig.** Die Server-Validierung der Routen gilt unverändert — der Vorschlag ist kein Schreibrecht.
- **Status persistieren:** `PATCH /plot/chat-proposal` ([routes/plot-chat-proposals.js](../routes/plot-chat-proposals.js), Logik in der mit dem Ideen-Chat geteilten Fabrik [routes/chat-proposal-status.js](../routes/chat-proposal-status.js)), Body `{ message_id, index, action: 'applied'|'discarded'|'reopen', applied_id? }` → `applied_at` + `applied_id` bzw. `status='discarded'` am Vorschlag (Lesen + Schreiben in einer Transaktion). Besitz über die Session, nur `kind='plot'`, Buch-ACL editor. Verwerfen eines übernommenen Vorschlags → `409 PROPOSAL_ALREADY_APPLIED`.
- **Zustand wird gegen das Board berechnet, nicht nur gelesen** (`proposalStatus`, pure, unit-getestet):
  - übernommen, aber das Angelegte ist weg (Undo, gelöscht) → wieder offen, „Erneut übernehmen";
  - Ziel (Beat/Akt/Strang) gelöscht → blockiert mit Grund;
  - `act_ref`/`thread_ref`, deren Akt/Strang noch nicht übernommen ist → blockiert („Übernimm zuerst den neuen Akt …");
  - Beat seit dem Vorschlag geändert (`before` ≠ Board) → Hinweis, kein Block; übernommen werden nur die gezeigten Felder.
- Beat-Änderungen zeigen Feld für Feld vorher → nachher, Titel/Beschreibung als Wort-Diff ([word-diff.js](../public/js/chat/word-diff.js), geteilt mit dem Abschnitts-Chat).

## Pflicht-Invarianten

- **Vorschläge schreiben nie** — nur der Klick des Users, über die regulären `/plot`-Routen. Kein Server-Endpunkt wendet einen Vorschlag an.
- **Nie Prosa:** Prompt verbietet Szenen/Dialoge/Romantext; Beats bleiben Stichpunkte.
- **Kein „alle übernehmen".**
- **Lese-Werkzeuge nur aus `BOOK_CHAT_TOOLS`** — keine Kopie eines Board-/Figuren-/Text-Lesers.
- **Content-Store-Facade** für Kapitel; Plot-Tabellen nur über [db/plot.js](../db/plot.js).
