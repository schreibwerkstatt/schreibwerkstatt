// Gate fuer die Kohaerenz-Invariante der SPA-Shell im Service Worker.
//
// WARUM ALS UNIT-TEST: Der SW ist auf localhost bewusst deaktiviert
// (public/js/app/boot/sw-register.js) — dieser Fehlerfall kann darum weder
// lokal noch per Klick-Test noch im Smoke auffallen. Er entsteht ausschliesslich
// beim Deploy auf HTTPS und schlaegt dann als Wand von Alpine-Expression-Fehlern
// zu ("$store.x is undefined", "xxxCard is not defined").
//
// DIE INVARIANTE: Der Shell-HTML gehoert zum kohaerenz-kritischen Asset-Satz.
// Jede SW-Generation precacht ihren Satz atomar und liefert ihn cache-only aus.
// Wuerde handleNavigate die Netzkopie in den SHELL_CACHE zurueckschreiben,
// landete nach einem Deploy das HTML der NEUEN Generation im Cache des noch
// aktiven ALTEN SW (kein skipWaiting) — waehrend jedes Modul/Partial weiter
// cache-only aus der ALTEN Generation kommt. Ergebnis: neues Markup gegen alte
// JS-Module. Ein Login ist der typische Ausloeser, weil er mehrere echte
// Navigationen hintereinander macht: die erste schreibt das fremde HTML in den
// Cache, die zweite serviert es.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');

// DIE ZWEITE INVARIANTE: Nur die echte SPA-Shell darf als Shell gelten.
// `GET /` liefert unter EINER URL zwei Dokumente — eingeloggt die Shell, anonym
// die Landing-Seite (routes/public.js), beide mit 200 und ohne Redirect —, und
// die Partials stehen hinter dem Auth-Guard (302 auf /login). Ein Install ohne
// gueltige Session legte darum frueher die Landing-Seite als Shell und die
// Login-Seite unter jedem Partial-Pfad ab. Weil Shell-Assets cache-only
// ausgeliefert werden, blieb die Generation danach dauerhaft kaputt: der
// eingeloggte User sah die anonyme Startseite, ein Klick auf "Anmelden" fuehrte
// ueber /login zurueck auf dieselbe gecachte Seite ("nichts passiert"), und nur
// ein Hard-Refresh (umgeht den SW) kam daran vorbei.
//
// Minimal-Stubs der SW-Umgebung. Nur so viel, dass sw.js evaluiert und
// handleNavigate/install aufrufbar sind.
const SHELL_HTML = '<body x-data="lektorat">GENERATION-A</body>';
const SHELL_HEADERS = { 'X-App-Shell': '1' };


class FakeResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.type = init.type ?? 'basic';
    this._h = new Map(
      Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    // Echte Responses tragen ein Headers-Objekt; sw.js liest darueber den
    // Shell-Marker. Ein blankes `{}` wuerde den Aufruf werfen lassen.
    this.headers = { get: (k) => this._h.get(String(k).toLowerCase()) ?? null };
  }
  get ok() { return this.status >= 200 && this.status < 300; }
  async text() { return this.body; }
  clone() {
    return new FakeResponse(this.body, {
      status: this.status, type: this.type, headers: Object.fromEntries(this._h),
    });
  }
}

// Vollstaendigkeits-Marke, die der Install als letzten Eintrag ablegt.
const COMPLETE = { '/__sw-generation-complete': new FakeResponse('testbuild') };

class FakeRequest {
  constructor(url, init = {}) {
    this.url = String(url).startsWith('http') ? String(url) : 'https://example.test' + url;
    this.method = init.method ?? 'GET';
    this.mode = init.mode ?? 'navigate';
    // `redirect`/`signal` reicht der Precache mit — der Test prueft genau das.
    this.redirect = init.redirect ?? 'follow';
    this.signal = init.signal;
    this.body = init.body;
  }
  get pathname() { return new URL(this.url).pathname; }
}

