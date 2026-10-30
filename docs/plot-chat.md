# Plot-Chat

Agentischer Chat als **Panel in der Plot-Werkstatt** (Markup [public/partials/plot-chat.html](../public/partials/plot-chat.html), per `_loadPartials`-Cascade in [plot.html](../public/partials/plot.html); Scope + Methoden aus `plotCard`). Entwickelt das Beat-Board im Gespräch — Akte, Beats, Stränge — und gründet dabei jeden Vorschlag im Board, in den Figuren (Katalog + Werkstatt mit Want/Need/Wound/Lie), im geschriebenen Text, in Szenen, Zeitstrahl und Weltregeln. **Schreibt nie selbst**: Änderungen kommen als Vorschläge, die der User **einzeln** übernimmt oder verwirft. Nie generativ in den Buchtext — Beats sind Struktur-Stichpunkte, keine Prosa (gleiche Invariante wie Brainstorm/Consistency, [plot.md](plot.md)).

**Platzierung:** ab 1280px eigene, sticky Spalte rechts neben dem Board (`.plot-split` in [book/plot/chat.css](../public/css/book/plot/chat.css)); schmaler klappt das Panel per `order: -1` über das Board. Das Board behält seinen horizontalen Scroll.

Liest den Bearbeitungsstand über `get_edit_status` (ein Beat in einem fertigen Kapitel heisst Umbau, [bearbeitungsstand.md](bearbeitungsstand.md)).

## Provider — zwei Pfade

**Jeder Provider.** `runPlotChatJobDispatch` ([routes/jobs/plot-chat.js](../routes/jobs/plot-chat.js)) wählt am effektiven Provider (`providerSupportsTools`, [lib/ai/config.js](../lib/ai/config.js)):
- **Agentisch** (Claude, openai-compat mit Werkzeugen): Tool-Loop mit Lese-Werkzeugen + `propose_*` (unten). Lokale Provider bekommen den kleineren Lese-Werkzeugsatz (Spalte `plot` = `slim` in [prompts/chat-tools/access.js](../public/js/prompts/chat-tools/access.js)) und denselben lokalen Iterationsdeckel wie der Buch-Chat (`jobs.book_chat.max_tool_iter_local`); Runden- und Kosten-Deckel wie in allen agentischen Chats ([agentic-chat/limits.js](../routes/jobs/agentic-chat/limits.js)).
- **Klassisch** (Ollama, openai-compat mit `ai.openai-compat.tools = false`, und als `fallbackJob`, wenn ein Endpunkt Function-Calling erst zur Laufzeit ablehnt — `AI_TOOLS_UNSUPPORTED`): **ein** JSON-Call (`runClassic` in [proposal-chat.js](../routes/jobs/proposal-chat.js), dem gemeinsamen Gerüst von Plot- und Ideen-Chat; [plot-chat.js](../routes/jobs/plot-chat.js) liefert nur Board-Kontext und Prompt-Bausteine). Board, Figuren und Gedächtnis stehen im Prompt wie im agentischen Pfad, dazu als Text-Grundierung die semantisch nächsten Passagen zur Frage + letzten Runde (`preContextPassages` + `retrievalQuery`, dieselbe Pipeline wie der Erst-Kontext des Buch-Chats; ohne Embedding-Index nur Board + Figuren — der Prompt sagt das). Die Antwort ist `{ antwort, vorschlaege: [{ werkzeug, …Felder }] }` (`SCHEMA_PLOT_CHAT_CLASSIC`, Feldnamen aus den Werkzeug-Schemas abgeleitet), und **jeder Eintrag läuft durch dieselben Handler** wie ein Werkzeug-Aufruf. Was dort abgelehnt würde, fällt still heraus (`context_info.rejected` zählt es) — es gibt keine Runde zum Korrigieren. Vor dem Call prüft der klassische Pfad das Input-Budget: erst fallen die Textpassagen, dann der älteste Verlauf (der Verlauf beginnt danach wieder mit einer User-Nachricht).

