# Architektur und Projektstruktur

Vollstaendiges Datei-Inventar immer via `ls`/`find` — hier stehen nur Einstiege und Cluster.

## Architektur-Überblick

```
Browser → NGINX (HTTPS) → Express (Port 3737)
  /auth/*    → Google OIDC (Login/Callback/Logout/Me)
  /config    → Modell-Config + User (keine Credentials)
  /content/*       → Content-Store-Facade (Books/Chapters/Pages, Order, Revisions)
  /book-editor/*   → Page-Save/Apply, Locks, Presence
  /book-access/*   → ACL: User ↔ Book (Owner/Editor/Reader)
  /claude          → api.anthropic.com (ANTHROPIC_API_KEY-Injection, SSE)
  /ollama          → Ollama /api/chat (NDJSON → SSE normalisiert)
  /jobs/*          → Hintergrund-Jobs (Status-Polling, alle KI-Analysen)
  /events/stream   → SSE-Push der SPA: Job-Kanal + Buch-Abo (Anstösse für Collab-Changes/-Presence)
  /chat/*          → Abschnitts-Chat (SSE-Streaming) + Buch-Chat-Sessions
  /history/*       → Job-Verlauf (SQLite)
  /figures/*       → Figuren-CRUD (SQLite)
  /figures/:id/alter → Alterstabelle lesen (abgeleiteter Alters-Index, read-only, ab `viewer`)
  /jobs/figur-alter → Alters-Analyse: Altersangaben der Figuren aus dem Buchtext (Muster + semantische Nachlese, dann KI-Lesung der Kandidatensaetze)
  /draft-figures/* → Figuren-Drafts (Brainstorming vor Übernahme)
  /locations/*     → Orte-CRUD (SQLite, inkl. lat/lng/land für Geo-Karte)
  /geocode         → Geocoding-Proxy (Nominatim/Photon) für die Orte-Karte, kein KI-Call
  /motifs/consistency → Konsistenz-Befunde der Motiv-Kanten gegen den Ist-Index (deterministisch, kein KI-Call)
  /jobs/motif-consistency → KI-Urteil über den Motiv-Katalog (Belegstellen + Vorbefunde der Messung)
  /diagram/render  → Diagramm zu SVG rendern (Cache zuerst) für die Leseansichten — kein KI-Call, spart den 3,4-MB-mermaid-Bundle im Client
  /ideen/*         → Ideen/Pendenzen: CRUD + Stufen-Achse (`status`), Board (`/board`),
                     Verknuepfungen zu Recherche/Beat/Motiv + deren Rueckwaerts-Lesung
                     (`/links`) — user-privat, siehe docs/ideen-board.md
  /research/*      → Recherche-Board: Fundstueck-CRUD, Verknuepfungen (`research_item_links`), Tags, Anhaenge. `research_items.status` (`offen`/`in_arbeit`/`eingearbeitet`/`verworfen`) ist die **Einarbeitungs-Achse** und wird ausschliesslich per `PATCH /research/:id` gesetzt
  /sources/*       → Quellen-Bibliothek: Pool-CRUD (`sources`, pro User) + Buch-Zuordnung (`book_source_links`) + Fundstellen-Lesepfad
  /sources/import  → BibTeX-/RIS-Import (Parser `lib/bib-parse.js`, pure); pro Eintrag anlegen + zuordnen, Duplikate skippen statt abbrechen
  /sources/lookup  → DOI-/ISBN-Lookup (Crossref/OpenLibrary, `lib/source-lookup.js`), liefert nur einen Entwurf — kein KI-Call, darum keine Job-Queue
  /sources/from-research → Recherche-Fundstueck (`research_items`) als Quellen-Entwurf uebernehmen; optionales `url_id` waehlt GEZIELT einen seiner Links (Aktion sitzt je Link-Zeile im Board, nicht am Fundstueck)
  /research/:id/scrape → den Link eines Fundstuecks serverseitig lesen und Titel/Text/Herkunft uebernehmen (kein KI-Call; das schlechtere Verfahren als die Browser-Erweiterung, aber das einzige fuer einen aus der Android-App geteilten Link)
  /sources/by-url  → „liegt dieses Dokument schon im Pool?" (normalisierter URL-Vergleich, `lib/url-normalize.js`) — die Dublettenfrage der Browser-Erweiterung vor dem Erfassen
  /sources/evidence → Belegvorschlag: zu einer unbelegten Behauptung die passende Stelle in der eigenen Quellen-Bibliothek (semantisch, kein KI-Call); liefert `linked` mit, weil ein Marker nur als Fundstelle zaehlt, wenn die Quelle dem Buch zugeordnet ist
  /jobs/source-detect → Quellen-Erkennung: findet im Buchtext LOSE erwaehnte Werke (ohne Quellen-Marker) und schlaegt sie zur Aufnahme vor
  /jobs/source-pdf-draft → Quelle aus PDF: DOI/ISBN → Register, sonst Titelseite lesen → Register-Suche; liefert nur einen Entwurf (Anlage + Anhang laufen ueber /sources)
  /lexicon/:book_id  → Wortschatz-Analyse lesen (abgeleitete Kennzahlen + Ranglisten, read-only)
  /jobs/lexicon-scan → Wortschatz-Scan: laengenrobuste Diversitaetsmasse + Lieblingswoerter + Wendungen (kein KI-Call)
  /jobs/manuscript-import → EIN Word-/ODT-Dokument nach Ueberschriften-Ebenen in Kapitel + Seiten zerlegen (Zuordnung h1..h6 kommt vom User); …/preview liefert dieselbe Gliederung synchron, ohne zu schreiben — kein KI-Call
  /jobs/book-map   → Buchlandkarte: PCA- oder Pol-Projektion (Abschnitte oder Passagen) + Ähnlichkeitsmatrix in Lesereihenfolge mit Bruchstellen/Echos + Kapitel-Kohaesion + Ausreisser (kein KI-Call; Embedding-Call nur für Freitext-Pole)
  /jobs/book-map-label → Buchlandkarte: KI benennt die PCA-Achsen aus den Abschnitten an ihren Enden
  /jobs/redundancy → Redundanz-Radar: All-Pairs-Cosinus ueber die Seiten-Chunks des Index + Figuren-Dubletten (kein KI-Call, kein Embedding-Call)
  /capture         → Erfassen aus der Browser-Erweiterung: Recherche-Fundstueck und/oder Quelle in EINER Transaktion (`routes/capture.js`), Scope `capture:write`, kein KI-Call
  /songs/*         → Songs-Feature (Buch-Soundtrack)
  /redundancy/:book_id → Redundanz-Radar: letztes Ergebnis lesen + Paare ignorieren/wieder anzeigen (gerechnet wird in /jobs/redundancy, kein KI-Call)
  /booksettings/*  → Per-Buch-Settings (Buchtyp, Freitext, Zitierstil/Verzeichnis)
  /me/*            → User-Settings (Sprache, Modell-Override), Device-Tokens, Konto-Selbstloeschung
  /admin/ai-profiles → KI-Profile (benannte Modell-Konfigurationen, User-Zuweisung via app_users.ai_profile_id)
  /me/books        → Buecherregal: Kennzahlen je Buch (GET) + persoenliches Anheften/Archivieren (PUT), eigener Router [routes/mybooks.js](../routes/mybooks.js)
  /me/author-profile → Autorenprofil: stilistische Kennzahlen der EIGENEN Buecher nebeneinander, in Werk-Reihenfolge (read-time aus `book_lexicon` + `page_stats`, kein KI-Call, kein eigener Index), eigener Router [routes/author-profile.js](../routes/author-profile.js)
  /me/account      → DELETE: Konto-Selbstloeschung (App-Store-Guideline 5.1.1(v)), siehe harte Regel unten
  /sync/*          → Buchstatistik-Sync (manuell + Cron)
  /export/*        → Buch-Export (PDF/HTML/Markdown/Plaintext/EPUB via App-eigenen Builder)
  /search/*        → FTS5-Volltextsuche
  /categories/*    → Kategorie-Pool (CRUD, Zuordnung pro Buch via ACL)
  /pdf-export/*    → Custom-PDF-Export-Profile (CRUD + Cover-Upload + Font-Liste)
  /jobs/pdf-export → Render-Job (eigene pdfkit-Pipeline mit PDF/A-2B)
  /docx-export/*   → Custom-Word-Export-Profile (CRUD + Font-Whitelist)
  /jobs/docx-export → Render-Job (programmatische docx-Lib, Manuskript für Lektorat/Verlag)
  /blog/*          → WordPress-Blog-Connection (Buchtyp 'blog'): Test, Connect + geteilte Sync-Routen (routes/sync-router.js: Status, Links, Konflikt-Diff/-Resolve, Trennen)
  /hubspot/*       → HubSpot-Blog-Connection (Buchtyp 'blog'): Test, Blogs/Authors-Combo, Connect + dieselben geteilten Sync-Routen
  /jobs/blog-*     → Blog-Sync-Jobs (import, pull, push, reconcile; Push/Abgleich/Routen aus routes/jobs/sync/)
  /jobs/hubspot-*  → HubSpot-Sync-Jobs (import, push in den Draft-Buffer, reconcile; Push/Abgleich/Routen aus routes/jobs/sync/)
  /usage/*         → Feature-Usage-Tracking (Recency für Palette/Quick-Pills)
  /telemetry/*     → Block-Level-Merge-Counter (POST /telemetry/merge → merge_telemetry, exponiert via /metrics)
  /admin/books, /admin/logs, /admin/registration-requests, /admin/settings, /admin/usage, /admin/users
  /public/*        → Unauthentifizierte Endpoints (Health, Marketing)
  /                → public/index.html (SPA)

Cron (täglich nachts; Uhrzeit in lib/cron.js, TZ aus app.timezone) → syncAllBooks() → page_stats + book_stats_history
```

