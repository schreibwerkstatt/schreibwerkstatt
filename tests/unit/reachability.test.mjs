// Gate für die Server-Erreichbarkeit (public/js/app/boot/reachability.js,
// fetch-guard.js, net-required.js, public/sw-net.js).
//
// DIE INVARIANTEN:
//   1. Offline = Browser offline ODER Server unerreichbar (`isOffline`).
//   2. Einstieg: 'slow'/'timeout' sofort, 'network'/'proxy' ab dem zweiten
//      innert FAIL_WINDOW_MS. Versteckter Tab und Browser-offline zählen nicht.
//   3. Ausstieg mit der ersten echten Server-Antwort.
//   4. Der Test (`/ping`) gilt nur mit `{ app: 'schreibwerkstatt' }` — ein
//      Captive Portal mit 200 und eigener Seite schaltet nicht zurück.
//   5. Riegel: bei unerreichbarem Server testet eine ausdrückliche Aktion
//      erst und läuft weiter, wenn der Server antwortet; automatische
//      Requests werden ohne Test abgewiesen; Saves nie.
//   6. fetch-guard zählt Erfolg nur für Antworten, die sicher vom Netz kamen
//      (Schreib-Request oder kein SW); ein Abbruch durch den Aufrufer zählt nie.
//   7. sw-net.js meldet ok/fail/slow an die Tabs und wartet bei bekanntem
//      Ausfall nur FAST_MS.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const setNavigator = (v) => Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true, writable: true });
globalThis.window = new EventTarget();
globalThis.document = { hidden: false };
globalThis.location = { href: 'https://example.test/app', origin: 'https://example.test' };
setNavigator({ onLine: true });

const reach = await import('../../public/js/app/boot/reachability.js');
const net = await import('../../public/js/app/boot/net-required.js');
const guard = await import('../../public/js/app/boot/fetch-guard.js');

const events = [];
window.addEventListener('net:required', () => events.push('net:required'));

beforeEach(() => {
  reach._resetReachability();
  reach.setRawFetch(null);
  setNavigator({ onLine: true });
  document.hidden = false;
  events.length = 0;
});

test('Einstieg: zwei Netzfehler innert Fenster, ein einzelner nicht', () => {
  reach.noteServerFail('network', 1000);
  assert.equal(reach.isOffline(), false);
  reach.noteServerFail('network', 1000 + reach.FAIL_WINDOW_MS + 1);
  assert.equal(reach.isOffline(), false, 'ausserhalb des Fensters');
  reach.noteServerFail('proxy', 1000 + reach.FAIL_WINDOW_MS + 5);
  assert.equal(reach.isOffline(), true);
  assert.equal(reach.isServerUnreachable(), true);
});

test('Einstieg: langsam oder Timeout schaltet sofort', () => {
  reach.noteServerFail('slow');
  assert.equal(reach.isOffline(), true);
  reach._resetReachability();
  reach.noteServerFail('timeout');
  assert.equal(reach.isOffline(), true);
});

test('Versteckter Tab und Browser-offline zählen nicht als Server-Ausfall', () => {
  document.hidden = true;
  reach.noteServerFail('slow');
  assert.equal(reach.isServerUnreachable(), false);
  document.hidden = false;
  setNavigator({ onLine: false });
  reach.noteServerFail('slow');
  assert.equal(reach.isServerUnreachable(), false);
  assert.equal(reach.isOffline(), true, 'Browser offline ist trotzdem offline');
});

test('Ausstieg mit der ersten echten Antwort, Event bei jedem Wechsel', () => {
  const seen = [];
  const h = (e) => seen.push(e.detail.unreachable);
  window.addEventListener('net:reachability', h);
  reach.noteServerFail('slow');
  reach.noteServerFail('slow');
  reach.noteServerOk();
  reach.noteServerOk();
  window.removeEventListener('net:reachability', h);
  assert.deepEqual(seen, [true, false]);
  assert.equal(reach.isOffline(), false);
});

test('onReconnect: feuert bei Rückkehr, mit once nur einmal', () => {
  let n = 0; let m = 0;
  const off = reach.onReconnect(() => { n++; });
  reach.onReconnect(() => { m++; }, { once: true });
  reach.noteServerFail('slow');
  assert.equal(n, 0, 'nicht beim Ausfall');
  reach.noteServerOk();
  reach.noteServerFail('slow');
  reach.noteServerOk();
  off();
  assert.equal(n, 2);
  assert.equal(m, 1);
});

test('Test /ping: echte Antwort schaltet zurück, Captive Portal nicht', async () => {
  reach.noteServerFail('slow');
  reach.setRawFetch(async () => ({ ok: true, json: async () => { throw new SyntaxError('html'); } }));
  assert.equal(await reach.probeServer(), false, 'Portal-HTML');
  reach.setRawFetch(async () => ({ ok: true, json: async () => ({ hello: 'portal' }) }));
  assert.equal(await reach.probeServer(), false, 'fremdes JSON');
  assert.equal(reach.isServerUnreachable(), true);
  const urls = [];
  reach.setRawFetch(async (url) => { urls.push(url); return { ok: true, json: async () => ({ app: reach.PING_APP }) }; });
  assert.equal(await reach.probeServer(), true);
  assert.deepEqual(urls, ['/ping']);
  assert.equal(reach.isServerUnreachable(), false);
});

