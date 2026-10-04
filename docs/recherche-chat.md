# Recherche-Chat

Agentischer Chat als **Panel in der Recherche-Karte** (Markup [public/partials/recherche-chat.html](../public/partials/recherche-chat.html), per `<!-- @include recherche-chat -->` in [recherche.html](../public/partials/recherche.html) eingesetzt; Scope + Methoden kommen aus `rechercheCard`). Recherchiert im offenen Web **und** im vorhandenen Recherche-Material, kennt die Buch-Entitäten als Kontext und schlägt Fundstücke als neue Recherche-Items vor. **Rückwärtsgewandt**: schreibt nie in den Buchtext ([user_app_philosophy]).

**Platzierung:** Ab 1280px steht das Panel als eigene, sticky Spalte **rechts neben dem Board** (`.recherche-split` in [public/css/entities/recherche/chat.css](../public/css/entities/recherche/chat.css); Muster des Abschnitts-Chats neben dem Editor, aber breiter — `clamp(420px, 32vw, 620px)` statt 420px, weil Web-Such-Antworten, Quellenlisten und Fundstück-Vorschläge mehr Zeilenbreite brauchen). Darunter klappt es per `order: -1` **über** das Board, damit es nicht unter einer langen Schnipsel-Liste verschwindet. Die Schnipsel-Karte des Boards liegt als eigenes Fragment in [public/partials/recherche-item.html](../public/partials/recherche-item.html).

## Claude-only — warum

Die einzige Echtzeit-Websuche läuft über Anthropics serverseitiges `web_search`-Tool (kein eigener Google-Key, Anthropic führt die Suche selbst aus). Ollama/OpenAI-compat können das nicht. Darum ist der Chat Claude-only. Die Bedingung (`resolveProvider({userEmail}) === 'claude'` + `ai.claude.api_key` gesetzt + Kill-Switch `research_chat.enabled` ≠ false) steht **einmal** in [lib/research-chat-gate.js](../lib/research-chat-gate.js) und greift an drei Stellen: `/config` → `researchChat.enabled` (Panel sichtbar, [routes/proxies.js](../routes/proxies.js)), `POST /jobs/research-chat` (`preflight` von `_handleChatPost`, **vor** dem Speichern der User-Nachricht — sonst bliebe bei abgeschaltetem Chat eine Frage ohne Antwort in der Session; `403 RESEARCH_CHAT_DISABLED` bzw. `400 RESEARCH_CHAT_CLAUDE_ONLY`) und der Job selbst (`validate`, weil Setting/Provider zwischen POST und Queue-Start wechseln können). Der Job erzwingt zusätzlich `provider='claude'`.

## Datenmodell

Keine neue Tabelle — die Sessions leben in `chat_sessions` mit **`kind='research'`** (Migration 220; `page_id IS NULL`, buchweit, analog `kind='book'`). Nachrichten in `chat_messages`; `context_info` (JSON) trägt `tool_calls`, `web_searches` und die **`proposals`** (Speicher-Vorschläge).

## Tools ([routes/jobs/research-chat-tools.js](../routes/jobs/research-chat-tools.js) + [public/js/prompts/recherche.js](../public/js/prompts/recherche.js))