**Auth:** Alle Routen ausser `/auth/*` sind durch Session-Guard geschützt. HTML-Requests → Redirect auf Login. API-Requests → `401 JSON`.

**Credentials:** KI-Aufrufe laufen über Server-Proxies — der Server hält alle API-Keys.

**Content-Store-Facade ([lib/content-store/](../lib/content-store/)):** zentrale Storage-Abstraktion über das SQLite-Backend. Bündelt Page-Revisions, Tree-Overlay (book_order) und FTS-Index-Hooks am Schreib-Chokepoint. Konsumenten (Routes, Jobs, Sync) importieren ausschliesslich die Facade.

## Projektstruktur (thematische Cluster)

Vollständiges Inventar via `ls`/`find` — hier nur Einstiege und Cluster, damit Drift gegen Datei-Listings nicht jeden Refactor bricht.

- `server.js` — Express-Setup und Route-Mounting. Ausgelagert: `lib/csp.js` (CSP-Header), `lib/auth-guard.js` (Session-/Device-Token-Guard, 401 vs. Login-Redirect), `lib/async-routes.js` (async-Rejections → finaler JSON-Fehler-Handler), `lib/cron.js` (node-cron-Jobs), `lib/startup.js` (Boot-Aufgaben nach `listen`, Sync-Catch-up).
- `logger.js` — Winston-Config.
- **`lib/`** — Server-Libs. Highlights:
  - `ai.js` (callAI + Provider-Dispatch + JSON-Fallback), `content-store/` (Pages/Chapters/Books-Facade), `html-clean.js` (Page-HTML-Sanitization, **SSoT** vor jedem DB-Write).
  - PDF/Export: `pdf-render.js` + `pdf-render/` (Pipeline), `pdf-export-defaults.js`, `pdfa-validate.js`, `font-fetch.js`, `cover-prepare.js`, `export-builders/` (HTML/MD/EPUB/Plaintext), `bibliography.js` (Quellenverzeichnis + Kurzbeleg-Auflösung der Quellen-Chips; SSoT für jeden Ausgabeweg, siehe [docs/publikation-export.md](../docs/publikation-export.md)), `endnotes.js` (Anmerkungsapparat — die Alternative zum Inline-Kurzbeleg, gesteuert über `book_settings.citation_notes`: `endnotes` sammelt pro Kapitel, `footnotes` setzt an den Seitenfuss), `pdf-render/footnotes.js` (Platzierung am Seitenfuss: Reserve über `margins.bottom`, Zeichnen im Stamp-Pass). **Jeder Export-Builder ruft als erstes `prepareCitations` aus [lib/export-builders/shared.js](../lib/export-builders/shared.js)** und rendert danach dessen `groups` — ohne das steht im Export der Chip-Text vom Einfüge-Zeitpunkt statt des aktuellen Kurzbelegs (im numerischen Stil die Autor-Jahr-Form statt der Nummer). Der Helper entscheidet auch zwischen den **zwei Belegdarstellungen** (`book_settings.citation_notes`): Kurzbeleg inline **oder** Anmerkungsapparat — nie beide hintereinander, der zweite Pass überschriebe den ersten. Neuer Ausgabeweg ⇒ derselbe Aufruf, keine eigene Auflös-Logik.
  - Cross-cutting: `acl.js`, `admin-mw.js`, `admin-login-ratelimit.js`, `register-ratelimit.js`, `app-settings.js` (Speicher; Key-Registry in `app-settings/`), `budget.js`, `fehler-heatmap.js` (pure Heatmap-Aggregation), `lektorat-findings.js` (Zählregel offen/angenommen/alle für Heatmap + Fassungs-Kennzahl), `pricing.js`, `cache-cleanup.js`, `crypto.js`, `dev-seed.js`, `draft-mindmap-builder.js`, `filenames.js`, `i18n-server.js`, `load-contents.js`, `local-date.js`, `log-context.js`, `mailer.js` + `mailer-templates.js`, `notify.js`, `page-index.js` + `sentence-split.js` (Satzzerlegung der Stil-Metriken), `prompts-loader.js`, `search.js`, `slug.js`, `validate.js`.
