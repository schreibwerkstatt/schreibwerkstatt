// Service-Worker-Teil „Entwürfe nachsenden" (Background Sync) — von sw.js per
// importScripts geladen (eigene Datei, weil sw.js am LOC-Deckel steht).
// Klassisches Skript, registriert seinen `sync`-Listener selbst.
//
// WARUM ES DAS BRAUCHT: Die Reconnect-Outbox (public/js/app/app-outbox.js)
// sendet Entwürfe nur, solange ein Tab der App läuft. Wer offline schreibt und
// den Laptop zuklappt, hätte seinen Text bis zum nächsten Öffnen der App nur
// auf dem Gerät. Hat ein Tab beim Schreiben ohne Netz einen Sync angemeldet
// (draft-idb.js#requestDraftSync), weckt der Browser den SW, sobald wieder Netz
// da ist — auch ohne offenen Tab (Chromium; andere Browser haben kein
// Background Sync, dort bleibt es bei der Outbox).
//
// WAS ER DARF: nur, was ohne Merge-Logik sicher ist. Jeder PUT trägt den
// Basis-Stempel des Entwurfs und `base_html`: der Server mergt kollisionsfrei
// selbst (routes/content/pages.js#_mergeStaleWrite) und antwortet sonst 409 —
// dann bleibt der Entwurf liegen, die App löst den Konflikt beim Öffnen. Nur
// Entwürfe des angemeldeten Kontos (`/config`), nie ein fremder.
//
// ABSTIMMUNG MIT DEN TABS: Abschnitte, die ein offener Tab hält (Notebook-,
// Focus- oder Bucheditor, editor/live-edit.js), fasst er nicht an — er fragt
// jeden Tab danach ('draft-sync-held'). Antwortet ein Tab nicht (eingefroren),
// scheitert der Sync und der Browser wiederholt ihn später. Pro Abschnitt
// derselbe Web Lock wie die Outbox (`draft-flush:<pageId>`), damit nie beide
// gleichzeitig senden. Gefragt werden nur Fenster der App-Shell (`/`).
//
// ANTWORTEN DES SERVERS: 2xx → Entwurf fällt (nur, wenn er noch der gesendete
// Stand ist). 409/404/400/403 → Entwurf bleibt, die App klärt ihn beim Öffnen.
// 5xx/429 → Lauf scheitert, der Browser wiederholt ihn (Chromium nur wenige
// Male — danach sendet die Outbox beim nächsten Öffnen). 401 → Lauf endet still.
//
// Datenbank, Store, Kanal und Lock-Name sind Kopien aus
// public/js/editor/draft-idb.js, gegated durch tests/unit/draft-idb-drift.test.mjs.
(function () {
  const DRAFT_DB = 'schreibwerkstatt-drafts';
  const DRAFT_STORE = 'drafts';
  const DRAFT_DB_VERSION = 1;
  const DRAFT_CHANNEL = 'schreibwerkstatt-drafts';
  const DRAFT_SYNC_TAG = 'schreibwerkstatt-drafts';
  const DRAFT_LOCK_PREFIX = 'draft-flush:';
  const OWNER_PREFIX = 'editor_draft_u:';
  const DRAFT_SENT_PREFIX = 'sent:';
  const HELD_TIMEOUT_MS = 1500;
  const OWN_SAVE_IDS_MAX = 16;
  // Die SPA-Shell läuft unter `/` (Hash-Router). Nur dort lebt ein Editor, der
  // Abschnitte halten kann — Share-Reader, Login- oder Rechtsseiten antworten
  // nie und dürfen den Sync nicht aufhalten.
  const APP_PATHS = new Set(['/', '/index.html']);

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DRAFT_DB, DRAFT_DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(DRAFT_STORE)) req.result.createObjectStore(DRAFT_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function req(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, mode);
      let out;
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('draft tx abort'));
      const r = fn(tx.objectStore(DRAFT_STORE));
      if (r) r.onsuccess = () => { out = r.result; };
    });
  }

  const getKeys = (db) => req(db, 'readonly', (s) => s.getAllKeys());
  const getOne = (db, key) => req(db, 'readonly', (s) => s.get(key));

  // Nur löschen, wenn der Entwurf noch der gesendete Stand ist — ein Tab kann
  // inzwischen weitergeschrieben haben. Dazu ein Vermerk `sent:<key>`: eine
  // localStorage-Restkopie desselben Stands (Tab zwischen IndexedDB-Commit und
  // Aufräumen geschlossen) holt der nächste Start nicht wieder zurück
  // (editor/draft-storage.js#_load).
  function deleteIfSame(db, key, savedAt) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, 'readwrite');
      const s = tx.objectStore(DRAFT_STORE);
      let deleted = false;
      const g = s.get(key);
      g.onsuccess = () => {
        s.put({ savedAt, at: Date.now() }, DRAFT_SENT_PREFIX + key);
        if (g.result && g.result.savedAt === savedAt) { s.delete(key); deleted = true; }
      };
      tx.oncomplete = () => resolve(deleted);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('draft tx abort'));
    });
  }

  // Kennung des anstehenden PUT im Entwurf vermerken, bevor er rausgeht — wie
  // repo/save-ids.js#beginSave für die Tabs. Geht die Antwort verloren, nennt
  // der nächste Lauf (oder die Outbox, die den Entwurf aus IndexedDB lädt) sie
  // in `own_save_ids`, und der Server erkennt seinen Stand als eigenen
  // Vorgänger statt als fremden. Nur am unveränderten Stand (`savedAt`), der
  // Stempel bleibt — deleteIfSame räumt nach dem Erfolg wie bisher.
  function rememberSaveId(db, key, savedAt, entry) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, 'readwrite');
      const s = tx.objectStore(DRAFT_STORE);
      const g = s.get(key);
      g.onsuccess = () => {
        const d = g.result;
        if (!d || d.savedAt !== savedAt) return;
        const prior = Array.isArray(d.ownSaveIds) ? d.ownSaveIds : [];
        s.put({ ...d, ownSaveIds: [...prior, entry].slice(-OWN_SAVE_IDS_MAX) }, key);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('draft tx abort'));
    });
  }

  // null = abgemeldet (dann nichts senden). Ein anderer Fehler (5xx, Proxy)
  // wirft — der Lauf scheitert und der Browser wiederholt ihn.
  async function sessionEmail() {
    const r = await fetch('/config', { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) return null;
    if (!r.ok) throw new Error('config ' + r.status);
    const cfg = await r.json();
    return cfg?.user?.email || null;
  }

  // Welche Abschnitte halten die offenen Tabs? null = ein Tab hat nicht
  // geantwortet (dann lieber gar nichts senden).
  async function heldByTabs() {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const wins = all.filter((c) => {
      try { return APP_PATHS.has(new URL(c.url).pathname); } catch { return true; }
    });
    const answers = await Promise.all(wins.map((c) => new Promise((resolve) => {
      const ch = new MessageChannel();
      const t = setTimeout(() => resolve(null), HELD_TIMEOUT_MS);
      ch.port1.onmessage = (e) => { clearTimeout(t); resolve(Array.isArray(e.data?.held) ? e.data.held : []); };
      try { c.postMessage({ type: 'draft-sync-held' }, [ch.port2]); } catch { clearTimeout(t); resolve(null); }
    })));
    if (answers.some((a) => a === null)) return null;
    return new Set(answers.flat().map(Number));
  }

  function withLock(pageId, fn) {
    const locks = self.navigator && self.navigator.locks;
    return locks ? locks.request(DRAFT_LOCK_PREFIX + pageId, fn) : fn();
  }

  // Der Entwurf trägt die Kennungen seines Schreibers als `{ id, base }`
  // (public/js/repo/save-ids.js); der Server nimmt nur die nackten Kennungen.
  // Mit wie die Outbox (`beginSave` → `idsOnBases`): nur die Saves, die gegen
  // die Basis des Entwurfs gingen — nur von denen ist er ein Nachfahre.
  function ownIdsOnBase(entries, base) {
    if (!Array.isArray(entries) || !base) return [];
    const ids = entries
      .filter((e) => e && typeof e === 'object' && typeof e.id === 'string' && e.base === base)
      .map((e) => e.id);
    return [...new Set(ids)].slice(-OWN_SAVE_IDS_MAX);
  }

  function uuid() {
    return self.crypto && self.crypto.randomUUID ? self.crypto.randomUUID() : null;
  }

  // Ein Entwurf. 'ok' | 'keep' (bleibt für die App) | 'offline' (Netz weg) |
  // 'retry' (Server vorübergehend weg: 5xx/429 — der Browser soll wiederholen) |
  // 'auth' (Sitzung abgelaufen/kein Recht mehr: Lauf beenden, die App fragt
  // nach dem Login; der Entwurf bleibt).
  async function sendOne(db, key, pageId) {
    return withLock(pageId, async () => {
      const d = await getOne(db, key);
      if (!d || !d.html || !d.originalUpdatedAt || typeof d.originalHtml !== 'string') return 'keep';
      const body = {
        html: d.html,
        base_html: d.originalHtml,
        source: d.writer === 'book' ? 'book' : 'main',
        expected_updated_at: d.originalUpdatedAt,
        save_reason: 'bg-sync',
        own_save_ids: ownIdsOnBase(d.ownSaveIds, d.originalUpdatedAt),
      };
      const id = uuid();
      if (id) {
        body.save_id = id;
        // Scheitert der Vermerk (Quota), geht der PUT trotzdem: dann endet ein
        // Verlust der Antwort im Merge bzw. 409 wie ohne Kennung.
        try { await rememberSaveId(db, key, d.savedAt, { id, base: d.originalUpdatedAt }); } catch {}
      }
      let res;
      try {
        res = await fetch('/content/pages/' + pageId, {
          method: 'PUT', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch { return 'offline'; }
      if (res.status >= 500 || res.status === 429) return 'retry';
      if (res.status === 401) return 'auth';
      if (!res.ok) return 'keep';
      if (await deleteIfSame(db, key, d.savedAt)) {
        try { new BroadcastChannel(DRAFT_CHANNEL).postMessage({ type: 'del', key, savedAt: d.savedAt }); } catch {}
      }
      const paths = ['pages/' + pageId, 'pages/' + pageId + '/revisions'];
      try { await _invalidateCacheEntries(CONTENT_CACHE, paths, '/content/'); } catch {}
      try { await self.__swOffline?.invalidate(paths); } catch {}
      // Offene Lese-Ansichten zeigen sonst den Stand vor dem Nachsenden.
      try { if (typeof notifyContentUpdated === 'function') await notifyContentUpdated('/content/pages/' + pageId); } catch {}
      return 'ok';
    });
  }

  async function flush() {
    const email = await sessionEmail();
    if (!email) return; // abgemeldet: nichts senden, die App fragt nach dem Login
    const held = await heldByTabs();
    if (!held) throw new Error('tab hält Abschnitte, ohne zu antworten');
    const prefix = OWNER_PREFIX + email + ':';
    const db = await openDb();
    try {
      for (const key of await getKeys(db)) {
        if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
        const pageId = Number(key.slice(prefix.length));
        if (!(pageId > 0) || held.has(pageId)) continue; // `…:discarded` fällt hier raus
        const r = await sendOne(db, key, pageId);
        if (r === 'offline' || r === 'retry') throw new Error(r);
        if (r === 'auth') return;
      }
    } finally { db.close(); }
  }

  self.addEventListener('sync', (event) => {
    if (event.tag !== DRAFT_SYNC_TAG) return;
    // Ein Wurf lässt den Browser den Sync später wiederholen.
    event.waitUntil(flush());
  });

  self.__swDrafts = { flush };
})();
