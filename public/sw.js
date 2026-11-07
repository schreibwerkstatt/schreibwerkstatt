// Service Worker: hält die SPA-Shell und Buch-Inhalte offline verfügbar (Zug-Szenario).
// Strategie je Request-Klasse (Begründung jeweils am Handler, Überblick docs/caching.md):
//  - Navigate (/, /index.html) und kohärenz-kritische Shell-Assets (App-JS,
//    Partials, App-CSS, i18n, Icon-Sprite): Cache-Only aus der Generation, die
//    der Install ATOMAR precacht hat (handleNavigate, handleShellAsset). Der
//    Cache-Name folgt dem Content-Hash __SHELL_BUILD aus /sw-manifest.js — jede
//    Asset-Änderung ist eine neue Generation, Wechsel nur per `skip-waiting`.
//  - vendor/*, fonts/*: versionsstabil, generationsunabhängiger VENDOR_CACHE.
//  - /content/*: Stale-While-Revalidate mit Nachzug-Meldung an die Tabs;
//    Poll-Endpunkte nie, Logs/Suche Netz-zuerst (CONTENT_LIVE/VOLATILE_REGEX).
//    Abschnitts-Bilder eigener Cache (sw-offline.js#respondImage).
//  - Werkstatt-Daten Netz-zuerst (sw-domain.js), Schreiben/Auth/KI/SSE nie.

// Build-Konstanten (self.__SHELL_BUILD/__SHELL_MANIFEST), „Buch offline halten"
// (sw-offline.js), Entwürfe per Background Sync (sw-drafts.js), Werkstatt-Daten
// offline (sw-domain.js). Persistiert mit der Registrierung; updateViaCache:'none'.
importScripts('/sw-manifest.js', '/sw-offline.js', '/sw-drafts.js', '/sw-domain.js');
const OFFLINE = self.__swOffline || null;
const DOMAIN = self.__swDomain || null;
const SHELL_BUILD = self.__SHELL_BUILD || 'dev';
const SHELL_MANIFEST = Array.isArray(self.__SHELL_MANIFEST) ? self.__SHELL_MANIFEST : [];
const MANIFEST_SET = new Set(SHELL_MANIFEST);
// Aktueller vendor/ + fonts/-Bestand (scripts/sw-manifest.js). Fehlt die Liste
// (Manifest eines älteren Generators), bleibt der VENDOR_CACHE unangetastet.
const VENDOR_SET = Array.isArray(self.__VENDOR_SET) && self.__VENDOR_SET.length
  ? new Set(self.__VENDOR_SET) : null;
const SHELL_CACHE = 'schreibwerkstatt-shell-' + SHELL_BUILD;
const CONTENT_CACHE = 'schreibwerkstatt-content-v1';
const CONFIG_CACHE = 'schreibwerkstatt-config-v2';
// Versionsstabile Assets (vendor/*, fonts/*) leben generationsunabhängig hier,
// damit sie nicht bei jedem Deploy mit dem SHELL_CACHE weggeworfen werden.
const VENDOR_CACHE = 'schreibwerkstatt-vendor-v1';
const ACTIVE_CACHES = new Set([SHELL_CACHE, CONTENT_CACHE, CONFIG_CACHE, VENDOR_CACHE, OFFLINE?.CACHE, OFFLINE?.IMAGE_CACHE, DOMAIN?.CACHE]);
const SHELL_PATH = '/index.html';
const CONFIG_PATH = '/config';

// Pfade, die niemals aus dem Cache kommen dürfen (dynamische/auth-pflichtige Daten, Streams).
// /content/* und /config haben eigene SWR-Handler, die Werkstatt-Daten
// (/figures, /ideen, /book-editor …) Netz-zuerst in sw-domain.js.
const NEVER_CACHE_PREFIXES = [
  '/auth/',
  '/jobs',
  '/events',
  '/chat',
  '/sync',
  '/publication',
  '/search',
  '/share',
];

const SHELL_ASSET_REGEX = /\.(?:css|js|mjs|json|svg|ico|png|woff2?)$/i;
const PARTIAL_REGEX = /^\/partials\//;
const VERSION_STABLE_REGEX = /^\/(?:vendor|fonts)\//;

// /js/plausible-init.js wird vom Server dynamisch aus app_settings gerendert
// (Plausible an/aus + URL). Niemals cachen, sonst greift Admin-Toggle nicht
// ohne Hard-Reload + SW-Invalidate.
const PLAUSIBLE_INIT_PATH = '/js/plausible-init.js';

function isShellRequest(url) {
  if (url.pathname === '/' || url.pathname === '/index.html') return true;
  if (url.pathname === PLAUSIBLE_INIT_PATH) return false;
  if (PARTIAL_REGEX.test(url.pathname)) return true;
  if (SHELL_ASSET_REGEX.test(url.pathname)) return true;
  return false;
}

function isNeverCache(url) {
  // Exakter Pfad oder echter Unterpfad (mit Slash). Kein nackter Prefix-Match —
  // sonst würde z.B. `/searchbar` fälschlich als `/search` gewertet.
  return NEVER_CACHE_PREFIXES.some(p => url.pathname === p || url.pathname.startsWith(p + '/'));
}

// Positiv-Marker der SPA-Shell (server.js setzt ihn auf index.html). Er ist
// nötig, weil `GET /` unter EINER URL zwei Dokumente liefert: eingeloggt die
// Shell, anonym die Landing-Seite (routes/public.js) — beide mit 200, ohne
// Redirect. `ok`/`opaqueredirect` allein unterscheidet sie also nicht.
const SHELL_MARKER = 'X-App-Shell';

// Gilt für Netz- UND Cache-Antworten: nur eine so markierte Antwort darf als
// SPA-Shell abgelegt werden.
function isShellResponse(res) {
  return !!res && res.ok && res.type !== 'opaqueredirect' && res.headers.get(SHELL_MARKER) === '1';
}

