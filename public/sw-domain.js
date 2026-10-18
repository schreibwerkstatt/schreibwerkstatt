// Service-Worker-Teil „Werkstatt-Daten offline lesen" — von sw.js per
// importScripts geladen (eigene Datei, weil sw.js am LOC-Deckel steht).
// Klassisches Skript, exportiert genau ein Objekt: self.__swDomain.
//
// WARUM ES DAS BRAUCHT: Der CONTENT_CACHE hält nur Buch, Baum und Abschnitte.
// Figuren, Orte, Szenen, Ideen, Recherche, Buch-Einstellungen, Lektorat-
// Historie und der Volltext des Bucheditors (`/book-editor/:id/contents`)
// liefen ohne Verbindung ins Leere — im Zug war das Buch lesbar, aber jede
// Werkstatt-Karte leer und der Bucheditor öffnete gar nicht.
//
// STRATEGIE: Netz zuerst, die letzte gute Antwort nur als Offline-Rückfall.
// Online ändert sich damit nichts — jede Karte sieht den Serverstand wie
// bisher, kein Stale-Hit, keine Nachzug-Meldung nötig (anders als SWR im
// CONTENT_CACHE). Eine Fehlerantwort (401/500) geht unverändert durch, der
// globale 401-Wrapper sieht sie. Ohne Netz und ohne Eintrag scheitert der
// Request wie ohne SW (`Response.error()` → TypeError beim Aufrufer).
//
// WAS ABGELEGT WIRD: nur JSON-Antworten auf GET. Bilder, Dokumente und Audio der
// Recherche (`/research/:id/image|doc|audio`) behandelt der SW gar nicht — sie
// wären gross, taugen ohne Netz ohnehin nur zum Ansehen des Fundstücks, und
// Range-Requests auf Medien gehören nicht durch respondWith. Suchanfragen
// (`q=`, Pfade auf `-search`) auch nicht: jede Eingabe wäre ein eigener Eintrag
// und verdrängte die Karten-Listen. Gedeckelt nach Einfüge-Reihenfolge, für
// den Volltext des Bucheditors (ein ganzes Buch je Eintrag) mit eigenem,
// kleinerem Deckel, damit ihn die vielen kleinen Listen nicht verdrängen.
//
// WACKLIGES NETZ: Kommt nach NET_TIMEOUT_MS keine Antwort, liefert der SW den
// abgelegten Stand, sofern es einen gibt — `navigator.onLine` lügt im Zug, und
// ein hängender Fetch liesse jede Karte minutenlang drehen. Ohne Eintrag wird
// weiter aufs Netz gewartet.
//
// RÜCKFALL ERKENNBAR: Jede Antwort aus der Ablage trägt `X-SW-Fallback: domain`.
// Der Bucheditor gleicht so den Volltext gegen den frischeren Content-Cache ab
// (cards/book-editor/blocks.js#fetchBookContents) — die Ablage hier wird bei
// Writes nicht nachgeführt, der Content-Cache schon.
//
// SITZUNG: fällt mit CONTENT_CACHE/CONFIG_CACHE (`drop`, sw.js
// SESSION_CACHE_DROP_TYPES) — die Antworten sind Daten EINES Kontos.
(function () {
  const CACHE = 'schreibwerkstatt-domain-v1';
  const MAX_ENTRIES = 150;
  const MAX_BOOK_ENTRIES = 8;
  const NET_TIMEOUT_MS = 6000;
  const FALLBACK_HEADER = 'X-SW-Fallback';
  const PREFIXES = ['/figures', '/locations', '/ideen', '/research', '/book-editor', '/history', '/booksettings'];
  const MEDIA_RE = /^\/research\/[^/]+\/(?:image|doc|audio)(?:\/|$)/;
  const BOOK_RE = /^\/book-editor\//;

  // Exakter Pfad oder echter Unterpfad — kein nackter Prefix-Match.
  function handles(url) {
    if (MEDIA_RE.test(url.pathname)) return false;
    if (url.searchParams?.has('q') || /-search$/.test(url.pathname)) return false;
    return PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(p + '/'));
  }

  function storable(res) {
    if (!res || !res.ok || res.type === 'opaqueredirect') return false;
    return /\bapplication\/json\b/i.test(res.headers.get('Content-Type') || '');
  }

  function isBook(req) {
    try { return BOOK_RE.test(new URL(req.url).pathname); } catch { return false; }
  }

  async function evict(cache) {
    const keys = await cache.keys();
    const books = keys.filter(isBook);
    const rest = keys.filter((k) => !isBook(k));
    for (let i = 0; i < books.length - MAX_BOOK_ENTRIES; i++) await cache.delete(books[i]);
    for (let i = 0; i < rest.length - MAX_ENTRIES; i++) await cache.delete(rest[i]);
  }

  // Abgelegte Antwort, markiert als Rückfall.
  async function cached(req) {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (!hit) return null;
    try {
      const headers = new Headers(hit.headers);
      headers.set(FALLBACK_HEADER, 'domain');
      return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
    } catch { return hit; }
  }

  async function store(req, res) {
    const cache = await caches.open(CACHE);
    await cache.put(req, res);
    await evict(cache);
  }

  // `event`: der Ablage-Write läuft per waitUntil neben der Auslieferung — die
  // Antwort (beim Bucheditor ein ganzes Buch) streamt sofort an den Aufrufer.
  async function respond(req, event) {
    const netP = fetch(req);
    let net;
    try {
      net = await Promise.race([
        netP,
        new Promise((resolve) => setTimeout(() => resolve(null), NET_TIMEOUT_MS)),
      ]);
      if (net === null) {
        const hit = await cached(req);
        if (hit) { netP.then((r) => (storable(r) ? store(req, r) : null)).catch(() => {}); return hit; }
        net = await netP;
      }
    } catch {
      return (await cached(req)) || Response.error();
    }
    if (storable(net)) {
      const put = store(req, net.clone()).catch(() => {});
      if (event?.waitUntil) event.waitUntil(put);
    }
    return net;
  }

  function drop() { return caches.delete(CACHE); }

  self.__swDomain = { CACHE, FALLBACK_HEADER, handles, respond, drop };
})();
