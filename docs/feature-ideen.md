## Rolle Lektor
- kann auch editieren, aber alles als Draft, ein Editor muss es abnehnehmen

## Websuche über SearXNG (Recherche-Chat + Faktencheck für jeden Provider)

Umsetzungs-Prompt für eine Claude-Code-Session in diesem Repo:

> Recherche-Chat ([docs/recherche-chat.md](recherche-chat.md)) und Weltfakten-Faktencheck ([docs/komplett.md](komplett.md), Job `POST /jobs/faktencheck`) sind heute Claude-only, weil die einzige Websuche Anthropics serverseitiges `web_search`-Tool ist. Mach beide für **jeden Provider mit Tool-Calling** nutzbar, indem du eine selbst gehostete **SearXNG**-Instanz als zweiten Suchweg anbindest.
>
> **Infrastruktur (steht, nicht anfassen):** SearXNG läuft im LAN unter `http://ubuntu-ki.lan:8888` (vom Prod-CT erreichbar, ~1 s). JSON-API: `GET /search?q=<query>&format=json[&language=de][&pageno=1]` → `results[]` mit `title`, `url`, `content` (Snippet), `engines`, `publishedDate`; dazu `unresponsive_engines`. Kein API-Key, kein Kosten-Deckel nötig. Einzelne Engines (Brave, DuckDuckGo) antworten zeitweise mit Rate-Limit/Captcha. Das ist kein Fehler, solange `results` nicht leer ist.

### Ist-Zustand: wo «Claude-only» heute steckt

Alle Stellen müssen angefasst werden, sonst bleibt ein Pfad am Provider-Namen hängen:

| Stelle | Was heute passiert |
|---|---|
| [lib/research-chat-gate.js](../lib/research-chat-gate.js) | `resolveProvider !== 'claude'` → `RESEARCH_CHAT_CLAUDE_ONLY`; prüft zusätzlich den Claude-API-Key. SSoT für `/config`, `POST /jobs/research-chat` ([routes/jobs/chat.js](../routes/jobs/chat.js)) und `validate` im Job. |
| [routes/jobs/research-chat.js](../routes/jobs/research-chat.js) | `callProvider: 'claude'`, `resolveProvider: () => 'claude'` und `effortSettingKey: 'ai.claude.effort.researchchat'` sind fest verdrahtet. |
| [public/js/prompts/recherche.js](../public/js/prompts/recherche.js) | `buildResearchChatTools` liefert `{ type: 'web_search_20250305', … }` als Server-Tool; `allowed_domains` wird nur dort gesetzt. Der System-Prompt beschreibt `web_search` als Echtzeit-Websuche und die Domain-Eingrenzung. |
| [routes/jobs/research-chat-helpers.js](../routes/jobs/research-chat-helpers.js)#`toolsForRound` | Deckel über `max_uses` des Server-Tools. Ein Function-Tool hat kein `max_uses`. |
| [routes/jobs/agentic-chat/loop.js](../routes/jobs/agentic-chat/loop.js)#`accumulate` | Zählt `webSearches`/`webQueries` und sammelt `webResults` **nur** aus `server_tool_use`/`web_search_tool_result`-Blöcken. Ein Function-Tool erzeugt diese Blöcke nicht. Folge: Deckel `stopBeforeRound`, `context_info.sources` und die Quellen-Validierung blieben leer. |
| [lib/pricing.js](../lib/pricing.js)#`costUsd` | Rechnet jede gezählte Websuche mit `WEB_SEARCH_USD_PER_1K` ab. SearXNG-Suchen dürfen dort nicht landen. |
| [routes/jobs/komplett/job-faktencheck.js](../routes/jobs/komplett/job-faktencheck.js) | `WEB_SEARCH_TOOL` als Server-Tool, `_judgeOneFact` ruft `callAIWithTools(…, 'claude')`, `recordCallCost(…, 'claude', …)` fest. Die Schleife kennt nur `pause_turn` und keine `tool_use`-Runden mit eigenem Handler. |
| [routes/jobs/komplett/index.js](../routes/jobs/komplett/index.js) + [routes/proxies.js](../routes/proxies.js) (`komplett.factcheck`) | `resolveProvider !== 'claude'` → `FACTCHECK_CLAUDE_ONLY`; `/config` analog. |
| [lib/ai/config.js](../lib/ai/config.js)#`providerSupportsTools` | SSoT für «kann Function-Calling»: `claude` ja, `openai-compat` ja ausser `ai.openai-compat.tools = false`, `ollama` nein. Der Kommentar dort sagt ausdrücklich, dass der Recherche-Chat am Namen gegated bleibt. Kommentar anpassen. |

