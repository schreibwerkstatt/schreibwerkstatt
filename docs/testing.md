# Tests

Vier Suiten, sequenziell via `npm test`. Erstmaliges Setup: `npx playwright install chromium`.

| Suite | Runner | Pfad | Befehl | Charakter |
|-------|--------|------|--------|-----------|
| Unit | `node --test` | [tests/unit/](../tests/unit/) | `npm run test:unit` | Parallelisiert (concurrency 4), kein Browser; DB-Tests je File auf eigener Wegwerf-SQLite |
| Integration | `node --test` | [tests/integration/](../tests/integration/) | `npm run test:integration` | Parallelisiert (concurrency 4), Mock-AI, Content-Store gegen Test-SQLite |
| E2E | Playwright | [tests/e2e/](../tests/e2e/) | `npm run test:e2e` | Chromium gegen `tests/server.js` mit Fixture-Harness |
| Smoke | Playwright | [tests/e2e-app/](../tests/e2e-app/) | `npm run test:smoke` | Chromium gegen die **echte** App (`node server.js`, `LOCAL_DEV_MODE`); lokal zusätzlich Firefox nur für `smoke`, `focus-editor-app` und `notebook-*`. Lokal startet [scripts/smoke-parallel.js](../scripts/smoke-parallel.js) drei Playwright-Prozesse gleichzeitig (Chromium in zwei Shards + Firefox), je mit eigenem Server/DB via `SMOKE_SHARD`; mit Spec-Argumenten läuft Chromium ungeteilt (CI: nur Chromium, zwei Shards) |

## Wann welche Suite?

