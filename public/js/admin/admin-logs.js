// AdminLogsCard-Methods. Wird im adminLogsCard-Alpine-Scope gespreaded.
// Root-Zugriffe via window.__app. Liest aus /admin/logs/{tail,search,files,
// stream,download}.
//
// Zwei Ansichten: ohne Filter der Tail samt Live-Stream, mit Filter das
// Suchergebnis (ohne Stream — der Server filtert nur die Suche). Massgeblich
// ist der ANGEWENDETE Filter (`adminLogsApplied`), nicht der Stand der Felder:
// Felder wenden sich nach kurzer Pause selbst an (`_adminLogsScheduleApply`).

import { fetchJson, downloadChecked } from '../utils.js';
import { tFetchError } from '../i18n.js';

// Zeilen je Seite der Liste. Gerendert wird immer nur eine Seite — die Liste
// selbst kann bis ADMIN_LOGS_MAX_ENTRIES Einträge halten.
export const ADMIN_LOGS_PAGE_SIZE = 100;
// Obergrenze der im Speicher gehaltenen Einträge (Live-Tail + nachgeladene).
const ADMIN_LOGS_MAX_ENTRIES = 2000;
// Live-Zeilen werden gesammelt und in diesem Takt eingespielt: lokal schreiben
// laufende Tests mehrere Zeilen pro Sekunde ins selbe Log, eine Mutation je
// SSE-Nachricht hielte den Renderer dauerbeschäftigt.
const ADMIN_LOGS_FLUSH_MS = 500;
// Pause nach der letzten Eingabe in einem Filterfeld, bis gesucht wird.
const ADMIN_LOGS_APPLY_DEBOUNCE_MS = 400;

const EMPTY_FILTER = Object.freeze({ level: '', scope: '', user: '', book: '', q: '' });
const filterKey = (f) => JSON.stringify([f.level || '', f.scope || '', f.user || '', f.book ?? '', f.q || '']);
const hasAny = (f) => !!(f.level || f.scope || f.user || f.book || f.q);

