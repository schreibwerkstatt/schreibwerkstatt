// Gate fuer die Auslieferungsstrategie der /content/*-GETs im Service Worker.
//
// WARUM ALS UNIT-TEST: Der SW ist auf localhost bewusst deaktiviert
// (public/js/app/boot/sw-register.js). Ein Stale-Hit faellt darum weder lokal
// noch im Smoke auf — er zeigt sich erst auf HTTPS, und zwar als Aussage, die
// niemand als Cache-Problem liest: "die Seite hat keine Fassungen". Ein
// Hard-Refresh (umgeht den SW komplett) widerlegt sie, ein normaler Reload nicht
// zuverlaessig.
//
// DIE INVARIANTE: Stale-While-Revalidate ist die richtige Strategie fuer einen
// STAND, der sich aendert (Seiteninhalt, Baum) — und die falsche fuer ein LOG,
// das nur waechst. Die Revisionsliste einer Seite ist ein Log: der Stale-Hit
// zeigt den Stand des letzten Besuchs, und der Hintergrund-Revalidate fuellt nur
// den Cache, nicht die schon gerenderte Karte. Bei einer frisch angelegten Seite
// ist dieser Stand leer, waehrend der Server bereits Fassungen haelt.
// Der Write-seitige Cache-Bust rettet das nicht: er greift nur im schreibenden
// Browser, und Revisionen entstehen auch auf einem zweiten Geraet, im
// Mac-/Android-Client und in Server-Apply-Pfaden.
//
// Umgekehrt muss der Voll-Body EINER Revision und der Seiteninhalt SWR BLEIBEN —
// sonst kostet die Korrektur das Offline-Versprechen des Caches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');

class FakeResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.type = init.type ?? 'basic';
    this._h = new Map(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    this.headers = { get: (k) => this._h.get(String(k).toLowerCase()) ?? null };
  }
  get ok() { return this.status >= 200 && this.status < 300; }
  clone() {
    return new FakeResponse(this.body, {
      status: this.status, type: this.type, headers: Object.fromEntries(this._h),
    });
  }
  async json() { return JSON.parse(this.body); }
  async text() { return String(this.body); }
}

class FakeRequest {
  constructor(url, init = {}) {
    this.url = String(url).startsWith('http') ? String(url) : 'https://example.test' + url;
    this.method = init.method ?? 'GET';
    this.mode = init.mode ?? 'cors';
  }
}

// Anders als im Shell-Test wird hier nach VOLLER URL geschluesselt: die
// Query-Varianten derselben Liste (`?limit=`, `?before=`) sind eigene Eintraege,
// und genau das macht `__fresh` bzw. den Bust interessant.
function makeCache(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => ['https://example.test' + k, v]));
  const writes = [];
  const deletes = [];
  // Der SW schluesselt teils mit einem Request, teils mit einem String-Pfad
  // (CONFIG_PATH) — beide Formen muessen auf denselben Eintrag zeigen.
  const norm = (req) => new URL(typeof req === 'string' ? req : req.url, 'https://example.test').href;
  return {
    store, writes, deletes,
    async match(req) { return store.get(norm(req)); },
    async put(req, res) {
      const key = norm(req);
      writes.push(new URL(key).pathname + new URL(key).search);
      store.set(key, res);
    },
    async delete(req) {
      const key = norm(req);
      deletes.push(new URL(key).pathname);
      return store.delete(key);
    },
    async keys() { return [...store.keys()].map(u => new FakeRequest(u)); },
  };
}

function loadSw({ cache, fetchImpl, posted }) {
  const caches = {
    async open() { return cache; },
    async keys() { return []; },
    async delete() { return true; },
    async match() { return undefined; },
  };
  const listeners = {};
  const sandbox = {
    console, URL, AbortController, JSON,
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout,
    Response: FakeResponse,
    Request: FakeRequest,
    caches,
    fetch: fetchImpl,
    importScripts() {},
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self.__SHELL_BUILD = 'testbuild';
  sandbox.self.__SHELL_MANIFEST = ['/js/app.js'];
  sandbox.self.addEventListener = (type, fn) => { listeners[type] = fn; };
  // Eine Senke fuer postMessage: die Nachzug-Meldung des SW ist Verhalten, das
  // nur hier ueberhaupt beobachtbar ist.
  sandbox.self.clients = {
    matchAll: async () => (posted ? [{ postMessage: (m) => posted.push(m) }] : []),
  };
  sandbox.self.location = { origin: 'https://example.test' };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SW_SRC, ctx);
  ctx.__listeners = listeners;
  return ctx;
}