**Eingaben sind in beiden Pfaden gleich:** leere Werte (`""`, `0`, `null`, `[]`), die Constrained Decoding gern mitschickt und Modelle in optionale Felder schreiben, heissen «nicht angegeben» und werden vor jedem Vorschlags-Handler entfernt (`cleanProposalInput`, [proposal-chat-shared.js](../routes/jobs/proposal-chat-shared.js)). Geleert wird ein Feld nur ausdrücklich über `leeren`.

Beide Pfade schreiben dasselbe `context_info.proposals`; das Frontend unterscheidet sie nicht.

## Datenmodell

Keine neue Tabelle: Sessions in `chat_sessions` mit **`kind='plot'`** (Migration 297, buchweit, `page_id IS NULL`), Nachrichten in `chat_messages`. `context_info.proposals` trägt die Vorschläge samt Status. Buch-ACL **editor** (wie die Plot-Werkstatt) für Session, Job und Status-Route.

## Agentischer Job ([routes/jobs/plot-chat.js](../routes/jobs/plot-chat.js))

Geteilter agentischer Loop ([agentic-chat/](../routes/jobs/agentic-chat/), `makeAgenticChatJob`). Cap `jobs.plot_chat.max_tool_iter` (Default 8, Admin → Jobs) — Vorschlags-Aufrufe zählen als Runden mit.