function makeCache(initial = {}) {
  const store = new Map(Object.entries(initial));
  const writes = [];
  return {
    store,
    writes,
    async match(req, opts = {}) {
      const key = typeof req === 'string' ? req : new URL(req.url).pathname;
      if (store.has(key)) return store.get(key);
      if (opts.ignoreSearch) {
        const bare = key.split('?')[0];
        if (store.has(bare)) return store.get(bare);
      }
      return undefined;
    },
    async put(req, res) {
      const key = typeof req === 'string' ? req : new URL(req.url).pathname;
      writes.push(key);
      store.set(key, res);
    },
    async add() { throw new Error('cache.add nicht erwartet'); },
    async keys() { return [...store.keys()]; },
  };
}

// Laedt sw.js in einen frischen VM-Context. Top-Level-Funktionsdeklarationen
// (handleNavigate) landen dabei als Globals des Contexts und sind aufrufbar,
// waehrend die `const`-Bindings (SHELL_CACHE, SHELL_PATH) im Scope sichtbar
// bleiben.
function loadSw({ cache, fetchImpl, posted = [], updates = [], manifest = ['/js/app.js', '/partials/x.html'] }) {
  const caches = {
    async open() { return cache; },
    async keys() { return []; },
    async delete() { return true; },
    async match() { return undefined; },
  };
  const listeners = {};
  const sandbox = {
    console,
    URL,
    AbortController,
    // Backoff sofort ablaufen lassen — die Tests messen Verhalten, nicht Wartezeit.
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout,
    Response: FakeResponse,
    Request: FakeRequest,
    caches,
    fetch: fetchImpl,
    importScripts() { /* Manifest-Konstanten werden unten direkt gesetzt */ },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self.__SHELL_BUILD = 'testbuild';
  sandbox.self.__SHELL_MANIFEST = manifest;
  sandbox.self.addEventListener = (type, fn) => { listeners[type] = fn; };
  sandbox.self.clients = { matchAll: async () => [{ postMessage: (m) => posted.push(m) }] };
  sandbox.self.registration = { update: async () => { updates.push(1); } };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SW_SRC, ctx);
  ctx.__listeners = listeners;
  return ctx;
}

// Feuert 'install' und liefert das an waitUntil uebergebene Promise.
function runInstall(ctx) {
  let p;
  ctx.__listeners.install({ waitUntil: (promise) => { p = promise; } });
  return p;
}

test('handleNavigate ueberschreibt eine gecachte Shell NICHT mit der Netzkopie', async () => {
  const cachedShell = new FakeResponse(SHELL_HTML, { headers: SHELL_HEADERS });
  const cache = makeCache({ '/index.html': cachedShell, ...COMPLETE });
  let fetchCalls = 0;
  const ctx = loadSw({
    cache,
    fetchImpl: async () => {
      fetchCalls++;
      return new FakeResponse('<body x-data="lektorat">GENERATION-B</body>', { headers: SHELL_HEADERS });
    },
  });

  const res = await ctx.handleNavigate(new FakeRequest('/'));

  assert.equal(res.body, SHELL_HTML,
    'Bei Cache-Hit muss die Shell DIESER Generation ausgeliefert werden.');
  assert.deepEqual(cache.writes, [],
    'Kein Write in den SHELL_CACHE bei Cache-Hit — sonst landet fremdes HTML in dieser Generation.');
  assert.equal(cache.store.get('/index.html').body, SHELL_HTML,
    'Die gecachte Shell darf unveraendert bleiben.');
  assert.equal(fetchCalls, 0,
    'Kein Revalidate-Fetch: die Generation ist unveraenderlich (HTML-Bytes gehen in __SHELL_BUILD ein).');
});

test('handleNavigate serviert eine gecachte Shell OHNE Marker weiter (Altbestand)', async () => {
  // Eintraege aus einer Generation vor dem Marker sind echte Shells. Sie durch
  // die Netzkopie zu ersetzen waere nach einem Deploy neues HTML gegen alte
  // Module — genau der Skew von oben. Erkannt wird das am Inhalt.
  const cache = makeCache({ '/index.html': new FakeResponse(SHELL_HTML), ...COMPLETE });
  let fetchCalls = 0;
  const ctx = loadSw({
    cache,
    fetchImpl: async () => { fetchCalls++; return new FakeResponse('<html>GENERATION-B</html>'); },
  });

  const res = await ctx.handleNavigate(new FakeRequest('/'));

  assert.equal(res.body, SHELL_HTML);
  assert.equal(fetchCalls, 0, 'kein Netz-Fetch, kein Generationswechsel durch die Hintertuer');
  assert.deepEqual(cache.writes, []);
});

