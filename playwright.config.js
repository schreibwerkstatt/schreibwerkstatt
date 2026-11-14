// Smoke-Tests für Fokus-Editor. Lädt eine Mini-Fixture-Page (kein Express), die `focusMethods` direkt importiert und an ein Test-
// Harness-Objekt bindet. Reicht aus, um die DOM-Logik (Toggle, Recenter,
// Pointer-Schonfrist, Cleanup) abzudecken.

// Snap-verpackte Editoren (VS Code als Snap) setzen `GIO_MODULE_DIR` auf ihren
// eigenen gio-modules-Cache. Dessen Module linken gegen das glibc/glib aus
// /snap/core20 und sind mit dem Host-glibc inkompatibel. WebKit lädt GIO-Module
// nur im **Netzwerk**prozess (TLS/Proxy-Resolver): der stirbt mit
// `symbol lookup error: … __libc_pthread_init, version GLIBC_PRIVATE`, jedes
// `page.goto` scheitert an „WebKit encountered an internal error", während
// `setContent` grün bleibt. Chromium bringt seine Netzwerk-Stack selbst mit und
// ist nicht betroffen — darum fällt es nur in der WebKit-Suite auf. Ausserhalb
// eines Snaps (CI, normales Terminal) ist die Variable nicht gesetzt → no-op.
delete process.env.GIO_MODULE_DIR;

// E2E_PORT: eigener Port fuer einen zweiten, gleichzeitigen Lauf (scripts/release-verify.js
// testet einen Release-Schnappschuss neben dem Arbeitsbaum). Specs adressieren
// den Harness relativ ueber baseURL, nie mit festem Host.
const E2E_PORT = Number(process.env.E2E_PORT) || 8765;

module.exports = {
  testDir: './tests/e2e',
  testMatch: '**/*.spec.js',
  // Eigener Unterordner statt des Defaults `test-results/`: Playwright leert
  // seinen outputDir beim Start, und in CI laufen die App-Shards
  // (test-results/app-sN) gleichzeitig — der Default wuerde deren Traces
  // mitten im Lauf wegputzen.
  outputDir: './test-results/e2e',
  fullyParallel: false,
  // CI läuft auf lokalem Runner über Ceph-RBD-Storage; IO-Stalls bremsen
  // Chromium → reine Setup/Navigations-Timeouts. Sequenziell (worker=1)
  // hält die IO-Last niedrig, höhere Timeouts + 3 Retries fangen Spikes.
  //
  // Lokal fest auf 2 statt Playwright-Default (= halbe Kernzahl): auf einer
  // 24-Kern-Maschine wären das 12 parallele Chromium-Instanzen, was bei
  // knappem RAM den OOM-Killer auslöst — der trifft dann den Editor, aus
  // dessen Terminal der Lauf gestartet wurde, nicht den Testrunner. Bei
  // Bedarf pro Lauf überschreibbar: `npm run test:e2e -- --workers=4`.
  workers: process.env.CI ? 1 : 2,
  retries: process.env.CI ? 3 : 0,
  timeout: 90000,
  expect: { timeout: 10000 },
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    viewport: { width: 1024, height: 768 },
    navigationTimeout: 45000,
    actionTimeout: 30000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' }, testIgnore: '**/*.webkit.spec.js' },
    // `*.webkit.spec.js` deckt Engine-spezifische Fehlerklassen ab, die Chromium
    // strukturell nicht sieht — z.B. die kaputte contenteditable-Selektion, wenn
    // die Padding-Summe die clientHeight der Scroll-Box erreicht
    // (focus-selection.webkit.spec.js). Eigenes Projekt statt zweitem Durchlauf
    // aller Specs: die übrige Suite ist auf Chromium geeicht.
    { name: 'webkit', use: { browserName: 'webkit' }, testMatch: '**/*.webkit.spec.js' },
  ],
  webServer: {
    command: 'node tests/server.js',
    url: `http://localhost:${E2E_PORT}/tests/fixtures/focus-harness.html`,
    timeout: process.env.CI ? 30000 : 10000,
    reuseExistingServer: !process.env.CI,
  },
};