### Anforderungen

> 1. **Admin-Settings** in [lib/app-settings/keys/app.js](../lib/app-settings/keys/app.js) neben `languagetool.*`/`stt.*` (Infrastruktur, nicht KI):
>    - `websearch.provider`: `searxng` | `off`, Default `off` — Suchweg für Provider ausser Claude.
>    - `websearch.claude`: `anthropic` | `searxng`, Default `anthropic` — Suchweg für Claude. Mit beiden Defaults ändert sich in Prod ohne Admin-Klick nichts.
>    - `websearch.searxng.url` (Default `''`), `websearch.searxng.timeout_ms` (Default 8000, int 1000–30000), `websearch.max_results` (Default 8, int 1–20). Die Suchsprache kommt aus `book_settings.language` des Buchs, kein eigenes Setting.
>    - Admin-UI-Feld im Tab, in dem LanguageTool/STT stehen, mit «Verbindung testen» (eine Probe-Suche, zeigt Trefferzahl und `unresponsive_engines`). i18n de/en.
>    - `searxng` ohne URL zählt wie `off` (bei `websearch.claude` fällt Claude dann auf `anthropic` zurück). Das prüft `webSearchMode`, nicht erst der Client.
>    - Admin-konfigurierter Host → kein `ssrf-guard`, aber `fetchWithTimeout`/`readCapped` aus [lib/http-util.js](../lib/http-util.js). `research_chat.enabled` und `ai.komplett.factcheck` bleiben die Kill-Switches der Features, `websearch.*` regelt nur den Suchweg.
>
> 2. **`lib/websearch/searxng.js`** (Client, rein, ohne KI-Bezug):
>    - `search(query, { domains, language, maxResults, signal })` → `{ results: [{ title, url, snippet, engines, published }], unresponsive: [...] }`.
>    - Nur http(s)-URLs. Dubletten per [lib/url-normalize.js](../lib/url-normalize.js) zusammenfassen (die `engines` vereinen). Snippet auf ~400 Zeichen kappen.
>    - Domain-Eingrenzung (`research_domains`): als `site:a.ch OR site:b.de` an die Query **und** serverseitiger Nachfilter auf den Treffer-Host (Subdomains zählen, `www.` egal). Nur der Nachfilter grenzt wirklich ein, der Operator sorgt nur dafür, dass überhaupt passende Treffer kommen.
>    - Fehlerbild: HTTP-Fehler/Timeout → eigener Fehlercode `WEBSEARCH_UNAVAILABLE`. Leere `results` sind **kein** Fehler. `unresponsive_engines` gehen ins Log (warn), nicht ans Modell.
>    - Unit-Test mit gemockter Antwort: Normalisierung, Dedup, Domain-Nachfilter, Timeout.
>
> 3. **`lib/websearch/index.js`** als Fassade mit `webSearchMode(userEmail)` → `'anthropic' | 'searxng' | null`. Das ist die eine Entscheidung, die beide Features und beide Gates lesen:
>    - Claude: Wert von `websearch.claude` (`anthropic` | `searxng`).
>    - Anderer Provider mit `providerSupportsTools`: `searxng`, wenn `websearch.provider = searxng` mit URL, sonst `null`.
>    - Provider ohne Tool-Calling (Ollama, openai-compat mit `ai.openai-compat.tools = false`): `null`.
>
> 4. **Recherche-Chat: Function-Tools statt Server-Tool** (bei Modus `searxng`):
>    - `buildResearchChatTools({ allowedDomains, webSearchMode })` liefert statt des Server-Tools zwei Function-Tools:
>      - `web_search { query }`: Handler ruft den Client und gibt kompakt nummerierte Treffer zurück (`[n] Titel — URL\nSnippet`), Gesamtdeckel ~4000 Zeichen.
>      - `read_web_page { url }`: holt über [lib/url-scrape.js](../lib/url-scrape.js)#`scrapeUrl` den Seitentext (SSRF-Guard Pflicht, die URL kommt vom Modell). Kappen auf ~12000 Zeichen und die Kappung ausweisen (Muster `doc_truncated`). Nur URLs zulassen, die in diesem Lauf als Treffer kamen, im Recherche-Board des Buchs stehen oder in der aktuellen User-Nachricht vorkommen (Vergleich normalisiert). Sonst Tool-Fehler «URL nicht aus bekannter Quelle». **Why:** interne Ziele fängt der SSRF-Guard; diese Beschränkung verhindert Abfluss per Prompt-Injection (eine gelesene Seite weist das Modell an, eine fremde URL mit Buchinhalt im Query-String aufzurufen).
>    - Handler in [routes/jobs/research-chat-tools.js](../routes/jobs/research-chat-tools.js)#`executeResearchTool`. Der Handler zählt selbst und hält den Deckel ein: `ctx.webSearches++`, Query nach `ctx.webQueries`, Treffer nach `ctx.webResults`. Ist `ctx.maxWebSearches` erreicht, kommt eine Tool-Fehlermeldung («Suchdeckel erreicht, antworte jetzt mit den vorhandenen Treffern») statt einer Suche. Das ersetzt `max_uses`, das ein Function-Tool nicht kennt. Parallele `web_search`-Calls in einer Runde zählen einzeln.
>    - **Loop** ([routes/jobs/agentic-chat/loop.js](../routes/jobs/agentic-chat/loop.js)): `stopBeforeRound`, `buildContextInfo` und die Kostenrechnung bekommen die Summe aus Server-Tool-Zählung (`state.*`) und Handler-Zählung (`ctx.*`). Dafür einen kleinen Hook vorsehen (z.B. `prep.webStats(ctx)`), statt Recherche-Wissen in den Loop zu ziehen; der Buch-Chat bleibt unberührt. An `costUsd` gehen **nur** die Anthropic-Suchen.
>    - `context_info.sources` füllt sich aus den SearXNG-Treffern in Auftrittsreihenfolge (gleiche Form `{ url, title }`). `validateAnswerSources` prüft `final_answer.quellen` dagegen, sowohl gegen die Treffer als auch gegen die gelesenen Seiten (`read_web_page` nach Redirect: `finalUrl` mit aufnehmen).
>    - **Zitate im Frontend**: Claude-`(cite index="N-…">`-Marker gibt es ohne Server-Tool nicht. [public/js/chat/research-chat-render.js](../public/js/chat/research-chat-render.js) bevorzugt `answer_sources` bereits und fällt sonst auf die Marker zurück. Prüfen, dass eine Antwort ohne Marker und mit `answer_sources` sauber nummerierte Quellen zeigt. Der Prompt verlangt im SearXNG-Modus Belegnummern `[n]` im Text; `n` ist das `nr` des Treffers aus `web_search`, fortlaufend über den ganzen Lauf und damit dieselbe Position wie in `context_info.sources` (wie der Index der cite-Marker). Der Renderer macht daraus dieselben `<sup class="chat-cite">`-Links wie bei den cite-Markern; ein `[n]` ohne passende Quelle bleibt Text. Nur aktiv, wenn die Antwort keine cite-Marker enthält, damit Claude/Anthropic unverändert rendert.
>    - **Provider**: `callProvider`/`resolveProvider` folgen dem effektiven Provider des Users (Muster Buch-Chat, [routes/jobs/chat/book-chat.js](../routes/jobs/chat/book-chat.js)). `effortSettingKey` gilt nur für Claude. Thinking-Notizen gibt es nur bei Claude; das ist schon so gelöst.
>    - **Prompt** ([public/js/prompts/recherche.js](../public/js/prompts/recherche.js), alle Locale-/Provider-Instanzen, siehe [public/js/prompts/CLAUDE.md](../public/js/prompts/CLAUDE.md)): Werkzeugbeschreibung je Modus. Bei SearXNG: «Snippets reichen nicht für Detailfakten → `read_web_page`»; die Eingrenzung wird als serverseitig erzwungen beschrieben. `lookup_literature` bleibt vor `web_search` bevorzugt.
>    - **Lokale Modelle**: Kontext ist knapp. Deshalb `toolResultCap` im SearXNG-Modus setzen (heute `null`), Seitentext-Deckel abhängig von `aiCfg.inputBudgetTokens` wählen und `inputTokenCap`/`roundResultCapChars` wie im Buch-Chat nutzen.
>
> 5. **Faktencheck** ([routes/jobs/komplett/job-faktencheck.js](../routes/jobs/komplett/job-faktencheck.js)):
>    - `_judgeOneFact` bekommt einen zweiten Pfad: Bei Modus `searxng` ein kleiner Tool-Loop mit `web_search` (max. 3 Suchen je Fakt, wie heute `max_uses`) und optional `read_web_page` (max. 1). Der Loop läuft über `callAIWithTools` mit dem effektiven Provider, die `tool_use`-Runden führt er selbst aus. Rundendeckel bleibt `_MAX_JUDGE_TURNS`, höher setzen, weil jetzt jede Suche eine Runde kostet (z.B. 5).
>    - `recordCallCost` und `_factcheckModelName` mit dem echten Provider statt `'claude'`.
>    - **Beleg-Härtung**: Ein `falsch`-Urteil braucht heute nur irgendeine `https://`-URL in `quelle`. Im SearXNG-Pfad zusätzlich prüfen, dass die URL (normalisiert) unter den Treffern bzw. gelesenen Seiten dieses Fakts war, sonst `unklar`. Gleiches Prinzip wie `validateAnswerSources`.
>    - Prompt `buildWeltfaktRealityJudgePrompt` und den Judge-System-Prompt ([public/js/prompts/komplett/kontinuitaet.js](../public/js/prompts/komplett/kontinuitaet.js)) je Modus anpassen; JSON-Only bleibt.
>    - Parallelität: `_FACTCHECK_MAX_CONCURRENCY` (4) für `openai-compat` zusätzlich durch `ai.openai-compat.max_parallel` begrenzen. Die Semaphore in [lib/ai/shared.js](../lib/ai/shared.js) greift ohnehin, aber der Fortschrittsbalken sollte nicht vier Calls vortäuschen.
>
> 6. **Gates umbauen**:
>    - `researchChatGate(userEmail)`: Kill-Switch zuerst. Dann `webSearchMode(userEmail)`: `null` + Provider ohne Tool-Calling → neuer Code `RESEARCH_CHAT_NO_TOOLS`; `null` wegen `websearch.provider = off` → `RESEARCH_CHAT_NO_WEBSEARCH`. Der API-Key-Check gilt nur für Claude; bei anderen Providern prüft `aiApiKey` des jeweiligen Providers, falls vorhanden.
>    - `RESEARCH_CHAT_CLAUDE_ONLY` und `FACTCHECK_CLAUDE_ONLY` bleiben bestehen (i18n `error.*` und Frontend-Mapping), werden nach der Freischaltung aber nicht mehr ausgegeben; die neuen Codes kommen daneben. Im Client-Vertrag ([contract/](../contract/README.md)) stehen diese Codes nicht, dort ist nichts zu ändern. i18n-Keys für die neuen Fehler in de/en; [public/js/cards/world-facts-card.js](../public/js/cards/world-facts-card.js) und [public/js/book/kontinuitaet.js](../public/js/book/kontinuitaet.js) mappen die neuen Codes.
>    - Faktencheck-Gate analog als `factcheckGate(userEmail)` neben `researchChatGate`, genutzt von `routes/jobs/komplett/index.js`, `/config → komplett.factcheck` und dem Job selbst (Setting kann sich zwischen POST und Start ändern).
>    - `/config` bleibt die einzige Quelle fürs Frontend; die UI-Gating-Logik nicht duplizieren.
>
> 7. **Prompt-Cache**: Die Werkzeugliste bleibt über den Lauf konstant (`toolsForRound` nur beim Start). Bei Function-Tools ist das automatisch so, weil der Deckel im Handler liegt und nicht in der Liste. `max_web_searches` gilt auch für SearXNG-Suchen (Laufzeit, nicht Kosten).
>
> 8. **Logging/Metriken**: Je Suche eine Info-Zeile `websearch q="…" hits=N unresponsive=[…] ms=…` (Buch-Kontext kommt über den Job automatisch). Optional eine `/metrics`-Kennzahl `websearch_requests_total{result}`; falls ja, gehören die Home-Assistant-Configs in denselben Commit (Drift-Reminder).
>
> 9. **Doku**:
>    - [docs/recherche-chat.md](recherche-chat.md): Abschnitt «Claude-only — warum» ersetzen durch «Suchwege»: Anthropic vs. SearXNG, Gate-Matrix, Unterschiede (Zitat-Marker, `read_web_page`, Kosten).
>    - [docs/komplett.md](komplett.md): Faktencheck-Gating.
>    - [docs/ai-providers.md](ai-providers.md): Liste der provider-gegateten Features.
>    - [docs/chats.md](chats.md): Zeile Recherche-Chat («Claude-only» raus).
>    - Root-[CLAUDE.md](../CLAUDE.md), Chat-Beschreibung: «Claude-only mit Web-Suche» anpassen.
>    - SSRF-Konsumentenliste: `read_web_page` läuft über `url-scrape.js`, das schon gelistet ist. Den Zweck dort ergänzen.
>
> 10. **Tests**:
>    - Unit: Client (siehe 2), `webSearchMode`-Matrix (3 Provider × 3 Settings × `ai.openai-compat.tools`), beide Gates, Deckel im Handler (11. Suche → Fehlertext, keine HTTP-Anfrage), `validateAnswerSources` mit SearXNG-Treffern + `finalUrl`, Faktencheck-Beleg-Härtung.
>    - Integration: ein Recherche-Chat-Lauf mit openai-compat-Mock (Function-Calling) + gemocktem SearXNG-HTTP-Server. Prüft `context_info.web_searches`, `sources`, `answer_sources`, `cost_usd` ohne Suchanteil.
>    - Integration: Faktencheck-Lauf mit demselben Mock; ein `falsch` mit fremder URL wird `unklar`.
>    - Regression: Claude + `anthropic` liefert unverändert Server-Tool und Kosten (bestehende Tests müssen grün bleiben, ohne Anpassung).
>    - Client-Vertrag: `client-contract.test.js` mit den neuen `error_code`s.
>
> Demo-Instanz (CT 149) hat keine KI-Endpunkte, dort bleibt `websearch.provider = off`.


