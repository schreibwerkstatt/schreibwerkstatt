// Service-Worker-Teil „Buch offline halten" — von sw.js per importScripts
// geladen (eigene Datei, weil sw.js am LOC-Deckel steht). Klassisches Skript,
// exportiert genau ein Objekt: self.__swOffline.
//
// WARUM ES DAS BRAUCHT: Der CONTENT_CACHE in sw.js füllt sich nur mit dem, was
// schon einmal geöffnet wurde, und ist auf MAX_CONTENT_CACHE_ENTRIES gedeckelt.
// Ein Buch mit mehr Abschnitten kann dort nie vollständig liegen, und im Zug
// fehlt genau der Abschnitt, den man seit Wochen nicht angefasst hat. Ein
// angeheftetes Buch liegt darum KOMPLETT in einem eigenen Cache ohne Deckel:
// Buchliste, Buch, Baum und jeder Abschnitt.
//
// WIE ES ZUSAMMENSPIELT (Andockstellen in sw.js):
//   - Lesen: _handleSwr schaut nach einem CONTENT_CACHE-Miss hier nach
//     (`match`). Die Strategie bleibt SWR; dieser Cache ist nur der Rückfall,
//     der nie verdrängt wird.
//   - Frisch halten: jede Netzantwort, die sw.js für einen angehefteten Pfad
//     ohnehin bekommt, ersetzt die Kopie hier (`refresh`). Ein Write bustet den
//     CONTENT_CACHE; hier wird dagegen nachgeladen (`invalidate`) — gelöscht
//     wäre der Abschnitt bis zum nächsten Sync offline weg.
//   - Sitzung: fällt mit CONTENT_CACHE/CONFIG_CACHE (`drop`), sonst läge ein
//     fremdes Buch auf dem Gerät. Die ABSICHT („dieses Buch offline") hält der
//     Client pro Konto (app/offline-books.js) und stösst den Sync danach neu an.
//   - Nachrichten (`handleMessage`): 'offline-book-sync' {bookId},
//     'offline-book-remove' {bookId}, 'offline-book-status'. Fortschritt geht
//     als 'offline-book-progress' / 'offline-book-synced' an alle Tabs.
//
// INKREMENTELL: Die Metadaten merken sich pro Abschnitt den `updated_at` aus dem
// Baum. Ein erneuter Sync lädt nur, was sich geändert hat oder fehlt, und räumt
// Abschnitte, die nicht mehr im Baum stehen.
(function () {
  const CACHE = 'schreibwerkstatt-offline-v1';
  const META_PATH = '/__offline-books';
  const CONCURRENCY = 4;
  const CHECKPOINT_EVERY = 25;
  const origin = self.location.origin;
  const keyOf = (path) => origin + path;

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

  async function post(msg) {
    try {
      for (const c of await self.clients.matchAll({ includeUncontrolled: false })) c.postMessage(msg);
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

  const running = new Map(); // bookId → Promise (single-flight pro Buch)

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
        for (const [pid, stamp] of want) {
          const have = prev.pages?.[pid];
          if (have !== undefined && have === stamp && await cache.match(keyOf(`/content/pages/${pid}`))) continue;
          todo.push(pid);
        }
        const pagesMeta = {};
        for (const [pid, stamp] of want) if (!todo.includes(pid)) pagesMeta[pid] = stamp;

        let done = want.size - todo.length;
        let failed = 0;
        let next = 0;
        let sinceCheckpoint = 0;
        await post({ type: 'offline-book-progress', bookId: Number(id), done, total: want.size });
        const worker = async () => {
          while (next < todo.length) {
            const pid = todo[next++];
            try {
              await cache.put(keyOf(`/content/pages/${pid}`), await fetchOk(`/content/pages/${pid}`));
              pagesMeta[pid] = want.get(pid);
              // Zwischenstand sichern: der Browser beendet einen SW auch mit
              // waitUntil nach einigen Minuten. Ein abgebrochener Sync fängt
              // dann beim Gesicherten an, nicht wieder bei null.
              if (++sinceCheckpoint >= CHECKPOINT_EVERY) {
                sinceCheckpoint = 0;
                const meta = await readMeta(cache);
                meta.books[id] = { ...(meta.books[id] || {}), pages: { ...prev.pages, ...pagesMeta } };
                await writeMeta(cache, meta);
              }
            } catch (e) {
              if (!e?.status) throw e; // Netz weg → ganzer Sync später
              failed++;
            }
            done++;
            await post({ type: 'offline-book-progress', bookId: Number(id), done, total: want.size });
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));

        // Abschnitte, die nicht mehr im Baum stehen (gelöscht/verschoben).
        for (const pid of Object.keys(prev.pages || {})) {
          if (!want.has(pid)) await cache.delete(keyOf(`/content/pages/${pid}`));
        }
        const entry = { pages: pagesMeta, at: new Date().toISOString(), total: want.size, failed };
        const meta = await readMeta(cache);
        meta.books[id] = entry;
        await writeMeta(cache, meta);
        await post({ type: 'offline-book-synced', bookId: Number(id), at: entry.at, total: entry.total, failed });
        return entry;
      } catch (e) {
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

  async function removeBook(bookId) {
    const id = String(bookId);
    const cache = await caches.open(CACHE);
    const meta = await readMeta(cache);
    const entry = meta.books[id];
    delete meta.books[id];
    for (const pid of Object.keys(entry?.pages || {})) {
      await cache.delete(keyOf(`/content/pages/${pid}`));
    }
    await cache.delete(keyOf(`/content/books/${id}/tree`));
    await cache.delete(keyOf(`/content/books/${id}`));
    if (!Object.keys(meta.books).length) await cache.delete(keyOf('/content/books'));
    await writeMeta(cache, meta);
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

  // Netzantwort, die sw.js ohnehin bekommen hat: ersetzt die Kopie, falls der
  // Pfad angeheftet ist. `res` ist ein eigener Klon.
  async function refresh(req, res) {
    try {
      const url = new URL(req.url || req, origin);
      url.searchParams.delete('__fresh');
      if (url.search) return;
      const cache = await caches.open(CACHE);
      if (await cache.match(keyOf(url.pathname))) await cache.put(keyOf(url.pathname), res);
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
    CACHE, match, refresh, invalidate, handleMessage,
    drop: () => caches.delete(CACHE),
    // Für Tests.
    _syncBook: syncBook, _pagesOfTree: pagesOfTree,
  };
})();