**Unit:**
- Pure Funktionen, Validatoren, Renderer, Schema-Builder, Prompt-Builder.
- Single-Module-Logik, auch gegen die DB (einzelnes `db/`-Modul, Route-Handler mit Mini-Express) — dann über den Wegwerf-DB-Helper (siehe „Unit: Test-DB"). Kein Mock-AI, keine Job-Pipeline.
- Beispiele: [ai.test.js](../tests/unit/ai.test.js) (JSON-Parse-Fallback), [escape-xss.test.mjs](../tests/unit/escape-xss.test.mjs), [validate.test.js](../tests/unit/validate.test.js), [palette-fuzzy.test.mjs](../tests/unit/palette-fuzzy.test.mjs).

**Integration:**
- Komplette Job-Pipelines gegen Mock-Provider.
- DB-Interaktion (Migrations, Reads, Writes) mit echtem SQLite-File (in temp-Dir).
- Cross-Job-Regressionen.
- Beispiele: [komplett.test.js](../tests/integration/komplett.test.js), [review.test.js](../tests/integration/review.test.js).

**E2E:**
- DOM-Logik des Editors (Fokus-Modus, Selection, Pointer-Schonfrist, Cleanup).
- Lektorat-Flow mit Mock-Server.
- PDF-Export-Profile-CRUD inkl. Cover-Upload.
- Paste-Artefakt-Stripping (`cleanContentArtefacts`).

**Smoke ([smoke.spec.js](../tests/e2e-app/smoke.spec.js)):**
- Brüche, die nur über dem **kompletten** Template-Baum auftauchen: kaputte `$app`-Verdrahtung, fehlende Methode/`t()`-Key in einem Template, falsch gemountete Sub-Komponente.
- Boot der echten SPA + Öffnen jeder Hauptkarte + aller drei Editoren ohne Browser-Fehler.
- Reine „rendert ohne Crash"-Absicherung — gezielte Verhaltens-Assertions gehören nicht in diese Datei.

**App-Verhaltens-Specs (übrige Dateien in [tests/e2e-app/](../tests/e2e-app/)):**
- Verhalten, dessen geprüfte Eigenschaft von der **echten Shell** abhängt und die ein Fixture-Harness deshalb nicht sehen kann: CSS-Höhenkette, Overlay-/Anker-Geometrie, echter Alpine-Baum, echtes Backend.
- **Entscheidungsregel:** Hängt die Assertion an vollständigem CSS oder am kompletten Template-/Store-/Backend-Zusammenspiel? → hierher. Ist sie reine DOM-/Modul-Logik? → E2E-Harness (schneller, isolierter).
- Leitfall [focus-editor-app.spec.js](../tests/e2e-app/focus-editor-app.spec.js): die Schreiblinien-Geometrie des Focus-Editors leitet sich aus `--focus-anchor`/`--focus-vh`/`--focus-box-h`/`--focus-box-top` gegen die gemessene Box ab. [focus-harness.html](../tests/fixtures/focus-harness.html) lädt bewusst nur Minimal-CSS — die 52 Harness-Tests können vollständig grün bleiben, während im echten Editor die Zeile abdriftet. Genau dieser Fall ist eingetreten.
- Weitere: [book-editor.spec.js](../tests/e2e-app/book-editor.spec.js), [motiv.spec.js](../tests/e2e-app/motiv.spec.js), [offline-outbox.spec.js](../tests/e2e-app/offline-outbox.spec.js), [radio-reactivity.spec.js](../tests/e2e-app/radio-reactivity.spec.js), [plot-dnd.spec.js](../tests/e2e-app/plot-dnd.spec.js).
- Boot-/Buchauswahl-Sequenz nicht kopieren: SSoT in [tests/e2e-app/_helpers/app.js](../tests/e2e-app/_helpers/app.js).
- Console-Guard wie im E2E: Specs importieren `test`/`expect` aus [tests/e2e/_helpers/fixtures.js](../tests/e2e/_helpers/fixtures.js) (Auto-Fixture, siehe „Console-Fehler-Guard"), **keine** eigenen `page.on('pageerror'|'console')`-Sammler. Nur Specs, die an gezielten Checkpoints prüfen (z.B. [smoke.spec.js](../tests/e2e-app/smoke.spec.js) pro Karte), hängen `attachConsoleGuard` selbst an und bleiben beim direkten `@playwright/test`-Import — sonst liefe der Guard doppelt.
- **Pflicht bei neuem Geometrie-/Layout-Test: einmal mutationsprüfen.** Das geprüfte Verhalten absichtlich brechen (Funktion no-op, CSS-Property killen), Suite laufen lassen, rot sehen, zurückrollen. Ein Test, der nie rot war, ist keine Absicherung — die erste Fassung des Tipp-Recenter-Tests blieb mit komplett abgeschaltetem `runTypewriter` grün, weil sie nur `scrollTop != 0` prüfte (der native Caret-Scroll des Browsers erfüllt das auch).

## Unit-Test-Konventionen

Endung: `.test.js` (CJS) oder `.test.mjs` (ESM, fuer Frontend-Module die `import` nutzen).

```js
const test = require('node:test');
const assert = require('node:assert/strict');

test('parseJSON repairs unescaped quotes', () => {
  const out = parseJSON('{"foo": "He said "hi""}');
  assert.equal(out.foo, 'He said "hi"');
});
```

Frontend-Module (Alpine, ESM): `.mjs` + `import`. Beispiel: [hash-router.test.mjs](../tests/unit/hash-router.test.mjs) baut DOM-Stub via `globalThis.document = …`.

## Unit: Test-DB

Unit-Tests, die ein DB-Modul laden, holen ihre Wegwerf-SQLite **ausschliesslich** über [tests/unit/_helpers/tmp-db.js](../tests/unit/_helpers/tmp-db.js) — auf Modul-Ebene, vor dem ersten `require` von `db/…`:

```js
const { useTmpDb } = require('./_helpers/tmp-db');   // ESM: import { useTmpDb } from './_helpers/tmp-db.js';
const tmpDb = useTmpDb('sources-db');
```

Der Helper setzt `DB_PATH` auf eine eindeutige Datei (bevorzugt `/dev/shm`, Override `TEST_TMPDIR`) und registriert einen `after()`-Hook, der die Connection schliesst und Datei + `-wal`/`-shm`/`-journal` löscht (zusätzlich ein `exit`-Handler als Netz). **Kein** eigenes `process.env.DB_PATH = path.join('/tmp', …)` — ohne Aufräumen bleibt pro Lauf und File eine DB samt WAL in `/tmp` liegen. Ausnahme: Files, die pro Test eine frische DB in einer Factory aufsetzen (`mkdtempSync` + `teardown`), räumen selbst ab.

## Integration: Mock-AI

[tests/integration/_helpers/mock-ai.js](../tests/integration/_helpers/mock-ai.js) stubt `lib/ai.callAI` via `require.cache`. **Pflicht: vor allen Modulen laden, die `lib/ai` requiren** (also vor `routes/jobs/...`).

```js
const mockAi = require('./_helpers/mock-ai');
mockAi.register({
  match: ({ system }) => system.includes('SYSTEM_REVIEW'),
  reply: { gesamtnote: 7, beanstandungen: [] },
});

// Erst danach:
const reviewModule = require('../../routes/jobs/review');
```

Handler-API:
- `match: ({ prompt, system, schema }) => bool` — first-match wins.
- `reply: object | string | function | { __raw: {...} }` — Object → JSON, `__raw` reicht volle `callAI`-Response durch (fuer truncated etc).

## Integration: Test-DB

[tests/integration/_helpers/setup.js](../tests/integration/_helpers/setup.js) hebt eine frische SQLite-Test-DB hoch (Migrations laufen einmal pro Suite). Content-Store-Facade liest und schreibt direkt darauf.

## E2E

`tests/server.js` startet Mini-Express auf Port 8765 und serviert `tests/fixtures/*-harness.html`. Playwright lädt Harness, importiert das echte Modul (z.B. `editor/focus.js`) und bindet es an Test-Harness-Objekt — kein Storage-Backend, kein KI-Server.

`fullyParallel: false` (sequenziell), `retries: CI ? 2 : 0`, Timeout 60 s.

Harness-Fixtures müssen die **gleichen `<link rel=stylesheet>`-Tags in derselben Reihenfolge** wie [public/index.html](../public/index.html) haben, sonst weicht Cascade-Order ab und Layout-Tests sind unzuverlaessig. Neuer CSS-File → in beide Files.

### Console-Fehler-Guard

Specs importieren `test`/`expect` aus [tests/e2e/_helpers/fixtures.js](../tests/e2e/_helpers/fixtures.js) statt direkt aus `@playwright/test`. Eine Auto-Fixture (`consoleGuard`) hängt [tests/e2e/_helpers/console-guard.js](../tests/e2e/_helpers/console-guard.js) an die Page: gesammelt werden `pageerror`, `console.error` und Alpine-Warnungen (`Alpine Expression Error`/`Alpine Warn`). Nach dem Test (sofern er nicht ohnehin scheitert) wird `assertClean()` gerufen — jeder unbehandelte Fehler macht den Test rot.

- **Negativ-Test**, der einen Fehler absichtlich provoziert (z.B. erzwungener Save-Fail, fehlender Scroll-Container): `consoleGuard.skip()` am Test-Anfang.
- **Bekannte, erwartete Meldung** erlauben: `consoleGuard.ignore(/Regex/)`. Default-Allowlist deckt Netzwerk-Rauschen (fehlende Mock-Route, 401/403/404, ResizeObserver-Loop) ab.
- **Harness-Datenlücke** statt Bug: tritt der Fehler nur auf, weil der Harness dünnere Mock-Daten/Root mountet als Produktion (fehlende Methode, unvollständige Config), den **Harness** produktionsnah machen — nicht ignorieren. Beispiel: pdf-Mock-Profile liefert `defaultConfig()` aus [lib/pdf-export-defaults.js](../lib/pdf-export-defaults.js).

## Smoke (echte App)

[playwright.app.config.js](../playwright.app.config.js) bootet `node server.js` mit `LOCAL_DEV_MODE=true` (OAuth gebypasst → Dev-Admin-Session aus [server.js](../server.js); [lib/dev-seed.js](../lib/dev-seed.js) seedet ein Kafka-Buch) auf einer Wegwerf-DB (`DB_PATH=tests/.tmp/smoke-s<N>.db` bzw. `smoke-firefox-s<N>.db`, vor jedem Lauf gelöscht → frischer Seed; Port `8766 + 2·SMOKE_SHARD` (Chromium) bzw. `+1` (Firefox), `npm run test:smoke` belegt 8768–8773; eigenes `SESSION_SECRET`). KI-Keys sind nicht nötig — der Smoke triggert keine Jobs.

[tests/e2e-app/smoke.spec.js](../tests/e2e-app/smoke.spec.js) wählt das Seed-Buch via Hash-Deeplink, zieht die Toggle-Namen aus `EXCLUSIVE_CARDS` ([feature-registry.js](../public/js/cards/feature-registry.js), kein Drift) und öffnet jede Karte + alle drei Editoren, jeweils mit Console-Guard-Prüfung. **Warum:** Alpine wirft Expression-Fehler asynchron (`setTimeout(() => { throw })`) und loggt sie nur — Unit/Integration sehen davon nichts, Harnesses nur ihre eine Karte. Erst der komplette Template-Baum im echten Browser fängt sie. Neue Karte ⇒ automatisch im Smoke.

## Häufige Fallen

- **Playwright fehlt Chromium**: `npx playwright install chromium`.
- **Mock-AI nach echtem `lib/ai`-Require geladen**: stubt nicht. Mock-AI muss als allerstes oben in der Test-Datei geladen werden.
- **`node --test` ohne `--test-concurrency` ist NICHT sequenziell**: der Default ist `os.availableParallelism() - 1` — auf einem 24-Kern-Host also 23 gleichzeitige Test-Prozesse. Unit **und** Integration pinnen das Flag darum explizit auf `4`. Jedes Test-File bekommt seine eigene Wegwerf-DB (`bootstrap()`), es gibt also keinen DB-Lock zwischen Files; die Begrenzung schützt vor I/O-/CPU-Ueberbuchung auf dem CI-Runner. Bei Race-Conditions in einem File-Set: `node --test --test-concurrency=1 "tests/integration/*.test.js"`.
- **`waitForJob`-Timeout obwohl der Job korrekt laeuft**: das Budget in [_helpers/setup.js](../tests/integration/_helpers/setup.js) zaehlt Event-Loop-Zeit, nicht Wandzeit — Ticks > 200 ms gelten als Stall und werden abgezogen (siehe Kommentar dort). Meldet die Fehlermeldung viel Wandzeit + Stall, ist der Runner ueberbucht oder ein synchroner Cold-Require blockiert die Loop; Warm-up dann in `bootstrap()` (before-Hook) ziehen, nicht das Budget hochdrehen. Meldet sie kaum Stall, haengt der Job wirklich.
- **SHELL_CACHE nicht gebumpt**: E2E lädt Harness aus `public/` — falls du JS/CSS während eines Test-Runs änderst, hartes Reload nötig oder `SHELL_CACHE` bumpen ([public/sw.js](../public/sw.js)).
- **Tests anpassen statt Bug fixen**: bei UI-Änderungen am Editor/Fokus-Modus/Lektorat-Flow `npm test` laufen lassen. Schlägt etwas fehl, Ursache klären — nicht den Test entschärfen.

## Coverage-Schwerpunkte

Die folgenden Bereiche haben die kritischsten Tests; bei Aenderungen dort vor Commit:

- JSON-Fallback-Kette ([ai.test.js](../tests/unit/ai.test.js))
- Stale-Write-Schutz ([job-result-staleness.test.mjs](../tests/unit/job-result-staleness.test.mjs))
- Page-Stats-Normalisierung ([page-stats-normalization.test.mjs](../tests/unit/page-stats-normalization.test.mjs))
- Card-Exklusivitaet ([card-exclusivity.test.mjs](../tests/unit/card-exclusivity.test.mjs))
- Hash-Router ([hash-router.test.mjs](../tests/unit/hash-router.test.mjs))
- XSS-Escape-Invariante ([escape-xss.test.mjs](../tests/unit/escape-xss.test.mjs))
- Komplettanalyse-Pipeline ([komplett.test.js](../tests/integration/komplett.test.js), [kontinuitaet.test.js](../tests/integration/kontinuitaet.test.js)) + Pure-Helper ([figuren-merge.test.js](../tests/unit/figuren-merge.test.js), [komplett-remap.test.js](../tests/unit/komplett-remap.test.js), [figuren-beziehungen-merge.test.js](../tests/unit/figuren-beziehungen-merge.test.js), [figuren-backfill.test.js](../tests/unit/figuren-backfill.test.js)) — Feature-Doku [docs/komplett.md](komplett.md)
- PDF-Export ([pdf-export-defaults.test.js](../tests/unit/pdf-export-defaults.test.js), [pdf-render.test.mjs](../tests/unit/pdf-render.test.mjs), [pdf-export.spec.js](../tests/e2e/pdf-export.spec.js))
- Fokus-Editor ([focus-editor.spec.js](../tests/e2e/focus-editor.spec.js))

## Import-Gate und Test-Inventar

**Import-Gate** ([scripts/check-imports.js](../scripts/check-imports.js), eigener CI-Step neben den grep-Guards): fährt `tsc` über [public/js/tsconfig.check.json](../public/js/tsconfig.check.json) (Browser-ESM) und [tsconfig.check.json](../tsconfig.check.json) (`server.js`, `logger.js`, `lib/` inkl. `*.mjs`, `db/`, `routes/`) und wertet **nur** `TS2304`/`TS2552` („Cannot find name" — Symbole, die ein Modul benutzt, aber nicht importiert), `TS2305`/`TS2724` („has no exported member" — `import { x }` bzw. destrukturiertes `require` auf einen fehlenden Export) und `TS2339` ausschliesslich auf einem Modul-Namespace (`typeof import(…)` — `mod.x` ohne diesen Export) aus. **Why:** genau die Fehler, die ein Modul-Split produziert (Symbol wandert in eine neue Datei, Import bleibt zurück; Facade vergisst den Re-Export); der `node --check`-Syntax-Check sieht ihn nicht (die Datei ist syntaktisch gültig) und im Browser feuert er erst, wenn der betroffene Codepfad wirklich betreten wird — bei seltenen Pfaden also erst aus dem Prod-Error-Tracker. Kein Typecheck: alle übrigen tsc-Diagnosen verwirft der Runner. Echte Browser-Globals stehen in [public/js/\_globals.d.ts](../public/js/_globals.d.ts); dort **nur** ergänzen, was wirklich per `<script>`/`lazy-libs.js` im `window` landet.

**Unit** (`tests/unit/*.test.{js,mjs}`, `node --test`) — decken ab:
- JSON-Fallback-Kette ([ai.test.js](../tests/unit/ai.test.js)), Stil-/Figuren-Metriken ([page-index.test.js](../tests/unit/page-index.test.js)), Prompts-Build ([prompts.test.mjs](../tests/unit/prompts.test.mjs)), XSS-Escape-Invariante ([escape-xss.test.mjs](../tests/unit/escape-xss.test.mjs)), Request-Validierung ([validate.test.js](../tests/unit/validate.test.js)), Job-Reconnect-Events ([job-reconnect.test.mjs](../tests/unit/job-reconnect.test.mjs)), Hash-Router ([hash-router.test.mjs](../tests/unit/hash-router.test.mjs)), Card-Exklusivität ([card-exclusivity.test.mjs](../tests/unit/card-exclusivity.test.mjs)), Editor-Focus-Granularität ([editor-focus.test.mjs](../tests/unit/editor-focus.test.mjs), [focus-granularity.test.mjs](../tests/unit/focus-granularity.test.mjs)), Szenen-Filter ([szenen-filter.test.mjs](../tests/unit/szenen-filter.test.mjs)), Ideen-Prompt + Schema ([ideen-prompt.test.mjs](../tests/unit/ideen-prompt.test.mjs), [ideen-schema.test.js](../tests/unit/ideen-schema.test.js)), Shared-Jobs-Helper ([shared-jobs.test.js](../tests/unit/shared-jobs.test.js)), HTML-Cleaner ([html-clean.test.js](../tests/unit/html-clean.test.js)), Page-Stats-Normalisierung ([page-stats-normalization.test.mjs](../tests/unit/page-stats-normalization.test.mjs)), Stale-Write-Schutz ([job-result-staleness.test.mjs](../tests/unit/job-result-staleness.test.mjs)), Lektorat-Apply-Skip-Gründe ([lektorat-apply-guard.test.mjs](../tests/unit/lektorat-apply-guard.test.mjs)), PDF-Export ([pdf-export-db.test.js](../tests/unit/pdf-export-db.test.js), [pdf-export-defaults.test.js](../tests/unit/pdf-export-defaults.test.js), [pdf-html-walker.test.mjs](../tests/unit/pdf-html-walker.test.mjs), [pdf-render.test.mjs](../tests/unit/pdf-render.test.mjs)), Palette-Fuzzy ([palette-fuzzy.test.mjs](../tests/unit/palette-fuzzy.test.mjs)), Streak-Heatmap ([streak-heatmap.test.mjs](../tests/unit/streak-heatmap.test.mjs)), Local-Date ([local-date.test.mjs](../tests/unit/local-date.test.mjs), [local-date-server.test.js](../tests/unit/local-date-server.test.js)), Book-Overview-Load ([book-overview-load.test.mjs](../tests/unit/book-overview-load.test.mjs)), Buchorganizer-Kern ([book-organizer.test.mjs](../tests/unit/book-organizer.test.mjs): Snapshot-Rebuild aus `nav.tree`, Depth-First-Mirror-Ordnung, Struktur-Helper, Kapitel-Längenverteilung).

**Integration** (`tests/integration/*.test.js`, `node --test --test-concurrency=4`, Mock-AI, eigene Wegwerf-DB pro File):
- [tests/integration/komplett.test.js](../tests/integration/komplett.test.js) – Komplettanalyse-Pipeline (Vollextraktion, Konsolidierung, Block 2).
- [tests/integration/kontinuitaet.test.js](../tests/integration/kontinuitaet.test.js) – Standalone-Kontinuitätscheck.
- [tests/integration/review.test.js](../tests/integration/review.test.js) – Buch-Review-Job.
- [tests/integration/regression.test.js](../tests/integration/regression.test.js) – Cross-Job-Regressionen.
- Helpers in [tests/integration/_helpers/](../tests/integration/_helpers/).

**E2E** (`tests/e2e/*.spec.js`, Playwright, [playwright.config.js](../playwright.config.js)): isolierte Fixture-Harnesses (mounten je eine Karte mit Mock-Daten gegen [tests/server.js](../tests/server.js)), nicht die echte SPA. Specs importieren `test`/`expect` aus [tests/e2e/_helpers/fixtures.js](../tests/e2e/_helpers/fixtures.js) (Drop-in für `@playwright/test`) — eine Auto-Fixture hängt den Console-Fehler-Guard ([tests/e2e/_helpers/console-guard.js](../tests/e2e/_helpers/console-guard.js)) an und macht den Test rot bei unbehandelten Alpine-/Library-Fehlern. Negativ-Tests, die einen Fehler absichtlich provozieren, rufen `consoleGuard.skip()`; bekannte Meldungen via `consoleGuard.ignore(/…/)`. Specs u.a.: [focus-editor.spec.js](../tests/e2e/focus-editor.spec.js) (Fokus-Editor: Toggle, Recenter, Cleanup/Leak), [lektorat.spec.js](../tests/e2e/lektorat.spec.js) (Lektorat-Flow), [pdf-export.spec.js](../tests/e2e/pdf-export.spec.js) (PDF-Profile), [clean-content.spec.js](../tests/e2e/clean-content.spec.js) (Paste-Artefakt-Stripping), [organizer-hierarchy.spec.js](../tests/e2e/organizer-hierarchy.spec.js) (Buchorganizer 3-Level-Baum — lädt als einziges Harness das **echte** Partial inkl. `@include`-Auflösung, weil genau das Fragment-Sharing + Alias-Shadowing der Testgegenstand ist).

**Smoke** (`tests/e2e-app/*.spec.js`, Playwright, [playwright.app.config.js](../playwright.app.config.js)): bootet die **echte** App via `node server.js` mit `LOCAL_DEV_MODE=true` (OAuth gebypasst, Dev-Admin-Session + [lib/dev-seed.js](../lib/dev-seed.js)-Kafka-Buch) auf einer Wegwerf-DB (`DB_PATH=tests/.tmp/smoke-s<N>.db`, Ports 8768–8773 über `npm run test:smoke`). [tests/e2e-app/smoke.spec.js](../tests/e2e-app/smoke.spec.js) öffnet jede Hauptkarte (Liste aus `EXCLUSIVE_CARDS`, kein Drift) + alle drei Editoren und prüft, dass dabei kein unbehandelter Alpine-/Library-Fehler auftritt. **Warum diese Schicht:** Alpine schluckt Expression-Fehler (loggt + re-throwt async) — nur ein echter Browser über dem kompletten Template-Baum fängt sie. Neue Karte ⇒ automatisch im Smoke (registry-getrieben). Boot-/Buchauswahl-Helper sind SSoT in [tests/e2e-app/_helpers/app.js](../tests/e2e-app/_helpers/app.js), nicht pro Spec kopiert.

Dieselbe Schicht trägt ausserdem **Verhaltens**-Specs, die zwingend das echte Shell-CSS brauchen — der Smoke prüft nur „öffnet ohne Fehler", nicht „fühlt sich richtig an". Wichtigster Fall: [tests/e2e-app/focus-editor-app.spec.js](../tests/e2e-app/focus-editor-app.spec.js) (Schreiblinien-Geometrie des Focus-Editors; das Minimal-CSS-Harness kann dort vollständig grün bleiben, während der echte Editor abdriftet — siehe harte Regel „Focus-Editor ist stabilisiert"). **Regel für neue Invarianten dieser Art:** ist die geprüfte Eigenschaft von der CSS-Höhenkette, der Overlay-Geometrie oder dem echten Template-Baum abhängig, gehört der Test hierher und nicht in ein Fixture-Harness. Und: neue Geometrie-Tests **einmal mutationsprüfen** (Verhalten absichtlich brechen → muss rot werden), sonst bleibt unklar, ob sie überhaupt etwas messen.
