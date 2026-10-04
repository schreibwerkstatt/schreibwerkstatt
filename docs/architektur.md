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
  /jobs/book-map   → Buchlandkarte: PCA-Projektion der Seiten-Vektoren + Kapitel-Kohaesion + Ausreisser (kein KI-Call, kein Embedding-Call — liest nur den bestehenden Index)
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
  /blog/*          → WordPress-Blog-Connection (Buchtyp 'blog'): Status, Connect, Links, Konflikt-Resolve
  /hubspot/*       → HubSpot-Blog-Connection (Buchtyp 'blog'): Status, Connect, Blogs/Authors-Combo, Links
  /jobs/blog-*     → Blog-Sync-Jobs (initial-import, pull, push)
  /jobs/hubspot-*  → HubSpot-Sync-Jobs (initial-import, push-as-draft)
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
- **`db/`** — SQLite-Split. Einstieg: `connection.js`, `migrations.js`, `schema.js`, `squashed-schema.js` (Fresh-DB-Fast-Path). Eine Domäne pro File: `books`, `pages`, `page-revisions`, `page-presence`, `figures`, `draft-figures`, `book-access`, `book-categories`, `book-order`, `app-users`, `registration-requests`, `token-usage`, `admin-usage`, `budget-alerts`, `pdf-export`, `fonts`.
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
  - `js/editor/` — Editor-Fachmodule (`utils`, `edit`, `focus/` + `focus.js`, `find`, `synonyme`, `figur-lookup`, `toolbar`, `lektorat`, `shortcuts`, `draft-storage`). Cards in `cards/editor-*-card.js` importieren von hier.
  - Feature-eigene Submodul-Cluster (Facade-File + gleichnamiger Subfolder): `book-overview.js` + `book-overview/`, `figur-werkstatt.js` + `figur-werkstatt/`, `graph.js` + `graph/`, `cards/ereignisse-card.js` + `cards/ereignisse/` (`date`, `subtyp`, `band`, `model` — reine Module, von der Karte re-exportiert).
  - Weitere Cluster: `js/chat/`, `js/admin/`, `js/api/`, `js/i18n/`, `js/repo/`.
  - `js/prompts.js` Facade; `js/prompts/` Submodule pro Job-Typ (state, schema-utils, blocks, core, lektorat, review, komplett, chat, synonym, finetune, figur-werkstatt).
  - Cross-cutting Top-Level: `utils.js`, `lazy-libs.js` (vis-network/Chart.js on-demand), `features-usage.js`, `user-settings.js`, `num-input.js`, `page-revision-diff.js`, `theme-init.js`, `plausible-init.js`, `tooltip.js`, `fullscreen.js`, `register.js`.

## File-Limits / Modularitaet

- **File-Limits / Modularität** — JS-Module > 600 LOC (Browser **und** Server: `lib/`, `routes/`, `db/`), HTML-Partials > 250 LOC, CSS-Files > 600 LOC werden gesplittet in `<name>/`-Subfolder mit thematischen Sub-Files. Pattern: Facade-File `<name>.js` re-exportiert Sub-Module; Sub-Module gruppieren Methoden nach Domäne (z.B. `load/stats/coverage/figuren/orte/kapitel/recent/format`). Beispiele: [public/js/prompts/](../public/js/prompts/), [public/js/book-overview/](../public/js/book-overview/), [public/css/book-overview/](../public/css/book-overview/), [public/css/components/](../public/css/components/), [public/partials/bookoverview-*.html](../public/partials/bookoverview-snapshot.html). HTML-Partials werden via `_loadPartials` mit `<div id="partial-<name>">`-Placeholdern nested geladen (5-Pässe-Schleife, max 1-2 Verschachtelungstiefen). Für **geteiltes Markup innerhalb von `<template>`/`x-for`** (wo der DOM-Placeholder nicht greift — `querySelector` steigt nicht in Template-Content ab) gibt es den **string-seitigen Fragment-Include** `<!-- @include <name> -->` ([app-ui.js](../public/js/app/app-ui.js)#`_resolveIncludes`, ersetzt vor `innerHTML`/`Alpine.initTree`): das eingefügte Markup wird Teil des Template-Contents und pro Loop-Iteration normal geklont. SSoT-Beispiel: [public/partials/plot-beat-cell.html](../public/partials/plot-beat-cell.html) (Beat-Karte, geteilt zwischen flachem + Grid-Board). CSS-Subfolder via einzelne `<link>`-Tags in [public/index.html](../public/index.html) (Cascade-Order = Lade-Order, base zuerst). Tile-Compute-Methoden, die mehrfach pro Render gerendert werden, sind Pflicht-memoized. Maschinell gegated: [tests/unit/loc-limits.test.mjs](../tests/unit/loc-limits.test.mjs) — vier Kategorien (JS-Modul, HTML-Partial, CSS-File, **Server-Modul** = `lib/` + `routes/` + `db/`), Cap pro Kategorie + Ratschen-Allowlist für bestehende Überschreiter (dürfen nur schrumpfen); neue Datei über dem Cap → CI rot. Beim Split einer allowlisted Datei deren Eintrag im Test streichen. Wächst eine Altlast durch eine berechtigte Änderung, das Ceiling dort nachziehen — nicht die Kategorie aufweichen. `exclude` (derzeit nur [db/migrations.js](../db/migrations.js)) ist Dateien vorbehalten, bei denen Wachstum in der Natur der Sache liegt: die Reihenfolge der `if (version < N)`-Blöcke **ist** dort die Struktur, ein Split wäre sinnlos. Server-Beispiel für einen Split: [db/sources/](../db/sources/) (Facade + fünf Themen).