const REVISIONS = '/content/pages/7/revisions';

test('Revisionsliste: der Serverstand gewinnt gegen einen gecachten Stand', async () => {
  // Die gemeldete Lage: die Karte hat die Liste gecacht, als die Seite frisch war
  // (eine Fassung), danach schrieb ein anderer Pfad weiter.
  const cache = makeCache({ [REVISIONS]: new FakeResponse('{"total":1}') });
  const ctx = loadSw({ cache, fetchImpl: async () => new FakeResponse('{"total":42}') });

  const res = await ctx.handleContent(new FakeRequest(REVISIONS));

  assert.equal(res.body, '{"total":42}',
    'Netz zuerst: ein Log darf nicht aus dem Cache beantwortet werden.');
  assert.deepEqual(cache.writes, [REVISIONS],
    'Die Netzantwort fuellt den Cache — sonst ist die Liste offline nicht lesbar.');
});

test('Revisionsliste: offline faellt sie auf den Cache zurueck', async () => {
  const cache = makeCache({ [REVISIONS]: new FakeResponse('{"total":1}') });
  const ctx = loadSw({ cache, fetchImpl: async () => { throw new Error('offline'); } });

  const res = await ctx.handleContent(new FakeRequest(REVISIONS));

  assert.equal(res.body, '{"total":1}', 'Der Cache bleibt der Offline-Rueckfall.');
  assert.equal(res.status, 200);
});

test('Revisionsliste: eine Fehlerantwort wird nicht durch den Cache beschoenigt', async () => {
  // 401 nach Session-Ablauf muss den Client erreichen (globaler 401-Handler),
  // nicht durch eine alte Liste ersetzt werden.
  const cache = makeCache({ [REVISIONS]: new FakeResponse('{"total":1}') });
  const ctx = loadSw({ cache, fetchImpl: async () => new FakeResponse('{}', { status: 401 }) });

  const res = await ctx.handleContent(new FakeRequest(REVISIONS));

  assert.equal(res.status, 401);
  assert.deepEqual(cache.writes, [], 'Kein Cache-Write fuer eine Fehlerantwort.');
});

test('Der Voll-Body EINER Revision bleibt Cache-zuerst', async () => {
  // Unveraenderlich: hier IST der Cache-Hit die richtige Antwort, und der
  // Viewer soll ihn ohne Netzwartezeit zeigen.
  const path12 = '/content/pages/7/revisions/12';
  const cache = makeCache({ [path12]: new FakeResponse('ALT') });
  let fetched = 0;
  const ctx = loadSw({ cache, fetchImpl: async () => { fetched++; return new FakeResponse('NEU'); } });

  const res = await ctx.handleContent(new FakeRequest(path12));

  assert.equal(res.body, 'ALT', 'Cache-Hit sofort — kein Warten auf das Netz.');
  assert.equal(fetched, 1, 'Revalidate laeuft im Hintergrund (SWR bleibt SWR).');
});

test('Der Seiteninhalt bleibt Stale-While-Revalidate', async () => {
  // Regressions-Gate fuer das Offline-Versprechen: die Korrektur oben darf nicht
  // zur Regel "alles Netz-zuerst" werden.
  const cache = makeCache({ '/content/pages/7': new FakeResponse('<p>offline</p>') });
  const ctx = loadSw({ cache, fetchImpl: async () => new FakeResponse('<p>netz</p>') });

  const res = await ctx.handleContent(new FakeRequest('/content/pages/7'));

  assert.equal(res.body, '<p>offline</p>');
});

test('Poll-Endpunkte werden nicht behandelt und damit nie gecacht', async () => {
  // `/changes` traegt pro Poll einen eigenen `since`-Stempel: gecacht waere jede
  // Antwort ein eigener Eintrag, zwoelf pro Minute — der 200-Eintraege-Deckel
  // haette den offline lesbaren Buchinhalt in einer Viertelstunde verdraengt.
  const cache = makeCache({});
  const ctx = loadSw({ cache, fetchImpl: async () => new FakeResponse('{}') });

  for (const p of [
    '/content/books/3/changes?since=2026-08-31T10:00:00.000Z',
    '/content/books/3/presence?device_id=abc',
    '/content/pages/7/presence?device_id=abc',
  ]) {
    let responded = false;
    ctx.__listeners.fetch({
      request: new FakeRequest(p),
      respondWith: () => { responded = true; },
    });
    assert.equal(responded, false, `${p} muss unbehandelt ans Netz gehen.`);
  }
});