test('handleNavigate liefert eine eingefangene Landing-Seite NICHT als Shell aus', async () => {
  // Die kaputte Lage: ein Install ohne Session hat die Landing-Seite als Shell
  // abgelegt. Sie auszuliefern hiesse, dem eingeloggten User die anonyme
  // Startseite zu zeigen — die Falle, aus der nur der Hard-Refresh half.
  const cache = makeCache({ '/index.html': new FakeResponse('<h1>Landing</h1>'), ...COMPLETE });
  const ctx = loadSw({
    cache,
    fetchImpl: async () => new FakeResponse(SHELL_HTML, { headers: SHELL_HEADERS }),
  });

  const res = await ctx.handleNavigate(new FakeRequest('/'));

  assert.equal(res.body, SHELL_HTML, 'der User bekommt die echte Shell vom Netz');
  assert.deepEqual(cache.writes, [],
    'aber kein Write in die fremde Generation — die raeumt der naechste Install auf.');
});

test('handleNavigate liefert bei kaltem Cache vom Netz, schreibt aber nichts dazwischen', async () => {
  // Kalt heisst beim laufenden SW immer: die Generation ist verloren (der
  // Install fuellt sie vollstaendig). Frueher legte dieser Pfad die Netz-Shell
  // ab — heraus kam „Shell da, Assets weg", und jeder Asset-Miss meldete
  // 'shell-incoherent'. Nachfuellen ist Sache von repairGeneration.
  const cache = makeCache({});
  const ctx = loadSw({
    cache,
    fetchImpl: async () => new FakeResponse('<html>FRISCH</html>', { headers: SHELL_HEADERS }),
  });

  const res = await ctx.handleNavigate(new FakeRequest('/'));

  assert.equal(res.body, '<html>FRISCH</html>');
  assert.deepEqual(cache.writes, [], 'kein Einzel-Eintrag in eine unvollstaendige Generation');
});

test('handleNavigate cacht die anonyme Landing-Seite nicht als Shell', async () => {
  // Kalter Cache, keine Session: `/` antwortet mit 200 und der Landing-Seite.
  // Ohne Marker-Pruefung landete genau die als SPA-Shell in der Generation.
  const cache = makeCache({});
  const ctx = loadSw({ cache, fetchImpl: async () => new FakeResponse('<h1>Landing</h1>') });

  const res = await ctx.handleNavigate(new FakeRequest('/'));

  assert.equal(res.body, '<h1>Landing</h1>', 'anonyme Besucher sehen sie normal');
  assert.deepEqual(cache.writes, [], 'sie darf dabei nicht zur Shell werden');
});

test('handleNavigate cacht keinen Login-Redirect und keine Fehlerantwort als Shell', async () => {
  for (const bad of [
    new FakeResponse('', { status: 302, type: 'opaqueredirect' }),
    new FakeResponse('nope', { status: 500 }),
  ]) {
    const cache = makeCache({});
    const ctx = loadSw({ cache, fetchImpl: async () => bad });
    await ctx.handleNavigate(new FakeRequest('/'));
    assert.deepEqual(cache.writes, [],
      `Antwort (status=${bad.status}, type=${bad.type}) darf nicht als SPA-Shell gecacht werden.`);
  }
});

test('handleNavigate liefert 503 statt zu haengen, wenn offline und Cache leer', async () => {
  const cache = makeCache({});
  const ctx = loadSw({
    cache,
    fetchImpl: async () => { throw new Error('offline'); },
  });

  const res = await ctx.handleNavigate(new FakeRequest('/'));
  assert.equal(res.status, 503);
});

// --- Install: keine vergiftete Generation anlegen ----------------------------

