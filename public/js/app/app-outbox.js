// Reconnect-Outbox: synchronisiert ALLE lokal gesicherten Notebook-Entwürfe
// (editor_draft_*), nicht nur die gerade offene Seite. Der Per-Seite-Retry in
// editor/notebook/edit/autosave.js deckt ausschliesslich die aktive Edit-Seite
// ab; wer offline mehrere Seiten editiert und online zurückkommt, während
// Seite N offen ist, liesse Seite 1..N-1 sonst als Draft liegen, bis er sie
// einzeln wieder öffnet. Diese Outbox flusht sie im Hintergrund.
//
// DOM-frei: arbeitet rein aus dem persistierten Draft ({ html, originalHtml,
// originalUpdatedAt }). `originalHtml` ist der 3-Way-Merge-Ancestor, deshalb
// lässt sich ein Cross-User-Konflikt hier ohne Live-Editor block-mergen. Echte
// Block-Kollisionen bleiben als Draft liegen und werden gelöst, sobald der User
// die betroffene Seite öffnet (bestehender conflict.js-Pfad).
//
// Gepusht wird auch der Draft, den ein Seitenwechsel mit ungespeicherten
// Änderungen stehen lässt (`_teardownEditSession({ keepDraft: true })`): wer
// eine Seite verlässt, verwirft damit nichts — der Autosave hätte denselben
// Stand ohnehin gespeichert. Voraussetzung ist der Stempel der Basis
// (`originalUpdatedAt`): nur mit ihm läuft der PUT durch den OCC-Guard, und
// eine zwischenzeitliche Remote-Änderung wird gemergt statt überschrieben.
// Ein Draft ohne Stempel (Alt-Format) wird darum nie automatisch gepusht; er
// wartet auf den `pendingDraft`-Banner der Seite.
//
// Als Methoden-Modul in die `lektorat`-Root gespreadet (app.js) — `this` ist
// zur Laufzeit die Root-Komponente, darum greifen `this.$store`, `this.editMode`
// etc. Nur Plain-Methoden, keine Getter (Spread-Getter-Falle).
import { listDraftPageIds, readDraft, writeDraft, clearDraft, clearDraftIfSame, moveDraftToBackup, whenDraftsReady, refreshDraft, whenDraftSettled } from '../editor/draft-storage.js';
import { flushStructureQueue, pendingStructureCount, pendingStructureOps } from '../repo/structure-queue.js';
import { flushIdeenQueue, pendingIdeenCount } from '../repo/ideen-queue.js';
import { startLiveEdit } from '../editor/live-edit.js';
import { isLiveEditedElsewhere, isLiveEditedHere, liveEditedHereIds } from '../editor/live-edit.js';
import { requestDraftSync, withDraftLock, hasBackgroundSync } from '../editor/draft-idb.js';
import { savePage, isPageConflict } from '../editor/shared/page-api.js';
import { mergeBlocks, mergedToHtml } from '../editor/shared/block-merge.js';
import { contentRepo } from '../repo/content.js';
import { EVT } from '../events.js';
import { isNetworkError } from '../utils/net.js';

// Zählt die Flush-Ergebnisse ({pageId → 'ok'|'conflict'|'skip'}) für die
// Rückmeldung. `reported` merkt sich bereits gemeldete Konflikt-Seiten und wird
// mitgeführt: eine gelöste (ok) Seite fällt heraus, damit ein späterer neuer
// Konflikt derselben Seite wieder gemeldet wird.
export function summarizeOutboxResults(results, reported) {
  let synced = 0;
  let newConflicts = 0;
  for (const [pageId, status] of results) {
    if (status === 'ok') { synced++; reported.delete(pageId); }
    else if (status === 'conflict' && !reported.has(pageId)) { newConflicts++; reported.add(pageId); }
  }
  return { synced, newConflicts };
}

// Wiederholung, wenn der Server nicht erreichbar ist, der Browser aber nicht
// offline meldet — dann kommt kein `online`-Event. Verdoppelt sich je Fehlschlag.
export const OUTBOX_RETRY_MIN_MS = 15 * 1000;
export const OUTBOX_RETRY_MAX_MS = 5 * 60 * 1000;

export function nextOutboxBackoff(prevMs) {
  return Math.min(OUTBOX_RETRY_MAX_MS, prevMs ? prevMs * 2 : OUTBOX_RETRY_MIN_MS);
}