test('Der Baum bleibt behandelt — der Poll-Ausschluss greift nicht zu breit', async () => {
  const cache = makeCache({});
  const ctx = loadSw({ cache, fetchImpl: async () => new FakeResponse('{}') });
  let responded = false;
  ctx.__listeners.fetch({
    request: new FakeRequest('/content/books/3/tree'),
    respondWith: () => { responded = true; },
  });
  assert.equal(responded, true);
});

// ── /config ───────────────────────────────────────────────────────────────
// Der Wake-Refresh holt `/config` allein, um eine abgelaufene Session an den
// globalen 401-Wrapper zu geben. SWR beantwortet das aus dem Cache und verwirft
// die echte 401 im Hintergrund-Revalidate — der Check koennte per Konstruktion
// nie ausloesen. Der Bypass muss IM SW liegen: `cache.match(CONFIG_PATH)`
// ignoriert die Query, ein `?__fresh=1` allein trifft sonst denselben Eintrag.
test('/config?__fresh=1 umgeht den Cache — sonst kann der 401-Check nie ausloesen', async () => {
  const cache = makeCache({ '/config': new FakeResponse('{"user":"alt"}') });
  const ctx = loadSw({ cache, fetchImpl: async () => new FakeResponse('{}', { status: 401 }) });

  const res = await ctx.handleConfig(new FakeRequest('/config?__fresh=1'));

  assert.equal(res.status, 401, 'Die 401 muss beim Aufrufer ankommen.');
});

test('/config bleibt ohne Marker SWR (Offline-Bootstrap)', async () => {
  const cache = makeCache({ '/config': new FakeResponse('{"user":"alt"}') });
  const ctx = loadSw({ cache, fetchImpl: async () => new FakeResponse('{"user":"neu"}') });

  const res = await ctx.handleConfig(new FakeRequest('/config'));

  assert.equal(res.body, '{"user":"alt"}',
    'Der Boot darf aus dem Cache kommen — sonst startet die App offline nicht.');
});

test('/config?__fresh=1 aktualisiert den Cache-Eintrag unter seinem Basispfad', async () => {
  // Sonst laege der frische Stand unter dem Query-Schluessel und der naechste
  // Boot (ohne Marker) laese weiter die alte Fassung.
  const cache = makeCache({ '/config': new FakeResponse('{"user":"alt"}') });
  const ctx = loadSw({ cache, fetchImpl: async () => new FakeResponse('{"user":"neu"}') });

  await ctx.handleConfig(new FakeRequest('/config?__fresh=1'));

  assert.deepEqual(cache.writes, ['/config']);
  assert.equal(cache.store.get('https://example.test/config').body, '{"user":"neu"}');
});

test('Ein gecachtes no-cache wird nicht stale ausgeliefert (Server-Ansage gilt)', async () => {
  // Die drei `/content/*/release.json` deklarieren ausdruecklich „immer
  // revalidieren". Eine gecachte Antwort auf „gibt es eine neuere
  // Client-Version?" ist genau die Aussage, die der Endpunkt nicht machen wollte.
  const p = '/content/macclient/release.json';
  const cache = makeCache({ [p]: new FakeResponse('{"version":"1.0.0"}', {
    headers: { 'Cache-Control': 'no-cache' },
  }) });
  const ctx = loadSw({ cache, fetchImpl: async () => new FakeResponse('{"version":"2.0.0"}') });

  const res = await ctx.handleContent(new FakeRequest(p));

  assert.equal(res.body, '{"version":"2.0.0"}');
});

test('Ohne no-cache bleibt es bei SWR — die Ansage ist eine Ausnahme, keine Umkehr', async () => {
  const p = '/content/pages/9';
  const cache = makeCache({ [p]: new FakeResponse('ALT', {
    headers: { 'Cache-Control': 'private, max-age=3600' },
  }) });
  const ctx = loadSw({ cache, fetchImpl: async () => new FakeResponse('NEU') });

  const res = await ctx.handleContent(new FakeRequest(p));

  assert.equal(res.body, 'ALT');
});