// Alpine-Wurzel der SPA (public/index.html). Dient als Rückfall-Erkennung für
// Cache-Einträge aus einer Generation VOR dem Marker: die sind echte Shells,
// tragen den Header aber noch nicht. Sie am Inhalt zu erkennen ist Pflicht —
// sie stattdessen durch die Netzkopie zu ersetzen wäre nach einem Deploy das
// HTML der NEUEN Generation gegen die alten Module dieser hier (genau der Skew,
// den der cache-only-Satz verhindert). Landing- und Login-Seite enthalten den
// String nicht; Drift ist in tests/unit/sw-shell-coherence.test.mjs gegated.
const SHELL_BODY_MARKER = 'x-data="lektorat"';

// Darf dieser Cache-Eintrag als SPA-Shell ausgeliefert werden? Markierte
// Einträge (Regelfall) ohne Body-Lesen; erst der unmarkierte Altbestand kostet
// einen Textvergleich.
async function isCachedShell(res) {
  if (!res) return false;
  if (isShellResponse(res)) return true;
  try { return (await res.clone().text()).includes(SHELL_BODY_MARKER); }
  catch { return false; }
}

// Precache mit begrenzter Parallelität und Retry PRO ASSET (samt Body: ein Abbruch
// darin scheiterte sonst erst ohne Retry in cache.put), all-or-nothing: erst wenn
// ALLE Antworten da und ok sind, wird geschrieben (kein halb gefüllter Cache).
// Bleibt ein Asset nach PRECACHE_ATTEMPTS beim Fehler, bricht der Rest ab und
// der Install scheitert sauber; der alte SW bedient seinen eigenen, kohärenten
// Satz unverändert weiter.
//
// **Why begrenzt + Retry pro Asset:** ~900 Assets auf einmal liefen beim
// Erst-Install neben den ~700 Modul-Requests der unkontrollierten Seite, und
// ein transienter Fehler verwarf den ganzen Versuch — die Seite blieb still
// ohne Controller. So kostet ein Aussetzer einen Request, nicht 900.
//
// Bewusst NICHT `cache.addAll`: es folgt Redirects und legte ohne Session die
// Login-Seite unter jedem Partial-Pfad ab (Auth-Guard 302), cache-only für
// immer. `redirect:'error'` lässt den Fetch stattdessen scheitern.
const PRECACHE_CONCURRENCY = 16;
const PRECACHE_ATTEMPTS = 3;
const buffered = async (res) => new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });

