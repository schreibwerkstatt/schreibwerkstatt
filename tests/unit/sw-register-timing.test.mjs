// Gate für den Registrierungs-Zeitpunkt des Service Workers
// (public/js/app/boot/sw-register.js#whenDomReady).
//
// WARUM: die Registrierung hing am `load`-Event. `load` feuert erst, wenn JEDES
// Subresource durch ist — auf einer noch unkontrollierten Seite also erst nach
// den ~670 Modul-Requests der Shell, die der Precache beschleunigen soll. Die
// Registrierung hing damit an dem Event, das sie selbst teuer macht, und eine
// langsame Leitung blieb für immer kalt: jede Navigation wieder über das Netz,
// `sw=uncontrolled` in jedem Boot-Report.
//
// DIE INVARIANTE: registriert wird, sobald der Modul-Graph ausgewertet ist
// (DOMContentLoaded) — nicht früher (der Precache soll nicht mit der eigenen
// Ladearbeit der Seite konkurrieren) und nicht später (Bilder/Fonts/Late-Assets
// dürfen die Registrierung nicht aufhalten). Modul-Skripte sind deferred:
// DOMContentLoaded ist zum Aufrufzeitpunkt noch nicht gefeuert, auch wenn
// readyState schon 'interactive' steht.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Statisch importieren, BEVOR die Globals unten gefaelscht werden: der
// transitive Import von utils.js braucht beim Modul-Laden ein echtes DOM.
import { registerServiceWorker } from '../../public/js/app/boot/sw-register.js';

const SW_URL = '/sw.js';

// Minimaler DOM-Stand: je readyState ein Trap, der mitzaehlt, wann welches
// Event tatsaechlich gefeuert ist.
function fakeDom(readyState) {
  const fired = [];
  const listeners = new Map();
  const doc = {
    readyState,
    hidden: false,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
  };
  const fire = (type) => {
    fired.push(type);
    for (const fn of listeners.get(type) || []) fn({ type });
  };
  return { doc, fired, fire };
}

// Alles, was sw-register.js an Globals braucht. Der Registrierungs-Pfad laeuft
// async weiter (reg.update-Intervalle, busyLock-Takt) — deshalb wird nach dem
// Aufruf noch ein Tick gewartet, bevor geprueft wird.
function installGlobals({ readyState, controlled = false }) {
  const dom = fakeDom(readyState);
  const calls = { register: [], updates: 0 };
  const reg = {
    installing: null,
    waiting: null,
    addEventListener() {},
    async update() { calls.updates++; return reg; },
  };
  const controller = controlled ? { scriptURL: SW_URL } : null;
  const g = globalThis;
  const store = () => ({ getItem: () => null, setItem() {}, removeItem() {} });
  const next = {
    document: dom.doc,
    window: {
      addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
      location: { reload() {}, hostname: 'schreibwerkstatt.app', protocol: 'https:' },
      __app: null,
    },
    navigator: {
      onLine: true,
      serviceWorker: {
        controller,
        addEventListener() {},
        async register(url) { calls.register.push(url); return reg; },
        async getRegistrations() { return []; },
      },
    },
    localStorage: store(),
    sessionStorage: store(),
  };
  next.location = next.window.location;
  // setInterval abfangen: der Registrierungs-Pfad legt dauerhaft laufende
  // Takte an (60s-Update-Check, 1s-busyLock, autoApply) — die wuerden den
  // Testprozess nie beenden. Timeout bleibt echt, `await tick()` braucht ihn.
  next.setInterval = () => 0;
  next.clearInterval = () => {};
  // navigator/location sind in Node getter-only — ueber defineProperty setzen
  // und die Original-Deskriptoren fuer das Restore aufbewahren.
  const saved = new Map();
  for (const [key, value] of Object.entries(next)) {
    saved.set(key, Object.getOwnPropertyDescriptor(g, key));
    Object.defineProperty(g, key, { value, configurable: true, writable: true });
  }
  return {
    ...dom,
    calls,
    restore: () => {
      for (const [key, desc] of saved) {
        if (desc) Object.defineProperty(g, key, desc);
        else delete g[key];
      }
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('Registrierung wartet auf DOMContentLoaded und feuert NICHT beim `load`-Event', async (t) => {
  const env = installGlobals({ readyState: 'interactive' });
  t.after(() => env.restore());

  registerServiceWorker();
  await tick();
  assert.deepEqual(env.calls.register, [],
    'readyState "interactive": Modul-Skripte sind deferred, DOMContentLoaded steht noch aus.');

  // Genau die Regression, die gefangen werden soll: ein `load` darf nichts
  // registrieren. Waere der Code wieder an `load` gebunden, faellt das hier.
  env.fire('load');
  await tick();
  assert.deepEqual(env.calls.register, [],
    'Registrierung haengt an `load`: auf einer langsamen Leitung kommt `load` erst nach allen Modul-Requests.');

  env.fire('DOMContentLoaded');
  await tick();
  assert.deepEqual(env.calls.register, [SW_URL],
    'DOMContentLoaded genuegt — der Modul-Graph ist ausgewertet, der Precache darf starten.');
});

test('Registrierung laeuft sofort, wenn der Load schon fertig ist', async (t) => {
  const env = installGlobals({ readyState: 'complete' });
  t.after(() => env.restore());

  registerServiceWorker();
  await tick();
  assert.deepEqual(env.calls.register, [SW_URL],
    'readyState "complete" heisst sicher: DOMContentLoaded ist vorbei, ein Listener wuerde nie feuern.');
});

test('`load` nach dem Registrieren ist kein zweiter Trigger', async (t) => {
  const env = installGlobals({ readyState: 'interactive', controlled: true });
  t.after(() => env.restore());

  registerServiceWorker();
  await tick();
  env.fire('DOMContentLoaded');
  await tick();
  env.fire('load');
  await tick();
  assert.deepEqual(env.calls.register, [SW_URL], 'genau eine Registrierung.');
});