test('Install bricht ab, wenn `/` die Landing-Seite liefert — nach EINEM Request', async () => {
  const cache = makeCache({});
  const seen = [];
  const reports = [];
  const ctx = loadSw({
    cache,
    fetchImpl: async (req) => {
      seen.push(req.pathname);
      if (req.pathname === '/telemetry/js-error') { reports.push(JSON.parse(req.body)); return new FakeResponse('{}'); }
      return req.pathname === '/' ? new FakeResponse('<h1>Landing</h1>') : new FakeResponse('asset');
    },
  });

  await assert.rejects(runInstall(ctx),
    'Ohne Session ist diese Generation nicht installierbar — sie waere nur Muell.');
  assert.deepEqual(cache.writes, [], 'nichts gecacht: die alte Generation bleibt heil');
  assert.deepEqual(seen, ['/', '/telemetry/js-error'],
    'Die Shell-Antwort klaert die Lage allein — kein Precache-Sturm ueber ~800 Assets.');
  assert.equal(reports.length, 1,
    'Der Abbruch an der Session-Probe ist selbst der meldepflichtige Grund: ohne diesen Report bleibt ein dauerhaft unkontrollierter Browser ohne jede Spur, die ihn verursacht hat.');
  assert.match(reports[0].message, /SW-Install gescheitert: Install abgebrochen/);
  assert.match(reports[0].message, /build=testbuild\]/,
    'Ohne Precache-Fehler gibt es keine Fortschrittsangabe — kein "ok=undefined/undefined".');
  assert.equal(reports[0].source, null);
});

test('Precache cacht keine umgeleitete Antwort (Auth-Guard → /login)', async () => {
  // Session bricht MITTEN im Install weg: `/` kam noch als Shell, die Partials
  // laufen schon in den Guard. `redirect: 'error'` muss daraus einen Fehler
  // machen — ein gefolgter 302 landete sonst als Login-Seite unter dem
  // Partial-Pfad, und cache-only servierte sie danach als Karte aus.
  const cache = makeCache({});
  const ctx = loadSw({
    cache,
    fetchImpl: async (req) => {
      if (req.pathname === '/') return new FakeResponse(SHELL_HTML, { headers: SHELL_HEADERS });
      if (req.pathname.startsWith('/partials/')) {
        if (req.redirect === 'error') throw new TypeError('Failed to fetch: redirect');
        return new FakeResponse('<title>Anmeldung</title>');
      }
      return new FakeResponse('asset');
    },
  });

  await assert.rejects(runInstall(ctx));
  assert.deepEqual(cache.writes, [], 'kein halb gefuellter Cache, auch nicht die Shell');
});

test('Install cacht die markierte Shell unter beiden Schluesseln', async () => {
  const cache = makeCache({});
  const ctx = loadSw({
    cache,
    fetchImpl: async (req) => (req.pathname === '/'
      ? new FakeResponse(SHELL_HTML, { headers: SHELL_HEADERS })
      : new FakeResponse('asset')),
  });

  await runInstall(ctx);

  assert.equal(cache.store.get('/index.html').body, SHELL_HTML);
  assert.equal(cache.store.get('/').body, SHELL_HTML,
    'Navigation fragt "/", der Lookup greift auf SHELL_PATH — beide muessen treffen.');
  assert.ok(cache.store.has('/partials/x.html'), 'der uebrige Satz ist ebenfalls drin');
});

// --- Precache: Parallelitaet, Retry pro Asset, Install-Meldung --------------
//
// Ein gescheiterter Erst-Install laesst die Seite dauerhaft unkontrolliert —
// ohne jedes sichtbare Signal. Darum: ein Aussetzer darf nicht den ganzen Satz
// verwerfen, die Last bleibt begrenzt, und ein endgueltiges Scheitern meldet
// der SW selbst an die Telemetrie.

const shellOr = (fn) => async (req) => (req.pathname === '/'
  ? new FakeResponse(SHELL_HTML, { headers: SHELL_HEADERS })
  : fn(req));

