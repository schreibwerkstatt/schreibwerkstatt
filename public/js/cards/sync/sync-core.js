import { EVT } from '../../events.js';
import { startPoll } from '../job-helpers.js';
import { isSelectedBook } from '../book-guard.js';

// Push-Poller pro Seite: `_pushTimers[pageId]` hält ein Halter-Objekt, in dessen
// `timer` startPoll seinen Handle schreibt. Stoppen = Intervall räumen UND
// `timer` nullen — daran erkennt startPoll, dass sein Stream-Abo erledigt ist.
function stopPushPoller(holder) {
  if (!holder) return;
  clearInterval(holder.timer);
  holder.timer = null;
}
// Sync-Core — gemeinsame Logik für externe Buch-Sync-Provider (WordPress-Blog,
// HubSpot-Blog, künftige Provider). `createSyncCard(spec)` liefert ein
// Alpine.data-Objekt mit Links-Loading, Per-Page-Status, Push-Job-Trigger,
// Progress-Polling, Status-Modell und Konflikt-Diff. Der Provider liefert nur
// Endpoint, Job-Typen und die Ansicht-URL.
//
// Endpoint-Konvention pro Provider:
//   GET  ${endpointBase}/${bookId}/links → { connected, links[], …providerMeta }
//   POST /jobs/${jobType.push}  { book_id, page_ids } → { jobId }
//
// Provider-Spec:
//   key           — kurzer Identifier ('blog', 'hubspot'); i18n-Namensraum der
//                   Aktionen/Fehler (`${key}.action.*`, `${key}.conflict.*`)
//   endpointBase  — '/blog' | '/hubspot' (Routen: routes/sync-router.js)
//   jobTypes      — { push: 'blog-push', refresh: ['blog-import','blog-pull'],
//                     reconcile: 'blog-reconcile' }
//                   (refresh-Liste: nach diesen Jobs `loadPages()` triggern;
//                   nach push-/reconcile-Jobs reicht `loadLinks()`)
//   viewUrl(page, providerMeta, link) → URL-String oder '' (optional)
//   onBookChange  — optional, wird in book:changed nach Core-Reset gerufen
//   pushErrorCode — Fallback-Error-Code-String
//   confirmPush(pageId) → boolean | Promise<boolean> (optional). Wird in `push()`
//                         vor dem Backend-Call aufgerufen; liefert `false` →
//                         Push abgebrochen (z.B. wenn ein UI-Dialog erst eine
//                         Bestätigung einholen muss).
//
// Status-Modell und Konflikt-Diff sind für alle Provider gleich (Server-Seite:
// routes/jobs/sync/push.js, routes/sync-router.js):
//   'new'         — kein Link, Push legt den Remote-Post an
//   'conflict'    — beide Seiten geändert (conflict_state='detected')
//   'locked'      — der Beitrag enthält drüben Elemente, die der Import nicht
//                   übernimmt (`locked_blocks`, nur WordPress); der Push ist
//                   gesperrt, weil er sie im Live-Blog löschte
//   'push-needed' — Abschnitt oder Titel-Werkstatt jünger als der Sync-Punkt
//   'synced'      — Stand identisch zum letzten Abgleich
// Sync-Punkt = der jüngere von last_pulled_at/last_pushed_at — dieselbe Regel
// wie lib/blog-merge.js#classifyPull.

// Jüngster von mehreren ISO-Stamps ('' wenn keiner). Frontend-Pendant zu
// lib/blog-merge.js#latest — beide Provider rechnen ihren Sync-Status damit.
export function latestStamp(...stamps) {
  let out = '';
  for (const s of stamps) if (s && String(s) > out) out = String(s);
  return out;
}

export const SYNC_STATUS_LABELS = {
  new: 'sync.status.new',
  synced: 'sync.status.synced',
  'push-needed': 'sync.status.pushNeeded',
  conflict: 'sync.status.conflict',
  locked: 'sync.status.locked',
};
const CAN_PUSH_STATUSES = ['new', 'push-needed'];