test('Riegel: Server unerreichbar → ausdrückliche Aktion testet erst', async () => {
  reach.noteServerFail('slow');
  reach.setRawFetch(async () => ({ ok: true, json: async () => ({ app: reach.PING_APP }) }));
  const gate = net.guardNetRequired('/jobs/lektorat', { method: 'POST' });
  assert.ok(gate instanceof Promise);
  await gate;
  assert.equal(reach.isServerUnreachable(), false, 'Fehlalarm aufgehoben');
  assert.deepEqual(events, []);

  reach.noteServerFail('slow');
  reach.setRawFetch(async () => { throw new TypeError('fail'); });
  await assert.rejects(net.guardNetRequired('/tts/speak', {}), (e) => net.isOfflineRejection(e));
  assert.deepEqual(events, ['net:required']);
});

test('Riegel: automatische Requests ohne Test abgewiesen, Saves nie', () => {
  let probes = 0;
  reach.setRawFetch(async () => { probes++; return { ok: false }; });
  reach.noteServerFail('slow');
  assert.throws(() => net.guardNetRequired('/languagetool/check', { method: 'POST' }), (e) => net.isOfflineRejection(e));
  assert.equal(net.guardNetRequired('/content/pages/1', { method: 'PUT' }), undefined);
  assert.equal(net.guardNetRequired('/jobs/x'), undefined, 'Job-Polling nicht');
  assert.equal(probes, 0);
  assert.deepEqual(events, [], 'LT-Abweisung bleibt stumm');
});

test('fetch-guard: Erfolg nur sicher vom Netz, Fehlerarten', () => {
  const origin = 'https://example.test/app';
  const c = (input, init, controlled) => guard.classifyRequest(input, init, { controlled, origin });
  assert.deepEqual(c('/content/pages/1', undefined, true), { isGet: true, countsOk: false }, 'SW-GET: der SW meldet selbst');
  assert.deepEqual(c('/content/pages/1', undefined, false), { isGet: true, countsOk: true });
  assert.deepEqual(c('/content/pages/1', { method: 'PUT' }, true), { isGet: false, countsOk: true });
  assert.equal(c('https://other.test/x', undefined, false), null, 'fremde Origin');
  assert.equal(guard.failKind(new TypeError('Failed to fetch')), 'network');
  assert.equal(guard.failKind(Object.assign(new Error('t'), { name: 'TimeoutError' })), 'timeout');
  assert.equal(guard.failKind(Object.assign(new Error('a'), { name: 'AbortError' })), null);
  assert.equal(guard.failKind(net.offlineError()), null, 'eigene Abweisung');
});

// ── sw-net.js im Sandbox ─────────────────────────────────────────────────────
function loadSwNet(fetchImpl) {
  const posted = [];
  const timers = [];
  const sandbox = {
    TypeError, Promise, Date,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = () => {}; },
    fetch: fetchImpl,
  };
  sandbox.self = sandbox;
  sandbox.clients = { matchAll: async () => [{ postMessage: (m) => posted.push(m.status) }] };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/sw-net.js'), 'utf8'), vm.createContext(sandbox));
  const fire = (ms) => { for (const t of timers.filter((x) => x.ms === ms)) t.fn(); };
  return { swNet: sandbox.__swNet, posted, fire };
}

const tick = () => new Promise((r) => setImmediate(r));

test('sw-net: meldet ok, fail, 502 und langsam', async () => {
  const { swNet, posted, fire } = loadSwNet(async (req) => {
    if (req === 'fail') throw new TypeError('x');
    return { status: req === 'proxy' ? 502 : 200 };
  });
  assert.equal(swNet.SLOW_MS, reach.SLOW_MS, 'SLOW_MS gleich wie im Tab');
  await swNet.fetch('ok'); await tick();
  await assert.rejects(swNet.fetch('fail')); await tick();
  await swNet.fetch('proxy'); await tick();
  assert.deepEqual(posted, ['ok', 'fail', 'fail']);

  const hang = loadSwNet(() => new Promise(() => {}));
  hang.swNet.fetch('x');
  hang.fire(hang.swNet.SLOW_MS); await tick();
  assert.deepEqual(hang.posted, ['slow']);
});

test('sw-net: bei bekanntem Ausfall höchstens FAST_MS warten', async () => {
  const { swNet, fire } = loadSwNet(() => new Promise(() => {}));
  assert.equal(swNet.handleMessage({ data: { type: 'reachability', unreachable: true } }), true);
  const p = swNet.fetch('x');
  fire(swNet.FAST_MS);
  await assert.rejects(p, TypeError);
  assert.equal(swNet.handleMessage({ data: { type: 'skip-waiting' } }), false, 'fremde Nachricht nicht verschluckt');
});