async function fetchForPrecache(p, signal) {
  let lastErr;
  for (let i = 0; i < PRECACHE_ATTEMPTS; i++) {
    try {
      const res = await fetch(new Request(p, { cache: 'reload', redirect: 'error', signal }));
      if (res && res.ok) return await buffered(res);
      lastErr = new Error(`HTTP ${res && res.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (signal.aborted) break;
    if (i < PRECACHE_ATTEMPTS - 1) await new Promise(r => setTimeout(r, 500 * (i + 1)));
  }
  const err = new Error(`Precache ${p}: ${lastErr?.name || 'Error'}: ${lastErr?.message || lastErr}`);
  err.precachePath = p;
  throw err;
}

// `verify` läuft, wenn alles geholt ist und bevor geschrieben wird — wirft es,
// bleibt der Cache so leer wie bei einem Fetch-Fehler.
async function precacheWithRetry(cache, paths, verify) {
  // Beim ersten endgültigen Fehlschlag die übrigen Requests abbrechen: bei
  // fehlender Session (jeder Pfad scheitert) liefe der Install sonst Minuten.
  const ctrl = new AbortController();
  const fetched = new Array(paths.length);
  let next = 0;
  let firstErr = null;
  const worker = async () => {
    while (!firstErr && next < paths.length) {
      const idx = next++;
      try {
        fetched[idx] = await fetchForPrecache(paths[idx], ctrl.signal);
      } catch (err) {
        if (!firstErr) { firstErr = err; ctrl.abort(); }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PRECACHE_CONCURRENCY, paths.length) }, worker));
  if (firstErr) {
    firstErr.precacheDone = fetched.filter(Boolean).length;
    firstErr.precacheTotal = paths.length;
    throw firstErr;
  }
  if (verify) await verify();
  await Promise.all(paths.map((p, i) => cache.put(p, fetched[i])));
}

// Lebenszeit des SW über die Antwort hinaus verlängern, damit Cache-Writes und
// Meldungen nach `return` nicht mit dem beendeten Worker verloren gehen.
// Best-effort: ein Event ohne waitUntil (Tests, Aufruf ausserhalb) läuft so weiter.
function extendLife(event, p) {
  try { event?.waitUntil?.(p); } catch {}
  return p;
}

// Build, den der Server gerade ausliefert — null, wenn er sich nicht feststellen
// lässt (offline, unlesbar). Ein gleicher Build heisst: die Netz-Bytes jedes
// Manifest-Assets sind per Content-Hash die dieser Generation.
async function fetchServerBuild() {
  try {
    const res = await fetch(new Request(SW_MANIFEST_PATH, { cache: 'reload', redirect: 'error' }));
    const m = res && res.ok ? (await res.text()).match(/self\.__SHELL_BUILD\s*=\s*"([^"]+)"/) : null;
    return m ? m[1] : null;
  } catch { return null; }
}

// Dieselbe Frage für Einzel-Löcher, 30 s gemerkt: ein Boot mit mehreren
// fehlenden Assets fragt einmal, nicht je Asset.
let _sameBuild = null;
function sameBuildOnServer() {
  if (_sameBuild) return _sameBuild;
  const p = _sameBuild = fetchServerBuild().then((b) => b === SHELL_BUILD);
  setTimeout(() => { if (_sameBuild === p) _sameBuild = null; }, 30_000);
  return p;
}

// Ein gescheiterter Install hinterlässt nichts Sichtbares: ohne aktiven SW bleibt
// die Seite einfach unkontrolliert. Darum meldet der SW ihn selbst an dieselbe
// Telemetrie wie failsafe-reveal.js (kind 'boot') — JEDEN Abbruch, auch den der
// Session-Probe in fillGeneration vor dem ersten Manifest-Asset. Best-effort;
// Reichweite und Grenze des Reports: docs/caching.md.
async function reportInstallFailure(err) {
  const fortschritt = err?.precacheTotal ? ` ok=${err.precacheDone}/${err.precacheTotal}` : '';
  try {
    await fetch(new Request('/telemetry/js-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        kind: 'boot',
        message: `SW-Install gescheitert: ${err.message} [build=${SHELL_BUILD}${fortschritt}]`,
        source: err.precachePath || null,
      }),
    }));
  } catch {}
}

// Vollständigkeits-Marke der Generation: der Install legt sie als LETZTEN
// Eintrag ab, nachdem Shell + Asset-Satz komplett drin sind. Fehlt sie im Cache
// des laufenden SW, ist die Generation nicht „einzeln evictiert", sondern als
// Ganzes weg (Cache-Wurf der Heilungspfade in sw-register.js/failsafe-reveal.js,
// Storage-Druck, DevTools) — und der SW, der sie bedient, läuft trotzdem weiter.
// **Why:** `unregister()` greift nicht verlässlich: Chromium holt eine abgemeldete
// Registrierung beim nächsten `register()` derselben Script-URL zurück, ohne
// neuen Install. Ohne Marke hiesse das: jeder Asset-Request ein Cache-Miss, jeder
// meldet 'shell-incoherent', der Client lädt neu, der Banner-Klick findet keinen
// wartenden SW — eine Schleife, aus der nur Ctrl-F5 (am SW vorbei) herausführt.
const GENERATION_COMPLETE_PATH = '/__sw-generation-complete';
const SW_MANIFEST_PATH = '/sw-manifest.js';

async function isGenerationComplete(cache) {
  return !!(await cache.match(GENERATION_COMPLETE_PATH));
}

// Füllt den SHELL_CACHE dieser Generation vollständig: erst die Shell (klärt, ob
// überhaupt eine Session da ist), dann der Asset-Satz, dann die Shell unter beiden
// Schlüsseln, zuletzt die Marke. Geteilt von Install und Reparatur.
async function fillGeneration() {
  const cache = await caches.open(SHELL_CACHE);
  // ZUERST die Shell holen — ihre Antwort sagt autoritativ, ob diese Generation
  // überhaupt installierbar ist. Ohne gültige Session antwortet `/` mit der
  // Landing-Seite (200, kein Marker) und jedes auth-pflichtige Partial mit
  // einem Redirect auf /login; der Precache liefe dann in Müll. Ein Request
  // klärt das, statt erst den ganzen Satz zu laden. Body sofort lesen (`buffered`):
  // ungelesen bis zum `cache.put` nach dem Precache riss der Stream ab.
  const shellRes = await buffered(await fetch(new Request('/', { cache: 'reload' })));
  if (!isShellResponse(shellRes)) throw new Error('Install abgebrochen: `/` liefert keine SPA-Shell (Session abgelaufen?).');
  // Den VOLLSTÄNDIGEN kohärenz-kritischen Asset-Satz dieser Generation ATOMAR
  // vorcachen: App-JS + Partials + App-CSS + i18n + Icon-Sprite. So zieht zur
  // Laufzeit nie ein lazy-gefetchtes Partial / dynamisch importiertes Modul eine
  // fremde Generation vom Netz. `cache: 'reload'` umgeht den HTTP-Cache, damit
  // der Precache wirklich diese Generation holt.
  //
  // Vor dem Schreiben den Build des Servers prüfen: deploy/deploy.sh tauscht die
  // Dateien per rsync, Minuten bevor der Prozess neu startet, und der laufende
  // Server liefert sie sofort vom Disk. Fällt ein Install in dieses Fenster,
  // stammt der Satz teils aus dem alten, teils aus dem neuen Stand — und trüge
  // trotzdem die Marke. Nur ein NACHGEWIESENER Wechsel bricht ab; ein
  // unlesbares Manifest ist kein Beweis.
  await precacheWithRetry(cache, SHELL_MANIFEST, async () => {
    const build = await fetchServerBuild();
    if (build && build !== SHELL_BUILD) {
      throw new Error(`Install abgebrochen: Server liefert inzwischen Build ${build}.`);
    }
  });
  // Einstiegspunkt (SPA-Shell) zuletzt — nicht im Manifest, weil er unter zwei
  // Schlüsseln adressiert wird ('/' bei Navigation, SHELL_PATH beim Lookup).
  // Unter BEIDEN ablegen, damit der Lookup in handleNavigate deterministisch
  // die Kopie DIESER Generation trifft. Erst nach dem Precache, damit ein
  // gescheiterter Install keine Shell ohne ihren Asset-Satz hinterlässt.
  await cache.put(SHELL_PATH, shellRes.clone());
  await cache.put('/', shellRes.clone());
  await cache.put(GENERATION_COMPLETE_PATH, new Response(SHELL_BUILD));
}

// Reparatur einer verlorenen Generation, single-flight. Nachgefüllt wird NUR,
// wenn der Server noch genau diesen Build ausliefert — dann sind die Netz-Bytes
// per Content-Hash identisch mit denen dieser Generation. Ist der Server weiter,
// gehört der Netzstand einer anderen Generation; ihn hier abzulegen wäre der
// Skew, den der cache-only-Satz verhindert. Dann stattdessen den Update-Check
// anstossen: der neue SW installiert seinen eigenen Satz und kommt über den
// regulären Banner-/skip-waiting-Weg.
let _repairing = null;
function repairGeneration() {
  if (_repairing) return _repairing;
  _repairing = (async () => {
    try {
      if ((await fetchServerBuild()) !== SHELL_BUILD) {
        await self.registration?.update?.();
        return;
      }
      await fillGeneration();
    } catch {
      // Offline/keine Session: nächster Request versucht es erneut.
    } finally {
      _repairing = null;
    }
  })();
  return _repairing;
}

function startRepair(event) {
  extendLife(event, repairGeneration());
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      await fillGeneration();
    } catch (err) {
      await reportInstallFailure(err);
      throw err;
    }
    // Bewusst KEIN skipWaiting hier: der neue SW bleibt `waiting`, bis der
    // User das Update-Banner klickt (applyUpdate → 'skip-waiting'-Message).
    // Sonst übernähme der neue SW eine laufende (Editor-)Seite sofort und
    // bediente Partials/Assets der neuen Generation gegen die noch im Speicher
    // laufenden ALTEN JS-Module → Skew (z.B. ReferenceError auf neu
    // hinzugefügten Card-State-Feldern, die das alte Modul nicht kennt).
  })());
});

// Der VENDOR_CACHE ist generationsunabhängig und überlebt jeden Deploy — darum
// räumt ihn niemand sonst auf. Ohne diesen Schritt bliebe jede ersetzte
// Vendor-Version (neuer Dateiname, z.B. alpine-3.15.12 → 3.17.5) für immer
// liegen. Entfernt wird, was nicht mehr im aktuellen Bestand steht; ein
// trotzdem angefragter Alt-Pfad fällt ohnehin auf das Netz zurück (cache-first).
async function pruneVendorCache() {
  if (!VENDOR_SET) return;
  const cache = await caches.open(VENDOR_CACHE);
  for (const k of await cache.keys()) {
    let pathname = null;
    try { pathname = new URL(k.url).pathname; } catch {}
    if (!pathname || !VENDOR_SET.has(pathname)) await cache.delete(k);
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !ACTIVE_CACHES.has(k)).map(k => caches.delete(k)));
    try { await pruneVendorCache(); } catch {}
    // Kein clients.claim(): laufende Tabs behalten den alten SW (= alte
    // Partials + alte Module, kohärent), bis sie via Banner/Reload wechseln.
    // Activate läuft ohnehin erst nach 'skip-waiting', also nach User-Klick.
  })());
});

// Navigate (HTML-Shell): Cache-Only innerhalb der Generation, Netz nur, wenn die
// Generation nicht vollständig vorliegt (keine Marke, oder keine echte Shell).
// Das HTML ist Teil des kohärenten Satzes; seine Bytes gehen in __SHELL_BUILD ein.
//
// KEIN Stale-While-Revalidate: nach einem Deploy schriebe die Revalidierung das
// HTML der NEUEN Generation in den Cache des noch aktiven ALTEN SW, und die
// nächste Navigation lieferte neues Markup gegen alte JS-Module (typisch beim
// Login: mehrere Navigationen hintereinander). Updates laufen ausschliesslich
// über `skip-waiting` + controllerchange-Reload.
async function handleNavigate(req, event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(SHELL_PATH) || await cache.match('/');
  const complete = await isGenerationComplete(cache);
  if (complete && await isCachedShell(cached)) return cached;

  // Ab hier ist die Generation nicht auslieferbar: entweder fehlt sie als Ganzes
  // (keine Marke, siehe GENERATION_COMPLETE_PATH) oder der Shell-Eintrag ist
  // nachweislich keine Shell (eingefangene Landing-/Login-Seite). Die Seite kommt
  // dann komplett vom Netz — Shell UND Assets (handleShellAsset reicht im selben
  // Zustand durch), also kohärent aus dem deployten Stand. Nichts davon wird in
  // diese Generation geschrieben; das Nachfüllen ist Sache von repairGeneration,
  // die den Build prüft, bevor sie schreibt.
  if (!complete) startRepair(event);
  try {
    const net = await fetch(req);
    // Keine Shell (anonym → Landing mit 200, oder ein Redirect auf /login):
    // ebenso unverändert durchreichen.
    if (net) return net;
  } catch {}

  // Offline: ein vorhandener Alt-Eintrag ist besser als gar keine App.
  if (cached) return cached;
  return new Response('Offline – Shell nicht im Cache.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

// Broadcast an alle kontrollierten Tabs. Eine Stelle, zwei Meldungen
// ('shell-incoherent', 'content-updated') — beide sagen dem Client, dass das,
// was er gerade zeigt, nicht mehr das ist, was hier liegt.
async function postToClients(msg) {
  try {
    const clients = await self.clients.matchAll({ includeUncontrolled: false });
    for (const c of clients) c.postMessage(msg);
  } catch {}
}

// Meldet allen kontrollierten Tabs, dass der kohärente Asset-Satz dieser
// Generation Lücken hat (Einzel-Eviction). Der Client triggert daraufhin den
// regulären Update-/Reload-Pfad (Banner falls Editor dirty, sonst Reload) und
// bootet in eine frisch precachte, kohärente Generation.
function notifyIncoherent(pathname) {
  return postToClients({ type: 'shell-incoherent', path: pathname });
}

// Kohärenz-kritische Shell-Assets (App-JS/Partials/CSS/i18n/Icons): Cache-Only.
// Der Satz wurde beim Install atomar precacht → ein Hit ist garantiert kohärent.
// Ein Miss bei vollständiger Generation ist ein Einzel-Loch. Liefert der Server
// noch diesen Build, sind seine Bytes die dieser Generation: still nachfüllen —
// ein Reload landete beim selben SW im selben Loch. Ist der Server weiter, wäre
// die Einzeldatei genau der Skew, den cache-only verhindert: dann nur als
// Notnagel ungecacht durchreichen und die Clients zum Reload anstossen (ein
// wartender Nachfolger bringt die Kohärenz). Offline → 503.
//
// Nicht-kritische Shell-Assets (vendor/*, fonts/*): self-contained und
// versionsstabil, kein Skew auf App-Feldern möglich → klassisch Cache-First mit
// Netz-Fallback (lazy nachladbar, auch nach Eviction).
async function handleShellAsset(req, url, event) {
  // Versionsstabile Assets (vendor/*, fonts/*) liegen im generationsunabhängigen
  // VENDOR_CACHE → ein Hit überlebt jeden Deploy, kein erneuter Netz-Fetch beim
  // Generationswechsel. Kein Skew möglich (self-contained, kein App-Feld-Bezug).
  if (VERSION_STABLE_REGEX.test(url.pathname)) {
    const vcache = await caches.open(VENDOR_CACHE);
    const vhit = await vcache.match(req);
    if (vhit) return vhit;
    try {
      const net = await fetch(req);
      if (net && net.ok) extendLife(event, vcache.put(req, net.clone()).catch(() => {}));
      return net;
    } catch {
      return new Response('Offline', { status: 503 });
    }
  }

  const cache = await caches.open(SHELL_CACHE);

  // Die Build-ID der Seite (index.html lädt /sw-manifest.js klassisch) muss die
  // Generation nennen, die die Seite tatsächlich bedient — sonst vergleicht der
  // Build-Guard (app-init.js) gegen eine fremde Zahl. Die Datei steht nicht im
  // Manifest (sie hasht sich nicht selbst); vom Netz geholt und lazy abgelegt,
  // trüge sie den Build des Servers zum Zeitpunkt des ersten Loads, nicht den
  // dieses SW. Darum hier aus den eigenen Konstanten — ausser im Netz-Modus
  // einer verlorenen Generation, dort stammt die ganze Seite vom Netz.
  if (url.pathname === SW_MANIFEST_PATH) {
    if (!(await isGenerationComplete(cache))) {
      try { return await fetch(req); } catch { return new Response('', { status: 503 }); }
    }
    return new Response(
      `self.__SHELL_BUILD = ${JSON.stringify(SHELL_BUILD)};\nself.__SHELL_MANIFEST = ${JSON.stringify(SHELL_MANIFEST)};\n`,
      { headers: { 'Content-Type': 'application/javascript; charset=utf-8' } },
    );
  }

  const cached = await cache.match(req);
  if (cached) return cached;

  if (MANIFEST_SET.has(url.pathname)) {
    // Shell-Assets mit Query-String (Cache-Buster `?v=`) sind unter ihrem
    // query-losen Pfad precacht. ignoreSearch matcht die precachte Generation,
    // statt bei jedem ?v= einen ungecachten Netz-Fetch zu erzwingen (offline →
    // Icon-Sprite nicht ladbar → alle Icons weg). Die Generation ist trotzdem
    // kohärent: Ändert sich der Sprite-Inhalt, verschiebt sich __SHELL_BUILD und
    // die ganze Generation wird neu precacht.
    const ignoreSearchHit = await cache.match(req, { ignoreSearch: true });
    if (ignoreSearchHit) return ignoreSearchHit;
    // Generation als Ganzes weg (keine Marke): kein Einzel-Loch, sondern der
    // Netz-Modus aus handleNavigate — die Shell dieses Loads kam ebenfalls vom
    // Netz, also passt die Netzkopie zu ihr. KEIN 'shell-incoherent': ein Reload
    // landete im selben Zustand und triebe die Schleife, statt sie zu lösen.
    if (!(await isGenerationComplete(cache))) {
      startRepair(event);
      try { return await fetch(req); } catch { return new Response('Offline', { status: 503 }); }
    }
    if (await sameBuildOnServer()) {
      try {
        // Query-los und ohne Redirect, wie der Precache ablegt.
        const net = await fetch(new Request(url.pathname, { cache: 'no-cache', redirect: 'error' }));
        if (net.ok) {
          extendLife(event, cache.put(url.pathname, net.clone()).catch(() => {}));
          return net;
        }
      } catch {}
    }
    notifyIncoherent(url.pathname);
    try {
      return await fetch(req); // Notnagel, bewusst NICHT in diese Generation cachen
    } catch {
      return new Response('Offline', { status: 503 });
    }
  }

  try {
    const net = await fetch(req);
    if (net && net.ok) extendLife(event, cache.put(req, net.clone()).catch(() => {}));
    return net;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

// Content-GETs: Stale-While-Revalidate, damit Buch-/Kapitel-/Seitenlisten
// und einzelne Seiteninhalte (/content/pages/:id) offline lesbar bleiben.
// 401/Fehlerantworten werden nicht gecacht, damit Login-Redirects nicht festfrieren.
//
// LRU-Bound: ohne Limit wächst der Cache mit jeder besuchten Seite und
// verbraucht auf Long-Running-Sessions zig MB. MAX_CONTENT_CACHE_ENTRIES kappt
// nach FIFO (cache.keys() liefert Insertion-Order in allen Browsern, die SW
// unterstützen).
const MAX_CONTENT_CACHE_ENTRIES = 200;
async function _evictContentCache(cache) {
  const keys = await cache.keys();
  const overflow = keys.length - MAX_CONTENT_CACHE_ENTRIES;
  if (overflow > 0) {
    for (let i = 0; i < overflow; i++) await cache.delete(keys[i]);
  }
}

// `no-cache`/`no-store` heissen beide „nicht ohne Rueckfrage ausliefern".
// `must-revalidate` bewusst NICHT: das greift erst nach Ablauf der Frische und
// ist keine Aussage gegen einen frischen Cache-Eintrag.
function _forbidsStale(res) {
  const cc = res?.headers?.get?.('Cache-Control') || '';
  return /\bno-cache\b|\bno-store\b/i.test(cc);
}

// Hat die Revalidierung etwas anderes geliefert als den ausgelieferten Stand?
// Regelfall: die gecachte Antwort traegt einen ETag, der Header-Vergleich
// entscheidet ohne Byte-Read (bei unveraendertem Buch antwortet schon der
// HTTP-Cache mit 304). Sonst Textvergleich gegen den vorab gezogenen Klon; fehlt
// der, als Drift werten — ein Nachzug zu viel kostet einen leisen Re-Render,
// ein verpasster die Aussage, um derentwillen das Ganze existiert.
async function _samePayload(cachedEtag, cachedClone, net) {
  if (cachedEtag) return net.headers.get('ETag') === cachedEtag;
  if (!cachedClone) return false;
  try { return (await cachedClone.text()) === (await net.clone().text()); }
  catch { return false; }
}

// Fuer WELCHE Pfade lohnt der Vergleich? Buchliste, Seitenbaum und der Abschnitt
// selbst (sonst startete der Editor auf dem Stand des letzten Besuchs); alle drei
// tragen einen ETag (routes/content/shared.js#REVALIDATE_CACHE_CONTROL). Was ein
// Pfad BEDEUTET, entscheidet allein der Client (boot/content-updated.js).
const CONTENT_NOTIFY_REGEX = /^\/content\/(?:books|books\/\d+\/tree|pages\/\d+)$/;

// Meldet den Tabs, dass die Hintergrund-Revalidierung dieses Pfads einen ANDEREN
// Inhalt ergeben hat als der Cache-Hit, den sie gerade rendern. Ohne Meldung
// fuellt SWR nur den Cache, nicht die schon gerenderte Sidebar — erst der
// ZWEITE Reload zeigte den aktuellen Stand.
function notifyContentUpdated(pathname) {
  return postToClients({ type: 'content-updated', path: pathname });
}

// Offline-Antwort der JSON-Endpunkte (Content, Config): 503 mit
// `{ error: 'offline' }` — fetchJson liest daraus status + Body.
function offlineJson() {
  return new Response(JSON.stringify({ error: 'offline' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// Darf diese Netzantwort in einen Cache? 401/Fehler/Login-Redirects nicht,
// sonst frieren sie fest.
function _cacheable(res) {
  return !!res && res.ok && res.type !== 'opaqueredirect';
}

// Stale-While-Revalidate für /content/* UND /config. Die beiden unterscheiden
// sich nur in zwei Punkten, und genau die sind parametrisiert:
//  - `cacheKey`: fester Schlüssel statt der Request-URL. /config legt unter
//    CONFIG_PATH ab und matcht damit ohne Query — ein `?__fresh=1` am Aufrufer
//    träfe sonst weiter den Cache-Eintrag, der Bypass MUSS darum hier stehen.
//  - `content`: die Content-Regeln (LRU-Deckel, `_forbidsStale`, Nachzug-
//    Meldung an die Tabs). /config hat keinen Deckel (ein Eintrag), keinen
//    Konsumenten für eine Nachzug-Meldung und keinen no-cache-Vertrag.
// Das Ablegen der Netzantwort läuft nach der Auslieferung unter `event`s
// waitUntil (extendLife): ohne das kann der Browser den SW nach `return cached`
// beenden, und mit dem Cache-Write fiele gerade die Nachzug-Meldung weg. Beim
// Miss wartet der Aufrufer so auch nicht auf Write + Deckel-Pass.
async function _handleSwr(req, cacheName, { cacheKey = null, content = true, event = null } = {}) {
  // Bypass-Marker: konsistenzkritische Reads (z.B. Konflikt-Check vor
  // Draft-Push) müssen frische Server-Daten sehen, nicht den SWR-Cache.
  // Sonst matcht ein stale `page.html` mit dem `draft.originalHtml` und
  // ein veralteter Draft überschreibt Server-Stand.
  const url = new URL(req.url);
  if (url.searchParams.has('__fresh')) {
    try {
      const net = await fetch(req);
      // Den CACHE-EINTRAG trotzdem nachziehen. Der Marker heisst „beantworte
      // MICH nicht aus dem Cache" — nicht „lass die Offline-Kopie auf dem Stand
      // des allerersten Loads stehen". Ohne das frieren genau die Buecher ein,
      // die man nur per Buchwechsel oeffnet (`FRESH_SOURCES`): ihr Baum kaeme im
      // Zug nie aus dem Cache, weil er nie hineingeschrieben wurde. Der Aufrufer
      // bekommt unveraendert die Netzantwort — an der Konsistenzzusage des
      // Markers aendert sich nichts.
      if (_cacheable(net)) {
        // Unter dem Pfad OHNE `__fresh` ablegen, sonst entsteht ein zweiter
        // Eintrag, den kein normaler Read je trifft (und der den 200er-Deckel
        // mit Dubletten fuellt). Eigene URL-Instanz: `url` wird weiter unten
        // noch gelesen.
        let key = cacheKey;
        if (!key) {
          const u = new URL(req.url);
          u.searchParams.delete('__fresh');
          key = new Request(u.toString());
        }
        const forCache = net.clone();
        const forOffline = content ? net.clone() : null;
        extendLife(event, (async () => {
          const cw = await caches.open(cacheName);
          await cw.put(key, forCache);
          if (content) { await _evictContentCache(cw); await OFFLINE?.refresh(key, forOffline); }
        })().catch(() => {}));
      }
      return net;
    } catch {
      return offlineJson();
    }
  }
  const cache = await caches.open(cacheName);
  // Nach einem Miss der Rückfall auf ein offline gehaltenes Buch (nie verdrängt).
  const cached = await cache.match(cacheKey || req) || (content ? await OFFLINE?.match(req) : undefined);
  // Der Server darf widersprechen. Deklariert die GECACHTE Antwort `no-cache`
  // oder `no-store`, ist sie als Stale-Antwort nicht zugelassen — dann gilt
  // Netz-zuerst. Betrifft heute die drei `/content/*/release.json` (dort steht
  // ausdruecklich „immer revalidieren (via If-None-Match)"): eine gecachte
  // Antwort auf die Frage „gibt es eine neuere Client-Version?" ist genau die
  // Aussage, die der Endpunkt nicht machen wollte. Als Regel ist das die
  // billigste Absicherung gegen den naechsten solchen Endpunkt: er muss nur
  // seinen Header setzen und braucht keinen Eintrag in einer Liste hier.
  if (content && cached && _forbidsStale(cached)) return _handleNetworkFirst(req, cacheName);
  // Vergleichskopie ZIEHEN, BEVOR der Cache-Hit rausgeht: `clone()` wirft,
  // sobald der Client den Body gelesen hat. Traegt die gecachte Antwort einen
  // ETag, reicht spaeter der Header-Vergleich und der Klon entfaellt — der
  // Baum eines grossen Buchs sind ein paar hundert KB, die sonst bei jedem
  // Read doppelt im Speicher liegen.
  const worthDiffing = content && !!cached && CONTENT_NOTIFY_REGEX.test(url.pathname);
  const cachedEtag = worthDiffing ? cached.headers.get('ETag') : null;
  const cachedClone = (worthDiffing && !cachedEtag) ? cached.clone() : null;
  // Klone ziehen, bevor `res` an den Aufrufer geht; abgelegt wird danach.
  let stored = Promise.resolve();
  const netPromise = fetch(req).then((res) => {
    if (_cacheable(res)) {
      const forCache = res.clone();
      const forOffline = content ? res.clone() : null;
      const forDiff = (worthDiffing && !cachedEtag) ? res.clone() : res;
      stored = (async () => {
        // Der Vergleich muss VOR dem cache.put laufen, sonst ist der alte Stand weg.
        const drifted = worthDiffing && !(await _samePayload(cachedEtag, cachedClone, forDiff));
        await cache.put(cacheKey || req, forCache);
        if (content) { await _evictContentCache(cache); await OFFLINE?.refresh(req, forOffline); }
        if (drifted) await notifyContentUpdated(url.pathname);
      })().catch(() => {});
    }
    return res;
  }).catch(() => null);
  extendLife(event, netPromise.then(() => stored));

  if (cached) return cached;
  const net = await netPromise;
  if (net) return net;
  return offlineJson();
}

// Zwei Klassen von /content/*-GETs, fuer die Stale-While-Revalidate die falsche
// Strategie ist. Beide sind keine Ausnahme vom Offline-Versprechen, sondern
// seine Bedingung: SWR taugt fuer einen Stand, der sich aendert — nicht fuer ein
// Log, das nur waechst, und nicht fuer einen Poll, dessen Antwort eine Sekunde
// spaeter falsch ist.
//
// LIVE (nie cachen): die Poll-Endpunkte des Collab-Ticks. `/changes` traegt
// einen `since`-Stempel pro Poll — jede Antwort waere ein eigener Cache-Key,
// zwoelf pro Minute, und der 200-Eintraege-Deckel haette den offline lesbaren
// Buchinhalt in einer Viertelstunde verdraengt. `/presence` ist ein Heartbeat;
// ein gecachter Heartbeat ist eine Falschaussage.
//
// VOLATIL (Netz zuerst, Cache nur als Offline-Rueckfall): die Revisionsliste
// einer Seite und die Suche. Ein Stale-Hit der Revisionsliste zeigte den Stand
// des letzten Besuchs (frische Seite: leer), und ein Write bustet nur aus DIESEM
// Browser — Revisionen von anderen Geraeten, nativen Clients oder Server-Apply
// kommen ohne Bust an. Regel darum: "ein Log wird nicht stale ausgeliefert".
// Der Voll-Body EINER Revision (`/revisions/:rev_id`) bleibt bewusst SWR: er ist
// unveraenderlich, dort IST der Cache-Hit die richtige Antwort.
const CONTENT_LIVE_REGEX = /^\/content\/(?:books|pages)\/\d+\/(?:changes|presence)$/;
const CONTENT_VOLATILE_REGEX = /^\/content\/(?:pages\/\d+\/revisions|search)$/;

function isLiveContent(url) { return CONTENT_LIVE_REGEX.test(url.pathname); }

// Netz zuerst, Cache als Rueckfall. Anders als SWR wartet der Aufrufer auf die
// Netzantwort — die Aussage "das ist der Serverstand" ist hier den Umweg wert.
// Eine Fehlerantwort (401/500) wird durchgereicht, nicht durch einen alten
// Cache-Eintrag beschoenigt; nur ein echter Netzfehler faellt auf den Cache.
async function _handleNetworkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const net = await fetch(req);
    if (_cacheable(net)) {
      await cache.put(req, net.clone());
      await _evictContentCache(cache);
    }
    return net;
  } catch {
    return (await cache.match(req)) || offlineJson();
  }
}

function handleContent(req, event) {
  const url = new URL(req.url);
  if (CONTENT_VOLATILE_REGEX.test(url.pathname)) return _handleNetworkFirst(req, CONTENT_CACHE);
  return _handleSwr(req, CONTENT_CACHE, { event });
}

// /config liefert Session-User + Provider-Config. SWR, damit wiederkehrende
// Offline-User den App-Shell-Bootstrap komplett durchlaufen können. 401/Fehler
// werden nicht gecacht (via res.ok-Check), damit Login-Redirects nicht festfrieren.
async function handleConfig(req, event) {
  // Bypass-Marker wie bei /content/* — hier ist er nicht optional, sondern die
  // Voraussetzung eines vorhandenen Mechanismus: der Wake-Refresh
  // (app-view/bookscope.js#_refreshAfterWake) holt `/config` ausschliesslich, um
  // eine abgelaufene Session an den globalen 401-Wrapper zu geben. Aus dem Cache
  // beantwortet, kommt dort eine gecachte 200 an, waehrend die echte 401 im
  // Hintergrund-Revalidate verworfen wird — der Check kann per Konstruktion nie
  // ausloesen, und der User erfaehrt vom Ablauf erst beim naechsten Schreibversuch.
  // ACHTUNG: der Cache-Schlüssel CONFIG_PATH ignoriert die Query, ein blosses
  // `?__fresh=1` am Aufrufer wuerde also weiterhin den Cache-Eintrag treffen.
  // Der Bypass MUSS im SW stehen — _handleSwr prüft ihn vor dem Cache-Lookup.
  return _handleSwr(req, CONFIG_CACHE, { cacheKey: CONFIG_PATH, content: false, event });
}

// Sitzungs-gebundene Caches wegwerfen. ZWEI Anlaesse, gleiche Wirkung:
//
//  - 'auth-logout' — Logout aus dem Client, sonst rendert die SPA nach
//    `/auth/logout` kurz noch gecachte Seiten/Configs des alten Users.
//  - 'session-changed' — die SPA hat beim Start festgestellt, dass eine ANDERE
//    Sitzung laeuft als die, zu der dieser Cache gehoert
//    (public/js/app/boot/session-change.js). Warum das ein eigener Anlass sein
//    muss: der Logout-Griff greift nur, wenn der User den Logout-Link IN der
//    App klickt UND ein SW die Seite kontrolliert. Eine abgelaufene Session,
//    ein geschlossener Browser oder ein Login direkt von der Login-Seite
//    lassen den Cache stehen — und weil `/content/*` SWR ist, kommt der erste
//    Render nach dem Anmelden dann aus einer beliebig alten Kopie: der Baum
//    zeigt die Seiten des letzten Besuchs, und der Hintergrund-Revalidate
//    fuellt nur den Cache, nicht die schon gerenderte Sidebar.
//
// Geleert statt umgangen: ein leerer Cache laesst SWR ans Netz gehen und FUELLT
// sich dabei wieder — ein `__fresh=1` waere zwar auch frisch, liesse die
// Offline-Kopie aber leer zurueck.
//
// Update-Anstoss: 'skip-waiting' aktiviert den wartenden SW sofort. Erst danach
// feuert `controllerchange` im Client, der dann ein einmaliges location.reload()
// macht.
const SESSION_CACHE_DROP_TYPES = new Set(['auth-logout', 'session-changed']);

self.addEventListener('message', (event) => {
  if (event.data?.type === 'skip-waiting') {
    self.skipWaiting();
    return;
  }
  if (SESSION_CACHE_DROP_TYPES.has(event.data?.type)) {
    const type = event.data.type;
    event.waitUntil((async () => {
      await Promise.all([caches.delete(CONTENT_CACHE), caches.delete(CONFIG_CACHE), OFFLINE?.drop(), DOMAIN?.drop()]);
      event.source?.postMessage?.({ type: type + '-done' });
    })());
  }
  // Invalidiert CONTENT_CACHE-Einträge nach Writes. Ohne diesen Bust liefert SWR
  // nach einem PUT weiterhin die alte Fassung beim nächsten GET — und ein
  // Read-Modify-Write-Pfad (Lektorat-Save, Chat-Vorschlag) überschreibt damit
  // frische User-Edits mit Stale-Daten. paths sind /content/*-Subpfade
  // ohne `/content/`-Prefix.
  // Offline gehaltene Bücher werden dagegen nachgeladen, nicht gelöscht.
  if (event.data?.type === 'invalidate-content') {
    const paths = Array.isArray(event.data.paths) ? event.data.paths : [];
    event.waitUntil(Promise.all([_invalidateCacheEntries(CONTENT_CACHE, paths, '/content/'), OFFLINE?.invalidate(paths)]));
  }
  OFFLINE?.handleMessage(event);
});

async function _invalidateCacheEntries(cacheName, paths, prefix) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const targets = new Set(paths.map(p => prefix + p));
  for (const k of keys) {
    try {
      const u = new URL(k.url);
      if (targets.has(u.pathname)) await cache.delete(k);
    } catch {}
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isNeverCache(url)) return;

  if (req.mode === 'navigate') {
    // Nur die SPA-Shell selbst (/ bzw. /index.html) ist eine Shell-Navigation.
    // Server-gerenderte Public-Seiten (/datenschutz, /register, /landing, /privacy)
    // sind ebenfalls navigate-Requests, dürfen aber NIE durch handleNavigate
    // laufen: das würde ihre Antwort unter SHELL_PATH cachen und den nächsten
    // SPA-Load mit der falschen Seite (z.B. der Datenschutzerklärung) bedienen.
    // Diese Pfade gehen unbehandelt ans Netz.
    if (url.pathname === '/' || url.pathname === '/index.html') {
      event.respondWith(handleNavigate(req, event));
    }
    return;
  }
  if (url.pathname === CONFIG_PATH) {
    event.respondWith(handleConfig(req, event));
    return;
  }
  if (DOMAIN?.handles(url)) {
    event.respondWith(DOMAIN.respond(req, event));
    return;
  }
  // Abschnitts-Bilder vor /content/*: eigener Cache, sonst verdrängten sie
  // Baum und Abschnitte aus dem gedeckelten CONTENT_CACHE.
  if (OFFLINE?.handlesImage(url)) {
    event.respondWith(OFFLINE.respondImage(req, event));
    return;
  }
  if (url.pathname.startsWith('/content/')) {
    // Poll-Endpunkte gehen unbehandelt ans Netz (siehe isLiveContent).
    if (isLiveContent(url)) return;
    event.respondWith(handleContent(req, event));
    return;
  }
  if (isShellRequest(url)) {
    event.respondWith(handleShellAsset(req, url, event));
  }
});
