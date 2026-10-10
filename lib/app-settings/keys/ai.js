'use strict';
// Settings-Keys: KI-Provider (Claude / Ollama / OpenAI-kompatibel), deren
// Per-Job-Overrides, sowie Job-Queue und die drei Chats.
// Teil der Registry — Deskriptor-Format und Regeln stehen in
// [../registry.js](../registry.js).

module.exports = {
  // KI-Provider
  'ai.provider': {
    default: 'claude',
    validate: { type: 'enum', oneOf: ['claude', 'ollama', 'openai-compat'] },
    env: [['API_PROVIDER', v => String(v).toLowerCase()]],
  },
  // Eigener KI-Zugang im Profil (Claude oder OpenAI-kompatibel, eigener API-Key auf
  // eigene Kosten). Aus = Abschnitt im Profil verschwindet, gespeicherte Zugaenge
  // bleiben liegen, greifen aber nicht (lib/ai/profile.js#activeProfile).
  'ai.user_api.enabled': { default: false, validate: { type: 'bool' } },
  'ai.claude.model': { default: 'claude-sonnet-4-6', env: [['MODEL_NAME', v => String(v)]] },
  // Per-Job-Overrides nur für die Komplettanalyse-Familie (leer/0 = folgt dem globalen
  // Wert). Erlauben z.B. Opus 4.8 mit 128K Output, vollem Kontext und längerem Hard-Timeout
  // für die gründlichere Extraktion, während global Sonnet 4.6 / 64K / 10min fürs Lektorat
  // läuft. WICHTIG: max_tokens_out muss zum komplett-Modell passen (Sonnet 4.6 ≤ 64000,
  // Opus 4.8 ≤ 128000) – ein zu hoher Wert für das gewählte Modell führt zu HTTP 400.
  // timeout_ms.komplett: Opus ist langsamer und der Single-Pass macht mehrere grosse Calls,
  // darum braucht die Buchanalyse oft mehr als die globalen 10 Min pro Call.
  'ai.claude.model.komplett': { default: '' },
  'ai.claude.context_window.komplett': { default: 0, validate: { type: 'int', min: 0, max: 2000000 } },
  'ai.claude.max_tokens_out.komplett': { default: 0, validate: { type: 'int', min: 0, max: 200000 } },
  'ai.claude.timeout_ms.komplett': { default: 0, validate: { type: 'int', min: 0, max: 3600000 } },
  // Tiered Model Routing (nur Komplettanalyse, nur Claude): günstigeres Modell für die
  // MECHANISCHEN Extraktions-Calls (Vollextraktion, Completeness-Gaps, Coverage-Audit,
  // Lebensereignisse), während die KONSOLIDIERUNG + das Kontinuitäts-Urteil auf dem
  // starken `ai.claude.model.komplett` laufen. Leer = kein Tiering (Extraktion folgt
  // ebenfalls `ai.claude.model.komplett`). Beispiel: extract=claude-sonnet-5,
  // model.komplett=claude-opus-4-8[1m]. Das Extraktions-Modell fliesst in die cacheVersion
  // (es erzeugt den gecachten Phase-1-Inhalt).
  'ai.claude.model.komplett.extract': { default: '' },
  // Effort (output_config.effort) NUR für die Komplettanalyse-Familie (P1–P8 + Kontinuität).
  // Leer = kein Effort-Feld (Modell-Default: 'high', Opus 5.5 'medium'). Sinnvoll auf Opus 4.7+/Sonnet 5: 'xhigh'
  // für die anspruchsvollsten Urteils-/Verify-Phasen, 'high' als Standard. Wird via ALS an
  // lib/ai.js gereicht (_resolveClaudeEffort) und greift NUR bei `ai.provider = claude`.
  // Ungültige Werte werden dort still auf null gemappt (kein 400). Achtung: Effort-Tokens
  // (adaptive Thinking) zählen gegen dasselbe max_tokens-Budget wie das JSON.
  'ai.claude.effort.komplett': { default: '' },
  // Effort NUR fuer die mechanischen Extraktions-Calls der Komplettanalyse (dieselbe
  // Gruppe, die `ai.claude.model.komplett.extract` routet: Vollextraktion,
  // Completeness-Gaps, Coverage-Audit/-Feedback, Szenen-Backfill, Lebensereignisse).
  // Leer = folgt `ai.claude.effort.komplett`.
  //
  // WOZU: Extraktion ist Aufzaehlen, kein Urteilen — die Denk-Tiefe der
  // Kontinuitaetspruefung ist dort verschenkt. Da Reasoning-Tokens auf dieselbe
  // Output-Rechnung laufen wie das JSON, ist das der direkteste Kosten- UND
  // Dauer-Hebel: 'medium' oder 'low' hier, waehrend `effort.komplett` fuer P8/
  // Konsolidierung/Verify hoch bleibt. Reicht der Recall nicht, wieder anheben.
  // Der Wert fliesst in die cacheVersion (Wechsel invalidiert die Phase-1-Caches).
  'ai.claude.effort.komplett.extract': { default: '' },
  // Effort fuer das Seiten- und Batch-Lektorat (routes/jobs/lektorat.js). Greift NUR
  // auf Modellen mit adaptivem Denken (Sonnet 5+, Opus 4.7+, Fable/Mythos): dort
  // waehlt die API ohne Effort-Feld den Modell-Default (meist 'high'), und das Modell denkt pro Pass Zehn-
  // tausende Tokens lang stumm — minutenlang kein Stream-Text, Output-Kosten ein
  // Vielfaches. Auf Sonnet 4.6 und aelter (kein Thinking) bleibt das Feld weg, damit
  // der dort bewaehrte Lauf unveraendert bleibt. Leer = kein Effort-Feld.
  // Fliesst in die cacheVersion des Lektorat-Caches.
  'ai.claude.effort.lektorat': { default: 'medium' },
  // Effort fuer Buch- und Kapitelbewertung (routes/jobs/review.js, kapitel.js). Greift NUR
  // auf Modellen mit adaptivem Denken; ohne Feld gilt der Modell-Default (Opus 5.5:
  // 'medium'), der fuer ein Urteil ueber das ganze Buch zu flach ist. Leer = kein
  // Effort-Feld. Fliesst in die cacheVersion der Review-Caches.
  'ai.claude.effort.review': { default: 'high' },
  // Eigenes Claude-Modell fuer Seiten- und Batch-Lektorat (routes/jobs/lektorat-split.js
  // #applyLektoratAiOverrides). Leer = folgt `ai.claude.model`. Erlaubt ein denkendes
  // Modell (z.B. Opus 5.5) fuers Lektorat, waehrend Seiten-Chat/Review beim globalen
  // Modell bleiben. Fliesst ueber das Modell in die cacheVersion des Lektorat-Caches.
  'ai.claude.model.lektorat': { default: '' },
  // Eigenes Claude-Modell fuer die KI-Synonymsuche (routes/jobs/synonyme.js
  // #applySynonymAiOverrides). Leer = folgt `ai.claude.model`. Die Suche ist ein
  // interaktiver Kurz-Call im Kontextmenue: ein schnelles Modell (Sonnet 5.5) halbiert
  // die Wartezeit gegenueber Opus bei gleichwertigen Vorschlaegen. Fliesst ueber das
  // Modell in die cacheVersion des Synonym-Caches.
  'ai.claude.model.synonym': { default: '' },
  // Effort der Synonymsuche, nur auf Modellen mit adaptivem Denken. Ohne Feld gilt der
  // Modell-Default (Sonnet 5.5: 'high'), der fuer eine Wortliste nur Wartezeit kostet.
  // Leer = kein Effort-Feld. Fliesst in die cacheVersion des Synonym-Caches.
  'ai.claude.effort.synonym': { default: 'low' },
  // Dieselbe Per-Job-Override-Familie für den Buch-Chat (klassisch + agentisch).
  // Leer/0 = folgt dem globalen Wert. Erlaubt z.B. Opus für den agentischen Tool-Loop
  // (bessere Tool-Auswahl/Mehrschritt-Reasoning im 6-Iterationen-Budget), während global
  // Sonnet 4.6 für Lektorat/Komplettanalyse läuft. Greift nur bei `ai.provider = claude`.
  'ai.claude.model.bookchat': { default: '' },
  'ai.claude.context_window.bookchat': { default: 0, validate: { type: 'int', min: 0, max: 2000000 } },
  'ai.claude.max_tokens_out.bookchat': { default: 0, validate: { type: 'int', min: 0, max: 200000 } },
  'ai.claude.timeout_ms.bookchat': { default: 0, validate: { type: 'int', min: 0, max: 3600000 } },
  // 0 = aus dem Modell abgeleitet (lib/ai/config.js#_claudeModelMaxOut bzw.
  // #_claudeModelContext). Nur setzen, um bewusst unter/über dem Modell-Default zu fahren.
  'ai.claude.max_tokens_out': {
    default: 0,
    validate: { type: 'int', min: 0, max: 200000 },
    env: [['MODEL_TOKEN', v => parseInt(v, 10)]],
  },
  'ai.claude.context_window': {
    default: 0,
    validate: { type: 'int', min: 0, max: 2000000 },
    env: [['MODEL_CONTEXT', v => parseInt(v, 10)]],
  },
  'ai.claude.retry_max': {
    default: 3,
    validate: { type: 'int', min: 0, max: 10 },
    env: [['CLAUDE_RETRY_MAX', v => parseInt(v, 10)]],
  },
  'ai.claude.timeout_ms': {
    default: 600000,
    validate: { type: 'int', min: 1000, max: 3600000 },
    env: [['CLAUDE_TIMEOUT_MS', v => parseInt(v, 10)]],
  },
  'ai.claude.phase1_concurrency': {
    default: 4,
    validate: { type: 'int', min: 1, max: 16 },
    env: [['CLAUDE_PHASE1_CONCURRENCY', v => parseInt(v, 10)]],
  },
  // Kosten-Abgleich (lib/anthropic-billing.js): Workspace, dessen abgerechnete
  // Kosten gegen das App-Ledger gestellt werden. Die Cost-Report-API liefert
  // die ganze Organisation — laeuft dort mehr als diese App (Claude Code,
  // andere Dienste), waere der Vergleich ohne Filter wertlos. Leer = alle
  // Workspaces, 'default' = der Default-Workspace (API: workspace_id NULL).
  'ai.claude.billing.workspace_id': { default: '' },
  'ai.ollama.host': { default: 'http://localhost:11434', env: [['OLLAMA_HOST', v => String(v)]] },
  'ai.ollama.model': { default: 'llama3.2', env: [['OLLAMA_MODEL', v => String(v)]] },
  'ai.ollama.temperature': {
    default: 0.7,
    validate: { type: 'number', min: 0, max: 2 },
    env: [['OLLAMA_TEMPERATURE', v => parseFloat(v)]],
  },
  'ai.ollama.context_window': { default: 32000, validate: { type: 'int', min: 2048, max: 2000000 } },
  'ai.ollama.max_tokens_out': { default: 16000, validate: { type: 'int', min: 512, max: 200000 } },
  // Anti-Loop: penalisiert kürzlich wiederholte Tokens und bricht so die
  // Wiederholungsschleifen, in die kleine Modelle bei grammar-constrained JSON
  // laufen (endloses Generieren identischer Array-Items bis zum Token-Cap).
  // 1.0 = aus; mild (1.1–1.2) reicht meist, ohne legitime Key-Wiederholung im
  // JSON zu schädigen.
  'ai.ollama.repeat_penalty': { default: 1.15, validate: { type: 'number', min: 1, max: 2 } },
  // Reasoning/„Thinking" an/aus. Viele lokale Modelle (Qwen3, DeepSeek-R1-Distill,
  // Magistral …) denken per Default und verbrennen so Output-Tokens für eine
  // <think>-Spur, die wir verwerfen. false (Default) unterdrückt das via Ollama-
  // `think`-Flag; true lässt das Modell denken.
  'ai.ollama.think': { default: false },
  // Hard-Timeout pro Call (ms), ueber fetch UND Stream. Ohne ihn haelt ein stummer
  // Ollama (Modell haengt beim Laden, VRAM-Ueberlauf) den Job — und wegen des
  // globalen Ollama-Mutex auch jeden wartenden Job — unbegrenzt fest. Default
  // grosszuegiger als bei den entfernten Providern: ein lokales Modell auf CPU
  // braucht fuer einen grossen Prompt schnell zehn Minuten und mehr.
  'ai.ollama.timeout_ms': { default: 1800000, validate: { type: 'int', min: 1000, max: 3600000 } },
  'ai.openai-compat.host': { default: 'http://localhost:8080', env: [['OPENAI_COMPAT_HOST', v => String(v)]] },
  'ai.openai-compat.model': { default: 'llama3.2', env: [['OPENAI_COMPAT_MODEL', v => String(v)]] },
  'ai.openai-compat.temperature': {
    default: 0.7,
    validate: { type: 'number', min: 0, max: 2 },
    env: [['OPENAI_COMPAT_TEMPERATURE', v => parseFloat(v)]],
  },
  'ai.openai-compat.context_window': { default: 32000, validate: { type: 'int', min: 2048, max: 2000000 } },
  'ai.openai-compat.max_tokens_out': { default: 16000, validate: { type: 'int', min: 512, max: 200000 } },
  // Optionaler Bearer-Token für gehostete OpenAI-kompatible Endpoints (vLLM,
  // LiteLLM, OpenAI). Leer = kein Authorization-Header (lokale llama.cpp-Server).
  'ai.openai-compat.api_key': { default: '', secret: true, env: [['OPENAI_COMPAT_API_KEY', v => String(v)]] },
  // Anti-Loop für OpenAI-kompatible lokale Server, siehe ai.ollama.repeat_penalty.
  'ai.openai-compat.repeat_penalty': { default: 1.15, validate: { type: 'number', min: 1, max: 2 } },
  // Reasoning/„Thinking" an/aus, siehe ai.ollama.think. false (Default) sendet
  // `chat_template_kwargs: { enable_thinking: false }` mit — der De-facto-Standard
  // für vLLM/SGLang/llama.cpp (Qwen3 & Co). Server ohne dieses Template-Kwarg
  // ignorieren es folgenlos. true sendet das Kwarg NICHT (Modell-Default, denkt
  // i.d.R.) — so bleibt auch echtes OpenAI, das unbekannte Felder ablehnt, nutzbar.
  'ai.openai-compat.think': { default: false },
  // Provider-KLASSE des openai-compat-Modells (SSoT: lib/ai/config.js#providerClass).
  // false (Default) = schwaches/lokales Modell (llama.cpp & Co): Slim-Prompts,
  // Kombi-Lektorat-Call, serielle Verarbeitung. true = gehostetes Frontier-Modell
  // (z.B. Kimi/Moonshot, OpenAI): volle Cloud-Prompts, Lektorat-Split, parallele
  // Calls (gedeckelt via max_parallel). Rein prompt-/strategie-seitig — Claude-API-
  // Features (Prompt-Caching, Web-Search, Tiered Routing) bleiben `=== 'claude'`.
  'ai.openai-compat.cloud': { default: false, validate: { type: 'bool' } },
  // Kann dieser Endpunkt Function-Calling? true = der agentische Buch-Chat darf
  // Werkzeuge anbieten (SSoT der Fähigkeits-Frage: lib/ai/config.js#providerSupportsTools).
  // Auf false stellen, wenn Endpunkt oder Modell kein Tool-Protokoll sprechen — der
  // Buch-Chat läuft dann klassisch. Wird ein Tool-Call trotzdem abgelehnt, fällt der
  // Job von selbst auf den klassischen Pfad zurück (AI_TOOLS_UNSUPPORTED).
  'ai.openai-compat.tools': { default: true, validate: { type: 'bool' } },
  // Max. gleichzeitige Calls an den OpenAI-kompatiblen Server. 1 = strikt seriell
  // (wie Ollama). Höher setzen, wenn der lokale Server parallele Requests verträgt
  // (z.B. LocalAI mit mehreren Slots). Überzählige Calls warten in einer Queue.
  'ai.openai-compat.max_parallel': { default: 1, validate: { type: 'int', min: 1, max: 16 } },
  // Hard-Timeout pro Call (ms). Ohne ihn haelt ein stummer Endpunkt — haengender
  // Stream, gehosteter Anbieter im Ausfall — den Job-Slot unbegrenzt fest.
  'ai.openai-compat.timeout_ms': { default: 600000, validate: { type: 'int', min: 1000, max: 3600000 } },
  // Retry-Versuche bei transienten HTTP-Antworten (408/429/5xx) mit Exponential-
  // Backoff. Deterministische Fehler (400/401/404) werden NICHT wiederholt.
  'ai.openai-compat.retry_max': { default: 3, validate: { type: 'int', min: 0, max: 10 } },
  // Per-Job-Overrides der Komplettanalyse — das openai-compat-Pendant zu den
  // `ai.claude.*.komplett`-Keys (leer/0 = folgt dem globalen Wert). Ein gehostetes
  // Frontier-Modell soll die Buchanalyse mit groesserem Fenster, hoeherem Output-Cap
  // und laengerem Timeout fahren duerfen als das Alltags-Modell fuer Lektorat/Chat.
  // Buch-Chat-Override (klassisch + agentisch), Pendant zu ai.claude.*.bookchat. Der
  // agentische Chat braucht den umgekehrten Zuschnitt der Analyse: viel Input
  // (Werkzeugkatalog + Erst-Kontext + Tool-Results, ungecacht pro Iteration), wenig
  // Output. Leer/0 = folgt den Standardwerten des Providers.
  'ai.openai-compat.model.bookchat': { default: '' },
  'ai.openai-compat.context_window.bookchat': { default: 0, validate: { type: 'int', min: 0, max: 2000000 } },
  'ai.openai-compat.max_tokens_out.bookchat': { default: 0, validate: { type: 'int', min: 0, max: 200000 } },
  'ai.openai-compat.timeout_ms.bookchat': { default: 0, validate: { type: 'int', min: 0, max: 3600000 } },

  'ai.openai-compat.model.komplett': { default: '' },
  'ai.openai-compat.context_window.komplett': { default: 0, validate: { type: 'int', min: 0, max: 2000000 } },
  'ai.openai-compat.max_tokens_out.komplett': { default: 0, validate: { type: 'int', min: 0, max: 200000 } },
  'ai.openai-compat.timeout_ms.komplett': { default: 0, validate: { type: 'int', min: 0, max: 3600000 } },
  'ai.chat_temperature': {
    default: 0.7,
    validate: { type: 'number', min: 0, max: 2 },
    env: [['CHAT_TEMPERATURE', v => parseFloat(v)]],
  },
  'ai.chars_per_token': {
    default: 3,
    validate: { type: 'number', min: 1, max: 10 },
    env: [['CHARS_PER_TOKEN', v => parseFloat(v)]],
  },
  // Obergrenze gleichzeitiger KI-CALLS im Batch-Lektorat (nicht Seiten!). Der
  // Seiten-Pool ergibt sich daraus geteilt durch die Calls pro Seite — bei aktivem
  // Split sind das objective_runs + 1 (siehe routes/jobs/lektorat.js). Default 4
  // ergibt mit dem Split-Default (1 Objektiv- + 1 Stil-Call) zwei parallele Seiten;
  // ein Wert von 2 liesse den Batch strikt seriell laufen.
  'ai.lektorat_batch_concurrency': {
    default: 4,
    validate: { type: 'int', min: 1, max: 8 },
    env: [['LEKTORAT_BATCH_CONCURRENCY', v => parseInt(v, 10)]],
  },
  // Handler-Backstop zur Prompt-Mengen-Obergrenze: max. Anzahl SUBJEKTIV-stilistischer
  // Lektorat-Findings pro 10'000 Zeichen Abschnittstext; die wirksame Zahl skaliert mit der
  // Länge (routes/jobs/lektorat-filter.js#effectiveStylisticCap, Deckel 5× bzw. 200).
  // (Liste: STILISTISCHE_TYPEN in
  // public/js/prompts/lektorat-typen.js). Objektive Fehler (Rechtschreibung/Grammatik/
  // Zeichensetzung, Tempus-/Perspektivbruch, Dialogformat) sowie Konsistenz-, Form- und
  // Beleg-Befunde werden NIE gekappt. Derselbe Wert steht als Obergrenze im Prompt
  // (dort priorisiert das Modell nach Schwere); der Handler-Filter ist die
  // deterministische Absicherung und verteilt die behaltenen Funde über den Text.
  // Default 10: Opus füllt eine genannte Obergrenze eher auf, als sie nur zu deckeln.
  'ai.lektorat_stylistic_cap': { default: 10, validate: { type: 'int', min: 1, max: 200 } },
  // Claude-Split: ob das Seiten-Lektorat in fokussierte Einzel-Pässe aufgeteilt wird
  // (Objektiv-Pass für Rechtschreibung/Grammatik + Stil-Pass für Stil/Szenen) statt
  // einem grossen Kombi-Call. Fokussierte Pässe liefern präzisere/vollständigere Funde.
  // Nur Cloud/Claude – lokale Provider fahren immer einen Kombi-Call.
  'ai.lektorat_split': { default: true, validate: { type: 'bool' } },
  // Anzahl paralleler Objektiv-Läufe, deren übereinstimmende Funde (Konsens) behalten
  // werden. Greift nur bei aktivem Split. Default 1 = ein Objektiv-Lauf ohne Konsens
  // (genau ein fokussierter Call pro Typ: Objektiv + Stil). Höher = Konsens für mehr Präzision.
  'ai.lektorat_objective_runs': { default: 1, validate: { type: 'int', min: 1, max: 6 } },
  // Konsens-Schwelle: ein objektiver Fund bleibt nur, wenn ihn ≥ so viele der K
  // Läufe melden. Höher = strenger/präziser, weniger Recall. Auf K geklemmt.
  'ai.lektorat_consensus_threshold': { default: 2, validate: { type: 'int', min: 1, max: 6 } },
  // Output-Token-Cap pro Komplettanalyse-Extraktions-Call (Phase 1: Single-Pass-
  // lokal sowie Multi-Pass Split-Pässe A/B). Basis-Versuch; bei Truncation eskaliert
  // der Job einmalig auf das Provider-Ceiling (`ai.<provider>.max_tokens_out`), statt
  // den Chunk zu verwerfen. Effektiv immer durch das Provider-Ceiling gedeckelt.
  'ai.komplett.extract_max_tokens': { default: 16000, validate: { type: 'int', min: 1024, max: 200000 } },
  // Completeness-/Gap-Pässe der Komplettanalyse (Cloud; Single-Pass pro Buch, Multi-Pass
  // pro Kapitel-Chunk): wie oft nach der Erst-Extraktion zusätzlich gezielt nach FEHLENDEN
  // Figuren/Schauplätzen/Fakten/Szenen gesucht wird (Long-Tail-Recall). 0 = aus. Default 2:
  // Gap-Pässe lesen den Text aus dem 1h-Cache (Single-Pass: Buchtext-Block; Multi-Pass:
  // Kapiteltext-Block, der nur bei > 0 überhaupt in den Cache geht) — die Eingabe kostet
  // ~0.1× statt 1×, die Ausgabe (inkl. Denken) voll. Loop-until-dry: stoppt früher, sobald
  // eine Runde nichts Neues liefert. Höher = gründlicher, mehr Tokens.
  'ai.komplett.completeness_passes': { default: 2, validate: { type: 'int', min: 0, max: 3 } },
  // Coverage-Self-Audit (nur Claude): nach der Konsolidierung werden N zufällige Kapitel
  // gesampelt und das Modell gefragt, welche namentlich genannten Figuren/Schauplätze im
  // Katalog FEHLEN → Recall-Score ins Job-Result (Sichtbarkeit statt Blindflug). Läuft auf
  // dem Extraktions-Tier (günstig). 0 = aus. Diagnostisch, nicht gecacht.
  'ai.komplett.coverage_audit_chapters': { default: 3 },
  // Schwelle, unter der der Coverage-Score als Warnung (job.warn.coverageLow) gemeldet wird.
  'ai.komplett.coverage_min_score': { default: 0.8 },
  // Attribut-Widerspruchs-Detektor (nur Claude): baut aus figure_events/world_facts eine
  // Attribut→Kapitel→Wert-Sicht, findet deterministisch Kandidatenpaare mit divergenten Werten
  // und lässt das Modell (Komplett-Modell, Effort low) nur diese beurteilen → Cross-Chapter-Widersprüche,
  // die der fakten-basierte Kontinuitäts-Pfad pro Kapitel strukturell übersieht. true = an.
  'ai.komplett.attribute_check': { default: true },
  // Entitaeten-Paar-Urteil beim Matching (nur Claude): die deterministische Schicht
  // (lib/entity-match.js) entscheidet nur die klaren Faelle und legt den Graubereich
  // («Schulhaus Frohheim» vs. «Frohheim-Schule Olten») dem Modell als Paare vor —
  // wenige Tokens, weil nur die unsicheren Paare gehen, nicht die Gesamtliste. Aus =
  // Unsicheres bleibt getrennt (verwaiste Dubletten, die man von Hand zusammenfuehrt).
  'ai.komplett.entity_match_judge': { default: true },
  // Weltfakten-Realitätscheck (Standalone-Job /jobs/faktencheck, nur Claude): prüft die
  // extrahierten Welt-Fakten mit Anthropics web_search gegen die reale Faktenlage. Instanz-
  // Kill-Switch — bewusst Default AUS, weil jede Web-Suche echtes Geld kostet; der Betreiber
  // schaltet ihn frei. Zusätzlich pro Buch opt-in (book_settings.weltfakten_real_pruefen).
  'ai.komplett.factcheck': { default: false },
  // Extraktions-Single-Pass-Schwelle (Zeichen), ENTKOPPELT von der Kontinuitäts-Schwelle.
  // 0 = folgt der Kontinuitäts-Schwelle (context_window-abgeleitet; heutiges Verhalten). >0
  // begrenzt die EXTRAKTION auf kleinere Chunks (höherer Per-Chunk-Recall + Alias-Cluster +
  // Multi-Pass-Gap), während Kontinuität/Erzählprofil weiterhin das ganze Buch im 1M-Fenster
  // sehen. Empfehlung für Opus 4.8 + 1M: ~700000. Fliesst in die cacheVersion (Wechsel
  // invalidiert die Extraktions-Caches). Nur Claude.
  'ai.komplett.extract_single_pass_cap': { default: 0, validate: { type: 'int', min: 0, max: 2000000 } },
  // Szenen-Backfill (nur Claude Single-Pass): Kapitel mit substanziellem Text (≥
  // scene_backfill_min_chars Zeichen), für die die Extraktion 0 Szenen lieferte, bekommen
  // einen gezielten Szenen-Nachzieh-Call. Deterministische Lückenerkennung, nur der Fix
  // braucht KI. true = an.
  'ai.komplett.scene_backfill': { default: true },
  'ai.komplett.scene_backfill_min_chars': { default: 3000, validate: { type: 'int', min: 500, max: 100000 } },
  // Figuren-Batch-Grösse für die Lebensereignis- (E) und Beziehungs- (A2) Pässe (nur Claude
  // Single-Pass): grosse Casts werden in Gruppen dieser Grösse gebündelt und parallel
  // abgefragt (kleinere, robustere Outputs, weniger Truncation). ≤ Cast-Grösse → 1 Call
  // (heutiges Verhalten für kleine Bücher). A2 batcht per «von»-Scope erst OBERHALB dieser
  // Grösse (Paar-Dedup übernimmt mergeBeziehungenIntoFiguren).
  'ai.komplett.figure_batch_size': { default: 20, validate: { type: 'int', min: 1, max: 200 } },
  // Obergrenze der Ereigniszahl, ab der die KI-Konsolidierung des Zeitstrahls (P6)
  // übersprungen wird — NUR für die Provider-Klasse 'local'. Die Konsolidierung ist rein
  // kosmetisch (Dedup + kanonische Formulierung) und ihr Output wächst linear mit der
  // Ereigniszahl; bei 20–30 tok/s kostet sie ab ein paar hundert Ereignissen zweistellige
  // Minuten und reisst zunehmend am Output-Cap. Übersprungen werden die Ereignisse
  // vorgruppiert direkt persistiert (kein Datenverlust, Warnung im Job-Result).
  // 0 = kein Deckel. Die Cloud-Klasse ist nicht betroffen (schneller, paralleler Call).
  'ai.komplett.timeline_consolidate_max': { default: 40, validate: { type: 'int', min: 0, max: 5000 } },
  // Remap-Rescue (nur Claude): vor dem Verwerfen nicht auflösbarer Klarnamen aus Szenen/
  // Events ein billiger Auflösungs-Call (Kandidaten + Katalognamen → Zuordnung oder
  // «unbekannt»), damit Szenen-Figuren-Links und Event-Assignments nicht verloren gehen.
  // Läuft nur, wenn es überhaupt unauflösbare Namen gibt. true = an.
  'ai.komplett.remap_rescue': { default: true },

  // Jobs / Buch-Chat
  'jobs.max_concurrent': {
    default: 1,
    validate: { type: 'int', min: 1, max: 8 },
    env: [['MAX_CONCURRENT_JOBS', v => parseInt(v, 10)]],
  },
  'jobs.book_chat.mode': {
    default: 'auto',
    validate: { type: 'enum', oneOf: ['auto', 'agent', 'classic'] },
    env: [['BOOK_CHAT_MODE', v => String(v)]],
  },
  'jobs.book_chat.max_tool_iter': {
    default: 12,
    validate: { type: 'int', min: 1, max: 50 },
    env: [['BOOK_CHAT_MAX_TOOL_ITER', v => parseInt(v, 10)]],
  },
  // Iterations-Deckel für Provider der Klasse 'local'. Bewusst niedriger als der
  // Cloud-Wert: ohne Prompt-Caching kostet JEDE Iteration den vollen Prompt erneut
  // (Werkzeugkatalog + Historie + Tool-Results), und ein lokales Modell braucht dafür
  // Sekunden bis Minuten pro Runde. 0 = kein eigener Deckel (nimmt max_tool_iter).
  'jobs.book_chat.max_tool_iter_local': {
    default: 6,
    validate: { type: 'int', min: 0, max: 50 },
  },
  // Werkzeugsatz des agentischen Buch-Chats. Der volle Katalog kostet ~10k Input-
  // Tokens PRO Iteration und überfordert kleinere Modelle bei der Auswahl.
  //   auto  = 'full' für Provider-Klasse 'cloud', 'slim' für 'local' (Default)
  //   slim  = kuratierte Teilmenge (BOOK_CHAT_SLIM_TOOL_NAMES in prompts/book-chat-tools.js)
  //   full  = alle Werkzeuge, unabhängig von der Klasse
  'jobs.book_chat.tool_set': {
    default: 'auto',
    validate: { type: 'enum', oneOf: ['auto', 'slim', 'full'] },
  },
  // Kosten-Deckel pro Antwort im agentischen Buch-Chat: kumulierte Input-Tokens über
  // alle Iterationen (cache-inklusiv). Erreicht → erzwungene Synthese-Runde nur mit
  // final_answer (wie beim Iterationsdeckel), kein Hart-Abbruch. 0 = aus.
  'jobs.book_chat.max_input_tokens_per_answer': {
    default: 500000,
    validate: { type: 'int', min: 0, max: 50000000 },
  },
  'jobs.book_chat.token_budget': {
    default: 0,
    validate: { type: 'int', min: 0, max: 2000000 },
    env: [['BOOK_CHAT_TOKEN_BUDGET', v => parseInt(v, 10)]],
  },
  // Klassischer Buch-Chat (Nicht-Claude / mode=classic): Anzahl der semantisch
  // retrievten Auszüge (ein bester Chunk pro Seite) im Mini-RAG-Pfad. Greift nur,
  // wenn der Embedding-Index aktiv ist; sonst Keyword-Scoring über alle Seiten.
  'jobs.book_chat.rag_top_k': { default: 40, validate: { type: 'int', min: 1, max: 200 } },
  // Agentischer Buch-Chat: Erst-Kontext (Vorab-Retrieval vor der ersten Iteration).
  // Die semantisch naechsten Passagen zur Frage stehen damit schon in Iteration 1 im
  // System-Prompt — schmale Faktenfragen («wie alt war X») brauchen dann gar keinen
  // Werkzeug-Aufruf, statt ueber search_passages/get_chapter_text zu eskalieren.
  // top_k = 0 ODER chars = 0 schaltet den Erst-Kontext ab (Agent wie vorher).
  // Greift nur mit aktivem Embedding-Index; sonst faellt der Block ersatzlos weg.
  'jobs.book_chat.pre_rag_top_k': { default: 8, validate: { type: 'int', min: 0, max: 50 } },
  'jobs.book_chat.pre_rag_chars': { default: 12000, validate: { type: 'int', min: 0, max: 200000 } },
  // Seiten-Chat: kleiner buchweiter Kontext-Block (die semantisch naechsten Stellen
  // aus ANDEREN Seiten zur Frage, aktuelle Seite ausgeschlossen). 0 = aus. Zeichen-
  // deckel: der kleinere Wert aus jobs.book_chat.pre_rag_chars und dem Seiten-Chat-
  // Budget (routes/jobs/chat/page-chat.js#_pageChatRagChars).
  'jobs.page_chat.pre_rag_top_k': { default: 4, validate: { type: 'int', min: 0, max: 20 } },
  // Recherche-Chat (Claude-only, mit Web-Suche). Kill-Switch + Iterations-Cap.
  'research_chat.enabled': { default: true, validate: { type: 'bool' } },
  'jobs.research_chat.max_tool_iter': { default: 6, validate: { type: 'int', min: 1, max: 50 } },
  // Gesamtdeckel der Anthropic-Web-Suchen über ALLE Runden einer Antwort (jede
  // Suche kostet extra, siehe lib/pricing.js WEB_SEARCH_USD_PER_1K). Der Loop
  // senkt `max_uses` des web_search-Werkzeugs pro Runde auf den Rest und nimmt
  // das Werkzeug ganz weg, sobald der Deckel erreicht ist.
  'jobs.research_chat.max_web_searches': { default: 10, validate: { type: 'int', min: 1, max: 100 } },
  // Plot-Chat (Panel der Plot-Werkstatt): Iterations-Cap pro Antwort. Vorschlags-
  // Aufrufe zaehlen mit, darum etwas hoeher als der Buch-Chat-Default.
  'jobs.plot_chat.max_tool_iter': { default: 8, validate: { type: 'int', min: 1, max: 50 } },
  // Ideen-Chat (Panel im Ideen-Board): Iterations-Cap pro Antwort. Der Erledigt-
  // Check liest viele Abschnitte, Vorschlags-Aufrufe zaehlen mit — wie der Plot-Chat.
  'jobs.ideen_chat.max_tool_iter': { default: 8, validate: { type: 'int', min: 1, max: 50 } },
};