### Entscheidungen

- **Claude sucht weiter über Anthropic.** `websearch.provider = searxng` schaltet SearXNG zunächst für die Nicht-Claude-Provider frei; für Claude bleibt Anthropic, bis ein Vergleichslauf (5–10 echte Recherchefragen, Qualität + Kosten aus `ai_cost_ledger`) etwas anderes zeigt. Dafür trennt das Setting die beiden Fälle: `websearch.provider` (`searxng` | `off`) für Nicht-Claude und `websearch.claude` (`anthropic` | `searxng`, Default `anthropic`) für Claude. **Why:** Anthropic-Suchen kosten ~1 Cent, dafür liefert Anthropic Seitenauswertung und cite-Marker ohne Extra-Runde; SearXNG hat Engine-Ausfälle.
- **`read_web_page`** nur für Treffer dieses Laufs, Board-URLs des Buchs und URLs aus der aktuellen User-Nachricht (siehe Punkt 4).
- **Ollama bleibt ausgeschlossen**, bis [lib/ai/ollama.js](../lib/ai/ollama.js) Tool-Calling kann (eigenes Vorhaben). Lokale Modelle laufen über openai-compat.
- **Kein Such-Cache** in dieser Umsetzung. Nachrüsten erst, wenn die `unresponsive`-Logzeilen gehäuft leere Ergebnisse zeigen.
- **`[n]`-Belege werden verlinkt** (siehe Punkt 4, Zitate).
- **Zwei Etappen:** zuerst Recherche-Chat, dann Faktencheck. Jede Etappe ist für sich deploybar.

