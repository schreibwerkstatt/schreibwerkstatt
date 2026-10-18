// AdminLogsCard-Methods. Wird im adminLogsCard-Alpine-Scope gespreaded.
// Root-Zugriffe via window.__app. Liest aus /admin/logs/{tail,search,files,
// stream,download}.

import { fetchJson } from '../utils.js';
import { tFetchErrorRaw } from '../i18n.js';

// Zeilen je Seite der Liste. Gerendert wird immer nur eine Seite — die Liste
// selbst kann bis ADMIN_LOGS_MAX_ENTRIES Einträge halten.
export const ADMIN_LOGS_PAGE_SIZE = 100;
// Obergrenze der im Speicher gehaltenen Einträge (Live-Tail + nachgeladene).
const ADMIN_LOGS_MAX_ENTRIES = 2000;
// Live-Zeilen werden gesammelt und in diesem Takt eingespielt: lokal schreiben
// laufende Tests mehrere Zeilen pro Sekunde ins selbe Log, eine Mutation je
// SSE-Nachricht hielte den Renderer dauerbeschäftigt.
const ADMIN_LOGS_FLUSH_MS = 500;

export const adminLogsMethods = {
  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async adminLogsEnter() {
    if (this.adminLogsInitialized) return;
    this.adminLogsInitialized = true;
    await this._adminLogsLoadTail();
    await this._adminLogsLoadFiles();
    if (this.adminLogsLiveTail) this._adminLogsStartStream();
  },

  _adminLogsLeave() {
    this._adminLogsStopStream();
  },

  // Stabiler Zeilen-Key: neue Live-Zeilen landen vorne, ein Index-Key würde
  // bei jeder Zeile alle gerenderten Zeilen neu aufbauen.
  _adminLogsTag(entries) {
    for (const e of entries) e._k = ++this._adminLogsSeq;
    return entries;
  },

  // Kürzt die Liste auf ADMIN_LOGS_MAX_ENTRIES; der Nachlade-Cursor rückt auf
  // den ältesten verbliebenen Eintrag, damit «Weiter» die Lücke wieder füllt.
  _adminLogsCap() {
    if (this.adminLogsEntries.length <= ADMIN_LOGS_MAX_ENTRIES) return;
    this.adminLogsEntries.length = ADMIN_LOGS_MAX_ENTRIES;
    this.adminLogsOldestTs = this.adminLogsEntries[ADMIN_LOGS_MAX_ENTRIES - 1].ts;
    this.adminLogsHasMore = true;
  },

  _adminLogsResetList() {
    this.adminLogsEntries = [];
    this.adminLogsPending = [];
    this.adminLogsPage = 0;
    this.adminLogsExpanded = {};
    this.adminLogsOldestTs = null;
    this.adminLogsHasMore = true;
  },

  // ── Filter ─────────────────────────────────────────────────────────────────
  adminLogsResetFilters() {
    this.adminLogsFilter = { level: '', scope: '', user: '', book: '', q: '' };
  },

  adminLogsHasFilter() {
    const f = this.adminLogsFilter;
    return !!(f.level || f.scope || f.user || f.book || f.q);
  },

  async adminLogsApplyFilter() {
    this._adminLogsStopStream();
    this._adminLogsResetList();
    await this._adminLogsSearch({ append: false });
  },

  async adminLogsClearAndLive() {
    this.adminLogsResetFilters();
    this._adminLogsResetList();
    await this._adminLogsLoadTail();
    if (this.adminLogsLiveTail) this._adminLogsStartStream();
  },

  // ── Tail / Search ──────────────────────────────────────────────────────────
  async _adminLogsLoadTail() {
    this.adminLogsLoading = true;
    this.adminLogsError = '';
    try {
      const data = await fetchJson('/admin/logs/tail?lines=500');
      // Server liefert chronologisch (alt → neu). UI zeigt neueste oben.
      const entries = this._adminLogsTag((data.entries || []).reverse());
      this.adminLogsEntries = entries;
      const oldest = entries[entries.length - 1];
      this.adminLogsOldestTs = oldest?.ts || null;
      this.adminLogsHasMore = entries.length >= 500;
    } catch (e) {
      this.adminLogsError = tFetchErrorRaw(e);
    } finally {
      this.adminLogsLoading = false;
    }
  },

  async _adminLogsSearch({ append }) {
    this.adminLogsLoading = true;
    this.adminLogsError = '';
    try {
      const qs = new URLSearchParams();
      const f = this.adminLogsFilter;
      if (f.level) qs.set('level', f.level);
      if (f.scope) qs.set('scope', f.scope);
      if (f.user)  qs.set('user',  f.user);
      if (f.book)  qs.set('book',  f.book);
      if (f.q)     qs.set('q',     f.q);
      qs.set('limit', '200');
      if (append && this.adminLogsOldestTs) {
        const ts = this.adminLogsOldestTs;
        qs.set('before', ts);
        qs.set('skip', String(this.adminLogsEntries.filter(e => e.ts === ts).length));
      }
      const data = await fetchJson('/admin/logs/search?' + qs.toString());
      // Server liefert neueste zuerst (matched.push war reverse-iter).
      const next = this._adminLogsTag(data.entries || []);
      this.adminLogsEntries = append ? this.adminLogsEntries.concat(next) : next;
      const oldest = next[next.length - 1];
      if (oldest) this.adminLogsOldestTs = oldest.ts;
      this.adminLogsHasMore = !!data.hasMore;
    } catch (e) {
      this.adminLogsError = tFetchErrorRaw(e);
    } finally {
      this.adminLogsLoading = false;
    }
  },

  // Ohne Filter laedt search ohne Filter die aelteren Zeilen rueckwaerts nach.
  async adminLogsLoadMore() {
    if (!this.adminLogsHasMore || this.adminLogsLoading) return;
    await this._adminLogsSearch({ append: true });
  },

  // ── Pagination ─────────────────────────────────────────────────────────────
  adminLogsPageEntries() {
    const start = this.adminLogsPage * ADMIN_LOGS_PAGE_SIZE;
    return this.adminLogsEntries.slice(start, start + ADMIN_LOGS_PAGE_SIZE);
  },

  adminLogsPageCount() {
    return Math.max(1, Math.ceil(this.adminLogsEntries.length / ADMIN_LOGS_PAGE_SIZE));
  },

  adminLogsCanNext() {
    return this.adminLogsPage + 1 < this.adminLogsPageCount() || this.adminLogsHasMore;
  },

  adminLogsPrevPage() {
    if (this.adminLogsPage === 0) return;
    this.adminLogsPage--;
    if (this.adminLogsPage === 0) this._adminLogsFlushPending();
  },

  // Auf der letzten geladenen Seite holt «Weiter» die naechsten Eintraege vom
  // Server und blaettert erst, wenn welche gekommen sind.
  async adminLogsNextPage() {
    if (this.adminLogsLoading) return;
    if (this.adminLogsPage + 1 >= this.adminLogsPageCount()) {
      if (!this.adminLogsHasMore) return;
      await this.adminLogsLoadMore();
      if (this.adminLogsPage + 1 >= this.adminLogsPageCount()) return;
    }
    this.adminLogsPage++;
  },

  adminLogsFirstPage() {
    this.adminLogsPage = 0;
    this._adminLogsFlushPending();
  },

  // ── Files ──────────────────────────────────────────────────────────────────
  async _adminLogsLoadFiles() {
    try {
      const data = await fetchJson('/admin/logs/files');
      this.adminLogsFiles = data.files || [];
    } catch { /* noop */ }
  },

  adminLogsDownload(file) {
    const key = encodeURIComponent(file?.key || 'current');
    window.location.href = `/admin/logs/download?file=${key}`;
  },

  // ── SSE-Stream ─────────────────────────────────────────────────────────────
  _adminLogsStartStream() {
    if (this.adminLogsEventSource) return;
    if (this.adminLogsHasFilter()) return; // Live-Tail nur ohne Filter
    try {
      const es = new EventSource('/admin/logs/stream', { withCredentials: true });
      this.adminLogsEventSource = es;
      es.onmessage = (ev) => {
        try {
          this._adminLogsIncoming.push(JSON.parse(ev.data));
        } catch { return; }
        if (!this._adminLogsFlushTimer) {
          this._adminLogsFlushTimer = setTimeout(() => this._adminLogsFlushIncoming(), ADMIN_LOGS_FLUSH_MS);
        }
      };
      es.addEventListener('rotated', () => { this.adminLogsRotatedHint = true; });
      es.onerror = () => {
        // Nach Disconnect haengt SSE haeufig — Browser reconnected automatisch.
        // Nur error-Flag setzen, kein close.
        this.adminLogsStreamError = true;
      };
    } catch (e) {
      this.adminLogsStreamError = true;
    }
  },

  _adminLogsStopStream() {
    try { this.adminLogsEventSource?.close?.(); } catch {}
    this.adminLogsEventSource = null;
    clearTimeout(this._adminLogsFlushTimer);
    this._adminLogsFlushTimer = null;
    this._adminLogsIncoming = [];
  },

  // Auf Seite 1 kommen neue Zeilen direkt oben dazu; beim Blaettern warten sie
  // als «N neue Eintraege», sonst rutscht die gelesene Seite unter dem Leser weg.
  _adminLogsFlushIncoming() {
    this._adminLogsFlushTimer = null;
    const batch = this._adminLogsIncoming;
    this._adminLogsIncoming = [];
    if (!batch.length) return;
    // SSE liefert chronologisch, die Liste zeigt neueste oben.
    const fresh = this._adminLogsTag(batch.slice(-ADMIN_LOGS_MAX_ENTRIES).reverse());
    this.adminLogsPending = fresh.concat(this.adminLogsPending).slice(0, ADMIN_LOGS_MAX_ENTRIES);
    if (this.adminLogsPage === 0) this._adminLogsFlushPending();
  },

  _adminLogsFlushPending() {
    if (!this.adminLogsPending.length) return;
    this.adminLogsEntries = this.adminLogsPending.concat(this.adminLogsEntries);
    this.adminLogsPending = [];
    this._adminLogsCap();
  },

  adminLogsToggleLiveTail() {
    this.adminLogsLiveTail = !this.adminLogsLiveTail;
    if (this.adminLogsLiveTail) {
      this.adminLogsRotatedHint = false;
      this.adminLogsStreamError = false;
      this._adminLogsStartStream();
    } else {
      this._adminLogsStopStream();
    }
  },

  // ── Row-State ──────────────────────────────────────────────────────────────
  adminLogsToggleStack(entry) {
    const k = String(entry._k);
    if (this.adminLogsExpanded[k]) delete this.adminLogsExpanded[k];
    else this.adminLogsExpanded[k] = true;
  },

  adminLogsFmtTs(ts) {
    if (!ts) return '';
    // ts ist "YYYY-MM-DD HH:MM:SS" lokale-Server-Zeit aus winston-Formatter.
    // Wir zeigen es 1:1 — Timezone-Anzeige im Header-Hinweis.
    return ts;
  },

  // Liefert eindeutige Liste vorhandener Scopes aus den geladenen Entries.
  adminLogsScopeOptions() {
    const set = new Set();
    for (const e of this.adminLogsEntries) {
      if (e.scope) set.add(e.scope);
    }
    return [...set].sort().map(s => ({ value: s, label: s }));
  },
};

export const ADMIN_LOGS_LEVELS = [
  { value: 'info',  label: 'INFO' },
  { value: 'warn',  label: 'WARN' },
  { value: 'error', label: 'ERROR' },
  { value: 'debug', label: 'DEBUG' },
];