- **`db/`** — SQLite-Split. Einstieg: `connection.js`, `migrations.js`, `schema.js`, `squashed-schema.js` (Fresh-DB-Fast-Path). Eine Domäne pro File: `books`, `pages`, `page-revisions`, `page-presence`, `figures`, `draft-figures`, `book-access`, `book-categories`, `book-order`, `app-users`, `user-directory` (Sichtkreis fremder Anzeigenamen: eigener Account + Co-Mitglieder der eigenen Bücher, SSoT für `GET /me/users-light`), `registration-requests`, `token-usage`, `admin-usage`, `budget-alerts`, `pdf-export`, `fonts`.
- **`routes/`** — Ein Router pro Feature. Namen entsprechen der Routen-Tabelle oben.
  - `history.js` ist Facade über `history/` (checks, reviews, stats, heatmap, time-tracking, shared) — Submodule registrieren via `register(router)` auf denselben Router, Muster wie `content.js`/`content/`.
  - `figures.js` traegt zusaetzlich `figures/zeitstrahl.js` (GET `/figures/zeitstrahl/:book_id` + Buch-Chronologie) via `register(router)` — eigenes Thema (`zeitstrahl_events`), aber derselbe Router, damit ACL-/Log-`router.param` und die Reihenfolge vor `/:book_id` gelten.
  - `jobs.js` mountet alle Job-Sub-Router. Subfolder: `jobs/shared/` (Queue, AI-Helper, Loader, Model, Queries, Router, State) und `jobs/komplett/` (Pipeline: index, job, phases, checkpoint, figuren-merge, remap, utils). Single-File-Job-Router: `lektorat`, `review`, `kapitel`, `chat`, `synonyme`, `figur-werkstatt`, `pdf-export`. Helper-Files (kein Router): `narrative-labels`, `book-chat-tools`, `review-context`. `finetune-export/` als Subfolder mit eigenem Router.