### Umsetzungsplan

Jeder Schritt ist ein eigener Commit auf `main`, nach jedem Schritt `npm run test:unit` grün. Bis Schritt 6 ändert sich für Claude-User nichts Sichtbares.

**Etappe 1 — Recherche-Chat**

1. **Settings + Client**
   - Keys in [lib/app-settings/keys/app.js](../lib/app-settings/keys/app.js): `websearch.provider` (`off`), `websearch.claude` (`anthropic`), `websearch.searxng.url`, `websearch.searxng.timeout_ms`, `websearch.max_results`.
   - `lib/websearch/searxng.js` + Unit-Test `tests/unit/websearch-searxng.test.mjs` (Mock über injiziertes `fetch`).
   - `lib/websearch/index.js` mit `webSearchMode(userEmail)` + Unit-Test der Matrix.
2. **Admin-UI**
   - Neues Partial `public/partials/admin-settings-websearch.html` nach dem Muster von [admin-settings-languagetool.html](../public/partials/admin-settings-languagetool.html), eingehängt in [admin-settings.html](../public/partials/admin-settings.html).
   - Admin-Route «Verbindung testen»: eine Probe-Suche, synchron. Das ist kein KI-Call, deshalb gilt die Job-Queue-Regel hier nicht.
   - i18n de/en. `combobox` für die Modus-Auswahl, `numInput` für Timeout/Treffer.