// Beim Schliessen warnen, wenn Wartendes ohne offenen Tab liegen bliebe: der
// Server ist gerade nicht erreichbar, und nachsenden würde erst das nächste
// Öffnen. Entwürfe übernimmt sonst der Background Sync (nur Chromium);
// Struktur- und Ideen-Warteschlange sendet der Service Worker nie.
export function outboxWouldStrand({ drafts, queued, unreachable, backgroundSync }) {
  if (!unreachable) return false;
  return queued > 0 || (drafts > 0 && !backgroundSync);
}

export const appOutboxMethods = {
  // Wiederholung nach einem Netzfehler im Flush (_scheduleOutboxRetry): Timer +
  // aktuelle Wartezeit, wächst bis OUTBOX_RETRY_MAX_MS, Erfolg setzt zurück.
  _outboxRetryTimer: null,
  _outboxRetryMs: 0,
  // Zuletzt gemeldete Zahl abgewiesener Anlege-Operationen (_reportStructureResult).
  _outboxStuckReported: 0,
  // Offline vorgemerkte Ideen-Writes (repo/ideen-queue.js, IndexedDB — darum
  // hier gespiegelt, der Zähler selbst ist synchron).
  _pendingIdeenCount: 0,

  // Einmalig im Root-init() aufgerufen (mit dem AbortController-Signal). Hängt
  // die Reconnect-Trigger an und stellt den Pending-Zähler initial.
  _installOutbox(signal) {
    const flush = () => this._flushOutbox();
    window.addEventListener('online', flush, { signal });
    window.addEventListener('focus', flush, { signal });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this._flushOutbox();
    }, { signal });
    // Background Sync (public/sw-drafts.js) fragt, welche Abschnitte dieser Tab
    // hält — die sendet er nicht. Antwort über den mitgeschickten Port.
    navigator.serviceWorker?.addEventListener('message', (e) => {
      if (e.data?.type === 'draft-sync-held') e.ports?.[0]?.postMessage({ held: liveEditedHereIds() });
    }, { signal });
    // Draft-Bestand hat sich geändert (write/clear irgendwo) → Zähler neu.
    window.addEventListener(EVT.DRAFT_CHANGED, () => this._refreshPendingSyncCount(), { signal });
    // Entwurf liess sich nachträglich nicht sichern (localStorage voll, dann
    // IndexedDB gescheitert): Notebook-/Focus-Editor zeigt „nicht gesichert".
    // Den Bucheditor informiert sein eigener Listener (book-editor/drafts.js).
    window.addEventListener(EVT.DRAFT_PERSIST_FAILED, (e) => {
      if (this.editMode && Number(this.currentPage?.id) === Number(e.detail?.pageId)) {
        this.draftPersistFailed = true;
        this.setStatus?.(this.t('edit.draftPersistFailedLate'), true, 10000);
      }
    }, { signal });
    // Strukturänderung offline vorgemerkt (repo/structure-queue.js): Zähler
    // neu, und dem User sagen, dass sie noch nicht auf dem Server ist.
    window.addEventListener(EVT.STRUCTURE_QUEUE_CHANGED, (e) => {
      this._refreshPendingSyncCount();
      if (e.detail?.queued) this.setStatus?.(this.t('offline.structureQueued'), false, 6000);
    }, { signal });
    // Ideen-Write offline vorgemerkt (repo/ideen-queue.js): Zähler (asynchron
    // aus IndexedDB) neu, Hinweis wie bei der Struktur.
    window.addEventListener(EVT.IDEEN_QUEUE_CHANGED, (e) => {
      this._refreshPendingIdeenCount();
      if (e.detail?.queued) this.setStatus?.(this.t('ideen.offline.queued'), false, 6000);
    }, { signal });
    this._refreshPendingIdeenCount();
    // Den Dialogtext setzt der Browser selbst; was wartet, zeigt der Offline-Banner.
    window.addEventListener('beforeunload', (e) => {
      if (!this._outboxWouldStrand()) return;
      e.preventDefault();
      e.returnValue = '';
    }, { signal });
    // Seitenwechsel schiebt die vorher offene Seite von „live" zu „pending" —
    // Zähler neu rechnen, damit der Banner sofort stimmt.
    this.$watch(() => this.currentPage?.id, () => this._refreshPendingSyncCount());
    // Beim Boot: Zähler stellen und (falls online) direkt einmal flushen —
    // deckt „Tab offline geschlossen, online wieder geöffnet" ab.
    this._refreshPendingSyncCount();
    this._flushOutbox();
  },

  // Zählt unsynchronisierte Seiten für den Offline-Banner. Die aktuell offene
  // Edit-Seite ist „live" (wird laufend als Draft geschrieben/geleert) und zählt
  // nicht als „wartend" — sonst flackert der Zähler bei jedem Tippen.
  _refreshPendingSyncCount() {
    const openId = (this.editMode && this.currentPage?.id) ? Number(this.currentPage.id) : null;
    // Ein Abschnitt, den ein anderer Tab oder der Bucheditor dieses Tabs gerade
    // bearbeitet, wartet nicht — er ist dort live.
    const count = listDraftPageIds().filter((id) => id !== openId && !isLiveEditedHere(id) && !isLiveEditedElsewhere(id)).length
      + pendingStructureCount() + (this._pendingIdeenCount || 0);
    if (this.$store.session.pendingSyncCount !== count) {
      this.$store.session.pendingSyncCount = count;
    }
  },

  // Wie _refreshPendingSyncCount, aber Entwürfe getrennt von den Warteschlangen.
  // Die offene Edit-Seite schützt ihr eigener beforeunload (app-init.js).
  _outboxWouldStrand() {
    const openId = (this.editMode && this.currentPage?.id) ? Number(this.currentPage.id) : null;
    const drafts = listDraftPageIds().filter((id) => id !== openId && !isLiveEditedHere(id) && !isLiveEditedElsewhere(id)).length;
    return outboxWouldStrand({
      drafts,
      queued: pendingStructureCount() + (this._pendingIdeenCount || 0),
      unreachable: navigator.onLine === false || this._outboxRetryMs > 0,
      backgroundSync: hasBackgroundSync(),
    });
  },

  _pageNameById(pageId) {
    const p = this.$store.nav.pages.find((x) => String(x.id) === String(pageId));
    return p?.name || null;
  },

  // Name eines Abschnitts aus einem anderen als dem geöffneten Buch: vom
  // Server (bzw. aus dem Content-Cache). null + `gone` = es gibt ihn nicht mehr.
  async _pageNameRemote(pageId) {
    try {
      const p = await contentRepo.loadPage(pageId);
      return { name: p?.name || null, gone: false };
    } catch (e) {
      if (e?.status === 404) return { name: null, gone: true };
      return { name: null, gone: false, offline: isNetworkError(e) };
    }
  },

  // Flusht alle pending Drafts sequenziell. Bricht beim ersten Netzfehler ab
  // (dann sind wir wieder offline — der Rest wartet auf den nächsten Trigger).
  async _flushOutbox() {
    if (this._outboxFlushing) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    this._outboxFlushing = true;
    const results = new Map();
    let unreachable = false;
    try {
      // Strukturänderungen zuerst: ein offline angelegter Abschnitt braucht
      // seine echte ID, bevor irgendetwas anderes ihn adressiert.
      // Wirft die Warteschlange selbst (IndexedDB-Fehler, Lock), gilt sie als
      // „später nochmal" — die Entwürfe hängen nicht an ihr.
      let st;
      try { st = await flushStructureQueue((op) => contentRepo.sendQueuedStructureOp(op)); }
      catch (e) {
        console.warn('[outbox] Struktur-Warteschlange nicht abspielbar', e);
        st = { remaps: [], done: 0, dropped: 0, stuck: 0, offline: false, retry: true };
      }
      if (st.remaps.length) this._applyTempPageRemaps(st.remaps);
      this._reportStructureResult(st);
      // Baum frisch: Position der neuen Abschnitte und Namen kommen vom Server.
      if (st.done) this.loadPages?.({ fresh: true });
      // Netz weg: nichts weiter. Klemmt nur eine Warteschlange (5xx, 401),
      // gehen die Entwürfe trotzdem — sie hängen nicht an ihr (Abschnitte mit
      // temporärer ID haben keinen eigenen Entwurf-Send).
      if (st.offline) { unreachable = true; requestDraftSync(); }
      else {
        if (st.retry) unreachable = true;
        let ideen;
        try { ideen = await this._flushIdeenInto(st.remaps); }
        catch (e) { console.warn('[outbox] Ideen-Warteschlange nicht abspielbar', e); ideen = 'retry'; }
        if (ideen === 'offline') { unreachable = true; requestDraftSync(); }
        else {
          if (ideen === 'retry') unreachable = true;
          await this._flushDraftsInto(results, () => { unreachable = true; });
        }
      }
    } finally {
      this._outboxFlushing = false;
      this._refreshPendingSyncCount();
    }
    if (unreachable) this._scheduleOutboxRetry();
    else { clearTimeout(this._outboxRetryTimer); this._outboxRetryTimer = null; this._outboxRetryMs = 0; }
    this._reportOutboxResults(results);
  },

  // Entwürfe nachsenden (nach der Struktur-Warteschlange). `onUnreachable`
  // meldet den Netzabbruch an _flushOutbox (Backoff).
  async _flushDraftsInto(results, onUnreachable) {
    // Entwürfe aus IndexedDB stehen erst nach dem Start-Laden im Spiegel.
    await whenDraftsReady();
    const ids = listDraftPageIds();
    const openId = (this.editMode && this.currentPage?.id) ? Number(this.currentPage.id) : null;
    for (const pageId of ids) {
      if (pageId === openId) continue; // aktive Edit-Seite: eigener Retry-Pfad (autosave.js)
      // Gleicher Lock wie der Background Sync und die anderen Tabs: nie senden
      // zwei zugleich. Unter dem Lock den Stand frisch aus IndexedDB lesen (hat
      // ihn jemand vor uns gesendet, ist er dort schon weg) und das Räumen
      // abwarten, bevor der Nächste den Lock bekommt.
      const status = await withDraftLock(pageId, async () => {
        await refreshDraft(pageId);
        try { return await this._flushOneDraft(pageId); }
        finally { await whenDraftSettled(pageId); }
      });
      if (status === 'offline') {
        // Netz wieder weg → Rest später, notfalls ohne offenen Tab.
        requestDraftSync();
        onUnreachable();
        break;
      }
      if (status === 'retry') { onUnreachable(); continue; }
      results.set(pageId, status);
    }
  },

  // Offline vorgemerkte Ideen nachsenden (nach der Struktur: eine Idee an einem
  // offline angelegten Abschnitt bekommt dessen echte ID — aus `remaps` oder,
  // in einem späteren Durchgang, aus structure-queue.js#resolveTempId).
  // Liefert 'offline' | 'retry' | null.
  async _flushIdeenInto(remaps) {
    const realId = new Map((remaps || []).map((r) => [Number(r.tempId), r.page?.id]));
    const res = await flushIdeenQueue(undefined, realId);
    if (res.done) this.setStatus?.(this.t('ideen.offline.synced', { n: res.done }), false, 5000);
    if (res.dropped) this.setStatus?.(this.t('ideen.offline.dropped', { n: res.dropped }), true, 10000);
    if (res.stuck > (this._outboxIdeenStuckReported || 0)) this.setStatus?.(this.t('ideen.offline.stuck', { n: res.stuck }), true, 10000);
    this._outboxIdeenStuckReported = res.stuck || 0;
    // Zähler nach jedem Durchgang neu: ein nur abgewiesener Write meldet sich
    // nicht per IDEEN_QUEUE_CHANGED, stünde sonst weiter als „wartend" im Banner.
    await this._refreshPendingIdeenCount();
    this._refreshRescueCount?.();
    if (res.offline) return 'offline';
    return res.retry ? 'retry' : null;
  },

  async _refreshPendingIdeenCount() {
    this._pendingIdeenCount = await pendingIdeenCount();
    this._refreshPendingSyncCount();
  },

  // Abgewiesene Anlege-Operationen nur melden, wenn es mehr geworden sind —
  // sonst bei jedem Fokuswechsel derselbe Hinweis.
  _reportStructureResult(st) {
    if (st.done) this.setStatus?.(this.t('offline.structureSynced', { n: st.done }), false, 5000);
    if (st.dropped) this.setStatus?.(this.t('offline.structureDropped', { n: st.dropped }), true, 10000);
    if (st.stuck > this._outboxStuckReported) this.setStatus?.(this.t('offline.structureStuck', { n: st.stuck }), true, 10000);
    this._outboxStuckReported = st.stuck;
    this._refreshRescueCount?.();
  },

  // Offline angelegte Abschnitte haben jetzt ihre echte ID: überall nachziehen,
  // wo die temporäre stand — Seitenobjekte in nav.pages/nav.tree (dieselben
  // Objekte, darum in place), offene Seite samt Edit-Session, Entwurf, URL.
  _applyTempPageRemaps(remaps) {
    const nav = this.$store.nav;
    const byTemp = new Map(remaps.map((r) => [r.tempId, r.page]));
    const fix = (p) => {
      const real = byTemp.get(p?.id);
      if (!real) return;
      p.id = real.id;
      p.updated_at = real.updated_at || null;
      p.priority = real.position ?? p.priority;
      delete p.pending;
    };
    const seen = new Set();
    for (const p of nav.pages) { fix(p); seen.add(p); }
    for (const it of nav.tree) for (const p of it.pages || []) if (!seen.has(p)) fix(p);
    nav.pages = [...nav.pages];
    this._bumpTreeRev?.();
    this._rebuildTreeOrderMaps?.();
    // Organizer-Workstate traegt noch die temporaere ID (EVT.PAGE_ADDED).
    window.dispatchEvent(new CustomEvent(EVT.PAGE_ADDED, { detail: {} }));
    for (const { tempId, page: real, lateHtml, lateName } of remaps) {
      // Entwurf der temporären ID (Edit seit dem letzten lokalen Save) bzw. ein
      // lokaler Save, der während des Anlegens noch in die Operation lief, auf
      // die echte ID — Basis ist der gerade angelegte Stand, die Outbox sendet nach.
      const d = readDraft(tempId);
      const html = d?.html || lateHtml;
      if (html) writeDraft(real.id, html, real.html || '', real.updated_at, { writer: d?.writer || 'notebook' });
      clearDraft(tempId);
      if (lateName) {
        contentRepo.updatePage(real.id, { name: lateName }).catch((e) => {
          console.warn('[outbox] Name nach dem Anlegen nicht übernommen', { pageId: real.id, status: e?.status, code: e?.code });
          this.setStatus?.(this.t('offline.lateNameFailed', { name: lateName }), true, 8000);
        });
      }
      const cur = this.currentPage;
      if (cur && (cur.id === tempId || cur.id === real.id)) {
        cur.id = real.id;
        cur.updated_at = real.updated_at || null;
        delete cur.pending;
        if (this.editMode) {
          if (typeof real.html === 'string') this.originalHtml = real.html;
          startLiveEdit(real.id);
        }
      }
      try {
        if (location.hash.includes('/page/' + tempId)) {
          history.replaceState(history.state, '', location.hash.replace('/page/' + tempId, '/page/' + real.id));
        }
      } catch { /* kein history (Tests) */ }
    }
  },

  // Nach dem Baum-Laden: was offline vorgemerkt und noch nicht abgespielt ist,
  // über den (womöglich gecachten) Server-Baum legen — sonst verschwänden ein
  // offline angelegter Abschnitt und ein neuer Name beim Neuladen ohne Netz.
  _overlayPendingStructure(bookId) {
    const nav = this.$store.nav;
    let touched = false;
    for (const op of pendingStructureOps()) {
      if (op.op === 'rename' && (op.bookId == null || String(op.bookId) === String(bookId))) {
        if (op.kind === 'page') {
          for (const p of nav.pages) if (p.id === op.id) { p.name = op.name; touched = true; }
          for (const it of nav.tree) for (const p of it.pages || []) if (p.id === op.id) p.name = op.name;
        } else {
          const ch = this._findTreeChapter?.(op.id);
          if (ch) { ch.name = op.name; touched = true; }
        }
      } else if (op.op === 'createPage' && String(op.bookId) === String(bookId)
                 && !nav.pages.some((p) => p.id === op.tempId)) {
        const item = op.body.chapter_id != null ? this._findTreeChapter?.(op.body.chapter_id) : null;
        if (item && !item.solo) { this._insertCreatedPageIntoTree(item, op.page); touched = true; }
        // Ohne Kapitel (oder das Kapitel gibt es nicht mehr — so legt ihn auch
        // das Abspielen an): als Abschnitt auf Buchebene vor den Kapiteln.
        else { this._insertPendingSoloPage(op.page); touched = true; }
      }
    }
    if (touched) { nav.pages = [...nav.pages]; this._bumpTreeRev?.(); this._rebuildTreeOrderMaps?.(); }
  },

  // Offline angelegter Abschnitt ohne Kapitel in Baum und Leseliste: wie
  // tree/build.js die Abschnitte auf Buchebene führt (Solo-Eintrag vor den
  // Kapiteln, in nav.pages vor allen Kapitel-Abschnitten).
  _insertPendingSoloPage(page) {
    const nav = this.$store.nav;
    const p = { ...page, chapter_id: null, chapterName: null, priority: page.position ?? null };
    let lastSolo = -1;
    for (let i = 0; i < nav.tree.length; i++) if (nav.tree[i].type === 'chapter' && nav.tree[i].solo) lastSolo = i;
    nav.tree.splice(lastSolo + 1, 0, {
      type: 'chapter', id: 'solo-' + p.id, name: p.name, priority: p.priority,
      depth: 1, parent_id: null, open: true, solo: true, pages: [p],
    });
    let lastTop = -1;
    for (let i = 0; i < nav.pages.length; i++) if (!nav.pages[i].chapter_id) lastTop = i;
    nav.pages.splice(lastTop + 1, 0, p);
    window.dispatchEvent(new CustomEvent(EVT.PAGE_ADDED, { detail: { pageId: p.id } }));
  },

  _scheduleOutboxRetry() {
    this._outboxRetryMs = nextOutboxBackoff(this._outboxRetryMs);
    clearTimeout(this._outboxRetryTimer);
    this._outboxRetryTimer = setTimeout(() => {
      this._outboxRetryTimer = null;
      this._flushOutbox();
    }, this._outboxRetryMs);
  },

  // Rückmeldung nach dem Flush: synchronisierte Seiten + neu liegengebliebene
  // Konflikte als ein Toast. Konflikte, die schon gemeldet wurden, nicht bei
  // jedem Fokus-Trigger erneut (sie bleiben als Draft liegen, bis der User die
  // Seite öffnet). 'skip' bleibt stumm — Poison-Drafts/Fremd-Buch.
  _reportOutboxResults(results) {
    if (!this._outboxReportedConflicts) this._outboxReportedConflicts = new Set();
    const { synced, newConflicts } = summarizeOutboxResults(results, this._outboxReportedConflicts);
    if (!synced && !newConflicts) return;
    const parts = [];
    if (synced) parts.push(this.t('offline.syncDone', { n: synced }));
    if (newConflicts) parts.push(this.t('offline.syncConflicts', { n: newConflicts }));
    this._showJobToast?.({
      message: parts.join(' '),
      severity: newConflicts ? 'err' : 'ok',
      jobType: 'outbox',
      bookId: null,
    });
  },

  // Ein Draft. Rückgabe: 'ok' | 'conflict' | 'offline' | 'skip' | 'empty'
  // (leerer Draft verworfen, zählt nicht als synchronisiert).
  // 'offline' bricht die Schleife ab (Netz weg), 'skip'/'conflict' lassen den
  // Draft liegen, aber flushen die übrigen weiter.
  async _flushOneDraft(pageId) {
    const draft = readDraft(pageId);
    if (!draft || !draft.html) { clearDraft(pageId); return 'empty'; }
    // Race-Schutz: hat der User diese Seite inzwischen (während des async-Flushs)
    // zum Editieren geöffnet, gehört sie dem Live-Editor (autosave.js) — headless
    // nicht dazwischenfunken, sonst clearen wir den Draft unter seinen Füssen weg.
    if (this.editMode && Number(this.currentPage?.id) === pageId) return 'skip';
    // Ein anderer Tab bearbeitet den Abschnitt: der Draft ist sein laufender
    // Stand, gespeichert wird er dort (editor/live-edit.js). Ein Push von hier
    // liefe mit dessen altem Stempel in den Save des anderen Tabs.
    if (isLiveEditedElsewhere(pageId)) return 'skip';
    // Der Bucheditor dieses Tabs hält den Block (ungespeichert/Konflikt): er
    // speichert selbst (cards/book-editor/drafts.js).
    if (isLiveEditedHere(pageId)) return 'skip';
    // Offenes Konflikt-Modal dieser Seite: dort fällt die Entscheidung.
    if (Number(this.conflictResolution?.pageId) === pageId) return 'skip';
    // Ohne Basis-Stempel kein OCC-Guard: der PUT überschriebe jede
    // Remote-Änderung still. Bleibt liegen, bis der User die Seite öffnet.
    if (!draft.originalUpdatedAt) return 'skip';
    // Abschnitt eines anderen Buchs (der Entwurf blieb nach einem Buchwechsel
    // liegen): Name vom Server holen statt bis zum nächsten Öffnen zu warten.
    let name = this._pageNameById(pageId);
    if (!name) {
      const r = await this._pageNameRemote(pageId);
      if (r.gone) return this._orphanDraft(pageId);
      if (r.offline) return 'offline';
      name = r.name;
      if (!name) return 'skip';
    }
    try {
      await savePage(pageId, {
        html: draft.html, pageName: name, source: draft.writer === 'book' ? 'book' : 'main',
        expectedUpdatedAt: draft.originalUpdatedAt, reason: 'outbox',
        writer: 'outbox', extraOwnSaveIds: draft.ownSaveIds || [],
      });
      // Nur den gesendeten Stand räumen: ein Tab kann während des PUT
      // weitergeschrieben haben (editor/draft-storage.js#clearDraftIfSame).
      clearDraftIfSame(pageId, draft.savedAt);
      return 'ok';
    } catch (e) {
      if (isPageConflict(e)) return this._flushMergeDraft(pageId, draft, name);
      // Abschnitt gibt es nicht mehr (anderswo gelöscht): Sicherung statt
      // ewig „wartend".
      if (e?.status === 404) return this._orphanDraft(pageId);
      // Server vorübergehend weg: Backoff, die übrigen trotzdem versuchen.
      if (e?.status >= 500 || e?.status === 429) return 'retry';
      // Server hat geantwortet (4xx: kein Zugriff/invalide) → Retry bringt
      // nichts. Draft bleiben lassen, aber die übrigen NICHT blockieren (skip
      // statt offline) — sonst hängt ein einzelner Poison-Draft die ganze Queue.
      if (typeof e?.status === 'number') {
        console.warn('[outbox] Draft nicht synchronisierbar, übersprungen', { pageId, status: e.status, code: e.code });
        return 'skip';
      }
      return 'offline'; // kein Status = echter Netzfehler → Rest später
    }
  },

  // Entwurf eines gelöschten Abschnitts: als Sicherung ablegen (Dialog „Nicht
  // gespeichert"), zählt dann nicht mehr als wartend.
  _orphanDraft(pageId) {
    moveDraftToBackup(pageId, 'orphan');
    this.setStatus?.(this.t('offline.draftOrphaned'), true, 10000);
    this._refreshRescueCount?.();
    return 'orphan';
  },

  // Cross-User-Konflikt headless auflösen: 3-Way-Block-Merge mit dem Draft-
  // Ancestor (originalHtml) gegen den frischen Remote-Stand. Nur kollisionsfreie
  // Merges werden automatisch gespeichert; echte Block-Kollisionen bleiben als
  // Draft liegen (der User löst sie beim Öffnen der Seite über conflict.js).
  async _flushMergeDraft(pageId, draft, name) {
    const base = draft.originalHtml || '';
    if (!base) return 'conflict'; // kein Ancestor → nur manuell auflösbar
    let remote;
    try { remote = await contentRepo.loadPage(pageId, { fresh: true }); }
    catch (e) {
      if (e?.status === 404) return this._orphanDraft(pageId);
      if (e?.status >= 500 || e?.status === 429) return 'retry';
      return (typeof e?.status === 'number') ? 'conflict' : 'offline';
    }
    if (!remote?.updated_at) return 'conflict';
    let m;
    try { m = mergeBlocks(base, draft.html, remote.html || ''); }
    catch { return 'conflict'; }
    if (m.conflicts.length) return 'conflict'; // echte Kollision → beim Öffnen lösen
    try {
      await savePage(pageId, {
        html: mergedToHtml(m.merged), pageName: name, source: draft.writer === 'book' ? 'book' : 'main',
        expectedUpdatedAt: remote.updated_at, reason: 'outbox-merge', writer: 'outbox',
      });
      clearDraftIfSame(pageId, draft.savedAt);
      return 'ok';
    } catch (e) {
      if (e?.status >= 500 || e?.status === 429) return 'retry';
      return (typeof e?.status === 'number') ? 'conflict' : 'offline';
    }
  },
};