// ── Nachzug nach Revalidierung ────────────────────────────────────────────
// Stale-While-Revalidate liefert den Cache-Stand an die UI und die Netzantwort
// nur in den Cache. Ohne Meldung erfaehrt die schon gerenderte Sidebar davon nie
// — deshalb zeigt der erste Reload den Baum vom letzten Besuch und erst der
// zweite den aktuellen. Genau das ist das gemeldete „ich muss zu oft reloaden".

const TREE = '/content/books/3/tree';

// Der Netz-Fetch laeuft im Hintergrund (der Cache-Hit geht sofort raus); die
// Meldung faellt eine Mikrotask spaeter. `setTimeout` ist im Sandbox-Harness
// synchron, also reicht ein Tick der Microtask-Queue.
const settle = () => new Promise(r => setTimeout(r, 0));

// Die Nachrichten entstehen IM vm-Context und haben darum einen fremden
// Object-Prototyp — `deepEqual` scheitert daran, obwohl der Inhalt stimmt.
const assertPosted = (posted, paths) => {
  assert.deepEqual(posted.map(m => `${m.type} ${m.path}`),
    paths.map(p => `content-updated ${p}`));
};

test('Abweichende Revalidierung wird den Tabs gemeldet', async () => {
  const cache = makeCache({ [TREE]: new FakeResponse('{"chapters":[1]}') });
  const posted = [];
  const ctx = loadSw({
    cache, posted,
    fetchImpl: async () => new FakeResponse('{"chapters":[1,2]}'),
  });

  const res = await ctx.handleContent(new FakeRequest(TREE));
  assert.equal(res.body, '{"chapters":[1]}',
    'Der Cache-Hit geht weiterhin sofort raus — SWR bleibt SWR.');

  await settle();
  assertPosted(posted, [TREE],
    'Die Abweichung muss gemeldet werden, sonst rendert niemand nach.');
});

test('Unveraenderte Revalidierung meldet nichts', async () => {
  // Sonst waere jeder Read ein Re-Render — der Regelfall ist „nichts Neues".
  const cache = makeCache({ [TREE]: new FakeResponse('{"chapters":[1]}') });
  const posted = [];
  const ctx = loadSw({
    cache, posted,
    fetchImpl: async () => new FakeResponse('{"chapters":[1]}'),
  });

  await ctx.handleContent(new FakeRequest(TREE));
  await settle();

  assertPosted(posted, []);
});

test('Bei gleichem ETag entscheidet der Header — ohne Body-Vergleich', async () => {
  // Der Regelfall nach der Cache-Control-Ansage der Route: der HTTP-Cache des
  // Browsers beantwortet die Revalidierung per 304, der Body ist identisch.
  const cache = makeCache({ [TREE]: new FakeResponse('{"chapters":[1]}', {
    headers: { ETag: 'W/"abc"' },
  }) });
  const posted = [];
  const ctx = loadSw({
    cache, posted,
    fetchImpl: async () => new FakeResponse('{"chapters":[1]}', { headers: { ETag: 'W/"abc"' } }),
  });

  await ctx.handleContent(new FakeRequest(TREE));
  await settle();

  assertPosted(posted, []);
});

test('Abweichender ETag meldet, auch wenn der Body gleich aussaehe', async () => {
  const cache = makeCache({ [TREE]: new FakeResponse('X', { headers: { ETag: 'W/"abc"' } }) });
  const posted = [];
  const ctx = loadSw({
    cache, posted,
    fetchImpl: async () => new FakeResponse('X', { headers: { ETag: 'W/"def"' } }),
  });

  await ctx.handleContent(new FakeRequest(TREE));
  await settle();

  assertPosted(posted, [TREE]);
});

test('Ohne gecachten Stand gibt es nichts zu melden', async () => {
  // Kaltstart: die Netzantwort IST die ausgelieferte Antwort. Eine Meldung
  // hiesse, den Client zum Nachladen dessen zu bitten, was er gerade bekommt.
  const cache = makeCache({});
  const posted = [];
  const ctx = loadSw({ cache, posted, fetchImpl: async () => new FakeResponse('{"chapters":[]}') });

  await ctx.handleContent(new FakeRequest(TREE));
  await settle();

  assertPosted(posted, []);
});