3. **Gate**
   - `researchChatGate` auf `webSearchMode` umbauen, neue Codes `RESEARCH_CHAT_NO_TOOLS` / `RESEARCH_CHAT_NO_WEBSEARCH` + i18n.
   - Kommentar in `providerSupportsTools` anpassen.
   - Bestehender [research-chat-gate.test.js](../tests/integration/research-chat-gate.test.js) erweitern.
   - Bis Schritt 6 sperrt ein Flag in [lib/websearch/index.js](../lib/websearch/index.js) (`_searxngToolsReady`) den SearXNG-Pfad: Claude sucht immer über Anthropic, andere Provider bekommen weiter `RESEARCH_CHAT_CLAUDE_ONLY`. Das Verhalten bleibt damit bis zur Freischaltung exakt wie vorher.
4. **Tools + Handler**
   - `buildResearchChatTools({ allowedDomains, webSearchMode })` in [public/js/prompts/recherche.js](../public/js/prompts/recherche.js) inkl. aller Locale-/Provider-Instanzen; Prompt-Texte je Modus.
   - Handler `web_search` / `read_web_page` in [routes/jobs/research-chat-tools.js](../routes/jobs/research-chat-tools.js): Deckel, Zählung in `ctx`, URL-Herkunftsprüfung.
   - Unit-Tests: Deckel (keine HTTP-Anfrage nach dem Deckel), Herkunftsprüfung, Kappung.