| Tool | Handler? | Zweck |
|------|----------|-------|
| `web_search` | nein (Anthropic-Server-Tool, Typ `web_search_20250305`) | Echtzeit-Websuche; Ergebnis + Citations kommen in derselben Runde zurück. Trägt `allowed_domains`, wenn das Buch eine Eingrenzung gesetzt hat (siehe „Recherche-Profil“) |
| `list_research_items` | ja | vorhandenes Board durchsuchen (FTS bei `q`; Filter `kind`/`status`/`chapter_id`/`page_id`; liefert Status + `stellen`/`bezug`). Derselbe Handler bedient den Buch-Chat ([buchchat-tools.md](buchchat-tools.md)) |
| `read_research_item` | ja | Volltext eines Eintrags inkl. PDF-`doc_text` (auf 8 000 Zeichen gekappt — die Kappung wird als `doc_chars`/`doc_truncated` **ausgewiesen**, sonst hält das Modell den Anfang für das ganze Dokument) |
| `search_research_passages` | ja | semantische Passagen-Suche; mit `item_id` **innerhalb** eines langen PDFs. Nur angeboten bei `embed.isEnabled()` |
| `lookup_literature` | ja | bibliografische Register statt Web: Crossref (Aufsätze/DOI) und OpenLibrary (Bücher), `q` als Themen-Suche oder `doi`/`isbn` exakt ([lib/source-lookup.js](../lib/source-lookup.js)#`searchLiterature`/`lookupDoi`/`lookupIsbn`, feste Hosts → kein SSRF-Pfad). Liefert Titel/Autoren/Jahr/DOI/ISBN + stabile URL (doi.org). Ein ausgefallenes Register steht als `register_ausgefallen` im Result — keine Fehlanzeige. Treffer-URLs landen in `ctx.literatureHits` und sind damit zulässige Belege in `final_answer.quellen` |
| `list_book_entities` | ja | Figuren/Orte/Szenen/Beats/Stränge als Recherche-Kontext |
| `propose_research_item` | ja | sammelt EINEN Vorschlag in `ctx.proposals` — **persistiert nichts**. Gleicht URL (normalisiert, [lib/url-normalize.js](../lib/url-normalize.js)) und Titel mit dem Archiv ab (`findDuplicateItem` in [db/research-items.js](../db/research-items.js)): Treffer → `exists_item_id`/`exists_match` am Vorschlag + `already_in_archive` im Tool-Result. Wortgleicher Titel zweimal in einer Antwort → abgelehnt |
| `final_answer` | terminal | Pflicht-Endpunkt der Antwort. Optional `quellen: [{url, titel}]` — siehe „Web-Such-Zitate" |

**Zwei Zugriffsarten aufs Archiv, bewusst getrennt:** `list_research_items` ist die **Wortsuche** (FTS5) und beantwortet „welche Einträge gibt es"; `search_research_passages` ist die **Bedeutungssuche** (Embeddings, [docs/semantic-search.md](semantic-search.md)) und beantwortet „welche Stelle passt zu dieser Frage". Der Fall, für den das zweite Werkzeug existiert, ist das lange PDF: ein 40-Seiten-Dokument ist über `read_research_item` nur mit seinem Anfang lesbar, über `search_research_passages` mit `item_id` dagegen an jeder Stelle. Ohne Embedding-Endpunkt wird das Werkzeug gar nicht erst angeboten (Filter in [research-chat.js](../routes/jobs/research-chat.js)) — das Modell bleibt dann bei der Wortsuche.

`web_search` wird vom Loop **nicht** ausgeführt: in [lib/ai.js](../lib/ai.js) landen `server_tool_use`-Blöcke nicht in `result.toolUses` (nur `tool_use`), bleiben aber samt `web_search_tool_result` verbatim in `rawContentBlocks` (Re-Send-Pflicht, falls daneben ein Custom-Tool lief).

## Speicher-Vorschläge (Bestätigungs-Modell)

`propose_research_item` schreibt **nichts** — der Vorschlag landet in `context_info.proposals`. Das Frontend ([public/js/chat/research-chat-proposals.js](../public/js/chat/research-chat-proposals.js)) rendert pro Vorschlag „Speichern"; **erst der Klick** legt das Fundstück an. Spiegelt das `generate_image`→`ctx.images`-Sammelmuster des Buch-Chats.

**Speichern über `POST /research/chat-proposal`** ([routes/research-chat-proposals.js](../routes/research-chat-proposals.js)), Body `{ message_id, index, edits?, link?, allow_duplicate? }` — nicht über `POST /research`, weil drei Dinge in einem Schritt passieren müssen:
1. Fundstück anlegen (dieselbe Schreibsequenz `createItem` wie `POST /research`),
2. optional verknüpfen (`link: { target_kind: 'page'|'chapter', target_id }`, Kontext-Chip),
3. **Gespeichert-Status persistieren**: `context_info.proposals[index].saved_item_id` der Assistant-Nachricht. Nach einem Reload zeigt der Vorschlag weiter „Gespeichert" (Klick öffnet den Eintrag im Board); ein zweiter Klick antwortet `409 ALREADY_SAVED` statt eine Dublette anzulegen.

Liegt eine URL des Vorschlags schon an einem Fundstück des Buchs → `409 DUPLICATE_URL { existing_id }`; das Frontend zeigt dann „schon im Board" mit „Im Board öffnen" und „Trotzdem speichern" (`allow_duplicate: true`). Besitz über die Chat-Session (pro User), Buch-ACL `editor`.

**UI je Vorschlag:** Speichern · Bearbeiten vor dem Speichern (Titel, Inhalt, Typ aus `PROPOSAL_KINDS`, Tags — Felder, die das Board ohnehin kennt; Entwurf in `_proposalEdits`, geht als `edits` mit) · „Als Quelle übernehmen" (bei Vorschlägen mit URL: speichert bzw. nimmt den vorhandenen Eintrag und ruft die Brücke `POST /sources/from-research`, siehe [quellen.md](quellen.md)). Über der Liste „Alle {n} speichern" für die eindeutig neuen (ohne `exists_item_id`), nacheinander, damit der Dubletten-Abgleich die eben gespeicherten sieht.

**Kontext-Chip** über der Eingabe („Für Abschnitt/Kapitel «…» recherchieren"): erscheint, wenn das Board auf eine Seite/ein Kapitel gefiltert ist (Sprung vom Seiten-/Kapitel-Indikator) oder eine Seite offen war. Eingeschaltet verknüpft jedes Speichern das Fundstück mit diesem Ziel **und** das Modell bekommt die Stelle mit: das Frontend schickt `context: { kind, id }` im Body von `POST /jobs/research-chat` (`sendExtra` in [chat-base.js](../public/js/chat/chat-base.js)); `_handleChatPost` prüft es über `contextFn` = `researchMessageContext` gegen das Buch der Session (fremde Seite → still verworfen) und legt es als `context_info.research_context` an der **User-Nachricht** ab — die Job-Signatur aller Chats bleibt unverändert. `prepare` liest es über `userMsgId` (`readMessageContext`), lädt Name, einen Textauszug (Seite bzw. die ersten Seiten des Kapitels, auf 2 500 Zeichen gedeckelt) und das dort schon verknüpfte Material (`loadResearchContext`, [research-chat-helpers.js](../routes/jobs/research-chat-helpers.js)) und hängt `buildResearchWritingContextBlock` **ans Ende** des System-Prompts (volatil je Frage, der stabile Teil davor bleibt cachebar). Der Block verbietet ausdrücklich, den Auszug umzuschreiben oder fortzusetzen.

**Gedächtnis über Folge-Turns:** `prepare` hängt die früheren Vorschläge der Session kompakt ans Ende des System-Prompts (`buildResearchProposalMemoryBlock`: Titel, Typ, „gespeichert als id=…" / „nicht gespeichert") — „speicher das zweite" und „schlag das nicht nochmal vor" funktionieren, ohne dass die Vorschläge in der Gesprächshistorie stehen. Am Ende, damit der stabile Prompt-Teil davor cachebar bleibt.

**Leere Antwort trotz Vorschlägen** ist kein Abbruch: statt „Iterationen erschöpft"/„leere Antwort" steht `__i18n:recherche.chat.proposalsOnly__` (Server in `consumeFinalAnswer`, Frontend zusätzlich für die Loop-Marker `chat.errors.maxIterReached`/`emptyAnswer`).

Ein Vorschlag (und ein Recherche-Item generell) trägt **mehrere URLs** als `urls: [{ url, label }]` (http(s)-only, Tabelle `research_item_urls`, FK CASCADE — analog `research_item_tags`). Das Modell hängt alle belegenden Web-Quellen an einen `propose_research_item`-Aufruf; beim Speichern persistiert `POST /research` sie über `_replaceUrls`. Die alte Einzel-`url`-Spalte am `research_items` existiert nicht mehr (Migration 223).

## Recherche-Profil (pro Buch)

Zwei Spalten an `book_settings` (Migration 289) steuern, **wie** und **wo** der Chat sucht — gepflegt im Kontext-Tab der Bucheinstellungen (Abschnitt „Recherche“, nur sichtbar bei `researchChat.enabled`), geschrieben über den eigenen Endpunkt `PUT /booksettings/:book_id/research` (Muster `/citation`, `/xrefs`, `/textsorte`; der Header-Speichern-Knopf der Karte ruft ihn mit).

| Spalte | Wirkung |
|---|---|
| `research_profile` | Freitext (max. 1500 Zeichen) → Block **„VORRANGIGE ANGABEN DER AUTORIN / DES AUTORS ZUR RECHERCHE“** im System-Prompt, mit Vorrang vor den allgemeinen Arbeitsregeln — dieselbe Konvention wie `buch_kontext` im Buch-Prompt. |
| `research_domains` | Eine Domain pro Zeile (max. 20) → `allowed_domains` am serverseitigen `web_search`-Werkzeug (`buildResearchChatTools`). Leer = offenes Web. |

**Am Buch, nicht am User:** „ich suche medizinische Fachliteratur“ ist eine Aussage über *diese Arbeit* — dieselbe Autorin recherchiert im nächsten Projekt Bauernkriege. Damit sitzt das Profil auf der Achse von `buch_kontext` und `stilprofil`.

**Pflicht: die Eingrenzung steht doppelt im Call.** `allowed_domains` grenzt wirklich ein, der Prompt-Block sagt dem Modell, **dass** es eingegrenzt ist — samt der Anweisung, eine erfolglose Suche als eingegrenzt zu kennzeichnen statt als Nichtexistenz. Ohne die zweite Hälfte liest das Modell die leere Trefferliste als „dazu gibt es nichts“ und gibt eine Fehlanzeige weiter, die keine ist (gleiches Muster wie `scanned: false` beim Motiv-Index und `anchorMap === null` im Plot-Check).

**Normalisierung ausschliesslich serverseitig** ([lib/research-profile.js](../lib/research-profile.js), gegated in [tests/unit/research-profile.test.mjs](../tests/unit/research-profile.test.mjs)): eine eingefügte ganze URL wird zum Host, `www.` fällt weg, IDN wird zu Punycode, eine nackte IP und eine Zeile ohne Punkt fallen heraus. Die Antwort des Endpunkts trägt den **gespeicherten** Stand und setzt das Eingabefeld darauf — der User soll sofort sehen, was wirklich gilt. Kein zweiter Normalisierer im Browser; die Presets in [research.js](../public/js/book/book-settings/research.js) sind reine Eingabehilfe (anhängen, nicht ersetzen) und entscheiden nichts.

**Was das Profil NICHT kann:** es steuert die Formulierung und den Suchraum, nicht die Werkzeuge. Eine Fachdatenbank liefert über `web_search` gerenderte Trefferseiten, keine strukturierten Datensätze — zitierfähige Kerndaten (Autoren, Jahr, DOI/ISBN) liefert `lookup_literature`. Studiendesign und Fallzahl stehen in keinem der beiden Register; dafür bleibt die Web-Suche auf die DOI-Seite.

## Loop ([routes/jobs/research-chat.js](../routes/jobs/research-chat.js))

Geteilter agentischer Loop ([agentic-chat.js](../routes/jobs/agentic-chat.js)), aber ohne Seiten-Vorladen und ohne Zitat-Validierung: `callAIWithTools` → Custom-Tools ausführen → `final_answer`/Prosa terminiert; bei erschöpften Iterationen erzwungener Synthese-Turn mit nur `final_answer`. Cap `jobs.research_chat.max_tool_iter` (Default 6).

**System-Prompt:** eigener Recherche-Prompt + Buch-Kontext aus `getResearchPromptContext` ([prompts/core.js](../public/js/prompts/core.js)): nur Sprachnorm der Locale (`baseRules` **ohne** die Lektorat-`commonRules`) + Buchtyp/Autoren-Angaben/Hauptland. **Nicht** der Buch-Chat-Prompt — dessen Persona („kritischer Lektor, Feedback zu Stil") überstimmte das Verbot von Stil-Vorschlägen. Kein Stilprofil (der Chat erzeugt keinen Manuskripttext).

**Kosten-Deckel Web-Suche:** `jobs.research_chat.max_web_searches` (Default 10, Admin → Jobs) deckelt die Anthropic-Web-Suchen **über alle Runden** einer Antwort. `toolsForIter` ([research-chat-helpers.js](../routes/jobs/research-chat-helpers.js)#`toolsForRound`) senkt `max_uses` des `web_search`-Werkzeugs pro Runde auf den Rest und lässt es weg, sobald der Deckel erreicht ist. Solange der Rest ≥ dem Rundenwert (6) ist, bleibt das Werkzeug-Objekt bitgleich — der Prompt-Cache (Render-Reihenfolge tools → system → messages) bricht nur in der Runde, in der der Deckel greift. Der Prompt nennt den Deckel ebenfalls.

**Am Fuss jeder Antwort:** Zahl der Web-Suchen, die gelaufenen Suchbegriffe (`context_info.web_queries`, aus `server_tool_use.input.query`), die benutzten Werkzeuge mit i18n-Label (`recherche.chat.tool.<name>`) und die Kosten der Antwort (`context_info.cost_usd`, Tokens + Suchen nach [lib/pricing.js](../lib/pricing.js)).

## Frontend

Kein eigenes Card — Sub-State + Methoden sind in `rechercheCard` gespreadet ([public/js/cards/recherche-card.js](../public/js/cards/recherche-card.js)), Chat-Logik aus der geteilten `makeChatMethods`-Factory ([public/js/chat/chat-base.js](../public/js/chat/chat-base.js), Label `ResearchChat`). Toggle-Button im Karten-Header (nur bei `$app.researchChatEnabled`). Markup reused die `chat.css`-Klassen.

## Web-Such-Zitate (klickbare Quellen)

**Bevorzugt: benannte, geprüfte Belege.** `final_answer` nimmt optional `quellen: [{url, titel}]`. Der Job prüft sie gegen die tatsächlich in diesem Lauf gefundenen Web-Treffer (`validateAnswerSources`, URL-Vergleich über [lib/url-normalize.js](../lib/url-normalize.js)); was das Modell nie gesehen hat, fällt weg. Ergebnis `context_info.answer_sources: [{url, title, doc_nums}]` — `doc_nums` sind die Treffer-Positionen dieser URL. Das Frontend nummeriert die Quellenliste in dieser Reihenfolge und bildet `(cite index="N-…">`-Marker über `doc_nums` auf dieselbe Nummer ab; ein zitierter, aber nicht belegter Treffer wird als Link ohne Nummer (`↗`) gezeigt. Ohne `answer_sources` gilt der Fallback unten. Ein `cited_text`-Snippet als Tooltip gibt es nicht: die API hängt Citations an Text-Blöcke, die finale Antwort ist aber ein Tool-Argument — der Tooltip zeigt Titel bzw. URL.

**Fallback: cite-Marker.**
Bei aktiver `web_search` schreibt das Modell `<cite index="N-…">…</cite>`-Marker als Klartext in die `final_answer`-Antwort (claude.ai-Zitatformat; die strukturierten API-Citations hängen an Text-Blöcken, die finale Antwort ist aber ein Tool-Argument). Der geteilte Loop ([routes/jobs/agentic-chat.js](../routes/jobs/agentic-chat.js)) sammelt die `web_search_result`-Trefferdokumente (`url`+`title`) aus den `web_search_tool_result`-Blöcken **in Auftrittsreihenfolge, ohne Dedup** (das Modell referenziert per Position) und persistiert sie als `context_info.sources` (nur Recherche-Chat — Buch-Chat hat keine Web-Suche). Das Frontend ([research-chat.js](../public/js/chat/research-chat.js) `_renderResearchAnswer`) entfernt die `<cite>`-Tags, ersetzt sie durch klickbare Superscript-Marker `[N]` (1-basiert → N-tes Dokument, einzige Stelle der Basis-Annahme in `resolveSource` ([research-chat-render.js](../public/js/chat/research-chat-render.js))) und rendert unter der Antwort eine Quellenliste (`researchCitedSources`). Sentinels (``/``) umgehen den XSS-Escape von `renderChatMarkdown`; url/title werden beim Inject escaped.

## Routen

- `POST /chat/session/research` / `GET /chat/sessions/research/:book_id` ([routes/chat.js](../routes/chat.js)) — editor-scoped, buchweit.
- `POST /jobs/research-chat` ([routes/jobs/chat.js](../routes/jobs/chat.js), via `_handleChatPost` mit `preflight` = Gate) — Job-Queue, ACL `editor`.
- `POST /research/chat-proposal` ([routes/research-chat-proposals.js](../routes/research-chat-proposals.js)) — Vorschlag speichern (siehe oben).

## Vorbelegte Frage aus anderen Oberflächen (`research-chat:ask`)

Kleine Schnittstelle, damit z.B. der Buch-Chat einen Button „Im Recherche-Chat fragen" anbieten kann ([public/js/chat/research-chat-ask.js](../public/js/chat/research-chat-ask.js)):

```js
window.dispatchEvent(new CustomEvent(EVT.RESEARCH_CHAT_ASK, {   // 'research-chat:ask', public/js/events.js
  detail: { bookId, question },   // bookId optional; question Pflicht (max. 4000 Zeichen)
}));
```

Wirkung: Recherche-Karte öffnen (Registry-Toggle `toggleRechercheCard`, nur wenn zu — `onReclick: 'refresh'` würde sonst neu laden), Chat-Panel aufklappen, Eingabefeld vorbelegen und fokussieren. **Nicht** automatisch senden — Web-Suchen kosten, der User prüft die Frage. Ignoriert wird: leere Frage, `bookId` ≠ offenes Buch, `researchChat.enabled` false. Weil die Karte lazy ist, hält das Modul die Frage als „pending"; die Karte holt sie in `init()` bzw. über das interne Event `EVT.RESEARCH_CHAT_ASK_PENDING` ab. Der Listener wird einmal in `registerRechercheCard` installiert.

## Pflicht-Invarianten

- Nie generativ in den Buchtext (nur Recherche/Weltaufbau). Der System-Prompt verbietet Manuskript-Generierung explizit.
- `propose_research_item` persistiert nie selbst — Speichern ist immer User-bestätigt.
- Gespeichert-Status lebt am Vorschlag in der DB (`saved_item_id`), nie nur im Karten-State.
- Kill-Switch/Claude-only wird **vor** dem Speichern der User-Nachricht geprüft (`preflight`), nicht erst im Job.
- Belege in `answer_sources` stammen ausschliesslich aus den Web-Treffern oder `lookup_literature`-Treffern desselben Laufs (letztere ohne `doc_nums`).
- Claude-only: Sichtbarkeit gegated + Job erzwingt `provider='claude'`.
- Eine gesetzte Domain-Eingrenzung steht **immer** auch im System-Prompt — `allowed_domains` allein macht aus „dort nichts gefunden“ ein „gibt es nicht“.
