# Chat-Werkzeuge (`routes/jobs/chat-tools/` + `public/js/prompts/chat-tools/`)

Gilt zusätzlich zur Root-[CLAUDE.md](../../../CLAUDE.md). Gemeinsamer Katalog der vier agentischen Chats (Buch, Plot, Ideen, Recherche); Inventar, Loop und Deckel: [docs/chat-tools.md](../../../docs/chat-tools.md). Alles hier ist durch [tests/unit/chat-tools-contract.test.mjs](../../../tests/unit/chat-tools-contract.test.mjs) gegated — wer eine Regel ändern will, ändert Test und Begründung im selben Commit.

## Ein Werkzeug, eine Stelle je Aspekt

| Aspekt | Ort | genau |
|---|---|---|
| Definition (Name, Beschreibung, Schema, `see`) | `public/js/prompts/chat-tools/catalog-*.js` | einmal |
| Handler | `routes/jobs/chat-tools/tools-*.js`, Eintrag in `TOOLS` ([index.js](index.js)) | einmal |
| SQL | `db/book-chat/*.js` bzw. bestehendes `db/`-Modul — **nie** im Werkzeug-Modul | — |
| Wer bekommt es | eine Zeile in [access.js](../../../public/js/prompts/chat-tools/access.js) (`slim`/`full` je Chat) | einmal |
| Wann es fehlt | Eintrag in `AVAILABILITY` ([index.js](index.js)), wenn es einen Endpunkt oder Daten braucht | höchstens einmal |
| Doku | Tabellenzeile in [docs/chat-tools.md](../../../docs/chat-tools.md) | einmal |
| UI-Label | `chat.tool.<name>` in **beiden** Locales | einmal |

Kein Chat führt eine eigene Liste von Lese-Werkzeugen, keine zweite Definition, kein eigener Filter daneben. Ausgabe-Werkzeuge (`final_answer`, `propose_*`, Web-Suche) gehören dem jeweiligen Chat und stehen bei dessen Prompt-Modul. **Why:** vorher hatte jeder Chat eigene Namenslisten, der Recherche-Chat eigene Definitionen derselben Werkzeuge, und Slim-Listen verwiesen auf Werkzeuge, die es dort nicht gab.

## Nennt ein Text ein anderes Werkzeug, dann nur bedingt

Jeder Text, den das Modell liest, nennt ein anderes Werkzeug nur, wenn es im laufenden Lauf angeboten wird — sonst erfindet ein Modell den Aufruf oder verbrennt eine Runde.

- **Definition:** Kernbeschreibung und Parameter-Beschreibungen nennen **keine** Werkzeugnamen. Querverweise stehen in `see: { ziel: 'Satz mit `ziel`.' }`; `renderChatTools` hängt den Satz nur an, wenn das Ziel angeboten wird. IDs heissen «aus der Gliederung», «aus einem Werkzeug-Ergebnis», nicht «aus list_chapters».
- **System-Prompt:** jede Erwähnung über `toolMentions(toolNames)` ([mentions.js](../../../public/js/prompts/chat-tools/mentions.js)) — `route()` für Routing-Zeilen, `ifAll()` für Prosa, `list()` für Aufzählungen. Kein `ifAny` mit mehreren Namen in einer fest formulierten Zeile.
- **Handler-Ergebnis:** Hinweise («weiter mit X») über `toolHint(ctx, name, text)` / `offeredList(ctx, names)` aus [shared.js](shared.js), auf derselben oder der vorigen Zeile. Logs sind ausgenommen.
- Einzige Ausnahme überall: `final_answer` (in jedem Chat Pflicht-Endpunkt).

## Form

- **Name:** `verb_objekt` in snake_case; Verb aus `list | get | search | read | quote | find | lookup | generate`. Ein abgelöster Name (`RETIRED_CHAT_TOOL_NAMES`) kommt nie wieder — gespeicherte Antworten tragen ihn noch.
- **Überblick und Detail = ein Werkzeug** mit optionalem Auswahl-Parameter (Muster: `get_motifs` + `motif_id`, `list_werkstatt_drafts` + `draft_id`, `list_revisions` + `diff`, `get_lektorat` + `view`). Ein neues Werkzeug nur, wenn kein bestehendes die Frage mit einem Parameter mehr beantwortet. **Why:** jedes Werkzeug kostet in jeder Runde Input-Tokens, und ein Modell wählt aus wenigen Werkzeugen zuverlässiger.
- **Budgets (Ratsche, nur senken):** Kernbeschreibung ≤ 650 Zeichen, gerendert ≤ 900, Parameter-Beschreibung ≤ 250, `see`-Satz ≤ 160, ≤ 8 Parameter, Schema-Tiefe ≤ 3; dazu Anzahl und Gesamtgrösse je Chat und Satz (`SET_BUDGET` im Test). Ein neues Werkzeug, das die Ratsche reisst, wird gekürzt oder ersetzt ein bestehendes — die Grenze wird nicht angehoben, um Platz zu schaffen.
- **Beschreibung:** was es liefert (Felder), zwei typische Fragen, wann es leer ist und was das bedeutet. Defaults und Maxima stehen in der Parameter-Beschreibung, damit das Modell sie nicht zurückrechnet.
- **Ergebnis:** Zusammenfassungen (`total_*`, `hint`) vor den Listen, Listen als Arrays auf oberster Ebene — die strukturierte Kürzung halbiert sie statt hart zu schneiden. Fehler als `{ error, errorKey: 'chat.toolError.<fall>', errorParams? }`, Key in beiden Locales.
- **Scope:** fremde `page_id`/`chapter_id` vor dem Laden gegen `ctx.bookId` prüfen; user-skopierte Daten mit `ctx.userEmail`. Read-only, deterministisch, kein KI-Call (Ausnahme mit Begründung: `generate_image`).

## Neues Werkzeug — Reihenfolge

1. Gibt es ein bestehendes, das mit einem Parameter mehr reicht? Dann das erweitern.
2. Definition in das passende `catalog-*.js`, Querverweise in `see`.
3. Handler in `tools-*.js`, SQL in `db/book-chat/`, Eintrag in `TOOLS`; braucht es Daten oder einen Endpunkt, `AVAILABILITY` mit **derselben** DB-Funktion wie der Handler.
4. Zeile in `access.js` — für jeden Chat bewusst entscheiden (`slim` nur, wenn es eine häufige Frage billiger beantwortet).
5. Tabellenzeile in `docs/chat-tools.md`, Label `chat.tool.<name>` in de + en.
6. `npm run test:unit` (Vertrag) und die Integrationstests des Bereichs.