5. **Loop + Job**
   - Hook `prep.webStats(ctx)` in [routes/jobs/agentic-chat/loop.js](../routes/jobs/agentic-chat/loop.js); `stopBeforeRound`, `buildContextInfo` und `costUsd` summieren korrekt (Kosten nur Anthropic-Suchen).
   - [routes/jobs/research-chat.js](../routes/jobs/research-chat.js): Provider dynamisch, `effortSettingKey` nur Claude, `toolResultCap`/`inputTokenCap` im SearXNG-Modus.
   - `validateAnswerSources` nimmt gelesene Seiten (`finalUrl`) mit auf.
   - Integrationstest: Recherche-Chat-Lauf mit injiziertem `callAIWithTools` (Function-Calling-Antworten) + gemocktem SearXNG. Regressionstest Claude/Anthropic unverändert.
6. **Frontend + Freischaltung**
   - `[n]`-Verlinkung in [research-chat-render.js](../public/js/chat/research-chat-render.js) + Unit-Test.
   - Fehlercodes in der Recherche-Karte anzeigen; Hinweistexte, die «nur mit Claude» sagen, anpassen (i18n de/en durchsuchen).
   - Feature-Flag aus Schritt 3 entfernen.
   - Doku: [recherche-chat.md](recherche-chat.md), [chats.md](chats.md), [ai-providers.md](ai-providers.md), Root-[CLAUDE.md](../CLAUDE.md).
   - `npm test` komplett, dann Deploy. Auf Prod `websearch.provider = searxng` + URL im Admin-UI setzen (Prod-Writes macht der User).
   - Manuelle Abnahme: eine Recherchefrage mit openai-compat-Profil (Treffer, gelesene Seite, verlinkte Belege, Kostenfuss ohne Suchanteil) und eine mit Claude (unverändert).

**Etappe 2 — Faktencheck**

7. **Gate:** `factcheckGate(userEmail)` neben `researchChatGate`; genutzt von [routes/jobs/komplett/index.js](../routes/jobs/komplett/index.js), `/config` in [routes/proxies.js](../routes/proxies.js) und im Job. Neue Codes `FACTCHECK_NO_TOOLS` / `FACTCHECK_NO_WEBSEARCH` + Mapping in [world-facts-card.js](../public/js/cards/world-facts-card.js) und [kontinuitaet.js](../public/js/book/kontinuitaet.js).
8. **Judge-Loop:** zweiter Pfad in `_judgeOneFact` mit Function-Tools (wiederverwendete Handler aus Schritt 4, eigener Deckel 3 Suchen + 1 Seite je Fakt), echter Provider in `recordCallCost`/`_factcheckModelName`, Beleg-Härtung für `falsch`. Prompt-Varianten in [kontinuitaet.js](../public/js/prompts/komplett/kontinuitaet.js). [faktencheck.test.js](../tests/integration/faktencheck.test.js) erweitern (injiziertes `callTools`).
9. **Doku + Abnahme:** [komplett.md](komplett.md), [ai-providers.md](ai-providers.md). `npm test`, Deploy, ein Faktencheck-Lauf mit openai-compat auf einem Buch mit `weltfakten_real_pruefen`.

**Danach (nicht Teil dieser Umsetzung):** Vergleichslauf Claude Anthropic vs. SearXNG → entscheiden, ob `websearch.claude` auf `searxng` wechselt.
