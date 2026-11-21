// Netz-Fetch des Service Workers mit Erreichbarkeits-Meldung an die Tabs.
//
// Der SW beantwortet GETs auch aus dem Cache; der Seite ist einer Antwort nicht
// anzusehen, ob sie vom Netz kam. Was der Server tatsächlich tut, sieht nur der
// SW — auch bei den Hintergrund-Abgleichen hinter einem Cache-Treffer. Darum
// meldet er seine eigenen Netz-Ergebnisse als `{ type: 'net-status', status }`
// ('ok' | 'fail' | 'slow') an alle Tabs; dort führt public/js/app/boot/
// reachability.js den Zustand.
//
// UMGEKEHRT sagt der Tab dem SW, wenn der Server als unerreichbar gilt
// (`{ type: 'reachability', unreachable }`). Dann wartet ein Netz-Fetch höchstens
// FAST_MS und fällt danach auf den Cache des Aufrufers zurück, statt den Klick
// bis zum Browser-Timeout hängen zu lassen. Der Fetch selbst läuft weiter und
// meldet ein spätes 'ok' trotzdem — so kommt die Rückkehr auch ohne Test an.
//
// SW-Neustart (idle) vergisst den Zustand: dann gilt „erreichbar" bis zur
// nächsten Meldung des Tabs — der schlimmste Fall ist ein einzelner Fetch mit
// der alten Wartezeit.
(function () {
  const SLOW_MS = 10000;   // = SLOW_MS in reachability.js
  const FAST_MS = 3000;
  const OK_GAP_MS = 2000;  // 'ok' höchstens so oft; Fehler immer
  let unreachable = false;
  let lastOkAt = 0;

  async function post(status) {
    const now = Date.now();
    if (status === 'ok') {
      if (!unreachable && now - lastOkAt < OK_GAP_MS) return;
      lastOkAt = now;
    }
    try {
      const clients = await self.clients.matchAll({ includeUncontrolled: false });
      for (const c of clients) c.postMessage({ type: 'net-status', status });
    } catch { /* kein Tab, nichts zu melden */ }
  }

  // 502/504: Reverse-Proxy antwortet, die App dahinter nicht.
  function isProxyDown(res) { return res.status === 502 || res.status === 504; }

  function netFetch(req) {
    const slow = setTimeout(() => post('slow'), SLOW_MS);
    const p = fetch(req).then((res) => {
      clearTimeout(slow);
      post(isProxyDown(res) ? 'fail' : 'ok');
      return res;
    }, (err) => {
      clearTimeout(slow);
      if (err?.name !== 'AbortError') post('fail');
      throw err;
    });
    if (!unreachable) return p;
    return Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new TypeError('sw-net: server unreachable')), FAST_MS)),
    ]);
  }

  function handleMessage(event) {
    if (event.data?.type !== 'reachability') return false;
    unreachable = !!event.data.unreachable;
    return true;
  }

  self.__swNet = { fetch: netFetch, handleMessage, SLOW_MS, FAST_MS };
  self.addEventListener?.('message', handleMessage);
})();