test('Precache: ein transienter Fehler kostet EINEN Retry, nicht den ganzen Satz', async () => {
  const cache = makeCache({});
  const seen = [];
  let failedOnce = false;
  const ctx = loadSw({
    cache,
    fetchImpl: shellOr(async (req) => {
      seen.push(req.pathname);
      if (req.pathname === '/js/app.js' && !failedOnce) {
        failedOnce = true;
        throw new TypeError('Failed to fetch');
      }
      return new FakeResponse('asset');
    }),
  });
  await runInstall(ctx);
  assert.ok(cache.store.has('/js/app.js') && cache.store.has('/partials/x.html'));
  assert.equal(seen.filter(p => p === '/partials/x.html').length, 1,
    'das intakte Asset wird nicht erneut geholt');
  assert.equal(seen.filter(p => p === '/js/app.js').length, 2);
});

test('Precache: hoechstens PRECACHE_CONCURRENCY Requests gleichzeitig', async () => {
  const manifest = Array.from({ length: 100 }, (_, i) => `/js/m${i}.js`);
  let inFlight = 0;
  let peak = 0;
  const ctx = loadSw({
    cache: makeCache({}),
    manifest,
    fetchImpl: shellOr(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 1));
      inFlight--;
      return new FakeResponse('asset');
    }),
  });
  await runInstall(ctx);
  assert.ok(peak <= 16, `Spitze ${peak} > 16 parallele Requests`);
  assert.ok(peak > 1, 'aber parallel, nicht seriell');
});

test('Install-Fehler im Precache wird an die Telemetrie gemeldet, Cache bleibt leer', async () => {
  const cache = makeCache({});
  const reports = [];
  const ctx = loadSw({
    cache,
    fetchImpl: async (req) => {
      if (req.pathname === '/telemetry/js-error') { reports.push(JSON.parse(req.body)); return new FakeResponse('{}'); }
      if (req.pathname === '/') return new FakeResponse(SHELL_HTML, { headers: SHELL_HEADERS });
      if (req.pathname === '/partials/x.html') return new FakeResponse('down', { status: 502 });
      return new FakeResponse('asset');
    },
  });
  await assert.rejects(runInstall(ctx));
  assert.deepEqual(cache.writes, []);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].kind, 'boot');
  assert.equal(reports[0].source, '/partials/x.html');
  assert.match(reports[0].message, /SW-Install gescheitert: .*HTTP 502.*build=testbuild ok=1\/2/);
});

// --- Verlorene Generation: Netz-Modus + Selbstreparatur ----------------------
//
// Die Lage aus der Telemetrie: der SW dieser Generation laeuft, sein SHELL_CACHE
// ist aber leer (Cache-Wurf der Heilungspfade; `unregister()` wird vom naechsten
// `register()` derselben Script-URL zurueckgeholt, ohne neuen Install). Jeder
// Asset-Request war ein Miss, jeder meldete 'shell-incoherent', der Client lud
// neu, der Banner-Klick fand keinen wartenden SW — nur Ctrl-F5 kam heraus.

function assetEnv({ cache, serverBuild = 'testbuild' }) {
  const posted = [];
  const updates = [];
  const netSeen = [];
  const ctx = loadSw({
    cache, posted, updates,
    fetchImpl: async (req) => {
      netSeen.push(req.pathname);
      if (req.pathname === '/sw-manifest.js') {
        return new FakeResponse(`self.__SHELL_BUILD = "${serverBuild}";`);
      }
      if (req.pathname === '/') return new FakeResponse(SHELL_HTML, { headers: SHELL_HEADERS });
      return new FakeResponse('NETZ ' + req.pathname);
    },
  });
  const pending = [];
  const event = { waitUntil: (p) => pending.push(p) };
  const asset = (p) => ctx.handleShellAsset(new FakeRequest(p, { mode: 'no-cors' }), new URL('https://example.test' + p), event);
  return { ctx, posted, updates, netSeen, pending, event, asset };
}

