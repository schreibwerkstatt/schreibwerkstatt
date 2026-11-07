// Service-Worker-Teil „Buch offline halten" — von sw.js per importScripts
// geladen (eigene Datei, weil sw.js am LOC-Deckel steht). Klassisches Skript,
// exportiert genau ein Objekt: self.__swOffline.
//
// WARUM ES DAS BRAUCHT: Der CONTENT_CACHE in sw.js füllt sich nur mit dem, was
// schon einmal geöffnet wurde, und ist auf MAX_CONTENT_CACHE_ENTRIES gedeckelt.
// Ein Buch mit mehr Abschnitten kann dort nie vollständig liegen, und im Zug
// fehlt genau der Abschnitt, den man seit Wochen nicht angefasst hat. Ein
// angeheftetes Buch liegt darum KOMPLETT in einem eigenen Cache ohne Deckel:
// Buchliste, Buch, Baum, jeder Abschnitt und jedes Bild darin.
//
// WIE ES ZUSAMMENSPIELT (Andockstellen in sw.js):
//   - Lesen: _handleSwr schaut nach einem CONTENT_CACHE-Miss hier nach
//     (`match`). Die Strategie bleibt SWR; dieser Cache ist nur der Rückfall,
//     der nie verdrängt wird.
//   - Frisch halten: jede Netzantwort, die sw.js für einen angehefteten Pfad
//     ohnehin bekommt, ersetzt die Kopie hier (`refresh`); ein frischer Baum
//     mit neuen Stempeln stösst dabei den inkrementellen Sync an. Ein Write bustet den
//     CONTENT_CACHE; hier wird dagegen nachgeladen (`invalidate`) — gelöscht
//     wäre der Abschnitt bis zum nächsten Sync offline weg.
//   - Bilder (`/content/page-image/:id`): `respondImage` bedient alle, auch die
//     nicht angehefteter Bücher, aus einem eigenen gedeckelten IMAGE_CACHE —
//     im CONTENT_CACHE verdrängten ein paar bebilderte Abschnitte sonst Baum und
//     Text. Cache-first, weil die Bytes einer Bild-ID sich nie ändern (ein
//     neues Bild ist eine neue ID; db/page-images.js verschiebt nur die Seite).
//   - Werkstatt-Listen (`domainPaths`): der Sync legt sie mit ab, höchstens
//     alle DOMAIN_REFRESH_MS; sw-domain.js fällt nach einem Miss darauf zurück
//     (`matchDomain`) und frischt sie mit jeder Netzantwort auf (`refreshDomain`).
//   - Sitzung: fällt mit CONTENT_CACHE/CONFIG_CACHE (`drop`, beide Caches), sonst
//     läge ein fremdes Buch auf dem Gerät. Die ABSICHT („dieses Buch offline")
//     hält der Client pro Konto (app/offline-books.js) und stösst den Sync danach
//     neu an.
//   - Nachrichten (`handleMessage`): 'offline-book-sync' {bookId},
//     'offline-book-remove' {bookId}, 'offline-book-status'. Fortschritt geht
//     als 'offline-book-progress' / 'offline-book-synced' an alle Tabs.
//
// INKREMENTELL: Die Metadaten merken sich pro Abschnitt den `updated_at` aus dem
// Baum und die Bild-IDs darin. Ein erneuter Sync lädt nur, was sich geändert hat
// oder fehlt, und räumt Abschnitte und Bilder, die nicht mehr im Baum stehen.
//
// METADATEN SERIELL: Der Client stösst beim Start den Sync aller angehefteten
// Bücher auf einmal an. Jeder Meta-Write ist darum ein Lesen-Ändern-Schreiben
// hinter `updateMeta` — parallel überschrieb sonst ein Buch den gerade
// geschriebenen Eintrag eines anderen mit dessen altem Stand.
(function () {
  const CACHE = 'schreibwerkstatt-offline-v1';
  const IMAGE_CACHE = 'schreibwerkstatt-images-v1';
  const IMAGE_MAX = 150;
  const META_PATH = '/__offline-books';
  const CONCURRENCY = 4;
  const CHECKPOINT_EVERY = 25;
  const IMAGE_PATH_RE = /^\/content\/page-image\/\d+$/;
  const IMAGE_REF_RE = /\/content\/page-image\/(\d+)/g;
  const TREE_PATH_RE = /^\/content\/books\/(\d+)\/tree$/;
  // Ein Baum mit neuen Stempeln stösst den Sync von selbst an — höchstens so
  // oft je Buch (die Drift-Probe fragt alle 40 s, ein schreibendes zweites
  // Gerät liefert ihr jedes Mal einen neuen Baum).
  const AUTO_SYNC_GAP_MS = 30_000;
  // Werkstatt-Daten werden seltener nachgeladen als die Abschnitte: der
  // Bucheditor-Volltext ist ein ganzes Buch, und ein Sync läuft bei jedem
  // Write eines anderen Geräts.
  const DOMAIN_REFRESH_MS = 10 * 60_000;
  const origin = self.location.origin;
  const keyOf = (path) => origin + path;
  const imageKey = (imgId) => keyOf(`/content/page-image/${imgId}`);

  async function readMeta(cache) {
    try {
      const res = await cache.match(keyOf(META_PATH));
      const meta = res ? await res.json() : null;
      return meta && typeof meta.books === 'object' ? meta : { books: {} };
    } catch { return { books: {} }; }
  }

  function writeMeta(cache, meta) {
    return cache.put(keyOf(META_PATH), new Response(JSON.stringify(meta), {
      headers: { 'Content-Type': 'application/json' },
    }));
  }

  // `fn(meta, cache)` ändert `meta` an Ort und Stelle; liefert es `false`, wird
  // nicht geschrieben.
  let metaChain = Promise.resolve();
  function updateMeta(fn) {
    const run = metaChain.then(async () => {
      const cache = await caches.open(CACHE);
      const meta = await readMeta(cache);
      if ((await fn(meta, cache)) === false) return;
      await writeMeta(cache, meta);
    });
    metaChain = run.catch(() => {});
    return run;
  }

  // Auch an unkontrollierte Tabs (Erst-Install, harter Reload — sw.js ruft
  // kein clients.claim()): dort steht der Offline-Knopf ebenfalls, und ohne
  // die Nachricht bliebe sein Fortschritt auf „Wird abgelegt …" stehen.
  async function post(msg) {
    try {
      for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage(msg);
    } catch {}
  }

  // Alle Abschnitte des Baums: topPages + Kapitel rekursiv (subchapters).
  function pagesOfTree(tree) {
    const out = [];
    const walk = (chapters) => {
      for (const c of chapters || []) {
        for (const p of c.pages || []) out.push(p);
        walk(c.subchapters);
      }
    };
    for (const p of tree?.topPages || []) out.push(p);
    walk(tree?.chapters);
    return out.filter((p) => p && p.id != null);
  }

  // Bild-IDs, auf die ein Abschnitt verweist (figure-html.js: `<img src="/content/page-image/42">`).
  // Gelesen wird der rohe JSON-Text: JSON.stringify maskiert `/` nicht.
  function imageIdsOf(text) {
    return [...new Set([...String(text).matchAll(IMAGE_REF_RE)].map((m) => m[1]))];
  }

  function imagesOfEntry(entry) {
    return new Set(Object.values(entry?.pageImages || {}).flat());
  }

  function imageUsedBy(meta, imgId) {
    return Object.values(meta.books).some((e) => imagesOfEntry(e).has(imgId));
  }

  // Netz-Fetch eines Content-Pfads; nur eine echte 200 zählt (kein Login-
  // Redirect, keine 401). `redirect: 'error'` wie im Precache von sw.js.
  async function fetchOk(path) {
    const res = await fetch(new Request(path, { credentials: 'same-origin', redirect: 'error' }));
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  // Ein Abschnitt samt seiner Bilder. Ein Bild mit HTTP-Fehler (gelöscht, aber
  // noch verlinkt) bleibt aus, ohne den Abschnitt scheitern zu lassen — er
  // würde sonst bei jedem Sync erneut geladen. Netzfehler werfen.
  async function storePage(cache, pid) {
    const res = await fetchOk(`/content/pages/${pid}`);
    const imgs = imageIdsOf(await res.clone().text());
    await cache.put(keyOf(`/content/pages/${pid}`), res);
    for (const img of imgs) {
      if (await cache.match(imageKey(img))) continue;
      try { await cache.put(imageKey(img), await fetchOk(`/content/page-image/${img}`)); }
      catch (e) { if (!e?.status) throw e; }
    }
    return imgs;
  }

  // Die Listen der Werkstatt-Karten eines Buchs, genau unter den URLs, die die
  // Karten beim Öffnen holen (ohne Filter). sw-domain.js fällt nach einem Miss
  // in seiner gedeckelten Ablage hierauf zurück (`matchDomain`) — sonst wären
  // offline nur die Karten lesbar, die zuletzt online geöffnet wurden.
  function domainPaths(id) {
    return [
      `/figures/${id}`, `/figures/scenes/${id}`, `/figures/zeitstrahl/${id}`, `/locations/${id}`,
      `/ideen/board?book_id=${id}`, `/ideen/stages?book_id=${id}`,
      `/research?book_id=${id}`, `/research/tags?book_id=${id}`,
      `/booksettings/${id}`, `/book-editor/${id}/contents`,
    ];
  }

  // Best effort: eine Liste ohne Zugriff (Rolle) oder ohne Netz bleibt auf
  // ihrem letzten Stand, ohne den Abschnitts-Sync scheitern zu lassen.
  async function storeDomain(cache, id) {
    for (const path of domainPaths(id)) {
      try { await cache.put(keyOf(path), await fetchOk(path)); } catch {}
    }
  }

  const running = new Map(); // bookId → Promise (single-flight pro Buch)
  const aborted = new Set(); // bookIds, deren Sync ein removeBook beendet
  const lastAuto = new Map(); // bookId → Zeitpunkt des letzten Auto-Syncs

  function syncBook(bookId) {
    const id = String(bookId);
    if (running.has(id)) return running.get(id);
    const p = (async () => {
      const cache = await caches.open(CACHE);
      const prev = (await readMeta(cache)).books[id] || { pages: {} };
      try {
        const treeRes = await fetchOk(`/content/books/${id}/tree`);
        const tree = await treeRes.clone().json();
        await cache.put(keyOf(`/content/books/${id}/tree`), treeRes);
        await cache.put(keyOf('/content/books'), await fetchOk('/content/books'));
        await cache.put(keyOf(`/content/books/${id}`), await fetchOk(`/content/books/${id}`));

        const pages = pagesOfTree(tree);
        const want = new Map(pages.map((p) => [String(p.id), p.updated_at || null]));
        const todo = [];
        const pagesMeta = {};
        const pageImages = {};
        for (const [pid, stamp] of want) {
          const have = prev.pages?.[pid];
          const imgs = prev.pageImages?.[pid];
          // Ohne gemerkte Bild-Liste (Stand vor den Bildern) einmal neu laden.
          if (have !== undefined && have === stamp && Array.isArray(imgs)
            && await cache.match(keyOf(`/content/pages/${pid}`))) {
            pagesMeta[pid] = stamp;
            pageImages[pid] = imgs;
            continue;
          }
          todo.push(pid);
        }

        let done = want.size - todo.length;
        let failed = 0;
        const failedPages = {}; // pid → Stempel, damit `treeDrifted` sie nicht für geändert hält
        let next = 0;
        let sinceCheckpoint = 0;
        await post({ type: 'offline-book-progress', bookId: Number(id), done, total: want.size });
        const worker = async () => {
          while (next < todo.length && !aborted.has(id)) {
            const pid = todo[next++];
            try {
              pageImages[pid] = await storePage(cache, pid);
              pagesMeta[pid] = want.get(pid);
              // Zwischenstand sichern: der Browser beendet einen SW auch mit
              // waitUntil nach einigen Minuten. Ein abgebrochener Sync fängt
              // dann beim Gesicherten an, nicht wieder bei null.
              if (++sinceCheckpoint >= CHECKPOINT_EVERY) {
                sinceCheckpoint = 0;
                await updateMeta((meta) => {
                  if (aborted.has(id)) return false;
                  const cur = meta.books[id] || {};
                  meta.books[id] = {
                    ...cur,
                    pages: { ...prev.pages, ...pagesMeta },
                    pageImages: { ...prev.pageImages, ...pageImages },
                  };
                });
              }
            } catch (e) {
              if (!e?.status) throw e; // Netz weg → ganzer Sync später
              failed++;
              failedPages[pid] = want.get(pid);
            }
            done++;
            await post({ type: 'offline-book-progress', bookId: Number(id), done, total: want.size });
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
        if (aborted.has(id)) return null;

        // Abschnitte, die nicht mehr im Baum stehen (gelöscht/verschoben).
        for (const pid of Object.keys(prev.pages || {})) {
          if (!want.has(pid)) await cache.delete(keyOf(`/content/pages/${pid}`));
        }
        let domainAt = prev.domainAt || null;
        if (!domainAt || Date.now() - Date.parse(domainAt) >= DOMAIN_REFRESH_MS) {
          await storeDomain(cache, id);
          if (aborted.has(id)) return null;
          domainAt = new Date().toISOString();
        }
        const entry = {
          pages: pagesMeta, pageImages, failedPages, domainAt,
          at: new Date().toISOString(), total: want.size, failed,
        };
        await updateMeta(async (meta, c) => {
          meta.books[id] = entry;
          // Bilder, auf die kein angeheftetes Buch mehr verweist.
          for (const img of imagesOfEntry(prev)) {
            if (!imageUsedBy(meta, img)) await c.delete(imageKey(img));
          }
        });
        await post({ type: 'offline-book-synced', bookId: Number(id), at: entry.at, total: entry.total, failed });
        return entry;
      } catch (e) {
        if (aborted.has(id)) return null;
        // 403/404: Buch weg oder Zugriff entzogen — der Client hebt die
        // Anheftung auf. Sonst (Netz) bleibt der alte Stand stehen.
        await post({ type: 'offline-book-failed', bookId: Number(id), status: e?.status || 0 });
        return null;
      } finally {
        running.delete(id);
      }
    })();
    running.set(id, p);
    return p;
  }

  // Ein laufender Sync desselben Buchs wird erst beendet — er schriebe den
  // Eintrag sonst nach dem Entfernen wieder hinein.
  async function removeBook(bookId) {
    const id = String(bookId);
    const run = running.get(id);
    if (run) {
      aborted.add(id);
      await run.catch(() => {});
    }
    try {
      await updateMeta(async (meta, cache) => {
        const entry = meta.books[id];
        delete meta.books[id];
        for (const pid of Object.keys(entry?.pages || {})) {
          await cache.delete(keyOf(`/content/pages/${pid}`));
        }
        for (const img of imagesOfEntry(entry)) {
          if (!imageUsedBy(meta, img)) await cache.delete(imageKey(img));
        }
        await cache.delete(keyOf(`/content/books/${id}/tree`));
        await cache.delete(keyOf(`/content/books/${id}`));
        for (const path of domainPaths(id)) await cache.delete(keyOf(path));
        if (!Object.keys(meta.books).length) await cache.delete(keyOf('/content/books'));
      });
    } finally {
      aborted.delete(id);
    }
  }

  async function status() {
    const meta = await readMeta(await caches.open(CACHE));
    const books = {};
    for (const [id, e] of Object.entries(meta.books)) {
      books[id] = { at: e.at, total: e.total, failed: e.failed || 0 };
    }
    return books;
  }

  // Nur angeheftete Pfade landen hier; alles andere ist kein Treffer.
  async function match(req) {
    try {
      const url = new URL(req.url || req, origin);
      if (url.search) return undefined;
      return await (await caches.open(CACHE)).match(keyOf(url.pathname));
    } catch { return undefined; }
  }

  // Weicht ein frischer Baum vom Stand des letzten Syncs ab (Abschnitt neu,
  // geändert oder weg)? Abschnitte, die beim letzten Sync mit demselben
  // Stempel scheiterten, zählen nicht — sonst liefe der Sync bei jeder Probe.
  async function treeDrifted(id, tree) {
    const entry = (await readMeta(await caches.open(CACHE))).books[id];
    if (!entry?.pages) return false; // Erst-Sync läuft noch oder fehlt — der Client stösst ihn an
    const known = { ...(entry.failedPages || {}), ...entry.pages };
    const pages = pagesOfTree(tree);
    if (pages.length !== Object.keys(known).length) return true;
    return pages.some((p) => known[String(p.id)] !== (p.updated_at || null));
  }

  // Netzantwort, die sw.js ohnehin bekommen hat: ersetzt die Kopie, falls der
  // Pfad angeheftet ist. `res` ist ein eigener Klon. Ist es der Baum und weicht
  // er vom letzten Sync ab, läuft der Sync gleich mit: so folgt die Offline-
  // Kopie jedem frischen Baum (Drift-Probe, Aufwachen, Buchwechsel, Collab-
  // Nachzug), nicht nur dem Start und dem `online`-Event. Ein offener Tab, der
  // stundenlang online mitläuft, während ein anderes Gerät schreibt, hielte
  // sonst die Abschnitte vom Start — und genau die nähme er in den Zug mit.
  // Das Promise schliesst den Sync ein; sw.js hält den SW per extendLife wach.
  async function refresh(req, res) {
    try {
      const url = new URL(req.url || req, origin);
      url.searchParams.delete('__fresh');
      if (url.search) return;
      const cache = await caches.open(CACHE);
      if (!(await cache.match(keyOf(url.pathname)))) return;
      const treeMatch = TREE_PATH_RE.exec(url.pathname);
      const forCheck = treeMatch ? res.clone() : null;
      await cache.put(keyOf(url.pathname), res);
      if (!treeMatch) return;
      const id = treeMatch[1];
      if (running.has(id) || Date.now() - (lastAuto.get(id) || 0) < AUTO_SYNC_GAP_MS) return;
      if (!(await treeDrifted(id, await forCheck.json()))) return;
      lastAuto.set(id, Date.now());
      await syncBook(id);
    } catch {}
  }

  // Werkstatt-Liste eines angehefteten Buchs (exakte URL samt Query).
  async function matchDomain(req) {
    try {
      const url = new URL(req.url || req, origin);
      return await (await caches.open(CACHE)).match(keyOf(url.pathname + url.search));
    } catch { return undefined; }
  }

  // Netzantwort von sw-domain.js: ersetzt die Kopie, falls die URL zu einem
  // angehefteten Buch gehört.
  async function refreshDomain(req, res) {
    try {
      const url = new URL(req.url || req, origin);
      const key = keyOf(url.pathname + url.search);
      const cache = await caches.open(CACHE);
      if (await cache.match(key)) await cache.put(key, res);
    } catch {}
  }

  // Nach einem Write: angeheftete Pfade nachladen statt löschen. `paths` sind
  // /content/*-Subpfade ohne Prefix (wie bei 'invalidate-content').
  async function invalidate(paths) {
    const cache = await caches.open(CACHE);
    for (const p of paths || []) {
      const path = '/content/' + p;
      if (!(await cache.match(keyOf(path)))) continue;
      try { await cache.put(keyOf(path), await fetchOk(path)); } catch {}
    }
  }

  // Bild-Requests ohne Query (`?download=1` ist ein Datei-Download, kein Bild).
  function handlesImage(url) {
    return IMAGE_PATH_RE.test(url.pathname) && !url.search;
  }

  async function evictImages(icache) {
    const keys = await icache.keys();
    for (let i = 0; i < keys.length - IMAGE_MAX; i++) await icache.delete(keys[i]);
  }

  // Angeheftet → nie verdrängt; sonst der gedeckelte IMAGE_CACHE; sonst Netz.
  // 401/Fehler werden nicht abgelegt (sonst fröre ein Login-Problem fest).
  async function respondImage(req, event) {
    const key = keyOf(new URL(req.url).pathname);
    const pinned = await (await caches.open(CACHE)).match(key);
    if (pinned) return pinned;
    const icache = await caches.open(IMAGE_CACHE);
    const hit = await icache.match(key);
    if (hit) return hit;
    try {
      const net = await fetch(req);
      if (net && net.ok && !net.redirected) {
        const copy = net.clone();
        const put = (async () => { await icache.put(key, copy); await evictImages(icache); })().catch(() => {});
        try { event?.waitUntil?.(put); } catch {}
      }
      return net;
    } catch {
      return new Response('', { status: 503 });
    }
  }

  function handleMessage(event) {
    const d = event.data || {};
    if (d.type === 'offline-book-sync' && d.bookId != null) {
      event.waitUntil(syncBook(d.bookId));
      return true;
    }
    if (d.type === 'offline-book-remove' && d.bookId != null) {
      event.waitUntil(removeBook(d.bookId).then(async () => {
        event.source?.postMessage?.({ type: 'offline-book-status', books: await status() });
      }));
      return true;
    }
    if (d.type === 'offline-book-status') {
      event.waitUntil(status().then((books) => {
        event.source?.postMessage?.({ type: 'offline-book-status', books });
      }));
      return true;
    }
    return false;
  }

  self.__swOffline = {
    CACHE, IMAGE_CACHE, match, refresh, invalidate, handleMessage, handlesImage, respondImage,
    matchDomain, refreshDomain,
    drop: () => Promise.all([caches.delete(CACHE), caches.delete(IMAGE_CACHE)]),
    // Für Tests.
    _syncBook: syncBook, _removeBook: removeBook, _pagesOfTree: pagesOfTree, _imageIdsOf: imageIdsOf,
    _domainPaths: domainPaths, _resetAutoSync: () => lastAuto.clear(),
  };
})();