test('Eine Fehlerantwort meldet nichts und ueberschreibt den Cache nicht', async () => {
  const cache = makeCache({ [TREE]: new FakeResponse('{"chapters":[1]}') });
  const posted = [];
  const ctx = loadSw({ cache, posted, fetchImpl: async () => new FakeResponse('{}', { status: 401 }) });

  await ctx.handleContent(new FakeRequest(TREE));
  await settle();

  assertPosted(posted, []);
  assert.deepEqual(cache.writes, []);
});

test('Ein abweichender Abschnitt wird gemeldet', async () => {
  // Ohne Meldung bliebe die Lese-Ansicht auf dem Stand des letzten Besuchs, und
  // ein Edit-Start nähme ihn als Basis.
  const p = '/content/pages/9';
  const cache = makeCache({ [p]: new FakeResponse('ALT') });
  const posted = [];
  const ctx = loadSw({ cache, posted, fetchImpl: async () => new FakeResponse('NEU') });

  const res = await ctx.handleContent(new FakeRequest(p));
  assert.equal(res.body, 'ALT', 'SWR bleibt SWR.');
  await settle();
  assertPosted(posted, [p]);
  assert.deepEqual(cache.writes, [p]);
});

test('Revisionsliste und Revisions-Body eines Abschnitts werden nicht gemeldet', async () => {
  // Nur der Abschnitt selbst hat einen Konsumenten; der Anker schliesst die
  // Unterpfade aus. Der Voll-Body einer Revision ist unveränderlich.
  const p = '/content/pages/9/revisions/12';
  const cache = makeCache({ [p]: new FakeResponse('ALT') });
  const posted = [];
  const ctx = loadSw({ cache, posted, fetchImpl: async () => new FakeResponse('NEU') });
  await ctx.handleContent(new FakeRequest(p));
  await settle();
  assertPosted(posted, []);
});

// ── __fresh fuellt den Cache ──────────────────────────────────────────────
// Der Marker heisst „beantworte MICH nicht aus dem Cache". Er darf nicht
// zusaetzlich heissen „lass die Offline-Kopie stehen": ein Buch, das man nur
// per Buchwechsel oeffnet, wird ausschliesslich `fresh` gelesen
// (tree/load.js#FRESH_SOURCES) — sein Baum kaeme im Zug sonst nie aus dem
// Cache, weil er nie hineingeschrieben wurde. `/config` macht es seit je so.

test('__fresh liefert die Netzantwort UND zieht den Cache-Eintrag nach', async () => {
  const cache = makeCache({ [TREE]: new FakeResponse('ALT') });
  const ctx = loadSw({ cache, fetchImpl: async () => new FakeResponse('NEU') });

  const res = await ctx.handleContent(new FakeRequest(TREE + '?__fresh=1'));

  assert.equal(res.body, 'NEU', 'Der Aufrufer bekommt unveraendert den Serverstand.');
  assert.deepEqual(cache.writes, [TREE],
    'Abgelegt unter dem Pfad OHNE Marker — sonst trifft ihn kein normaler Read.');
  assert.equal(cache.store.get('https://example.test' + TREE).body, 'NEU');
});

test('__fresh behaelt die uebrigen Query-Parameter beim Ablegen', async () => {
  const p = '/content/pages/7/revisions';
  const cache = makeCache({});
  const ctx = loadSw({ cache, fetchImpl: async () => new FakeResponse('{"total":3}') });

  await ctx.handleContent(new FakeRequest(p + '?limit=5&__fresh=1'));

  // Netz-zuerst-Pfad (volatiles Log) — er cacht ohnehin unter der vollen URL.
  assert.deepEqual(cache.writes, [p + '?limit=5&__fresh=1']);
});

test('__fresh cacht keine Fehlerantwort', async () => {
  const cache = makeCache({ [TREE]: new FakeResponse('ALT') });
  const ctx = loadSw({ cache, fetchImpl: async () => new FakeResponse('{}', { status: 401 }) });

  const res = await ctx.handleContent(new FakeRequest(TREE + '?__fresh=1'));

  assert.equal(res.status, 401);
  assert.deepEqual(cache.writes, []);
  assert.equal(cache.store.get('https://example.test' + TREE).body, 'ALT',
    'Der bestehende Offline-Stand bleibt, statt durch eine 401 ersetzt zu werden.');
});