- **`public/`** — SPA.
  - `index.html` Shell; `partials/` werden via `_loadPartials()` nested geladen.
  - `css/` thematisch gesplittet (eine Datei pro Komponente; grosse Cards als Subfolder, z.B. `book-overview/`). `tokens.css` Facade-File (importiert `tokens/`-Module); Cascade via `@layer base, components, utilities`. `tokens.css` selbst unlayered.
  - `js/app.js` Alpine-Root; `js/app/` Root-Slices (`app-state`, `app-view`, `app-ui`, `app-jobs-core`, `app-hash-router`, `app-navigation`, `app-chrome`, `app-komplett`, `app-collab`, `app-collab-stream`).
  - `js/cards/` — Alpine-Sub-Komponenten, eine pro Karte. **SSoT-Liste in [feature-registry.js](../public/js/cards/feature-registry.js)** — nicht hier pflegen. Shared neben den Karten: `catalog-store.js`, `feature-registry.js`, `job-helpers.js`, `job-feature-card.js`, `card-lifecycle.js`, `palette-card.js`/`palette-fuzzy.js`/`palette-providers.js`.
  - `js/book/` — Buch-/Seiten-Fachmodule (tree, page-view, history, review, kapitel-review, fehler-/stil-heatmap, kontinuitaet, ereignisse, orte, szenen, figuren, ideen, finetune-export, export, songs, book-create, book-settings, bookstats). **Die drei Heartbeat-Zeit-Tracker** (`writing-time`, `lektorat-time`, `stt-time`) sind Spec-Objekte über `heartbeat-tracker.js` (Timer-Lifecycle, Flush, Senden) und `heartbeat.js` (Tick-Clamp + Tab-Lease, hält `HEARTBEAT_MS`) — sie halten nur ihre Unterschiede (`isActive`, `watch`, `onStart`, `payload`, `skipTick`). Serverseitig spiegelt [db/time-tracking.js](../db/time-tracking.js) dieselbe Spec-Idee (Tabelle, Zusatzspalten, Scope-Spalte), die sechs Routen erzeugt [routes/history/time-tracking.js](../routes/history/time-tracking.js) daraus. **Ein vierter Zähler ist je ein Spec-Eintrag, kein viertes Modul.**
  - `js/editor/` — Editor-Fachmodule (`utils`, `edit`, `focus/` + `focus.js`, `find`, `synonyme`, `figur-lookup`, `toolbar`, `lektorat`, `shortcuts`, `draft-storage` + `draft-idb` (Entwürfe in IndexedDB), `live-edit`). Cards in `cards/editor-*-card.js` importieren von hier.
  - Feature-eigene Submodul-Cluster (Facade-File + gleichnamiger Subfolder): `book-overview.js` + `book-overview/`, `figur-werkstatt.js` + `figur-werkstatt/`, `graph.js` + `graph/`, `cards/ereignisse-card.js` + `cards/ereignisse/` (`date`, `subtyp`, `band`, `model` — reine Module, von der Karte re-exportiert).
  - Weitere Cluster: `js/chat/`, `js/admin/`, `js/api/`, `js/i18n/`, `js/repo/`.
  - `js/prompts.js` Facade; `js/prompts/` Submodule pro Job-Typ (state, schema-utils, blocks, core, lektorat, review, komplett, chat, synonym, finetune, figur-werkstatt).
  - Cross-cutting Top-Level: `utils.js`, `lazy-libs.js` (vis-network/Chart.js on-demand), `features-usage.js`, `user-settings.js`, `num-input.js`, `page-revision-diff.js`, `diff/` (geteilter Diff-Kern: `word-diff.js`, `diff-parts.js` Markierung, `html-blocks.js` Text-Extraktion — für Historie, Fassungen, Kommentar-Leisten, Konflikt-Auflösung und Chat-Vorschläge), `theme-init.js`, `plausible-init.js`, `tooltip.js`, `fullscreen.js`, `register.js`.