**Prompt** ([prompts/plot-chat.js](../public/js/prompts/plot-chat.js)#`buildPlotChatSystemPrompt`), zwei Blöcke:
- **System-Prompt** (`ttl: '1h'`): Dramaturgen-Rolle, Vorschlags-Regeln, Werkzeug-Strategie, Sprachnorm + Buch-Kontext (`getResearchPromptContext`: Buchtyp, Autoren-Angaben, Hauptland).
- **Vorspann der Frage** (`preamble: true`): [proposal-chat.js](../routes/jobs/proposal-chat.js) stellt ihn als `userPreamble` vor die Frage in die aktuelle User-Nachricht (Muster des Buch-Chat-Erst-Kontexts, `=== FRAGE ===` trennt), mit `cacheHistory` — so bleiben Werkzeuge + System + Verlauf ein stabiler Cache-Präfix, persistiert wird nur die Frage; der klassische Pfad baut die User-Nachricht genauso. Inhalt: **das Board als Text-Gliederung** mit `[#id]`-Markern (`fitBoardOutline`, [plot-chat-context.js](../routes/jobs/plot-chat-context.js)) samt Reihenfolge-Regel, die Figurenliste mit Kennung (`fig_id` bzw. `draft#<id>` für Werkstatt-Figuren), der Gedächtnis-Block früherer Vorschläge (übernommen / verworfen / offen) und — mit Embedding-Endpunkt — der **Erst-Kontext** `TEXTPASSAGEN`: die semantisch nächsten Stellen zur Frage + letzten Runde (`agentPreContext` in [book-chat-retrieval.js](../routes/jobs/chat/book-chat-retrieval.js), dieselben Settings `jobs.book_chat.pre_rag_*` wie der Buch-Chat, Nachbar-Chunks inklusive; je Passage `kind`, `entity_id` = page_id für `get_pages`, Kapitelpfad, Rang + Ähnlichkeit, plus Status-Hinweis bei unvollständigem Index oder ausgefallener Suche — Bausteine aus [prompts/chat-pre-context.js](../public/js/prompts/chat-pre-context.js), geteilt mit Buch- und Ideen-Chat). Volatil, weil jede Übernahme und jede Frage ihn ändert. `context_info.pre_context = {count, chars}`.

**Board-Gliederung = Lesereihenfolge der Analyse:** Blöcke aus [lib/plot-reading-order.js](../lib/plot-reading-order.js)#`laneReadingOrder` (SSoT; gleiche Regel wie `plotReadingBlocks` der Brainstorm-/Consistency-Prompts) — geteilte Akte, danach je Strang mit eigener Aktstruktur ein beschrifteter Block. Beats eines Akts nach Lane-Rang (Strang-Reihenfolge, «ohne Strang» zuletzt), dann `sort_order`. Die Reihenfolge-Regel kommt aus [prompts/plot/board.js](../public/js/prompts/plot/board.js)#`_reihenfolgeRegel`: bei Hybrid-Akten gilt die Reihenfolge nur innerhalb eines Blocks, über Blockgrenzen hinweg keine.

**Deckel der Board-Gliederung:** 15 % des Input-Budgets des effektiven Providers (mindestens 6000 Zeichen). Passt das volle Board nicht, stufenweise kürzere Beschreibungen (300 → 120 → keine), verworfene Beats nur noch als Zahl je Akt; reicht auch das nicht, harter Schnitt mit Hinweis. Ist das Board gekürzt, sagt der Vorspann das und verweist — nur wenn angeboten — auf `get_plot_board`.

**Warum das Board im Vorspann steht:** der Chat lebt neben dem Board, und jeder Vorschlag braucht ids. Eine Pflicht-Runde `get_plot_board` pro Frage wäre reine Verschwendung; das Werkzeug bleibt für Rückfragen angeboten.

**Lese-Werkzeuge:** aus dem gemeinsamen Katalog ([chat-tools.md](chat-tools.md), Spalte `plot` in [prompts/chat-tools/access.js](../public/js/prompts/chat-tools/access.js), Handler [routes/jobs/chat-tools/](../routes/jobs/chat-tools/)) — Board, Kapitel, Figuren + Beziehungen, Szenen, Orte, Zeitstrahl, Alter, Welt-Fakten, Werkstatt-Figuren, Motive, Text-Suche (`search_similar` nur mit Embedding-Endpunkt), Kapitel-/Seitentext, Ideen, Kontinuitätsbefunde, Reviews. Ohne Stil-/Lektorat-/Revisions-/Bild-Werkzeuge. Was im Buch keine Daten hat (z.B. noch kein Board, keine Motive), wird nicht angeboten; ein Name ausserhalb der angebotenen Liste wirft (`executePlotChatTool`).

## Vorschlags-Werkzeuge ([routes/jobs/plot-chat-tools.js](../routes/jobs/plot-chat-tools.js))

| Werkzeug | gespeicherter `type` | Inhalt |
|---|---|---|
| `propose_beat` ohne `beat_id` | `beat_create` | Akt (`act_id` oder `act_ref`), Strang (`thread_id`/`thread_ref`/keiner), Position (`after_beat_id`/`at_start`), Felder Titel, Beschreibung, Spannung, Zeit, Kapitel, Figuren |
| `propose_beat` mit `beat_id` | `beat_update` | nur geänderte Felder (inkl. `verworfen`) + `before` (Vorher-Werte); `leeren` (`beschreibung`, `zeit`, `kapitel`, `intensitaet`, `figuren`) leert ausdrücklich — z.B. «Kapitel entfernen» = `chapter_id: null` |
| `propose_beat_move` | `beat_move` | Ziel-Akt/-Strang (`ohne_strang`), Position, `before` (alte Zelle) |
| `propose_act` | `act_create` / `act_update` | Name, optional strang-eigener Akt (`thread_id` oder `thread_ref` auf einen neuen Strang derselben Antwort), Position (`after_act_id`/`at_start`) bzw. Umbenennung; `fork: true`, wenn der Strang noch keine eigene Aktstruktur hat |
| `propose_thread` | `thread_create` / `thread_update` | Name, Hauptfigur (Katalog oder Werkstatt) |
| `final_answer` | — | Pflicht-Endpunkt, nur `antwort` |

Regeln, die der Handler durchsetzt (Fehler kommen als `{ error }` ans Modell zurück, damit es korrigiert — das Frontend sieht nur Vorschläge, die beim Erzeugen gültig waren):
- **Nichts wird geschrieben.** Der Handler validiert gegen den Board-Stand der Antwort und hängt einen normalisierten Vorschlag an `ctx.proposals`.
- **ids gegen (Buch, User):** Akt, Strang, Beat, Kapitel (aus der Content-Store-Facade, inkl. ausgeschlossener Kapitel), Figuren (Kennung `fig_id` bzw. `draft#<id>`, sonst Name/Kurzname). Unbekanntes → Fehler, kein stilles Weglassen. **Ein Name, der auf mehrere Figuren passt** (Katalog und Werkstatt, gleiche Kurznamen), wird nicht geraten: Fehler mit den Kennungen der Kandidaten.
- **Hybrid-Akt-Regel** wie `plotDb.actFitsThread`: ein Strang mit eigener Aktstruktur liegt nur auf seinen eigenen Akten, alle anderen Beats auf geteilten — auch gegen den vorgeschlagenen Strang (`thread_id`/`thread_ref`) eines neuen Akts.
- **Strang-eigener Akt ohne eigene Aktstruktur** (bestehender Strang ohne eigene Akte oder neuer Strang per `thread_ref`): Vorschlag mit `fork: true`; eigene Akte entstehen nur über `fork-acts` ([plot.md](plot.md)). Ohne geteilte Akte gibt es keinen Fork (Fehler), und `after_act_id` ist dort nicht möglich (die Klone haben noch keine ids).
- **`after_beat_id` muss in der Zielzelle liegen.**
- **Kein No-Op:** eine Änderung, die nichts ändert (auch ein leeres Feld leeren), oder eine Verschiebung ohne Bewegung wird abgelehnt. `propose_beat` mit `beat_id` verschiebt nie (dafür `propose_beat_move`). `leeren` nur bei Änderungen und nie für ein Feld, das derselbe Aufruf setzt.
- **Kein Löschen.** Statt zu löschen schlägt das Modell „verwerfen" vor.
- **Referenzen innerhalb einer Antwort:** jeder Vorschlag bekommt `ref` (= Index + 1); `act_ref`/`thread_ref` zeigen auf einen `act_create`/`thread_create` derselben Antwort — auch `propose_act` per `thread_ref`. So entsteht ein neuer Strang mit eigenem Akt samt Beats in einem Zug; übernommen wird in Reihenfolge (ein Vorschlag mit offenem Bezug ist blockiert).
- Höchstens 30 Vorschläge pro Antwort.

Leere Antwort trotz Vorschlägen ist kein Abbruch: `__i18n:plot.chat.proposalsOnly__`. Endet der Lauf ohne `final_answer` (Iterationen erschöpft, Synthese ohne Antwort), stehen die gesammelten Vorschläge mit `__i18n:plot.chat.proposalsCut__` da statt hinter einer Fehlermeldung (`proposalsOnlyFallback` in `parseFinal`).

**Gedächtnis** früherer Vorschläge (`sessionPlotProposalMemory`, geteilte Logik in [proposal-chat-shared.js](../routes/jobs/proposal-chat-shared.js), Textform [prompts/proposal-memory.js](../public/js/prompts/proposal-memory.js)): übernommen / verworfen / offen — und «übernommen, danach rückgängig gemacht», wenn das mit einem `*_create` Angelegte nicht mehr im Board steht.

## Übernehmen ([public/js/chat/plot-chat-proposals.js](../public/js/chat/plot-chat-proposals.js))

**Jeder Vorschlag einzeln** — wie die Änderungsvorschläge des Abschnitts-Chats (gleiche Karte `.chat-vorschlag*`), bewusst ohne „alle übernehmen". Je Karte: Übernehmen · Verwerfen/Wieder öffnen · nach dem Übernehmen „Im Board zeigen".

- **Gleicher Schreibweg wie jede Board-Bearbeitung:** die Übernahme ruft die normalen `/plot`-Routen (`POST /plot/beats`, `PATCH /plot/beats/:id`, `PUT /plot/beats/order`, `POST /plot/acts`, …) und schreibt dieselben Undo-Records ([book/plot/history.js](../public/js/book/plot/history.js)): neu angelegt → `create-*`, geändert → `*-fields`, verschoben → `beat-place`. **Cmd/Ctrl+Z macht eine Übernahme rückgängig.** Die Server-Validierung der Routen gilt unverändert — der Vorschlag ist kein Schreibrecht.
- **Strang-eigener Akt mit `fork: true`:** hat der Strang beim Übernehmen noch keine eigenen Akte, fragt das Frontend per `appConfirm` (wie der Fork im Strang-Menü; nicht per Undo umkehrbar), ruft `POST /plot/threads/:id/fork-acts`, lädt das Board neu und legt dann den Akt an.
- **Status persistieren:** `PATCH /plot/chat-proposal` ([routes/plot-chat-proposals.js](../routes/plot-chat-proposals.js), Logik in der mit dem Ideen-Chat geteilten Fabrik [routes/chat-proposal-status.js](../routes/chat-proposal-status.js)), Body `{ message_id, index, action: 'applied'|'discarded'|'reopen', applied_id? }` → `applied_at` + `applied_id` bzw. `status='discarded'` am Vorschlag (Lesen + Schreiben in einer Transaktion). Besitz über die Session, nur `kind='plot'`, Buch-ACL editor. Verwerfen **oder erneutes Übernehmen** eines übernommenen Vorschlags → `409 PROPOSAL_ALREADY_APPLIED` mit dem gespeicherten Vorschlag im Body — ausser das mit einem `*_create` Angelegte existiert nicht mehr (`plotAppliedExists`, nach Undo/Löschen): dann ist erneutes Übernehmen erlaubt.
- **Kein Doppel-Schreiben:** Übernehmen läuft über `applyProposalOnce` ([public/js/chat/proposal-status.js](../public/js/chat/proposal-status.js), geteilt mit dem Ideen-Chat und den Ideen-Vorschlägen aus Abschnitts- und Buch-Chat). Scheitert nur der Status-PATCH, merkt sich der Vorschlag das Geschriebene (transient `_written`/`_appliedId`); der nächste Klick holt nur den Status nach statt ein Duplikat anzulegen. Ein 409 `PROPOSAL_ALREADY_APPLIED` gilt als Stand: der gespeicherte Vorschlag wird übernommen.
- **Zustand wird gegen das Board berechnet, nicht nur gelesen** (`proposalStatus`, pure, unit-getestet):
  - übernommen, aber das Angelegte ist weg (Undo, gelöscht) → wieder offen, „Erneut übernehmen";
  - Ziel (Beat/Akt/Strang) gelöscht → blockiert mit Grund;
  - `act_ref`/`thread_ref`, deren Akt/Strang noch nicht übernommen ist → blockiert („Übernimm zuerst den neuen Akt …");
  - Beat seit dem Vorschlag geändert (`before` ≠ Board) → Hinweis, kein Block; übernommen werden nur die gezeigten Felder.
- Beat-Änderungen zeigen Feld für Feld vorher → nachher, Titel/Beschreibung als Wort-Diff ([word-diff.js](../public/js/diff/word-diff.js), geteilt mit dem Abschnitts-Chat).

## Pflicht-Invarianten

- **Vorschläge schreiben nie** — nur der Klick des Users, über die regulären `/plot`-Routen. Kein Server-Endpunkt wendet einen Vorschlag an.
- **Nie Prosa:** Prompt verbietet Szenen/Dialoge/Romantext; Beats bleiben Stichpunkte.
- **Kein „alle übernehmen".**
- **Lese-Werkzeuge nur aus dem gemeinsamen Katalog** — keine Kopie eines Board-/Figuren-/Text-Lesers ([routes/jobs/chat-tools/CLAUDE.md](../routes/jobs/chat-tools/CLAUDE.md)).
- **Content-Store-Facade** für Kapitel; Plot-Tabellen nur über [db/plot.js](../db/plot.js).