/** Badge-Status einer Seite (siehe Status-Modell oben). Titel-Werkstatt-Edits
 *  (Titel/Lead/Teaser gehen mit dem Push raus) bewegen pages.updated_at nicht —
 *  darum zählt headline_updated_at mit. */
export function computeSyncStatus(page, link) {
  if (!link) return 'new';
  if (link.conflict_state === 'detected') return 'conflict';
  if (link.locked_blocks) return 'locked';
  const lastSync = latestStamp(link.last_pushed_at, link.last_pulled_at);
  const localUpdated = latestStamp(page?.updated_at, link.headline_updated_at);
  if (localUpdated && lastSync && localUpdated > lastSync) return 'push-needed';
  return 'synced';
}

export function createSyncCard(spec) {
  const refreshTypes = new Set([
    ...(spec.jobTypes?.refresh || []),
  ]);
  const pushType = spec.jobTypes?.push || `${spec.key}-push`;
  const reconcileType = spec.jobTypes?.reconcile || null;
  const linkRefreshTypes = new Set([pushType, ...(reconcileType ? [reconcileType] : [])]);
  const globalWindowKey = `__${spec.key}Card`;

  return () => {
    const base = {
      connected: false,
      providerMeta: {},
      linksMap: {},
      pushBusy: {},
      pushProgress: {},
      _pushTimers: {},
      // Konflikt-Diff (Modal im Buchorganizer): Seite + beide Stände.
      hasConflict: true,
      conflictOpen: null,
      conflictData: null,

      init() {
        window[globalWindowKey] = this;
        this._onPagesLoaded = () => this.loadLinks();
        this._onBookChanged = () => {
          for (const h of Object.values(this._pushTimers)) stopPushPoller(h);
          this._pushTimers = {};
          this.connected = false;
          this.providerMeta = {};
          this.linksMap = {};
          this.pushBusy = {};
          this.pushProgress = {};
          this.conflictOpen = null;
          this.conflictData = null;
          if (typeof spec.onBookChange === 'function') spec.onBookChange.call(this);
        };
        this._onJobFinished = (ev) => {
          const t = ev?.detail?.type;
          if (linkRefreshTypes.has(t)) {
            this._applyPushRenames(ev?.detail?.job);
            this.loadLinks();
          }
          // source:'job' → frischer Tree-Read: Import-/Pull-Jobs legen die Seiten
          // SERVERSEITIG an, im Browser lief also kein Cache-Bust. Ein Pull kann
          // Seiten umbenennen (WP-Titel) — dann laedt _applyPushRenames den Tree.
          else if (refreshTypes.has(t)) {
            if (!this._applyPushRenames(ev?.detail?.job)) window.__app?.loadPages?.({ source: 'job' });
          }
        };
        window.addEventListener(EVT.PAGES_LOADED, this._onPagesLoaded);
        window.addEventListener(EVT.BOOK_CHANGED, this._onBookChanged);
        window.addEventListener(EVT.JOB_FINISHED, this._onJobFinished);
      },

      destroy() {
        for (const h of Object.values(this._pushTimers)) stopPushPoller(h);
        this._pushTimers = {};
        window.removeEventListener(EVT.PAGES_LOADED, this._onPagesLoaded);
        window.removeEventListener(EVT.BOOK_CHANGED, this._onBookChanged);
        window.removeEventListener(EVT.JOB_FINISHED, this._onJobFinished);
        if (window[globalWindowKey] === this) window[globalWindowKey] = null;
      },

      // Endpoint /links liefert `connected: false`, wenn Buchtyp != 'blog' oder
      // keine Connection gespeichert ist — kein zusätzlicher Client-Gate nötig.
      async loadLinks() {
        const bookId = Alpine.store('nav').selectedBookId;
        if (!bookId) {
          this.connected = false;
          this.providerMeta = {};
          this.linksMap = {};
          return;
        }
        try {
          const res = await fetch(`${spec.endpointBase}/${bookId}/links`);
          if (!isSelectedBook(bookId)) return;
          if (!res.ok) {
            this.connected = false;
            this.providerMeta = {};
            this.linksMap = {};
            return;
          }
          const data = await res.json();
          if (!isSelectedBook(bookId)) return;
          this.connected = !!data.connected;
          this.providerMeta = data;
          const map = {};
          for (const link of (data.links || [])) map[link.page_id] = link;
          this.linksMap = map;
        } catch (e) {
          console.error(`[sync:${spec.key}] Links laden fehlgeschlagen:`, e);
        }
      },

      statusFor(page) {
        if (!this.connected || !page) return null;
        return computeSyncStatus(page, this.linksMap[page.id] || null);
      },

      statusLabel(status) {
        if (!status) return '';
        const key = SYNC_STATUS_LABELS[status];
        return key ? (window.__app?.t(key) || '') : '';
      },

      // Tooltip des Badges. Beim gesperrten Beitrag mit den Elementen, die
      // ihn sperren — sonst weiss niemand, was er in WordPress ändern müsste.
      statusTip(page) {
        const s = this.statusFor(page);
        if (s === 'locked') {
          const blocks = this.linksMap[page.id]?.locked_blocks || '';
          return window.__app?.t('sync.status.lockedTip', { blocks }) || '';
        }
        return this.statusLabel(s);
      },

      canPush(page) {
        const s = this.statusFor(page);
        return !!s && CAN_PUSH_STATUSES.includes(s);
      },

      async openConflict(pageId) {
        const bookId = Alpine.store('nav').selectedBookId;
        if (!bookId) return;
        this.conflictOpen = pageId;
        this.conflictData = null;
        try {
          const { contentRepo } = await import('../../repo/content.js');
          const [remoteRes, localPage] = await Promise.all([
            fetch(`${spec.endpointBase}/${bookId}/pages/${pageId}/remote`).then(r => r.ok ? r.json() : Promise.reject(r)),
            // fresh: der Diff ist die Entscheidungsgrundlage „lokal oder Remote".
            // Aus dem SWR-Cache könnte die lokale Seite ÄLTER aussehen als sie ist —
            // der User verwürfe dann eigene Edits, die er im Diff nie gesehen hat.
            contentRepo.loadPage(pageId, { fresh: true }),
          ]);
          if (!isSelectedBook(bookId) || this.conflictOpen !== pageId) return;
          this.conflictData = {
            pageId,
            local: { name: localPage.name || localPage.page_name || '', html: localPage.html || localPage.body_html || '' },
            remote: { title: remoteRes.title || '', html: remoteRes.html || '', modifiedAt: remoteRes.modifiedAt || '' },
          };
        } catch (e) {
          console.error(`[sync:${spec.key}] Konflikt-Diff laden fehlgeschlagen:`, e);
          this.conflictOpen = null;
        }
      },

      closeConflict() {
        this.conflictOpen = null;
        this.conflictData = null;
      },

      // side: 'app' (App-Stand behalten, nächster Push überschreibt) |
      //       'remote' (Remote-Stand in den Abschnitt übernehmen)
      async resolveConflict(side) {
        if (!this.conflictOpen) return;
        const bookId = Alpine.store('nav').selectedBookId;
        const pageId = this.conflictOpen;
        try {
          const res = await fetch(`${spec.endpointBase}/${bookId}/pages/${pageId}/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resolve: side }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error_code || `${spec.key.toUpperCase()}_RESOLVE_FAILED`);
          this.closeConflict();
          await this.loadLinks();
          // Der Server hat die Seite gerade überschrieben (kein Bust im Browser).
          // Hat der Remote-Titel den Seitennamen geändert, zieht _applyPushRenames
          // auch den offenen Editor-Titel nach (und lädt den Tree).
          if (side === 'remote') {
            if (data.name) this._applyPushRenames({ result: { renamed: [{ pageId, name: data.name }] } });
            else window.__app?.loadPages?.({ source: 'job' });
          }
        } catch (e) {
          console.error(`[sync:${spec.key}] Konflikt lösen fehlgeschlagen:`, e);
        }
      },

      viewUrl(page) {
        if (!page || typeof spec.viewUrl !== 'function') return '';
        return spec.viewUrl(page, this.providerMeta, this.linksMap[page.id] || null);
      },

      async push(pageId) {
        const bookId = Alpine.store('nav').selectedBookId;
        if (!bookId) return;
        if (this.pushBusy[pageId]) return;
        if (typeof spec.confirmPush === 'function') {
          const ok = await spec.confirmPush.call(this, pageId);
          if (!ok) return;
        }
        this.pushBusy = { ...this.pushBusy, [pageId]: true };
        this.pushProgress = { ...this.pushProgress, [pageId]: 0 };
        try {
          const res = await fetch(`/jobs/${pushType}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ book_id: bookId, page_ids: [pageId] }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error_code || spec.pushErrorCode || `${spec.key.toUpperCase()}_PUSH_FAILED`);
          if (data.jobId) {
            window.dispatchEvent(new CustomEvent(EVT.JOB_ENQUEUED, { detail: { type: pushType, jobId: data.jobId } }));
            this._pollPush(pageId, data.jobId);
          }
        } catch (e) {
          console.error(`[sync:${spec.key}] Push fehlgeschlagen:`, e);
          this._clearPushBusy(pageId);
        }
      },

      _pollPush(pageId, jobId) {
        stopPushPoller(this._pushTimers[pageId]);
        const holder = { timer: null };
        startPoll(holder, {
          timerProp: 'timer',
          jobId,
          intervalMs: 1000,
          onProgress: (job) => {
            this.pushProgress = { ...this.pushProgress, [pageId]: job.progress || 0 };
          },
          onDone: (job) => {
            this._clearPushBusy(pageId);
            this._applyPushRenames(job);
            this.loadLinks();
          },
          onError: () => this._clearPushBusy(pageId),
          onNotFound: () => this._clearPushBusy(pageId),
        });
        this._pushTimers = { ...this._pushTimers, [pageId]: holder };
      },

      // Push-Create kann den lokalen page_name prägen (z.B. WordPress-Datum-
      // Prefix, app-intern). Das Backend liefert `result.renamed: [{ pageId,
      // name }]`. `loadLinks()` deckt nur die Badges — Sidebar-Tree und offener
      // Editor-Titel zeigen sonst weiter den alten Namen. Tree via loadPages()
      // neu aufbauen; den offenen Editor-Titel (`currentPage.name`) direkt
      // nachziehen (loadPages refetcht nur den Page-Body, nicht den Namen).
      // No-op, wenn der Job nichts umbenannt hat (z.B. reiner Update-Push).
      _applyPushRenames(job) {
        const renamed = job?.result?.renamed;
        if (!Array.isArray(renamed) || !renamed.length) return false;
        const app = window.__app;
        if (!app) return false;
        for (const r of renamed) {
          if (app.currentPage && String(app.currentPage.id) === String(r.pageId)) {
            app.currentPage.name = r.name;
          }
        }
        app.loadPages?.({ source: 'job' });
        return true;
      },

      _clearPushBusy(pageId) {
        if (this._pushTimers[pageId]) {
          stopPushPoller(this._pushTimers[pageId]);
          const t = { ...this._pushTimers }; delete t[pageId]; this._pushTimers = t;
        }
        const b = { ...this.pushBusy }; delete b[pageId]; this.pushBusy = b;
        const p = { ...this.pushProgress }; delete p[pageId]; this.pushProgress = p;
      },
    };

    return base;
  };
}