export const adminLogsMethods = {
  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async adminLogsEnter() {
    if (this.adminLogsInitialized) {
      // Wiederöffnen: _adminLogsLeave hat den Stream gestoppt. Seite 1 und
      // keine wartenden Live-Zeilen — die stammen aus der Zeit vor dem
      // Schliessen und stuenden nach dem Tail doppelt in der Liste.
      this.adminLogsPage = 0;
      this.adminLogsPending = [];
      this.adminLogsExpanded = {};
      // Beim Schliessen noch nicht angewendete Feldaenderung jetzt anwenden.
      if (filterKey(this.adminLogsFilter) !== filterKey(this.adminLogsApplied || EMPTY_FILTER)) {
        await this.adminLogsApplyFilter();
        return;
      }
      if (this.adminLogsFiltered()) return;
      // Ohne Filter die Lücke seit dem Schliessen über den Tail füllen, dann live weiter.
      await this._adminLogsLoadTail();
      this._adminLogsMaybeStartStream();
      return;
    }
    this.adminLogsInitialized = true;
    await this._adminLogsLoadTail();
    await this._adminLogsLoadFiles();
    this._adminLogsMaybeStartStream();
  },

  // Stream erst nach dem Laden starten — und nur, wenn die Karte dann noch
  // offen ist: wurde sie waehrend des Tail-Requests geschlossen, liefe der
  // Stream sonst unsichtbar weiter (_adminLogsLeave kam schon vorher).
  _adminLogsMaybeStartStream() {
    if (!this.adminLogsLiveTail || this.adminLogsFiltered()) return;
    if (!window.__app?.showAdminLogsCard) return;
    this._adminLogsStartStream();
  },

  _adminLogsLeave() {
    clearTimeout(this._adminLogsApplyTimer);
    this._adminLogsApplyTimer = null;
    this._adminLogsStopStream();
  },

  // Stabiler Zeilen-Key: neue Live-Zeilen landen vorne, ein Index-Key würde
  // bei jeder Zeile alle gerenderten Zeilen neu aufbauen.
  // Nebenbei: jeden gesehenen Scope fuer die Filter-Auswahl merken.
  _adminLogsTag(entries) {
    for (const e of entries) e._k = ++this._adminLogsSeq;
    this._adminLogsNoteScopes(entries);
    return entries;
  },

  // Scope-Auswahl = Vereinigung aller je geladenen/gestreamten Scopes. Aus der
  // aktuellen Liste abgeleitet, schrumpfte sie mit dem Filter auf den einen
  // gefilterten Scope und liesse keinen Wechsel mehr zu.
  _adminLogsNoteScopes(entries) {
    if (!Array.isArray(this.adminLogsScopes)) return;
    let added = null;
    for (const e of entries) {
      if (!e.scope || this.adminLogsScopes.includes(e.scope) || added?.includes(e.scope)) continue;
      (added ||= []).push(e.scope);
    }
    if (added) this.adminLogsScopes = [...this.adminLogsScopes, ...added].sort();
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
    this.adminLogsFilter = { ...EMPTY_FILTER };
  },

  /** Felder tragen einen Filter (ob schon angewendet oder nicht). */
  adminLogsHasFilter() {
    return hasAny(this.adminLogsFilter);
  },

  /** Die Liste zeigt ein Suchergebnis (kein Tail, kein Live-Stream). */
  adminLogsFiltered() {
    return hasAny(this.adminLogsApplied || EMPTY_FILTER);
  },

  /** Live-Tail laeuft tatsaechlich (eingeschaltet und ungefiltert). */
  adminLogsLiveOn() {
    return !!this.adminLogsLiveTail && !this.adminLogsFiltered();
  },

  // Vom Watcher auf `adminLogsFilter` (admin-logs-card.js): nach einer kurzen
  // Pause anwenden; ein unveraenderter Stand (Reset durch clearAndLive) loest
  // nichts aus.
  _adminLogsScheduleApply() {
    clearTimeout(this._adminLogsApplyTimer);
    this._adminLogsApplyTimer = setTimeout(() => {
      this._adminLogsApplyTimer = null;
      if (filterKey(this.adminLogsFilter) === filterKey(this.adminLogsApplied || EMPTY_FILTER)) return;
      this.adminLogsApplyFilter();
    }, ADMIN_LOGS_APPLY_DEBOUNCE_MS);
  },

  // Leerer Filter = zurueck zu Tail + Live (statt einer ungefilterten Suche
  // ohne Stream).
  async adminLogsApplyFilter() {
    clearTimeout(this._adminLogsApplyTimer);
    this._adminLogsApplyTimer = null;
    if (!this.adminLogsHasFilter()) return this.adminLogsClearAndLive();
    this._adminLogsStopStream();
    this._adminLogsResetList();
    this.adminLogsApplied = { ...this.adminLogsFilter };
    await this._adminLogsSearch({ append: false });
  },

  async adminLogsClearAndLive() {
    clearTimeout(this._adminLogsApplyTimer);
    this._adminLogsApplyTimer = null;
    this._adminLogsStopStream();
    this.adminLogsResetFilters();
    this.adminLogsApplied = { ...EMPTY_FILTER };
    this._adminLogsResetList();
    this.adminLogsRotatedHint = false;
    this.adminLogsStreamError = false;
    await this._adminLogsLoadTail();
    this._adminLogsMaybeStartStream();
  },

  // ── Tail / Search ──────────────────────────────────────────────────────────
  // Jeder Listen-Request zieht eine Nummer; eine Antwort, die ein spaeterer
  // Request (anderer Filter, Zuruecksetzen) ueberholt hat, wird verworfen.
  async _adminLogsLoadTail() {
    const seq = ++this._adminLogsReqSeq;
    this.adminLogsLoading = true;
    this.adminLogsError = '';
    try {
      const data = await fetchJson('/admin/logs/tail?lines=500');
      if (seq !== this._adminLogsReqSeq) return;
      if (data.tz) this.adminLogsServerTz = data.tz;
      // Server liefert chronologisch (alt → neu). UI zeigt neueste oben.
      const entries = this._adminLogsTag((data.entries || []).reverse());
      this.adminLogsEntries = entries;
      const oldest = entries[entries.length - 1];
      this.adminLogsOldestTs = oldest?.ts || null;
      this.adminLogsHasMore = entries.length >= 500;
    } catch (e) {
      if (seq === this._adminLogsReqSeq) this.adminLogsError = tFetchError(e);
    } finally {
      if (seq === this._adminLogsReqSeq) this.adminLogsLoading = false;
    }
  },

  async _adminLogsSearch({ append }) {
    const seq = ++this._adminLogsReqSeq;
    this.adminLogsLoading = true;
    this.adminLogsError = '';
    try {
      const qs = new URLSearchParams();
      const f = this.adminLogsApplied || EMPTY_FILTER;
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
      if (seq !== this._adminLogsReqSeq) return;
      // Server liefert neueste zuerst (matched.push war reverse-iter).
      const next = this._adminLogsTag(data.entries || []);
      this.adminLogsEntries = append ? this.adminLogsEntries.concat(next) : next;
      const oldest = next[next.length - 1];
      if (oldest) this.adminLogsOldestTs = oldest.ts;
      this.adminLogsHasMore = !!data.hasMore;
    } catch (e) {
      if (seq === this._adminLogsReqSeq) this.adminLogsError = tFetchError(e);
    } finally {
      if (seq === this._adminLogsReqSeq) this.adminLogsLoading = false;
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

  // Per fetch statt Navigation: eine Fehlerantwort (rotierte Datei weg) steht
  // dann in der Karte, statt die App durch eine JSON-Seite zu ersetzen.
  async adminLogsDownload(file) {
    const key = file?.key || 'current';
    if (this.adminLogsDownloading) return;
    this.adminLogsDownloading = key;
    this.adminLogsError = '';
    try {
      await downloadChecked(`/admin/logs/download?file=${encodeURIComponent(key)}`, file?.path || 'schreibwerkstatt.log');
    } catch (e) {
      this.adminLogsError = tFetchError(e);
      this._adminLogsLoadFiles();
    } finally {
      this.adminLogsDownloading = null;
    }
  },

  // ── SSE-Stream ─────────────────────────────────────────────────────────────
  _adminLogsStartStream() {
    if (this.adminLogsEventSource) return;
    if (this.adminLogsFiltered()) return; // Live-Tail nur ohne Filter
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

  // Mit Filter gesperrt (Knopf disabled): der Stream liefert ungefiltert.
  adminLogsToggleLiveTail() {
    if (this.adminLogsFiltered()) return;
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
    // ts ist "YYYY-MM-DD HH:MM:SS" in Server-Ortszeit (winston-Formatter).
    // Wir zeigen es 1:1 — die Server-Zeitzone nennt der Hinweis unter der
    // Filterleiste (`adminLogsServerTz` aus /admin/logs/tail).
    return ts;
  },

  // Alle je gesehenen Scopes, der gerade gewaehlte immer dabei.
  adminLogsScopeOptions() {
    const all = new Set(this.adminLogsScopes || []);
    if (this.adminLogsFilter?.scope) all.add(this.adminLogsFilter.scope);
    return [...all].sort().map(s => ({ value: s, label: s }));
  },
};

export const ADMIN_LOGS_LEVELS = [
  { value: 'info',  label: 'INFO' },
  { value: 'warn',  label: 'WARN' },
  { value: 'error', label: 'ERROR' },
  { value: 'debug', label: 'DEBUG' },
];
