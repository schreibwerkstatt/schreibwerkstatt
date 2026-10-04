// Full-SPA-Smoke gegen die ECHTE App (im Gegensatz zu playwright.config.js,
// das nur isolierte Fixture-Harnesses gegen einen Mock-Server faehrt).
//
// Bootet `node server.js` mit LOCAL_DEV_MODE=true: OAuth wird uebersprungen,
// eine Dev-Admin-Session automatisch gesetzt (server.js), und lib/dev-seed.js
// legt auf der frischen Wegwerf-DB ein Kafka-Testbuch mit Kapiteln/Seiten an.
// So laeuft die komplette SPA inkl. Alpine-Template-Baum ohne Login- oder
// KI-Key-Infrastruktur. Der Smoke oeffnet jede Karte + alle drei Editoren und
// prueft, dass dabei kein unbehandelter Alpine-/Library-Fehler auftritt.
//
// DB_PATH zeigt auf eine Wegwerf-Datei unter tests/.tmp/ (vorab geloescht →
// jeder Lauf seedet frisch). PORT/SESSION_SECRET sind smoke-eigene Werte,
// damit ein parallel laufender Dev-Server (3737) unberuehrt bleibt.

// Eine Engine = ein Server = eine eigene Wegwerf-DB. Die Specs teilen sich
// innerhalb eines Laufs bewusst EINEN Seed-Stand (`workers: 1`) und zaehlen
// teilweise exakte Zeilen; zwei Engines auf derselben DB heisst darum, dass die
// zweite auf dem Endzustand der ersten startet und reihenfolgeabhaengig rot wird.
// Getrennte Ports/DBs statt Reset-Hooks: der webServer-Block laeuft einmal pro
// Lauf, nicht pro Projekt.
//
// Sharding (CI, .github/workflows/deploy.yml): mehrere Playwright-Prozesse mit
// `--shard=i/n` laufen gleichzeitig, jeder mit `SMOKE_SHARD=i` — eigene Ports,
// eigene DBs, eigener outputDir, also dieselbe Isolation wie zwischen den
// Engines. `workers: 1` bleibt pro Shard: die Specs einer Datei-Gruppe teilen
// weiterhin genau einen Seed-Stand. `SMOKE_ENGINES=chromium` bootet nur den
// Chromium-Server — Playwright startet sonst jeden webServer-Eintrag
// unabhaengig vom --project-Filter.
const SHARD = Number(process.env.SMOKE_SHARD) || 0;
const ENGINES = (process.env.SMOKE_ENGINES || 'chromium,firefox').split(',');
const SUFFIX = SHARD ? `-s${SHARD}` : '';
const DB = `./tests/.tmp/smoke${SUFFIX}.db`;
const PORT = 8766 + SHARD * 2;
const DB_FF = `./tests/.tmp/smoke-firefox${SUFFIX}.db`;
const PORT_FF = 8767 + SHARD * 2;

// `mkdir -p`: tests/.tmp/ ist gitignored und fehlt in jedem frischen Checkout (CI).
const serve = (db, port) =>
  `mkdir -p ./tests/.tmp && rm -f ${db} ${db}-wal ${db}-shm && DB_PATH=${db} LOCAL_DEV_MODE=true LOCAL_DEV_SEED=true PORT=${port} SESSION_SECRET=smoke-secret-do-not-use-in-prod node server.js`;

module.exports = {
  testDir: './tests/e2e-app',
  testMatch: '**/*.spec.js',
  outputDir: SHARD ? `./test-results/app${SUFFIX}` : undefined,
  fullyParallel: false,
  workers: 1,
  // Lokal EIN Retry, seit die Suite zwei Engines gegen zwei eigene Server faehrt:
  // im vollen `npm test` (direkt nach der e2e-Runde) konkurrieren vier Prozesse um
  // die Maschine, und der 30-s-Boot-Guard in tests/e2e-app/_helpers/app.js kippt
  // dann vereinzelt — dieselben Specs laufen einzeln in ~3 s durch. Verdeckt keinen
  // echten Fehler: der schlaegt im Retry genauso fehl.
  retries: process.env.CI ? 2 : 1,
  timeout: 120000,
  expect: { timeout: 15000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 900 },
    navigationTimeout: 45000,
    actionTimeout: 30000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', baseURL: `http://localhost:${PORT}` } },
    // Zweite Engine fuer denselben Durchlauf. Der Console-Fehler-Guard ist der
    // eigentliche Gewinn: Alpine schluckt Expression-Fehler, und ob eine Karte
    // in Gecko sauber bootet, sieht man sonst erst aus dem Feld (js_errors).
    // Firefox statt WebKit, weil playwright.config.js die WebKit-Achse bereits
    // gezielt ueber `*.webkit.spec.js` bedient.
    // Nur Smoke + die Editor-Specs: dort haengt das Verhalten an Selection,
    // contenteditable und Geometrie, wo Gecko eigene Fehler zeigt. Die uebrigen
    // Karten-Specs pruefen App-Logik, die in beiden Engines gleich laeuft — sie
    // doppelt zu fahren kostete rund die Haelfte der Suite-Laufzeit.
    {
      name: 'firefox',
      testMatch: ['**/smoke.spec.js', '**/focus-editor-app.spec.js', '**/focus-acceptance-app.spec.js', '**/notebook-*.spec.js'],
      use: { browserName: 'firefox', baseURL: `http://localhost:${PORT_FF}` },
    },
  ].filter((p) => ENGINES.includes(p.name)),
  webServer: [
    // DB vor dem Boot loeschen (inkl. -wal/-shm), damit dev-seed greift.
    // reuseExistingServer: false auch lokal — das `rm -f` laeuft nur beim
    // Server-Start. Ein wiederverwendeter Rest-Server haelt die vom Vorlauf
    // vollgeschriebene DB, und die Specs, die exakte Zeilen des gemeinsamen
    // Seeds zaehlen, scheitern dann an fremdem Zustand. Ist der Port belegt,
    // bricht Playwright lieber laut ab (Rest-Server beenden: lsof -i :8766).
    // Kein dedizierter Health-Endpoint — in LOCAL_DEV_MODE liefert `/` die SPA
    // (Auth-Guard via Dev-Session gebypasst), reicht als Readiness-Signal.
    ENGINES.includes('chromium') && {
      command: serve(DB, PORT),
      url: `http://localhost:${PORT}/`,
      timeout: 60000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    ENGINES.includes('firefox') && {
      command: serve(DB_FF, PORT_FF),
      url: `http://localhost:${PORT_FF}/`,
      timeout: 60000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ].filter(Boolean),
};