## File-Limits / Modularitaet

- **File-Limits / Modularität** — JS-Module > 600 LOC (Browser **und** Server: `lib/`, `routes/`, `db/`), HTML-Partials > 250 LOC, CSS-Files > 600 LOC werden gesplittet in `<name>/`-Subfolder mit thematischen Sub-Files. Pattern: Facade-File `<name>.js` re-exportiert Sub-Module; Sub-Module gruppieren Methoden nach Domäne (z.B. `load/stats/coverage/figuren/orte/kapitel/recent/format`). Beispiele: [public/js/prompts/](../public/js/prompts/), [public/js/book-overview/](../public/js/book-overview/), [public/css/book-overview/](../public/css/book-overview/), [public/css/components/](../public/css/components/), [public/partials/bookoverview-*.html](../public/partials/bookoverview-snapshot.html). HTML-Partials werden via `_loadPartials` mit `<div id="partial-<name>">`-Placeholdern nested geladen (5-Pässe-Schleife, max 1-2 Verschachtelungstiefen). Für **geteiltes Markup innerhalb von `<template>`/`x-for`** (wo der DOM-Placeholder nicht greift — `querySelector` steigt nicht in Template-Content ab) gibt es den **string-seitigen Fragment-Include** `<!-- @include <name> -->` ([app-ui.js](../public/js/app/app-ui.js)#`_resolveIncludes`, ersetzt vor `innerHTML`/`Alpine.initTree`): das eingefügte Markup wird Teil des Template-Contents und pro Loop-Iteration normal geklont. SSoT-Beispiel: [public/partials/plot-beat-cell.html](../public/partials/plot-beat-cell.html) (Beat-Karte, geteilt zwischen flachem + Grid-Board). CSS-Subfolder via einzelne `<link>`-Tags in [public/index.html](../public/index.html) (Cascade-Order = Lade-Order, base zuerst). Tile-Compute-Methoden, die mehrfach pro Render gerendert werden, sind Pflicht-memoized. Maschinell gegated: [tests/unit/loc-limits.test.mjs](../tests/unit/loc-limits.test.mjs) — vier Kategorien (JS-Modul, HTML-Partial, CSS-File, **Server-Modul** = `lib/` + `routes/` + `db/`), Cap pro Kategorie + Ratschen-Allowlist für bestehende Überschreiter (dürfen nur schrumpfen); neue Datei über dem Cap → CI rot. Beim Split einer allowlisted Datei deren Eintrag im Test streichen. Wächst eine Altlast durch eine berechtigte Änderung, das Ceiling dort nachziehen — nicht die Kategorie aufweichen. `exclude` (derzeit nur [db/migrations.js](../db/migrations.js)) ist Dateien vorbehalten, bei denen Wachstum in der Natur der Sache liegt: die Reihenfolge der `if (version < N)`-Blöcke **ist** dort die Struktur, ein Split wäre sinnlos. Server-Beispiel für einen Split: [db/sources/](../db/sources/) (Facade + fünf Themen).

## Eigenbau statt Library — bewusst

Die folgenden Teile sind geprüft und bleiben Eigenbau. Wer eine Library dafür vorschlägt, widerlegt zuerst die Begründung.

- **Die drei Editoren** (`contenteditable` + eigenes Undo in [edit-history.js](../public/js/editor/shared/edit-history.js), Block-IDs, Block-Merge): ProseMirror/Tiptap/Lexical wären ein Neubau, kein Tausch. Save-Pipeline, Block-Markup-SSoT, das OTA-Bundle der nativen Clients ([contract/](../contract/README.md)) und der stabilisierte Focus-Editor hängen daran.
- **PDF-Layouter** ([lib/pdf-render/](../lib/pdf-render/)): Paged.js/Vivliostyle über Chromium-PDF kann weder PDF/X noch CMYK und gibt Zeilenumbruch, Silbentrennung, Fussnotenapparat und Initialen aus der Hand. Der eigene Umbruch ist hier das Feature.
- **Satzzerlegung der Stil-Metriken** ([lib/sentence-split.js](../lib/sentence-split.js)): `Intl.Segmenter` (ICU) trennt im Deutschen falsch nach „z. B.", „Dr. Meier" und „am 3. Mai" und drückt damit Satzlänge, P90 und LIX. Jede Änderung hier verschiebt `METRICS_VERSION`.
- **BibTeX-/RIS-Parser** ([lib/bib-parse.js](../lib/bib-parse.js)) und **Zeitstrahl-Datumsparser** ([lib/datum-parse.js](../lib/datum-parse.js)): Das Ergebnis muss exakt auf die `csl_type`-Werte bzw. Formen wie „Tag 3" und „500 v. Chr." fallen; eine generische Lib liefert AST-Knoten, die vollständig umgemappt werden müssten.
- **HTML-Entity-Tabelle** ([lib/html-entities.js](../lib/html-entities.js) + Browser-Spiegel [public/js/html-entities.js](../public/js/html-entities.js)): Server und Frontend müssen für `page_stats` byte-gleich normalisieren; ohne Bundler gibt es keine npm-Lib, die beide Seiten teilen. Die Parität ist durch [page-stats-normalization.test.mjs](../tests/unit/page-stats-normalization.test.mjs) gegated.
- **Rate-Limiter** ([share-ratelimit.js](../lib/share-ratelimit.js), [register-ratelimit.js](../lib/register-ratelimit.js), [admin-login-ratelimit.js](../lib/admin-login-ratelimit.js)): drei verschiedene Semantiken (gleitendes Fenster je Token + IP-Hash; nur ausgewählte Ausgänge zählen; Fehlversuche mit Sperre und Reset bei Erfolg). `express-rate-limit` zählt Requests pro Middleware und liest `windowMs` nur beim Start — die live aus `app_settings` einstellbaren Fenster gingen verloren.
- **Wort-Diff** ([public/js/diff/word-diff.js](../public/js/diff/word-diff.js)): Er rechnet synchron, weil Alpine-Templates (Vorschlagskarten der Chats, Konflikt-Auflösung) die Teile direkt binden; jsdiff lädt erst bei Bedarf und übernimmt nur Absätze jenseits der LCS-Tabelle sowie die Block-Zuordnung (`diffArrays`). Gemessen an typischen Lektorats-Änderungen markiert der Eigenbau gleich oder feiner als jsdiff: Satzzeichen trennt er getrennt vom Wort („Haus, dann" → „Haus. Dann"), in Bindestrich-Komposita nur den geänderten Teil („E-Mail-" → „Mail-"). Die jsdiff-Aufrufe auf dem Server zeigen keine Markierung an, eine Abweichung zum Browser ist dort unsichtbar.
- **Popover-Geometrie** ([public/js/popover-anchor.js](../public/js/popover-anchor.js)): Die verankerten Menüs sind `position: fixed` und nach `<body>` bzw. in die Karten-Wurzel teleportiert (natives Vollbild). Floating UI im Alpine-Anchor-Plugin rechnet `container-type`-Vorfahren als Containing Block, der Browser nicht — genau die Verschiebung, die [combobox-anchoring.spec.js](../tests/e2e-app/combobox-anchoring.spec.js) für die Comboboxen absichert. Ein Umzug tauschte 59 gegatete Zeilen gegen diese Falle.
- **KI-Clients ohne Hersteller-SDK** ([lib/ai/claude.js](../lib/ai/claude.js), [lib/ai/openai-compat.js](../lib/ai/openai-compat.js)): Hart-Timeout über Fetch **und** Stream, `safeFetch` für eigene Endpunkte aus dem Profil, der einmalige Retry ohne `output_config.format` bei abgelehntem Schema und das Kosten-Ledger blieben auch mit SDK Eigenbau. Ein SDK übernähme nur SSE-Parsing und Retries, um den Preis einer zweiten Fehler- und Timeout-Semantik neben der eigenen.
- **Passwort-Hash** (scrypt aus dem Node-Core, [lib/password.js](../lib/password.js)), **SSRF-Guard** ([lib/ssrf-guard.js](../lib/ssrf-guard.js)), **Migrationen** ([db/migrations.js](../db/migrations.js)) und **i18n** ([public/js/i18n.js](../public/js/i18n.js)): klein, passgenau, ohne Pflegelast; eine Dependency brächte nur Fläche.
