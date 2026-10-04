# DB-Regeln (`db/`)

Gilt zusaetzlich zur Root-[CLAUDE.md](../CLAUDE.md). Schema-ERD: [docs/erd.md](../docs/erd.md). Eine neue Tabelle mit Konto-Bezug braucht ausserdem einen `USER_REF_PLAN`-Eintrag — siehe [lib/CLAUDE.md](../lib/CLAUDE.md).

- **DB-Timestamps: ISO+Z via `NOW_ISO_SQL`** — alle `*_at`-Spalten (`created_at`, `updated_at`, `last_seen_at`, …) speichern ISO-8601 mit Z-Suffix. In Code-Pfaden (INSERT/UPDATE in `db/*.js`, `routes/*.js`, `lib/*.js`): `${NOW_ISO_SQL}` aus [db/now.js](../db/now.js) interpolieren, **niemals `datetime('now')` inline**. In neuen Migrationen + CREATE-TABLE-Blöcken: Default `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` statt `(datetime('now'))`. INSERT-Statements liefern Timestamp-Spalten **explizit** (Spalte in Column-List + `${NOW_ISO_SQL}` in VALUES) — Default-Fallback ist drift-anfällig (Frontend kriegt sonst „YYYY-MM-DD HH:MM:SS" UTC-no-Z, JS parsed als lokale Zeit und `toLocaleString({ timeZone: appTimezone })` zeigt UTC-Uhr unter app.timezone-Label). Reine Vergleichs-WHERE-Clauses (`WHERE datetime(col) < datetime('now')`) dürfen `datetime('now')` behalten — beide Seiten via `datetime()` parsen ISO+Z und das alte Format gleich.

## Modul-Aufteilung

DB-Code lebt in [db/](../db/), **eine Domäne pro File**: [connection.js](../db/connection.js) (better-sqlite3-Setup, `PRAGMA foreign_keys = ON` global), [migrations.js](../db/migrations.js) (Schema + `runMigrations`), [books.js](../db/books.js), [pages.js](../db/pages.js), [figures.js](../db/figures.js), [token-usage.js](../db/token-usage.js), [pdf-export.js](../db/pdf-export.js), [fonts.js](../db/fonts.js) — vollständiges Inventar via `ls db/`.

[schema.js](../db/schema.js) ist **reine Facade** (nur Re-Exports, keine Logik): sie bündelt die Schreib-/Lesepfade, die Jobs und Routen über `require('../db/schema')` erwarten. **Neue Funktion gehört ins passende Domänen-Modul und wird hier nur re-exportiert**; eine neue Domäne bekommt ein neues Modul, nie einen Codeblock in der Facade. Kleine Normalisierer, die sich mehrere Schreibpfade teilen (`requireUserEmail`, `toRefString`), liegen in [write-helpers.js](../db/write-helpers.js) — sie sind der Grund, warum die Facade keine eigenen Helper braucht. Domänen hinter der Facade: [job-runs.js](../db/job-runs.js), [job-checkpoints.js](../db/job-checkpoints.js), [zeitstrahl.js](../db/zeitstrahl.js), [locations-write.js](../db/locations-write.js), [world-facts.js](../db/world-facts.js), [songs.js](../db/songs.js), [continuity.js](../db/continuity.js), [narrative-profiles.js](../db/narrative-profiles.js), [book-settings.js](../db/book-settings.js), [ai-caches.js](../db/ai-caches.js) (alle Delta-Caches, spec-gleich: `provider` im PRIMARY KEY, Signatur-Spalte, `requireUserEmail` im Schreibpfad), [rueckblick.js](../db/rueckblick.js). Die Module requiren `./migrations` selbst und bleiben damit auch einzeln importierbar.

**Schema-Übersicht: [docs/erd.md](../docs/erd.md)** — Mermaid-ERD mit allen Tabellen, FK-Kanten und thematischen Sub-Diagrammen (Buch-Hierarchie, Figuren, Continuity/Zeitstrahl, Chat/Reviews/Jobs/Caches/User/Export). Vor neuen Tabellen/Beziehungen prüfen, ob bestehende Strukturen (Bridge-Pattern, FK-Konventionen, ON-DELETE-Strategien) wiederverwendbar sind.

### Relationale Integrität (Pflicht)

- **Jede neue Tabelle integriert sich via FK** ins bestehende Schema. Lose `*_id`-Spalten (`book_id`, `page_id`, `chapter_id`, `figure_id`, `location_id`, …) ohne `REFERENCES` sind verboten.
- Refs auf lokale PKs/UNIQUE-Targets MÜSSEN als FK deklariert werden:
  - `books(book_id)` (PK; INTEGER, global eindeutig — analog `pages.page_id`/`chapters.chapter_id`)
  - `pages(page_id)` (PK)
  - `chapters(chapter_id)` (PK; global eindeutig)
  - `figures(id)` (PK; nicht `figures.fig_id` — TEXT, nicht UNIQUE alleine)
  - `locations(id)`, `figure_scenes(id)`, `chat_sessions(id)`, `continuity_*(id)`
- ON-DELETE-Strategie bewusst wählen:
  - `CASCADE` für reine Caches/Aggregationen (page_stats, chapter_reviews, figure_appearances, location_chapters, lektorat_time, page_figure_mentions, chat_sessions[kind=page], page_checks) sowie für user-kuratierte Daten, deren Zeile ohne ihren Anker unerreichbar wäre (`ideen.page_id`/`chapter_id`: eine am Ort entstandene Notiz ist ohne diesen Ort sinnlos — sie fällt bewusst **nicht** in den Buch-Scope zurück, den es für unzugeordnete Ideen gibt)
  - `SET NULL` für user-kuratierte Daten (figure_events.page_id/chapter_id, figure_scenes.page_id/chapter_id, locations.erste_erwaehnung_page_id, continuity_issue_chapters.chapter_id, page_checks.chapter_id, pages.chapter_id)
  - **`SET NULL` NIE auf einer Spalte, die ein CHECK als gesetzt fordert** — die FK-Aktion nullt die Spalte und verletzt denselben CHECK; die löschende Transaktion bricht ab, und zwar auf **jedem** Weg, der die Kette anfasst (Seite, Kapitel, Buch, Konto). Der Fehler zeigt sich nie beim Schreiben, nur beim Löschen. Gegated durch [tests/unit/migration-fk-smoke.test.js](../tests/unit/migration-fk-smoke.test.js) („Keine SET-NULL-FK-Spalte, die ein CHECK als NOT NULL fordert").
- **Snapshot-Spalten verboten** (`chapter_name`, `kapitel`, `seite`, `page_name`, `book_name`) — Display-Werte zur Lese-Zeit per JOIN auf `chapters`/`pages`/`books`/`figures`. Wahrheit lebt nur in `pages.page_name`, `chapters.chapter_name`, `books.name` und `figures.name` (User-Stamm). Erlaubte Ausnahmen: (1) Snapshot-Fallback bei nullbarem FK, wenn KI-Output keine ID liefern konnte (z. B. `continuity_issue_figures.figur_name` mit nullable `figure_id`); (2) Audit-Name in Deletion-Logs (`page_deletions.page_name`), weil die referenzierte Zeile hard-deleted ist und der Name dem User im Collab-Toast angezeigt wird.
- Index auf jede neue FK-Spalte Pflicht (`CREATE INDEX idx_xx_yy ON …`).
- `book_id`-Spalten referenzieren `books(book_id)` (PK). Buchanlage ausschliesslich über die Content-Store-Facade.

### Sentinel-freie Modellierung

Vermeide Sentinel-Werte (`page_id=0`, `page_name='__book__'`) als Diskriminator. Stattdessen: explizite Spalte (`kind TEXT NOT NULL CHECK(kind IN ('page','book'))`) + `NULL` für nicht-anwendbare Refs + CHECK-Constraint, der die Kombination erzwingt. Beispiel: `chat_sessions`. Sentinels blockieren FK-Constraints und verstecken Geschäftslogik.

### Migration hinzufügen

Neue Migration = **neue Datei** `db/migrations/NNNN-kurzname.js` (N = nächste fortlaufende Nummer, vierstellig; Kleinbuchstaben/Ziffern/Bindestrich), Export `{ version: N, fkOff?: true, up(db) }`. Die `if (version < N)`-Blöcke in [db/migrations.js](../db/migrations.js) (bis 291) sind die Legacy-Kette und bekommen keinen Zuwachs. Der Runner [db/migration-runner.js](../db/migration-runner.js) läuft am Ende von `runMigrations()` und übernimmt pro Datei: Validierung (Dateipräfix == `version`, fortlaufend ohne Lücke — sonst Boot-Abbruch), **eine Transaktion** um `up` + `foreign_key_check` + `UPDATE schema_version`, bei `fkOff: true` `PRAGMA foreign_keys = OFF` **vor** und `= ON` **nach** der Transaktion (innerhalb ist das Pragma ein No-op), Log-Zeile. `up` schreibt darum weder FK-Check noch Versions-Bump selbst. Muster: [db/migrations/0292-user-email-fk-indexes.js](../db/migrations/0292-user-email-fk-indexes.js). Neue Tabellen als `CREATE TABLE IF NOT EXISTS` mit FKs. **Timestamp-Defaults**: `TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))` — siehe Harte Regel „DB-Timestamps: ISO+Z via `NOW_ISO_SQL`". `datetime('now')` ist verboten in neuen Schema-Defaults und neuen Inline-INSERT/UPDATE-Statements.

**FK-Migration via Recreate-Pattern** (SQLite kann FKs nicht via `ALTER TABLE ADD CONSTRAINT`) — Datei mit `fkOff: true`, `up` macht:
1. Pre-Cleanup: orphans nullen (UPDATE … SET ref = NULL WHERE ref NOT IN parent) bzw. löschen (CASCADE-Targets)
2. `DROP TABLE IF EXISTS xxx_new` (defensiv gegen Crash-Reste)
3. `CREATE TABLE xxx_new` mit finalen FKs + Indexen
4. `INSERT INTO xxx_new SELECT … FROM xxx`
5. `DROP TABLE xxx` → `ALTER TABLE xxx_new RENAME TO xxx`
6. Indexe neu anlegen (Recreate verliert sie)

**Initial-Schema-Block** (oben in `migrations.js`) ist der „Stand vor allen Migrationen" für **Legacy-Installationen**. Nur additive Changes (neue Spalten via ALTER ADD COLUMN, neue Tabellen). FK-Anreicherung gehört in eigene Migrationen via Recreate-Pattern, nicht ins Initial-Schema — sonst brechen Daten-Migrationen, die ihre eigenen Vorbedingungen aus alten Spalten lesen, auf frischen DBs.

**Fresh-DB-Fast-Path:** Brand-neue Installationen (keine `schema_version`-Tabelle) installieren stattdessen [db/squashed-schema.js](../db/squashed-schema.js) in einem einzigen `db.exec`-Call (End-Zustand nach allen Migrationen) und überspringen die Legacy-Chain komplett. `runMigrations()` sieht direkt `version === SQUASHED_VERSION` und ist no-op. Drift zwischen Squashed-Snapshot und Legacy-Chain ist durch [tests/unit/squash-drift.test.mjs](../tests/unit/squash-drift.test.mjs) gegated.

**Pflicht nach jeder neuen Migration: `npm run squash:regen`** — regeneriert [db/squashed-schema.js](../db/squashed-schema.js) aus einem frischen Migration-Run. Wer das vergisst, lässt den Drift-Test in CI rot. Wird eine Migration geändert, deren Nummer schon `SQUASHED_VERSION` ist, nimmt der Regen den Fast-Path (Squash installiert, Datei gilt als gelaufen) und schreibt das alte Schema zurück — vorher `db/squashed-schema.js` auf den Stand vor der Migration zurücksetzen.

**Pflicht: [docs/erd.md](../docs/erd.md) im selben Commit aktualisieren.** Stand-Zeile (Schema-Version + Tabellen-Anzahl) bumpen; betroffene Block-Definitionen (neue Spalten, geänderte Typen) anpassen; bei neuen Tabellen einen Block + die FK-Kanten in Section 1 (Übersicht) und ggf. im passenden thematischen Sub-Diagramm ergänzen; bei neuen FK-Kanten auf bestehende Tabellen die Kante in Section 1 nachziehen. Drift gegated durch [tests/unit/erd-drift.test.mjs](../tests/unit/erd-drift.test.mjs): prüft Stand-Zeile (Schema-Version + Tabellen-Anzahl) und Set-Gleichheit der Mermaid-Block-Definitionen (`name {`) gegen `sqlite_master` (ohne `sqlite_*`/`schema_version`/FTS5-Shadow-Tables). Vergessene Tabelle → CI rot.

### Neuer Figurentyp

Die Rangliste der Figurentypen (`figures.typ`) ist **SSoT in [public/js/book/figur-typen.js](../public/js/book/figur-typen.js)** — die Reihenfolge ordnet jede Figurenliste (Katalog, Alterstabelle, Präsenz-Heatmap, Lebenslauf-Spalten) und die Tier-Achse des Figurengraphen. Neuer Typ = ein Eintrag dort, dazu Canvas-Farbe (`TYP_COLOR`/`TIER_COLOR` in [graph/constants.js](../public/js/graph/constants.js)), CSS-Farbton (`--fig-hue` in [entities/figuren.css](../public/css/entities/figuren.css) — **eine** Zuordnung für Listen- und Legendenpunkt), Prompt-Enum (`komplett/schema-strings.js` + `komplett/konsolidierung.js`) und `figuren.type.<key>` in **beiden** Locales. Gegated durch [tests/unit/figur-typen.test.mjs](../tests/unit/figur-typen.test.mjs) — es prüft die ganze Kette und verbietet eine zweite Rangliste im Frontend. **Ein Typ-Key ist eine Persistenz-Konstante:** ergänzen ja, umbenennen nein.

### Neuer Beziehungstyp

Keine Schemaänderung. `figure_relations.typ` ist Freitext. Neuen Typ in der `BZ`-Konstante (Frontend-Rendering) und im Claude-Prompt (`FIGUREN_BASIS_SCHEMA` in `public/js/prompts/komplett.js`) ergänzen.

`figure_relations.from_fig_id`/`to_fig_id` sind INTEGER-FK auf `figures.id` (nicht TEXT-fig_id). Schreib-/Lesepfade übersetzen via Lookup-Map (TEXT-fig_id ↔ INTEGER-id, siehe [db/figures.js](../db/figures.js) `saveFigurenToDb`/`updateFigurenSoziogramm`/`listFigurenWithDetails` und JOINs in [routes/jobs/shared/queries.js](../routes/jobs/shared/queries.js)).
