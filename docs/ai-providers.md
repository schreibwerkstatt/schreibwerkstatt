# KI-Provider

Code: [lib/ai.js](../lib/ai.js). Drei Provider, ein Vertrag.

## Provider-Auswahl

Admin setzt `ai.provider` global in `app_settings` (`claude` (Default) | `ollama` | `openai-compat`). Pro User zieht ein zugewiesenes **KI-Profil** (`app_users.ai_profile_id`) das vor — siehe „Per-User-Zuweisung" weiter unten und „KI-Profile" am Ende.

### Auflösungs-Reihenfolge

`lib/ai.js#resolveProvider({ userEmail })`:

1. Provider des **eigenen KI-Zugangs** des Kontos (`ai_profiles.owner_email`), solange `ai.user_api.enabled` an ist — siehe „Eigener KI-Zugang"
2. Provider des zugewiesenen KI-Profils (`app_users.ai_profile_id`; NULL = folgt global)
3. `app_settings.ai.provider`
4. Hardcoded `'claude'`

`userEmail` kommt aus dem ALS-Context (Job-Queue: `runWithContext({ user: job.userEmail, … })`) oder explizit (Routes/SSE via `req.session.email`). Job-Pfade resolven den Provider einmalig am Job-Start (siehe `effectiveProvider` in `routes/jobs/review.js`, `kapitel.js`, `lektorat.js`, `synonyme.js`, `komplett/`). In-Flight-Override-Wechsel ändert den laufenden Job nicht.

### Per-User-Zuweisung