test('Install legt die Vollstaendigkeits-Marke als LETZTEN Eintrag ab', async () => {
  const cache = makeCache({});
  const ctx = loadSw({
    cache,
    fetchImpl: async (req) => (req.pathname === '/'
      ? new FakeResponse(SHELL_HTML, { headers: SHELL_HEADERS })
      : new FakeResponse('asset')),
  });
  await runInstall(ctx);
  assert.equal(cache.writes.at(-1), '/__sw-generation-complete',
    'erst wenn alles drin ist, darf die Generation als vollstaendig gelten');
});

test('Verlorene Generation: Asset vom Netz, KEIN shell-incoherent, Reparatur fuellt nach', async () => {
  const cache = makeCache({});
  const env = assetEnv({ cache });

  const res = await env.asset('/js/app.js');
  assert.equal(res.body, 'NETZ /js/app.js', 'die Seite bootet aus dem Netz');
  await Promise.all(env.pending);

  assert.deepEqual(env.posted.filter(m => m.type === 'shell-incoherent'), [],
    'ein Reload landete im selben Zustand — die Meldung triebe nur die Schleife');
  assert.ok(cache.store.has('/__sw-generation-complete'), 'Generation ist wieder vollstaendig');
  assert.ok(cache.store.has('/partials/x.html') && cache.store.has('/index.html'));
});

test('Verlorene Generation, Server schon weiter: nichts Fremdes ablegen, Update anstossen', async () => {
  const cache = makeCache({});
  const env = assetEnv({ cache, serverBuild: 'neuerbuild' });

  await env.asset('/js/app.js');
  await Promise.all(env.pending);

  assert.deepEqual(cache.writes, [],
    'Netz-Bytes einer anderen Generation in diesen Cache = genau der Skew, den cache-only verhindert');
  assert.equal(env.updates.length, 1, 'der neue SW kommt ueber den regulaeren Update-Weg');
});

test('Einzel-Eviction in vollstaendiger Generation meldet weiterhin shell-incoherent', async () => {
  const cache = makeCache({ ...COMPLETE, '/partials/x.html': new FakeResponse('P') });
  const env = assetEnv({ cache });

  await env.asset('/js/app.js');
  await new Promise(r => setImmediate(r));

  assert.equal(env.posted.filter(m => m.type === 'shell-incoherent').length, 1);
  assert.deepEqual(cache.writes, [], 'der Notnagel wird nicht in die Generation geschrieben');
});

test('/sw-manifest.js nennt den Build DIESES SW, nicht den des Servers', async () => {
  const cache = makeCache({ ...COMPLETE });
  const env = assetEnv({ cache, serverBuild: 'neuerbuild' });

  const res = await env.asset('/sw-manifest.js');

  assert.match(res.body, /self\.__SHELL_BUILD = "testbuild"/,
    'sonst vergleicht der Build-Guard gegen die Zahl des Servers beim ersten Load');
  assert.ok(!env.netSeen.includes('/sw-manifest.js'));
  assert.deepEqual(cache.writes, []);
});

test('/sw-manifest.js kommt im Netz-Modus vom Netz (die ganze Seite stammt dort her)', async () => {
  const cache = makeCache({});
  const env = assetEnv({ cache, serverBuild: 'neuerbuild' });

  const res = await env.asset('/sw-manifest.js');

  assert.match(res.body, /neuerbuild/);
});

// --- Drift-Gate --------------------------------------------------------------

test('SHELL_BODY_MARKER steht wirklich in public/index.html', () => {
  const ctx = loadSw({ cache: makeCache({}), fetchImpl: async () => new FakeResponse('') });
  const marker = vm.runInContext('SHELL_BODY_MARKER', ctx);
  const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

  assert.ok(indexHtml.includes(marker),
    `public/index.html enthaelt "${marker}" nicht mehr — der SW erkennt unmarkierte `
    + 'Alt-Eintraege dann nicht als Shell und holt sie bei jeder Navigation neu.');
  for (const other of ['public/landing.html', 'public/register.html']) {
    assert.ok(!fs.readFileSync(path.join(ROOT, other), 'utf8').includes(marker),
      `${other} enthaelt "${marker}" — der Marker muss die SPA-Shell eindeutig auszeichnen.`);
  }
});