- Zugewiesen wird ein **Profil**, nicht bloss ein Provider-Name: es trägt Modell, Host, Kontextfenster, Klasse und optional einen eigenen Schlüssel. Was das Profil offen lässt, kommt weiter aus `app_settings` (siehe „KI-Profile").
- Admin weist es in der AdminUsersCard zu (Combobox `Global (…)` | Profilname · Provider). PUT `/admin/users/:email` mit `{ ai_profile_id: 7 | null }`; NULL/'' löst die Zuweisung.
- API-Guard: Profil, dessen effektive Konfiguration (Profil ODER global) keinen Host bzw. Schlüssel hat → `400 AI_PROVIDER_NOT_CONFIGURED`. Unbekannte ID → `404 AI_PROFILE_NOT_FOUND`.
- `GET /config` liefert den resolvten Provider read-only (`apiProvider`, `effectiveProvider`, `effectiveProviderClass`) plus die Modellnamen des effektiven Profils für die Frontend-Statuszeile.
- Self-Service gibt es nur als **eigenen KI-Zugang** mit eigenem Schlüssel (Admin-Freigabe `ai.user_api.enabled`); eine Admin-Zuweisung kann der User nicht ändern.

### Concurrency-Locks bleiben endpunkt-spezifisch

Locks serialisieren *pro Ziel-Endpunkt* (ein Bucket je KI-Profil, sonst der globale), nicht pro User. Ollama läuft über einen strikten Mutex (`withOllamaLock`) — VRAM verträgt keine Parallelität. OpenAI-kompatibel läuft über eine **Semaphore** (`withOpenAICompatLock`, `makeSemaphore` in [lib/ai/shared.js](lib/ai/shared.js)) mit dynamisch gelesener Obergrenze `ai.openai-compat.max_parallel` (Default 1 = seriell wie Ollama, Admin-Setting, greift ohne Neustart). Höher setzen, wenn der lokale Server mehrere Slots verträgt (z.B. LocalAI); überzählige Calls warten in der Queue.

### Cache-Key-Erweiterung

`provider`-Spalte ist Pflicht-Teil des PRIMARY KEY in: `chapter_extract_cache`, `book_extract_cache`, `chapter_review_cache`, `book_review_cache`, `chapter_macro_review_cache`, `synonym_cache`, `lektorat_cache`. Ohne den Split würde Claude-Output an Ollama-User ausgeliefert. Migration 117 backfillt bestehende Eintraege mit dem zur Migrationszeit aktiven Globalwert.

Cache-Helpers (`db/schema.js`): `loadXxxCache(…, provider)` / `saveXxxCache(…, provider)`. Caller muessen den resolvten Provider durchreichen.

## Konfiguration: `app_settings` als SSoT

Alle KI-Konfig liegt in der `app_settings`-Tabelle. Admin-PUT via `/admin/settings`. `.env`-Vars sind nur **Boot-Spiegel**: beim ersten Start gespiegelt in `app_settings`, danach nie wieder gelesen (Mapping: [lib/app-settings.js:270-278](../lib/app-settings.js#L270-L278)). Änderungen am Setting per Admin-UI/PUT erfordern App-Restart (Werte werden beim Modul-Load gefrosted).

| Setting-Key | Default | Boot-Env | Bedeutung |
|-------------|---------|----------|-----------|
| `ai.provider` | `claude` | `API_PROVIDER` | Globaler Provider (`claude` \| `ollama` \| `openai-compat`) |
| `ai.claude.api_key` | – | `ANTHROPIC_API_KEY` | Pflicht bei Claude |
| `ai.claude.model` | `claude-sonnet-4-6` | `MODEL_NAME` | |
| `ai.claude.context_window` | 0 = aus Modell | `MODEL_CONTEXT` | Gesamtfenster (Input+Output); 0 → `_claudeModelContext` (moderne Generation 1M, ältere 200K) |
| `ai.claude.max_tokens_out` | 0 = aus Modell | `MODEL_TOKEN` | Output-Cap (`MAX_TOKENS_OUT`); 0 → `_claudeModelMaxOut` (128K bzw. 64K) |
| `ai.claude.retry_max` | 3 | – | Retry-Attempts bei 429/529 |
| `ai.claude.timeout_ms` | 600 000 | – | Hard-Timeout (10 min) |
| `ai.ollama.host` | `http://localhost:11434` | `OLLAMA_HOST` | |
| `ai.ollama.model` | `llama3.2` | `OLLAMA_MODEL` | |
| `ai.ollama.temperature` | 0.7 | `OLLAMA_TEMPERATURE` | Default `0.2` für Lock-Logik |
| `ai.ollama.context_window` | 32 000 | – | Per-Provider-Override |
| `ai.ollama.max_tokens_out` | 16 000 | – | |
| `ai.ollama.think` | `false` | – | Reasoning an/aus (top-level `think`-Flag); aus spart Output-Token |
| `ai.ollama.timeout_ms` | 1 800 000 | – | Hard-Timeout pro Call (fetch + Stream); ohne ihn blockiert ein hängendes Ollama wegen des Mutex jeden wartenden Job |
| `ai.openai-compat.host` | `http://localhost:8080` | `OPENAI_COMPAT_HOST` | OpenAI-kompatibler `/v1/chat/completions`-Endpoint |
| `ai.openai-compat.model` | `llama3.2` | `OPENAI_COMPAT_MODEL` | |
| `ai.openai-compat.api_key` | – | `OPENAI_COMPAT_API_KEY` | Optionaler Bearer-Token (encrypted); leer = kein `Authorization`-Header |
| `ai.openai-compat.temperature` | 0.7 | `OPENAI_COMPAT_TEMPERATURE` | Default `0.1` für Lock-Logik |
| `ai.openai-compat.context_window` | 32 000 | – | |
| `ai.openai-compat.max_tokens_out` | 16 000 | – | |
| `ai.openai-compat.think` | `false` | – | Reasoning an/aus; aus sendet `chat_template_kwargs.enable_thinking=false`, an sendet nichts (Modell-Default; nötig für echtes OpenAI) |
| `ai.openai-compat.cloud` | `false` | – | Provider-Klasse (siehe unten): `true` = gehostetes Frontier-Modell (z.B. Kimi/Moonshot, OpenAI) → volle Cloud-Prompts, Lektorat-Split, parallele Calls. Pro Profil überschreibbar |
| `ai.openai-compat.tools` | `true` | – | Function-Calling verfügbar? `false` = agentischer Buch-Chat läuft für diesen Endpunkt klassisch (siehe „Tool-Use") |
| `ai.openai-compat.max_parallel` | 1 | – | Max. gleichzeitige Calls je Endpunkt; eigener Bucket pro KI-Profil |
| `ai.openai-compat.timeout_ms` | 600 000 | – | Hard-Timeout pro Call; ohne ihn hält ein stummer Endpunkt den Job-Slot unbegrenzt |
| `ai.openai-compat.retry_max` | 3 | – | Retry-Versuche bei 408/429/5xx mit Exponential-Backoff |
| `ai.openai-compat.{model,context_window,max_tokens_out,timeout_ms}.komplett` | leer / 0 | – | Per-Job-Overrides der Komplettanalyse (leer/0 = folgt global), siehe „Per-Job-Konfiguration“ |
| `ai.chars_per_token` | provider-default (3 Claude / 4 lokal) | – | Tokenizer-Heuristik (Boot-frozen). Gesetzt gilt der Wert fuer **alle** Provider — leer lassen, wenn Claude und ein lokales Modell nebeneinander laufen |
| `ai.chat_temperature` | – | – | Override nur für Abschnitts-/Buch-Chat |

| Provider | Streaming | Tool-Use | Caching |
|----------|-----------|----------|---------|
| `claude` | SSE | Ja (`callAIWithTools`, native `tool_use`-Blöcke) | `cache_control: ephemeral`, optional `ttl: '1h'` |
| `ollama` | NDJSON | Nein | Nein |
| `openai-compat` | OpenAI-SSE | Ja (OpenAI-Function-Calling, Schalter `ai.openai-compat.tools`) | Nein |

**Tool-Use ist eine Fähigkeits-, keine Klassenfrage.** SSoT ist `providerSupportsTools(provider)`
([lib/ai/config.js](../lib/ai/config.js)) — dieselbe Funktion lesen der Dispatch in
`lib/ai/core.js` **und** die Pfadwahl des agentischen Buch-Chats
([book-chat.js](../routes/jobs/chat/book-chat.js)#`_bookChatUseAgent`). Zwei
verschiedene Fragen an diesen zwei Stellen heissen: der Job wählt den agentischen
Pfad, und der erste Call wirft «Tool-Use nicht unterstützt».

Der Loop selbst ([agentic-chat.js](../routes/jobs/agentic-chat.js)) spricht **eine**
Sprache: die kanonische Anthropic-Form (`tools[{name, description, input_schema}]`,
Content-Blöcke `tool_use`/`tool_result`). Jeder Provider übersetzt selbst und liefert
sein Ergebnis wieder in dieser Form (`toolUses` / `stopReason` / `rawContentBlocks`);
die Übersetzung für OpenAI-Function-Calling liegt in
[lib/ai/tool-translate.js](../lib/ai/tool-translate.js) (rein, getestet in
`tests/unit/ai-tool-translate.test.js`). Vier Eigenheiten des openai-compat-Pfads:

- **Kein `response_format`** im Tool-Modus — ein erzwungenes JSON-Objekt drängt das
  Modell in eine JSON-Antwort statt in einen Werkzeug-Aufruf. Die Struktur der
  Endantwort erzwingt dort das `final_answer`-Werkzeug.
- **`stopReason` folgt dem Inhalt, nicht `finish_reason`:** viele Endpunkte melden
  `stop`, obwohl `tool_calls` im Delta standen — nach `finish_reason` gerechnet
  bräche der Loop die Recherche nach Runde 1 ab.
- **Text-Rettung:** schreibt ein Modell den Aufruf als Text (`[TOOL_CALLS][{…}]`,
  Code-Fence-JSON), wird er zum Tool-Use umgedeutet, sofern der Name im angebotenen
  Satz steht. Ohne das wäre das JSON-Fragment die «Antwort» des Agenten.
- **`tool_call_id` verbatim zurück** (Mistral validiert auf 9 alphanumerische
  Zeichen); Ersatz-IDs entstehen nur, wenn der Endpunkt gar keine liefert.

Lehnt ein Endpunkt Werkzeuge ab (400/404/422 mit Tool-Bezug), trägt der Fehler den Code
`AI_TOOLS_UNSUPPORTED` — der Buch-Chat fällt damit auf den klassischen Pfad zurück
(`fallbackJob` in `makeAgenticChatJob`) statt den Job zu verlieren. Ollama hat noch
keinen Pfad: `/api/chat` kann `tools`, aber in eigenem Wire-Format.

Beide entfernten Provider (`claude`, `openai-compat`) haben Hard-Timeout und Retry-Ladder; Details unter „Timeout + Retry“.

Ollama läuft über einen globalen **Mutex** (`withOllamaLock`) — VRAM-Schutz, parallele Calls würden das Modell abschmieren lassen. OpenAI-kompatibel läuft über eine **Semaphore** (`withOpenAICompatLock`) mit konfigurierbarer Obergrenze `ai.openai-compat.max_parallel` (Default 1). Beide führen einen eigenen Bucket **je KI-Profil** (siehe unten) — verschiedene Endpunkte vertragen verschiedene Last. Jobs laufen weiter parallel; die KI-Calls am Server sind auf die Semaphore-Grenze gedrosselt (bzw. bei Ollama seriell).

### Reasoning/„Thinking" (nur lokale Provider)

Viele lokale Modelle (Qwen3, DeepSeek-R1-Distill, Magistral …) denken per Default und verbrennen Output-Token für eine `<think>`-Spur, die der App nichts bringt (wir parsen nur `message.content` bzw. `delta.content`, die Spur landet in `thinking`/`reasoning_content` und wird verworfen). `ai.ollama.think` / `ai.openai-compat.think` (Default `false`) schalten das pro Provider ab; per-Call gelesen → Admin-Änderung greift ohne Server-Restart.

- **Ollama:** top-level `think: <bool>` im `/api/chat`-Body (nicht in `options` — dort wird es ignoriert).
- **OpenAI-kompatibel:** bei `false` reicht der Body `chat_template_kwargs: { enable_thinking: false }` an die Jinja-Chat-Vorlage durch (vLLM/SGLang/llama.cpp; Server ohne dieses Kwarg ignorieren es folgenlos). Bei `true` wird das Feld **nicht** gesendet, damit echtes OpenAI (lehnt unbekannte Felder ab) nutzbar bleibt.

## Token-Budgets

Boot-Konstanten in `lib/ai.js` lesen den **Claude-Globalwert** beim Modul-Load:
- `MODEL_CONTEXT = ai.claude.context_window`, bei 0 aus dem globalen Claude-Modell abgeleitet (`_claudeModelContext`: Opus 4.7+/Sonnet 5+/Fable 1M, ältere 200K). Pro Call rechnet `_resolveClaudeContextWindow` am **effektiven** Modell (Job-Override vor global).
- `MAX_TOKENS_OUT = ai.claude.max_tokens_out`, bei 0 aus dem Modell abgeleitet (`_claudeModelMaxOut`). Job-spezifische Overrides per `Math.min` gedeckelt.
- `CHARS_PER_TOKEN`: Default `3` (Claude) / `4` (lokal), Override via `ai.chars_per_token`. Tokenizer-Heuristik für Char→Token-Umrechnung. Die Konstante folgt dem **global** eingestellten Provider und ist ausserdem die **Anzeige**-Rate (`page_stats.tok`, `/config` → Frontend) — eine Zahl pro Instanz, weil `page_stats` buchweit persistiert wird und nicht pro User verschiedene Umfänge zeigen darf. Die **Budget**-Rechnung nimmt dagegen die Rate des gefragten Providers (siehe `getContextConfigFor` unten).

Abgeleitet:
- `INPUT_BUDGET_TOKENS = MODEL_CONTEXT − MAX_TOKENS_OUT − contextSafetyMargin(MODEL_CONTEXT)`.
- `INPUT_BUDGET_CHARS = INPUT_BUDGET_TOKENS × CHARS_PER_TOKEN`.

`contextSafetyMargin(ctx) = max(2000, round(ctx × 0.03))` — **proportional zum Fenster**, weil der Fehler der Char→Token-Heuristik mit der Prompt-Länge mitwächst: bei 72 000 geschätzten Input-Tokens deckt ein absoluter Puffer von 2000 keine 3 % Abweichung ab, während 5 % dort 3600 Tokens sind. Untergrenze 2000 für kleine Fenster (3 % von 8000 wären wirkungslos). Konkret: 200 000 → 6000, 90 000 → 2700, 32 000 → 2000, 1 000 000 (Komplett-Override) → 30 000.

Hard-Check beim Boot **pro Provider**: `max_tokens_out + contextSafetyMargin(context_window) < context_window`, sonst Crash (verhindert lokale-Provider-400-Fehler durch `max_tokens > num_ctx`). Derselbe Check läuft für den Komplett-Override (`ai.claude.max_tokens_out.komplett` gegen `ai.claude.context_window.komplett`) — Validierung und Budget-Rechnung lesen dieselbe Funktion, sonst divergieren sie. Der Frontend-Spiegel der Ableitung (`adminSettingsBudget` in [public/js/admin/admin-settings.js](../public/js/admin/admin-settings.js)) rechnet mit derselben Formel.

**Messen statt raten:** `npm run calibrate:tokens -- --book <id>` ([scripts/calibrate-chars-per-token.js](../scripts/calibrate-chars-per-token.js)) misst die tatsächliche Rate deutschen Buchtexts gegen `/v1/messages/count_tokens` (kostenlos, kein Inferenz-Call) und vergleicht sie mit der Annahme aus `_claudeCharsPerToken` — dieselbe Funktion, aus der die Budgets fallen, keine Kopie. Gemessen wird die **Differenz** zweier Probenlängen, damit der konstante Request-Overhead herausfällt. Liegt die Annahme ÜBER dem gemessenen Wert, passt weniger Text ins Fenster als gerechnet → Kontext-Overflow mitten im Job (Exit-Code 1). Nach jedem Modellwechsel laufen lassen: der Tokenizer der modernen Generation (Opus 4.7+/Sonnet 5+/Fable) produziert ~1×–1.35× so viele Tokens wie der ältere.

**Per-Provider via `getContextConfigFor(provider)`** ([lib/ai.js:968](../lib/ai.js#L968)): liefert `{ contextWindow, maxTokensOut, charsPerToken, safetyMargin, inputBudgetTokens, inputBudgetChars }` aus `ai.<provider>.context_window` + `ai.<provider>.max_tokens_out`. Fallback-Defaults: Claude aus dem effektiven Modell (`_claudeModelContext`), `ollama=32000`, `openai-compat=32000` (`PROVIDER_CONTEXT_DEFAULTS`). `charsPerToken` kommt **pro Provider** (`claude=3` bzw. modell-abhängig ≤2.5, lokal `4`) und nicht aus der globalen Boot-Konstante — im Mischbetrieb (KI-Profile) bekäme ein Claude-Call sonst die Rate eines lokalen Tokenizers und damit ein um ein Drittel zu grosses Zeichenbudget. Ein explizit gesetztes `ai.chars_per_token` übersteuert weiterhin alle Provider. Boot-Konstanten bleiben Claude-spezifisch für Backwards-Compat; neue Code-Pfade mit auflösbarem `userEmail` nutzen den Helper.

Job-Konstanten skalieren automatisch:
- `SINGLE_PASS_LIMIT = 0.7 × INPUT_BUDGET_CHARS`
- `PER_CHUNK_LIMIT  = 0.35 × INPUT_BUDGET_CHARS`
- `BOOK_CHAT_TOKEN_BUDGET` Default + Tool-Result-Caps + Classic-Buch-Chat-Text-Budget.

## API: callAI

```js
const { callAI } = require('../../lib/ai');

const { text, truncated, tokensIn, tokensOut, cacheReadIn, cacheCreationIn } = await callAI(
  userPrompt,
  systemPrompt,                          // String oder Array (s.u.)
  onProgress,                            // ({ chars, tokIn, delta }) => void
  maxTokensOverride,                     // optional, gedeckelt durch MODEL_TOKEN
  signal,                                // AbortController.signal
  provider,                              // optional, default API_PROVIDER
  jsonSchema,                            // optional: Grammar (lokal) bzw. Structured Outputs (Claude, s.u.)
);
```

**`systemPrompt` als Array** = mehrere Cache-Breakpoints (nur Claude):

```js
[{ text: bookText, ttl: '1h' }, { text: phaseSystem }]
// Claude: zwei cache_control-Blöcke (1h-Buch + 5min-Phase)
// Lokal:  zu einem String geflattet
```

Die TTLs müssen von vorne nach hinten **nicht steigen**: die API lehnt einen längeren TTL hinter einem kürzeren ab. Wer einen Block auf 5 min setzt, setzt darum alle dahinter mit (Muster [routes/jobs/komplett/call.js](../routes/jobs/komplett/call.js)#`withTtl`).

**TTL nach Leserzahl wählen.** Ein 1h-Write kostet 2× den Input-Preis, ein 5-min-Write 1.25×, ein Read 0.1×. Der 1h-Block lohnt sich nur, wenn mehrere Calls ihn lesen (Komplettanalyse: viele Pässe über denselben Buchblock); ein Job mit einem einzigen Leser schickt den Block mit 5-min-TTL (Standalone-Kontinuität und -Erzählprofil, [docs/komplett.md](komplett.md#caching--resume)).

**`callAIChat(messages, ...)`** — Multi-Turn-Variante mit Messages-Array.

**`callAIWithTools(messages, system, tools, ...)`** — Tool-Use für `claude` und `openai-compat`; wirft für Provider ohne Tool-Pfad mit `err.code = 'AI_TOOLS_UNSUPPORTED'` (Fallback-Signal, siehe oben). `messages` ist immer die kanonische Anthropic-Form. Caller verwaltet Loop: bei `stopReason === 'tool_use'` Tool-Results als `tool_result`-Blocks anhängen und neu callen.

## JSON-Pflicht

Jeder Systemprompt MUSS JSON-only erzwingen — `JSON_ONLY`-Konstante aus [public/js/prompts/state.js](../public/js/prompts/state.js).

Nach `callAI` ist Schema-Validierung Pflicht:

```js
const { text, truncated } = await callAI(...);
if (truncated) throw new Error('Output abgeschnitten — max_tokens erreicht.');
//                  ^^ IMMER vor parseJSON werfen, sonst liefert jsonrepair
//                     tolerant Partial-Daten (silent partial bug).

const parsed = parseJSON(text);
if (!parsed.fehler) throw new Error('Pflichtfeld `fehler` fehlt.');
```

`truncated`-Check zuerst, dann Parse, dann Pflichtfeld-Check.

## JSON-Parse-Fallback-Kette

`parseJSON(text)` in [lib/ai.js](../lib/ai.js):

1. Strip ```` ```json ```` -Fences, trim.
2. `JSON.parse()` direkt.
3. `extractBalancedJson()` — typ-sensitiver Stack, findet erstes balanciertes `{...}`.
4. `jsonrepair()` (toleranter Repairer).
5. `escapeUnescapedQuotes()` — escapet ASCII-`"` mitten in String-Werten (typisch: lokale Modelle vergessen Escape bei Anführungszeichen-Beispielen).
6. `jsonrepair(escaped)`.
7. Bei Fail: `_dumpParseFail` schreibt Rohtext in `ai_parse_fails/` (rotiert auf 50 Files), wirft mit Position-Preview.

`parseJSONLenient(text, [stringFields])` — schluckt Parse-Fehler, extrahiert benannte String-Felder einzeln per Regex (akzeptiert ASCII + typografische + DE/CH/FR-Quotes). Für User-Prosa-Rettung statt Job-Fail.

## Grammar-Constrained Decoding (lokal)

Optionales 7. Argument `jsonSchema`:
- **OpenAI-kompatibel**: `response_format: { type: 'json_schema', json_schema: { strict: true, schema } }` → GBNF-Grammar erzwingt Schema-Konformität + korrekt escapete Strings.
- **Ollama**: `format: <schema>` mit demselben Effekt.
- **Claude**: Structured Outputs, mit Ausnahme für den 1h-Präfix — siehe nächster Abschnitt.

Fixt die "unescaped `"` im String"-Klasse von Bugs, die mistral-small3.2 ohne Schema produziert.

## Structured Outputs (Claude)

Bei einem Modell mit Structured-Output-Support (`_claudeSupportsStructuredOutputs` in [lib/ai/config.js](../lib/ai/config.js): Opus 4.7+/Sonnet 5/Fable/Haiku 4.5/Legacy-Opus 4.5/4.1 — **nicht** Sonnet 4.6/4.5) sendet `_callClaude` ([lib/ai/claude.js](../lib/ai/claude.js)) das `jsonSchema` als `output_config.format` (`type: 'json_schema'`), neben dem Effort im selben `output_config`-Objekt. Das garantiert schema-valides JSON (kein Prosa-Leak durch adaptive Thinking, kein `jsonrepair`-Partial). Lehnt die API das Format ab (400 mit Schema-Hinweis → `AI_STRUCTURED_OUTPUT_UNSUPPORTED`), wiederholt `_callClaude` den Call **einmalig** ohne `output_config.format`, statt ihn non-retryable zu verwerfen.

**Kein Schema, wenn der vorderste System-Block als geteilter 1h-Präfix markiert ist** (`{ sharedPrefix: true, ttl: '1h' }`, `_isSharedPrefixSystem`). Das Schema bleibt dabei am Call — andere Provider brauchen es als Grammar, der Aufrufer für die Pflichtfeld-Prüfung —, nur Claude bekommt kein `output_config.format`. JSON erzwingen dort der Systemprompt (`JSON_ONLY` + Schema-Text) und der `truncated`-Check vor `parseJSON`. **Why:** Structured-Output-Schemas gehören zum Cache-Präfix. Lesen mehrere Pässe mit verschiedenen Schemas denselben 1h-Block (der Buchtext der Komplettanalyse), bricht jedes andere Schema den Cache, und jeder Pass schreibt den ganzen Block neu in den 1h-Cache (2× Input-Preis). Gemessen auf Prod: ~13 Buch-Writes pro Komplettanalyse-Lauf statt einem, rund 61 statt 18 USD pro Lauf. Die Regel hängt an der ausdrücklichen Markierung, nicht an der TTL: auch die `SYSTEM_*_BLOCKS` eines Buchs mit Autoren-Kontext beginnen mit einem 1h-Block (`_toCacheBlocks` in [public/js/prompts/core.js](../public/js/prompts/core.js)); ihre Calls (Lektorat, Review, Verify, F4-Urteil …) behalten Structured Outputs. Markiert sind nur der Buch- und der Kapiteltext-Block der Komplettanalyse. Gegated: [tests/unit/claude-shared-prefix-format.test.js](../tests/unit/claude-shared-prefix-format.test.js).

## Retries (nur Claude)

Transiente Fehler retryen mit Exp-Backoff (1s/2s/4s + Jitter, max `ai.claude.retry_max` = 3):
- HTTP 429 (Rate-Limit) — respektiert `retry-after`-Header.
- HTTP 529 (Overloaded).
- HTTP 503 mit `error.type === 'overloaded_error'` (Body-Typ-Detection via `_isOverloadedBody`).
- Stream-Event `overloaded_error` — nur retry wenn noch kein Text emittiert (sonst Output-Duplikat).

Nicht-retryable: alle anderen Status-Codes.

## Timeouts (Claude)

Hard-Timeout via `ai.claude.timeout_ms` (Default 600 000 ms = 10 min). `_combineSignals` merged User-Cancel und Timeout in einen AbortController. Marker `state.timedOut` unterscheidet Timeout (`code: 'AI_TIMEOUT'`) von User-Cancel (`AbortError`).

## Connection-Fehler (lokal)

`_connErrorCode` erkennt `ECONNREFUSED`/`ENOTFOUND`/`EHOSTUNREACH`/`ETIMEDOUT`/`EAI_AGAIN`/`ECONNRESET`/`ENETUNREACH` + node-fetch-`fetch failed`. Wirft i18n-keyed `error.OLLAMA_UNREACHABLE`/`error.OPENAI_COMPAT_UNREACHABLE` mit `i18nParams: { host, detail }`.

## Preflight: Input-Deckel vor dem Absenden

`assertPromptFitsContext` ([lib/ai/shared.js](../lib/ai/shared.js)) prüft **vor** jedem Call, ob geschätzter Input + Output-Cap + Sicherheitspuffer ins Kontextfenster passen:

```
estTokIn = promptChars / charsPerToken            // estimatePromptTokens(), zählt Prompt UND System-Blöcke
budget   = contextWindow − maxTokensOut − safetyMargin   // maxTokensOut = Cap DIESES Calls
estTokIn > budget  →  throw 'job.error.aiContextOverflow'
```

Der Wurf trägt `i18nParams: { provider, tokIn, window, maxOut, budget }` — die Meldung nennt die Zahlen und die drei Knöpfe (weniger Text, `ai.<provider>.context_window` höher, `ai.<provider>.max_tokens_out` tiefer).

Drei Aufrufer, ein Helfer:
- [routes/jobs/shared/ai.js](../routes/jobs/shared/ai.js)#`aiCall` — der Chokepoint, durch den alle Job-Calls laufen.
- `_callOllama` / `_callOpenAICompat` — defensiv, weil `callAIChat` aus den Chat-Jobs direkt in die Provider geht.

**Warum vorab:** ohne den Guard beantwortet llama.cpp/vLLM einen zu grossen Prompt mit `OpenAI-kompatibel 400: <Server-Text>` (kein Hinweis auf die Ursache), und Ollama kürzt still, weil es `num_ctx` selbst deckelt — der Job liefert dann ein Ergebnis über weniger Buch, als er behauptet. **Gekürzt wird darum nie automatisch**; der Job scheitert mit Ansage. Ist `contextWindow` unkonfiguriert, greift der Guard nicht (nicht raten).

Der Preflight **ersetzt den `truncated`-Check nicht** (siehe [JSON-Pflicht](#json-pflicht)): der eine deckt „Input zu gross", der andere „Output abgeschnitten".

## Sicherheits-Abbruch (lokal)

Während Streaming: wenn `estimatedOut > MAX_OUTPUT_RATIO × estimatedIn` (= 4×) → Abbruch + `truncated=true`. Schützt gegen Wiederholungs-Schleifen lokaler Modelle.

## Token-Tracking

Rückgabe enthält:
- `tokensIn` — Input-Tokens (inklusive Cache-Read + Cache-Creation bei Claude).
- `tokensOut` — generierte Output-Tokens.
- `cacheReadIn`, `cacheCreationIn` — Claude only, sonst 0.
- `truncated: bool` — `stop_reason === 'max_tokens'`.
- `genDurationMs` — Generation-Dauer ohne Setup-Zeit.

Lokale Provider: bei vollständigem Cache-Hit (`prompt_eval_count=0`) Fallback auf Char-Schätzung, damit Anzeige nicht 0 wird. Während Streaming KEIN Schätzwert für `tokIn` — sonst weicht Job-Status vom finalen `usage` ab.

## Kosten: Ledger und Anthropic-Abrechnung

Zwei Kostenquellen mit getrennten Aufgaben:

- **Ledger** (`ai_cost_ledger`, [db/cost-ledger.js](../db/cost-ledger.js)) — pro Call mit dem Tarif aus [lib/pricing.js](../lib/pricing.js) eingefrorene USD, mit User, Buch und Job-Typ. Grundlage für Budget-Gate, Pro-User-Auswertung und `/metrics`. Eine Preisänderung in `PRICING` wirkt nur auf künftige Calls.
  Admin-Usage → **Users** schlüsselt das Ledger pro User nach Job-Typ auf (Chat je Session-Art `page`/`book`/`research`, [db/admin-usage.js](../db/admin-usage.js)#`userJobBreakdown`, Route `GET /admin/usage/breakdown`), dazu eine Matrix User × die sechs teuersten Job-Typen. Calls ohne User laufen als eigene Zeile mit, damit die Summe der Aufschlüsselung der Ledger-Summe entspricht. Admin-Konten sind in allen Usage-Auswertungen nur mit `?includeAdmins=1` enthalten; das UI schickt den Parameter per Default (Schalter „Admins einbeziehen"), weil Admin-Calls genauso auf der Rechnung stehen.
- **Anthropic-Abrechnung** (`anthropic_cost_daily`, [lib/anthropic-billing.js](../lib/anthropic-billing.js)) — die tatsächlich abgerechneten Tageskosten aus der Cost-Report-API der Admin-API, je UTC-Tag × Modell/Token-Art/Workspace, ohne User-Bezug. Referenzwert, keine Zuordnung: Admin-Usage → **Abrechnung** stellt beides gegenüber. Weicht es ab, ist `PRICING` veraltet oder im Workspace läuft Fremdverbrauch.

Konfiguration: `ai.claude.admin_api_key` (Admin-Key `sk-ant-admin01-…`, ENV `ANTHROPIC_ADMIN_KEY`; ein normaler API-Key wird von der API abgewiesen) und `ai.claude.billing.workspace_id` (leer = ganze Organisation, `default` = Default-Workspace). Der Workspace-Filter greift beim Lesen — gespeichert werden alle Workspaces. Abruf täglich 05:15 per Cron (Korrekturwoche; bei leerer Tabelle 90 Tage Erstbefüllung) oder von Hand im Tab (31 Tage). Der Sync **ersetzt** den abgerufenen Tagesbereich, weil Anthropic jüngste Tage nachträglich korrigiert; leere Tage bekommen eine 0-Zeile, damit „abgerufen, nichts angefallen" von „nie abgerufen" unterscheidbar bleibt.

## Provider-Unterschiede in Prompts

`_isLocal`-Flag aus [public/js/prompts/state.js](../public/js/prompts/state.js) wird in `configurePrompts` gesetzt. Lokale Modelle bekommen abgespeckte Prompts (kein POV-/Tempus-Block, keine Figuren-Beziehungen, kein Nachbarseiten-Kontext) — sparen Tokens, weil lokale Kontextfenster meist 32-128K statt 200K sind.

Schemas werden per `_rebuildLektoratSchema()`/`_rebuildKomplettSchemas()` provider-spezifisch neu gebaut **vor** `configureLocales`.

### Zwei Instanzen, weil der Provider pro User auflöst

`_isLocal` ist ein **Modul-Flag**, die Provider-Auflösung aber **pro User** (`resolveProvider`, s.o.). [lib/prompts-loader.js](../lib/prompts-loader.js) hält darum zwei getrennte Modulgraphen — `cloud` (claude) und `local` (ollama, bzw. openai-compat je nach Klassen-Schalter) — und konfiguriert jeden **einmal**. `getPrompts(userEmail)` wählt die Instanz zum effektiven Provider; `getPromptsForProvider(provider)` für Aufrufer, die ihn schon aufgelöst haben (Chat-Titel-Job).

Ohne diese Trennung bekäme im Mischbetrieb jeder User die Prompts des jeweils anderen Providers: ein lokales Modell die Cloud-Felder, die das `_isLocal`-Gating bewusst weglässt, weil kleine Modelle sie halluzinieren (`machtverhaltnis`, `aeusseres`/`stimme`/`hintergrund`/`arc`) — und Claude die Slim-Variante **ohne** die `JSON_ONLY`-Pflichtanweisung, womit bei Claude-Modellen ohne Structured-Output-Support keine Schicht mehr reines JSON erzwingt.

**Nicht pro Call umkonfigurieren:** die Job-Queue läuft parallel, und Konsumenten halten die Namespace-Referenz über `await`-Grenzen hinweg (`const prompts = await getPrompts(u)` … später `prompts.SCHEMA_X`). Ein Flip zwischendurch zöge ihnen den Boden weg.

Die Isolation trägt der ESM-Resolve-Hook [lib/prompts-variant-hooks.mjs](../lib/prompts-variant-hooks.mjs): er zieht die Varianten-Query vom Eltern- auf jedes Kindmodul. **Ein blosser Query-Cache-Buster genügt nicht** — er dupliziert nur die Einstiegsdatei, die Dependencies (und damit `state.js` mit `_isLocal`) blieben geteilt. Fehlt `module.register` (Node < 20.6), fällt der Loader mit Warnung auf **eine** Instanz nach globalem Provider zurück. Gegated: die `Provider-Varianten`-Tests in [tests/unit/prompts.test.mjs](../tests/unit/prompts.test.mjs).

`PROMPTS_VERSION` unterscheidet sich zwischen den Instanzen (Content-Hash über die gebauten Prompts). Das ist korrekt und braucht **keinen** Bump des Basis-Prefix: alle provider-partitionierten Cache-Tabellen führen `provider` im PRIMARY KEY, und jeder `cacheVersion`-String enthält zusätzlich `_modelName(effectiveProvider)`.

### Provider-Klasse (`cloud` vs. `local`) und der Schalter `ai.openai-compat.cloud`

Die Klassen-Entscheidung ist SSoT in `providerClass(provider)` ([lib/ai/config.js](../lib/ai/config.js)): `claude` → `cloud`, `ollama` → `local`, `openai-compat` → per Default `local` (llama.cpp/vLLM & Co), mit Admin-Toggle `ai.openai-compat.cloud = true` → `cloud` (gehostete Frontier-APIs wie Kimi/Moonshot oder OpenAI über denselben Endpoint-Typ). Per-Call gelesen → greift ohne Server-Restart; beim Flip wechselt `PROMPTS_VERSION` mit der Variante, Caches invalidieren dadurch automatisch.

Konsumenten der Klasse (nicht des Provider-Namens):
- **Prompt-Variante** — `promptVariantFor` in [lib/prompts-loader.js](../lib/prompts-loader.js) (volle Cloud-Prompts inkl. `JSON_ONLY` vs. Slim-Prompts).
- **Lektorat-Kontext + Split** — `_isLocalProvider` in [routes/jobs/lektorat-page.js](../routes/jobs/lektorat-page.js): Klasse `cloud` lädt Nachbarseiten-Kontext (letzter Absatz der Vorseite, erster der Folgeseite — reiner Lesekontext, Findings daraus verwirft [lektorat-context.js](../routes/jobs/lektorat-context.js)#`dropNeighbourFindings`)/Figuren-Beziehungen/POV-Block wieder und lässt den fokussierten Objektiv/Stil-Split zu (sofern `ai.lektorat_split` aktiv).
- **Call-Serialisierung** — `settledAll` in [routes/jobs/shared/ai.js](../routes/jobs/shared/ai.js): Klasse `cloud` fährt parallel statt seriell; die Obergrenze bleibt die `max_parallel`-Semaphore.
- **Komplettanalyse-Strategie** — die Pipeline entscheidet durchgehend an der Klasse (`isCloudModel` in [job-komplett.js](../routes/jobs/komplett/job-komplett.js), `providerClass(effectiveProvider)` in den Phasen): kombinierter Extraktions-Pass statt Pass-A/B-Split, Single-Pass für Kontinuität und Erzählprofil, Completeness-Gap-Pässe, Coverage-Feedback + Self-Audit, Szenen-Backfill, Alias-Cluster, Entity-Reconcile-Judge, Soziogramm-Refine, Attribut-Check, Verify-Filter, Remap-Rescue und das Buchtext-Preprocessing.
- **Kontinuität + Erzählprofil auf allen drei Schichten** — `/config` (`komplett.continuity`/`narrativeProfile`, [routes/proxies.js](../routes/proxies.js)), Karten-Gate (`requiresCloudModel` in [feature-registry.js](../public/js/cards/feature-registry.js), gelesen aus `$store.config.effectiveProviderClass`) und Route-Guard (`400 CONTINUITY_PROVIDER_UNSUPPORTED` / `NARRATIVE_PROFILE_PROVIDER_UNSUPPORTED` in [routes/jobs/komplett/index.js](../routes/jobs/komplett/index.js)) stellen **dieselbe** Frage. Weichen sie auseinander, ist die Karte sichtbar und der Knopf antwortet 400.
- **Klasse am effektiven Provider, nicht am globalen.** Die beiden Job-seitigen Gates (`settledAll`, `_isLocalProvider`) lösen über `effectiveProviderClass()` auf. An `ai.provider` gelesen führe der Mischbetrieb sonst genau in die Irre, für die es die Zwei-Instanzen-Prompt-Schicht überhaupt gibt: ein Claude-User liefe seriell, weil global Ollama eingestellt ist, und ein Ollama-User parallel in den VRAM-Überlauf.

Bewusst **nicht** klassen-, sondern provider-gegatet (`=== 'claude'`): Prompt-Caching (`cache_control`) inklusive Warmup-Reihenfolge, der Recherche-Chat (er braucht Anthropics `web_search`-Server-Tool, nicht bloss irgendein Tool-Protokoll), Tiered Routing (`extractTier` — Claude-Modellnamen + `effort`), `ai.claude.phase1_concurrency`, der `web_search`-Faktencheck (`400 FACTCHECK_CLAUDE_ONLY`) und die aus dem Claude-Fenster abgeleitete Chunk-Obergrenze. Ein openai-compat-Frontier-Modell bekommt mit dem Schalter also die volle Prompt- und Strategie-Behandlung, aber keine Claude-API-Features — der Recherche-Chat bleibt für solche User ausgeblendet.

### Per-Job-Konfiguration: der ALS-Bag `aiJob`

Job-Familien, die mit eigener Modell-/Fenster-Konfiguration laufen dürfen, setzen **einen** provider-skopierten Bag in den ALS-Context:

```js
setContext({ aiJob: { provider, model, contextWindow, maxTokensOut, timeoutMs, effort } })
```

Gelesen wird er ausschliesslich über `jobOverride(provider, field)` ([lib/ai/config.js](../lib/ai/config.js)) — und **nur, wenn der anfragende Provider derselbe ist**. Ohne diese Grenze bekäme ein Call gegen einen anderen Provider fremde Modell-Parameter (dieselbe Falle, gegen die auch das Profil-Overlay abgesichert ist). Leerstring/0/null zählen als „nicht gesetzt" und fallen auf den globalen Wert zurück.

Präzedenz: **per-Call-Tier > Job-Bag > Profil > Instanz-Setting.**

| Setzer | Provider | Settings-Präfix |
|--------|----------|-----------------|
| `_komplettAiOverrides` ([job-shared.js](../routes/jobs/komplett/job-shared.js)) | `claude`, `openai-compat` | `ai.<provider>.{model,context_window,max_tokens_out,timeout_ms}.komplett` (+ `effort.komplett` nur Claude) |
| `_bookChatClaudeOverrides` ([book-chat.js](../routes/jobs/chat/book-chat.js)) | `claude` (Tool-Use) | `ai.claude.*.bookchat` |
| `applyLektoratAiOverrides` ([lektorat-split.js](../routes/jobs/lektorat-split.js)) | `claude` | `ai.claude.model.lektorat` (leer = globales Modell) + `ai.claude.effort.lektorat` (Default `medium`, nur wenn das Lektorat-Modell adaptiv denkt; ohne Feld denkt Sonnet 5 auf `high` minutenlang stumm). Das effektive Modell fliesst in die Lektorat-cacheVersion und in `page_checks.model` |
| `applyReviewAiOverrides` ([shared/model.js](../routes/jobs/shared/model.js)) | `claude` | `ai.claude.effort.review` (Default `high`, nur wenn das Modell adaptiv denkt) für Buch- und Kapitelbewertung. Ohne Feld gälte der Modell-Default, und der wechselt mit dem Modell (Opus 5.5: `medium`). Der Effort fliesst in die Review-cacheVersion |

Ollama hat bewusst keinen Override-Satz: dort ist das Modell an das geladene Gewicht gebunden.

### Timeout + Retry: geteilte Mechanik, provider-eigene Auslöser

`combineSignals` / `timeoutError` / `withOverloadRetry` / `parseRetryAfter` / `retryDelayMs` / `overloadError` liegen einmal in [lib/ai/shared.js](../lib/ai/shared.js) und werden von Claude **und** openai-compat benutzt (Ollama nutzt nur den Timeout). Der Timeout deckt fetch **und** jedes `reader.read()` im Stream und endet als `AI_TIMEOUT` mit i18n-Key `job.error.aiTimeout`. Ein Fehler-Chunk im Stream (`{"error":…}`) wirft mit der Server-Meldung, statt still mit leerem Text zu enden. Provider-eigen bleibt nur, **welche** Antwort transient ist:

| Provider | Hard-Timeout | Retry-Versuche | transient |
|----------|--------------|----------------|-----------|
| `claude` | `ai.claude.timeout_ms` (600 000) | `ai.claude.retry_max` (3) | 429, 529, `overloaded_error` im Body |
| `openai-compat` | `ai.openai-compat.timeout_ms` (600 000) | `ai.openai-compat.retry_max` (3) | 408, 429, 500, 502, 503, 504 |
| `ollama` | `ai.ollama.timeout_ms` (1 800 000) | — (lokaler Mutex) | — |

Zwei Regeln gelten für beide: **wiederholt wird nur, was vor dem ersten Delta scheitert** (ein mitten im Stream abgerissener Call hat schon Text emittiert; den fängt `retryOnTransientAi` in [routes/jobs/shared/ai.js](../routes/jobs/shared/ai.js) auf Job-Ebene ab), und `state.timedOut` trennt Timeout von User-Abbruch — beides kommt sonst als `AbortError` an, und ein hängender Endpunkt verschwände als „vom User abgebrochen" statt als retrybares `AI_TIMEOUT`.

## KI-Profile: mehrere Modelle pro Provider, pro User zugewiesen

Die globalen `ai.<provider>.*`-Settings beschreiben **eine** Konfiguration je Provider. Ein Instanz-Betrieb braucht oft mehr: ein lokales llama.cpp **und** ein gehostetes Frontier-Modell laufen beide über `openai-compat`, mit verschiedenem Host, Key, Kontextfenster und verschiedener Klasse.

Dafür gibt es `ai_profiles` (Tabelle, Admin unter **Einstellungen → Provider → KI-Profile**, Routen `/admin/ai-profiles`). Ein Profil trägt einen Provider plus beliebig viele Parameter-Überschreibungen und wird im Benutzer-Tab einem User zugewiesen (`app_users.ai_profile_id`, `ON DELETE SET NULL`). **Es gibt keine zweite Zuweisungs-Achse daneben** — das Profil ersetzt den früheren `ai_provider_override`; Migration 271 überführt bestehende Overrides in gleichnamige Profile ohne eigene Parameter.

**NULL heisst global, nicht leer.** Jede Parameter-Spalte ist nullbar und fällt dann auf `ai.<provider>.<key>` zurück. Ein Profil trägt darum nur, was wirklich anders sein soll (oft nur `model`), und eine Änderung an der Instanz-Einstellung zieht weiterhin mit. Aufgelöst wird das an **einer** Stelle: `aiSetting(provider, key, { userEmail })` in [lib/ai/profile.js](../lib/ai/profile.js) — überall dort, wo früher `appSettings.get('ai.<provider>.<key>')` stand (Provider-Module, `getContextConfigFor`, `providerClass`, `_modelName`, die Semaphore). Der User kommt wie bei `resolveProvider` aus dem ALS-Context, sofern der Aufrufer ihn nicht mitgibt.

**Das Overlay greift nur beim eigenen Provider.** `aiSetting('ollama', 'model')` liefert für einen User mit openai-compat-Profil den globalen Ollama-Wert — sonst bekäme ein Call gegen einen anderen Provider die Parameter eines fremden Modells (etwa den Claude-Modellnamen als `model` an einen llama.cpp-Server).

Drei Folgen, die leicht übersehen werden:
- **Cache-Schlüssel.** `_modelName(provider)` ([routes/jobs/shared/model.js](../routes/jobs/shared/model.js)) geht in jeden `cacheVersion`-String und löst deshalb über das Profil auf. Der `provider`-Anteil im PRIMARY KEY der Cache-Tabellen unterscheidet zwei openai-compat-Profile ja nicht — ohne den Profil-Modellnamen träfen sie gegenseitig ihre Zeilen.
- **Semaphore je Endpunkt.** `withOpenAICompatLock` / `withOllamaLock` ([lib/ai/shared.js](../lib/ai/shared.js)) führen einen Bucket **pro Profil**. Ein gemeinsamer Zähler würde entweder den lokalen Server überfahren oder den gehosteten ausbremsen. Die Obergrenze liest `aiSettingByProfileKey` — gegen den Bucket, nicht gegen den ALS-Context: der Zähler wird beim Freiwerden eines Slots neu ausgewertet, und das passiert im Kontext eines fremden Calls.
- **Fenster-Validierung beim Speichern.** Der Boot-Check in [lib/ai/config.js](../lib/ai/config.js) prüft nur die globalen Keys. Ein Profil mit `max_tokens_out + Puffer >= context_window` würde das Input-Budget still auf den 2000-Token-Floor kollabieren lassen — deshalb scheitert es in [routes/admin-ai-profiles.js](../routes/admin-ai-profiles.js) beim Speichern mit `CONTEXT_WINDOW_TOO_SMALL`, und `getContextConfigFor` warnt zusätzlich im Log.

Der API-Key liegt verschlüsselt (`enc:v1:`, [lib/crypto.js](../lib/crypto.js)) und verlässt den Server nie; die Admin-UI schickt beim Bearbeiten `__unchanged__`, wenn das Feld leer bleibt. `has_api_key` ist das einzige, was die Liste darüber verrät.

## Eigener KI-Zugang (Profil, Self-Service)

Ein Konto kann im Profil (**Profil → Eigener KI-Zugang**) einen eigenen API-Zugang hinterlegen — **Claude** (eigener Anthropic-Key, Modell optional) oder **OpenAI-kompatibel** (Endpunkt + Modell, Key optional, Klassen-Schalter `cloud`). Ollama ist ausgenommen: ein lokaler Server ist aus Sicht der Instanz immer ein internes Ziel. Der Admin öffnet bzw. schliesst das Feature über `ai.user_api.enabled` (Einstellungen → Provider → KI-Profile, Default aus). Zu heisst: Abschnitt weg, gespeicherte Zugänge bleiben liegen, greifen aber nicht; Entfernen geht weiterhin.

Gespeichert wird der Zugang als **KI-Profil mit `owner_email`** (höchstens eins pro Konto, `ON DELETE CASCADE`). Damit gelten Cache-Trennung (`_modelName`), Semaphore-Bucket je Profil und Key-Auflösung (`aiApiKey`) ohne zweite Mechanik. Er steht in keiner Admin-Liste und ist nicht zuweisbar (`/admin/ai-profiles` und `PUT /admin/users/:email` behandeln ihn als nicht vorhanden); im Benutzer-Tab zeigt ein Hinweis „Eigener Zugang: <Provider>". Routen: `GET|PUT|DELETE /me/ai-access` ([routes/me-ai-access.js](../routes/me-ai-access.js)); der Key geht nie zurück, nur `has_api_key`, und `__unchanged__` behält ihn — aber nur beim selben Provider.

Drei Invarianten, alle in [lib/ai/profile.js](../lib/ai/profile.js) bzw. [lib/ai/openai-compat.js](../lib/ai/openai-compat.js):
- **Kein Rückfall auf Host oder Key der Instanz.** `aiApiKey` liefert beim eigenen Zugang den eigenen Key oder `''`, nie `ai.<provider>.api_key`; `aiSetting(…, 'host')` erbt nie den Instanz-Host. **Why:** der Host kommt vom User — ein Rückfall schickte den Schlüssel des Betreibers an dessen Server bzw. den Key des Users ins interne Netz.
- **SSRF-Guard an zwei Stellen.** Beim Speichern `assertPublicUrl` (früh lesbar: `400 AI_ACCESS_HOST_BLOCKED`), bei jedem Call `safeFetch` mit `maxRedirects: 0` und ungelesenem Body (der Stream läuft wie gewohnt). Ein blockierter Host scheitert im Job als `error.AI_OWN_HOST_BLOCKED`.
- **Instanz-Overrides gelten nicht.** `usesOwnAccess()` → `jobOverride` liefert nur `timeoutMs`, `_resolveClaudeModel` ignoriert das Tier-Modell. Job-Modelle, Fenster und Effort beschreiben die Modelle der Instanz; an den Endpunkt des Users geschickt wären sie ein fremder Modellname bzw. liefen auf seine Kosten.

Der eigene Zugang schlägt die Admin-Zuweisung; die Kosten landen weiter im Ledger (`ai_cost_ledger`) unter dem Konto, das harte Monatsbudget ([lib/budget.js](../lib/budget.js)#`enforceBudget`) blockt ihn aber nicht — es deckelt die Kosten der Instanz, und die trägt hier der User. Test: [tests/unit/own-ai-access.test.js](../tests/unit/own-ai-access.test.js).

## Chat-Temperatur

`ai.chat_temperature` (app_settings) überschreibt Provider-Defaults nur für Abschnitts-Chat und Buch-Chat. Andere Job-Typen (Review, Lektorat, Komplett) bleiben deterministisch (Provider-Defaults: Ollama 0.2, Llama 0.1).
