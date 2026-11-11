// Alpine.data('pageRevisionsCard') — App-eigene Revisionsliste pro Seite.
// Lebt unter dem Editor parallel zur
// Lektorat-Verlaufsleiste (pageHistoryCard). Read aus
// GET /content/pages/:id/revisions, Voll-Body aus .../:rev_id, Restore via
// POST .../restore, Anheften via PATCH .../:rev_id. Viewer (natives <dialog>)
// in ./page-revisions/viewer.js.
//
// Liste: angeheftete Revisionen oben (unabhaengig vom Fenster), darunter die
// Geschichte, Autosave-Serien zu Sitzungen gebuendelt (page-revisions-groups.js)
// und nach Quelle/Person filterbar. Filter und Gruppen wirken nur auf die
// Anzeige — Vorgaengerin, Zeichen-Delta und ‹/› im Viewer rechnen immer gegen
// die vollstaendige Liste, sonst waere «Stand davor» eines gefilterten Eintrags
// der Stand eines anderen Users. Darum bilden sich auch die Sitzungen auf der
// vollstaendigen Liste und der Filter blendet danach ganze Sitzungen aus: so
// ist das Sitzungs-Delta auch gefiltert nur die eigene Sitzung. Das Tages-Delta
// ist die Summe der angezeigten Sitzungen (ohne Filter = der ganze Tag).

import { fetchJson, numberFormat, dateTimeFormat, localIsoDate, localDayDiff } from '../utils.js';
import { contentRepo } from '../repo/content.js';
import { EVT } from '../events.js';
import { memoMethods } from './card-memo.js';
import { groupRevisions, groupByDay, filterGroups, revisionDeltas, summaryInfo } from '../page-revisions-groups.js';
import { viewerState, viewerMethods, revisionErrorText } from './page-revisions/viewer.js';

export function registerPageRevisionsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('pageRevisionsCard', () => ({
    revisions: [],
    // Angeheftete Revisionen der Seite (Server liefert sie mit der ersten Seite).
    pinnedRevs: [],
    // Vorgaengerin der aeltesten geladenen Revision (Server: `older`) — damit
    // Delta, Vergleich und «Stand davor» auch am Fensterrand stimmen.
    older: null,
    // `total` = Gesamtzahl auf dem Server, `revisions` nur das geladene Fenster.
    // Beides auseinanderzuhalten ist der Kern dieser Karte: das `raw`-Bucket der
    // Retention haelt jeden Autosave der letzten 24 h, ein Schreibtag fuellt das
    // erste Fenster also allein — die getierte Historie dahinter kommt erst per
    // `loadMore()`.
    total: 0,
    hasMore: false,
    loadingMore: false,
    // Liste aufgeklappt. Nicht `open`: das Feld koppelt per x-model an
    // `collapsible`, und auf dessen Element loest `open` auf die eigene Variable
    // des Collapsible auf — die Bindung liefe ins Leere.
    listOpen: false,
    loading: false,
    restoringId: null,
    // Rueckfrage zum Wiederherstellen offen: ein zweites Cmd+Enter oder ein
    // zweiter Klick oeffnet keine zweite.
    _restorePending: false,
    pinningId: null,
    filterSource: '',
    filterUser: '',
    // Aufgeklappte Sitzungen, key = id der Kopfzeile. Wird bei jedem Toggle neu
    // zugewiesen (Memo-Deps vergleichen per Referenz).
    expanded: {},
    _pageId: null,
    // Re-Entry-Guard: Antworten eines frueheren Seitenwechsels verwerfen.
    _loadSeq: 0,
    _memos: {},
    // Window-Listener der Karte, abgebaut in destroy().
    _abortCtrl: null,

    ...viewerState(),

    init() {
      const app = window.__app;
      const cur = app?.currentPage?.id || null;
      if (cur) this.loadRevisions(cur);

      this.$watch(() => window.__app?.currentPage?.id, (pid) => {
        if (!pid) { this.reset(); return; }
        this.loadRevisions(pid);
      });

      this._abortCtrl = new AbortController();
      window.addEventListener(EVT.PAGE_REVISIONS_CHANGED, (e) => {
        const pid = e?.detail?.pageId;
        if (!pid || pid !== this._pageId) return;
        // Ein Save hat den gespeicherten Stand geaendert: der Vergleich
        // «aktuell» im offenen Viewer muss ihn neu holen.
        this._currentBody = null;
        // `keepDepth`: ein Autosave darf ein nachgeladenes Fenster nicht wieder
        // auf die juengsten 100 zusammenfallen lassen — der Autosave feuert im
        // Minutentakt, das Blaettern waere sonst nicht haltbar.
        this.loadRevisions(pid, { keepDepth: true });
      }, { signal: this._abortCtrl.signal });
    },

    destroy() {
      this._abortCtrl?.abort();
      this._abortCtrl = null;
    },

    reset() {
      this._loadSeq++;
      this._resetPageScope();
      this.revisions = [];
      this.pinnedRevs = [];
      this.older = null;
      this.total = 0;
      this.hasMore = false;
      this.loadingMore = false;
      this.listOpen = false;
      this.loading = false;
      this.restoringId = null;
      this.pinningId = null;
      this._pageId = null;
      this._memos = {};
    },

    // Was zur angezeigten Seite gehoert und beim Seitenwechsel faellt:
    // Filter, Aufklappzustand, offener Viewer, Body-Cache.
    _resetPageScope() {
      this.filterSource = '';
      this.filterUser = '';
      this.expanded = {};
      this.closeViewer();
      this._resetBodyCache();
    },

    // `keepDepth` haelt die bereits nachgeladene Tiefe: statt des Default-Fensters
    // wird so viel angefordert, wie geladen war, plus eins — der neue Save
    // schiebt das Fenster um eine Zeile, ohne Zuschlag fiele die aelteste
    // geladene heraus. Steht der Viewer auf einer Revision am Fensterrand,
    // reicht die Tiefe mindestens bis zu ihrer Vorgaengerin, sonst verloere
    // ‹/› den Halt. Server-Deckel ist 500 — bei mehr Tiefe faellt die Liste
    // bewusst auf 500 zurueck (der Rest ist einen Klick entfernt) statt eine
    // unbegrenzte Antwort zu verlangen.
    //
    // Kein `__fresh=1`: die Frische dieses Pfades garantiert der Service Worker
    // (CONTENT_VOLATILE_REGEX in public/sw.js liefert die Revisionsliste
    // Netz-zuerst). `__fresh` wuerde den SW-Cache umgehen, ihn aber auch nicht
    // fuellen — die Liste waere dann offline gar nicht lesbar.
    async loadRevisions(pageId, { keepDepth = false } = {}) {
      if (!pageId) return;
      const samePage = pageId === this._pageId;
      let depth = 0;
      if (keepDepth && samePage) {
        const n = this.revisions.length;
        const viewIdx = this.viewerRev ? this.revisions.findIndex(r => r.id === this.viewerRev.id) : -1;
        depth = Math.min(500, Math.max(n > 100 ? n + 1 : 0, viewIdx >= 0 ? viewIdx + 2 : 0));
      }
      if (!samePage) this._resetPageScope();
      this._pageId = pageId;
      const seq = ++this._loadSeq;
      this.loading = true;
      try {
        const qs = [];
        if (depth > 100) qs.push(`limit=${depth}`);
        const url = `/content/pages/${pageId}/revisions${qs.length ? '?' + qs.join('&') : ''}`;
        const data = await fetchJson(url);
        if (seq !== this._loadSeq) return;
        this.revisions = Array.isArray(data?.revisions) ? data.revisions : [];
        this.pinnedRevs = Array.isArray(data?.pinned) ? data.pinned : [];
        this.older = data?.older || null;
        this.hasMore = !!data?.has_more;
        this.total = Number.isFinite(data?.total) ? data.total : this.revisions.length;
        this._syncViewerRev();
      } catch (e) {
        if (seq !== this._loadSeq) return;
        console.error('[pageRevisions:load]', e);
        // Neuladen derselben Seite (Autosave, Restore, fremder Save) gescheitert:
        // den bisherigen Stand stehen lassen — sonst verschwaende die ganze
        // Leiste samt nachgeladener Tiefe wegen eines einzelnen Fehlers.
        if (samePage && (this.revisions.length || this.pinnedRevs.length)) {
          window.__app?.setStatus?.(window.__app.t('editor.revisions.reloadFailed'), true, 5000);
          return;
        }
        this.revisions = [];
        this.pinnedRevs = [];
        this.older = null;
        this.hasMore = false;
        this.total = 0;
      } finally {
        if (seq === this._loadSeq) this.loading = false;
      }
    },

    // Naechstes Fenster anhaengen. Cursor ist die aelteste bereits geladene
    // Revision (Keyset), nicht ein Offset — waehrend der User liest, schreibt
    // der Autosave vorne weiter.
    async loadMore() {
      const pageId = this._pageId;
      if (!pageId || this.loadingMore || !this.hasMore) return;
      const last = this.revisions[this.revisions.length - 1];
      if (!last?.created_at || !last?.id) return;
      const seq = this._loadSeq;
      this.loadingMore = true;
      try {
        const url = `/content/pages/${pageId}/revisions`
          + `?before=${encodeURIComponent(last.created_at)}&before_id=${last.id}`;
        const data = await fetchJson(url);
        if (seq !== this._loadSeq) return;
        const more = Array.isArray(data?.revisions) ? data.revisions : [];
        // Dedup gegen bereits geladene IDs: ein Restore waehrend des Blaetterns
        // laedt die Liste neu, die Antwort hier kann dann ueberlappen.
        const seen = new Set(this.revisions.map(r => r.id));
        this.revisions = this.revisions.concat(more.filter(r => !seen.has(r.id)));
        this.older = data?.older || null;
        this.hasMore = !!data?.has_more;
        if (Number.isFinite(data?.total)) this.total = data.total;
      } catch (e) {
        console.error('[pageRevisions:loadMore]', e);
        window.__app?.setStatus?.(window.__app.t('editor.revisions.loadMoreFailed'), true, 5000);
      } finally {
        this.loadingMore = false;
      }
    },

    // Offene Viewer-Revision auf das frisch geladene Objekt umhaengen, damit
    // Anheften/Name im Kopf sofort den Serverstand zeigen.
    _syncViewerRev() {
      if (!this.viewerRev?.id) return;
      const id = this.viewerRev.id;
      const fresh = this.revisions.find(r => r.id === id) || this.pinnedRevs.find(r => r.id === id);
      if (!fresh) return;
      if ((fresh.label || '') !== (this.viewerRev.label || '')) this.viewerLabelDraft = fresh.label || '';
      this.viewerRev = fresh;
    },

    // ── Anzeige: Filter, Sitzungen, Zeilen ─────────────────────────────────
    _matchesFilter(r) {
      return (!this.filterSource || r.source === this.filterSource)
        && (!this.filterUser || (r.user_email || '') === this.filterUser);
    },
    _visibleRevisions() {
      return this._memo('visible', [this.revisions, this.filterSource, this.filterUser], () =>
        this.revisions.filter(r => this._matchesFilter(r)));
    },
    _uiLocale() { return Alpine.store('shell').uiLocale; },

    // Delta-Rechner gegen die vollstaendige Liste (page-revisions-groups.js).
    _deltas() {
      return this._memo('deltas', [this.revisions, this.older, this.hasMore], () =>
        revisionDeltas(this.revisions, { older: this.older, hasMore: this.hasMore }));
    },

    isFiltered() { return !!(this.filterSource || this.filterUser); },

    // Tage fuer das Template, je Tag flache Zeilen: Kopfzeile jeder Sitzung,
    // bei aufgeklappter Sitzung die weiteren Saves dahinter. `size` > 1 nur an
    // der Kopfzeile, `oldest` = aeltester Save der Sitzung (Zeitspanne).
    // `delta`: zugeklappte Sitzung = ganze Sitzung, sonst der einzelne Save;
    // am Tag die Summe seiner angezeigten Sitzungen. `summary`/`split` je
    // Zeile einmal gerechnet, nicht je Template-Bindung.
    listDays() {
      return this._memo('days', [this.revisions, this.pinnedRevs, this.older, this.hasMore, this.filterSource, this.filterUser, this.expanded, this._uiLocale()], () => {
        const d = this._deltas();
        const groups = filterGroups(groupRevisions(this.revisions), r => this._matchesFilter(r));
        return groupByDay(groups, iso => (iso ? localIsoDate(new Date(iso)) : '')).map(day => {
          const rows = [];
          for (const g of day.groups) {
            const open = !!this.expanded[g.key];
            const head = g.items[0];
            const oldest = g.items[g.items.length - 1];
            const span = g.items.length > 1 && !open;
            rows.push(this._row('r', head, { oldest, size: g.items.length, group: g.key, open,
              delta: span ? d.span(head, oldest) : d.span(head, head) }));
            if (open) {
              for (const rev of g.items.slice(1)) {
                rows.push(this._row('r', rev, { group: g.key, open, child: true, delta: d.span(rev, rev) }));
              }
            }
          }
          return { key: day.key, newest: day.groups[0].items[0], delta: d.sum(day.groups), rows };
        });
      });
    },

    pinnedRows() {
      return this._memo('pinnedRows', [this.pinnedRevs, this.revisions, this.older, this.hasMore, this._uiLocale()], () => {
        const d = this._deltas();
        return this.pinnedRevs.map(rev => this._row('p', rev, { delta: d.span(rev, rev) }));
      });
    },

    _row(prefix, rev, { oldest = rev, size = 0, group = null, open = false, child = false, delta = null } = {}) {
      return { k: prefix + rev.id, rev, oldest, size, group, open, child, delta,
        summary: this.summaryLabel(rev), split: this.splitLink(rev) };
    },

    toggleGroup(key) {
      this.expanded = { ...this.expanded, [key]: !this.expanded[key] };
    },

    // Filter-Optionen nur aus dem, was in der geladenen Liste vorkommt — ein
    // Durchlauf je geladener Liste fuer beide Comboboxen und die Schalter.
    // Geraet nur zeigen, wenn die Liste mehr als eines kennt — sonst steht auf
    // jeder Zeile dieselbe Angabe.
    filterOptions() {
      return this._memo('filterOpts', [this.revisions, this._uiLocale()], () => {
        const sources = new Set(this.revisions.map(r => r.source));
        const users = new Set(this.revisions.map(r => r.user_email || ''));
        const clients = new Set(this.revisions.map(r => r.client).filter(Boolean));
        return {
          sources: [...sources].map(s => ({ value: s, label: this.sourceLabel(s) })),
          users: [...users].filter(Boolean).map(e => ({ value: e, label: this.userLabel(e) })),
          hasSource: sources.size > 1,
          hasUser: users.size > 1,
          hasClient: clients.size > 1,
        };
      });
    },
    hasSourceChoice() { return this.filterOptions().hasSource; },
    hasUserChoice() { return this.filterOptions().hasUser; },
    hasClientChoice() { return this.filterOptions().hasClient; },

    // Personen-Name in der Filter-Combobox; im Chip setzt ihn x-user-chip.
    userLabel(email) {
      const app = window.__app;
      if (!email) return app.t('editor.revisions.filter.noUser');
      const me = Alpine.store('session').currentUser?.email;
      return me && String(me).toLowerCase() === String(email).toLowerCase()
        ? app.t('userChip.self') : app.userDisplayName(email);
    },

    sourceLabel(src) {
      const app = window.__app;
      const key = `editor.revisions.source.${src}`;
      const out = app?.t?.(key);
      return out && out !== key ? out : src;
    },

    // «Abschnitt teilen» schreibt Kopf und Schwanz mit Quelle 'split' und dem
    // Verweis auf die andere Haelfte ins Summary (lib/content-store#splitPage):
    // `split → #<id>` (hintere Haelfte ging dorthin) bzw. `split from #<id>`.
    // Name/Sprung/geloeschte Seite erledigt x-entity-ref.
    splitLink(rev) {
      if (rev?.source !== 'split') return null;
      const m = /^split (→|from) #(\d+)$/.exec(String(rev.summary || ''));
      return m ? { dir: m[1] === '→' ? 'to' : 'from', pageId: Number(m[2]) } : null;
    },

    // Ausgangsstand, «vor dem Teilen», «aus der Version vom …».
    // Eine Revision heisst nach ihrem Datum, nicht nach einer Nummer: eine
    // Positionsnummer verschoebe sich mit jedem neuen Save und jeder
    // Ausduennung der Retention, «aus Version 37» zeigte morgen auf eine andere.
    summaryLabel(rev) {
      const info = summaryInfo(rev?.summary);
      if (!info) return '';
      const t = window.__app.t;
      if (info.kind === 'restore') {
        const src = this.revisions.find(r => r.id === info.revId) || this.pinnedRevs.find(r => r.id === info.revId);
        return src?.created_at
          ? t('editor.revisions.summary.restoreFrom', { when: window.__app.formatDate(src.created_at) })
          : t('editor.revisions.summary.restoreFromOld');
      }
      return t(`editor.revisions.summary.${info.kind}`);
    },

    // Viewer-Titel: Name der angehefteten Revision, sonst ihr Datum.
    revisionTitle(rev) {
      if (rev?.pinned && rev.label) return rev.label;
      return rev?.created_at ? window.__app.formatDate(rev.created_at) : '';
    },

    formatChars(n) {
      return numberFormat(Alpine.store('shell').uiLocale).format(Number(n || 0));
    },

    // Vorgaengerin = naechstaeltere Revision der vollstaendigen Liste; an der
    // aeltesten geladenen Zeile die vom Server mitgelieferte `older`.
    _prevRevFor(rev) {
      if (!rev?.id) return null;
      const idx = this.revisions.findIndex(r => r.id === rev.id);
      if (idx < 0) return null;
      if (idx + 1 < this.revisions.length) return this.revisions[idx + 1];
      return this.hasMore ? this.older : null;
    },
    hasPrevRevFor(rev) { return !!this._prevRevFor(rev); },

    // Zeichen-Delta der Zeile/des Tages steht als `row.delta`/`day.delta`,
    // gerechnet in listDays/pinnedRows. Die allererste Revision rechnet gegen
    // den leeren Stand, eine noch nicht nachgeladene Vorgaengerin ergibt kein
    // Delta (revisionDeltas).
    rowDeltaTip(row) {
      return window.__app.t(row.size > 1 && !row.open ? 'editor.revisions.deltaSessionTitle' : 'editor.revisions.deltaTitle');
    },
    dayDeltaTip() {
      return window.__app.t(this.isFiltered() ? 'editor.revisions.deltaDayFilteredTitle' : 'editor.revisions.deltaDayTitle');
    },
    deltaClass(d) {
      return d > 0 ? 'revision-delta--pos' : (d < 0 ? 'revision-delta--neg' : 'revision-delta--zero');
    },

    // Uhrzeit der Zeile; zugeklappte Sitzung als Spanne «10:42–10:53».
    formatTime(iso) {
      if (!iso) return '';
      return dateTimeFormat(Alpine.store('shell').uiLocale, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
    },
    rowTime(row) {
      const end = this.formatTime(row.rev.created_at);
      if (!(row.size > 1 && !row.open)) return end;
      const start = this.formatTime(row.oldest.created_at);
      return start === end ? end : `${start}–${end}`;
    },

    // Tageskopf: «Heute»/«Gestern», sonst Wochentag + Datum (Jahr nur, wenn
    // nicht das laufende). Datum als Zweitzeile auch bei Heute/Gestern.
    dayLabel(day) {
      const app = window.__app;
      const d = new Date(day.newest.created_at);
      const diff = localDayDiff(d);
      if (diff === 0) return app.t('editor.revisions.day.today');
      if (diff === 1) return app.t('editor.revisions.day.yesterday');
      return this.dayDate(day, true);
    },
    dayDate(day, withWeekday = false) {
      const d = new Date(day.newest.created_at);
      const sameYear = localIsoDate(d).slice(0, 4) === localIsoDate().slice(0, 4);
      return dateTimeFormat(Alpine.store('shell').uiLocale, {
        ...(withWeekday ? { weekday: 'long' } : {}),
        day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }),
      }).format(d);
    },
    dayHasRelative(day) {
      const diff = localDayDiff(new Date(day.newest.created_at));
      return diff === 0 || diff === 1;
    },

    formatDelta(d) {
      if (d == null) return '';
      return numberFormat(Alpine.store('shell').uiLocale, { signDisplay: 'exceptZero' }).format(Number(d));
    },

    // ── Schreibende Aktionen ───────────────────────────────────────────────
    // Schreibrecht wie der Server (editor). Im Notebook-Edit- und Fokusmodus
    // gesperrt: der offene Editor-Puffer kennt den wiederhergestellten Stand
    // nicht und wuerde ihn beim naechsten Autosave gegen sich mergen.
    canWrite() { return !!window.__app?.canEdit?.(); },
    editorBusy() { return !!(window.__app?.editMode || window.__app?.focusActive); },
    canRestore() { return this.canWrite() && !this.editorBusy(); },
    restoreTip(base) {
      return this.editorBusy() ? window.__app.t('editor.revisions.restoreBlockedEdit') : base;
    },

    // Tooltip von «Stand davor»: nennt das Datum des Ziels. Jenseits der letzten
    // 24 h duennt die Retention aus — die Vorgaengerin kann dann Tage oder
    // Wochen aelter sein als der Save davor.
    restorePrevTip(rev) {
      const prev = rev?.id === this.viewerRev?.id ? this._viewerPrev() : this._prevRevFor(rev);
      if (!prev) return this.restoreTip(window.__app.t('editor.revisions.restorePrevTitle'));
      return this.restoreTip(window.__app.t('editor.revisions.restorePrevTitleWhen', {
        when: window.__app.formatDate(prev.created_at),
      }));
    },

    // «Stand davor wiederherstellen»: schreibt die Vorgaengerin zurueck. Exakt
    // der Stand vor diesem Save ist das nur, solange beide im ungeduennten
    // 24-h-Fenster liegen; aelter ist es die naechstaeltere erhaltene Revision
    // (die Rueckfrage nennt deren Datum).
    async restorePrevious(rev) {
      const prev = this._prevRevFor(rev);
      if (prev) await this.restore(prev);
    },

    async restore(rev) {
      if (!rev?.id || this.restoringId || this._restorePending || !this.canRestore()) return;
      const app = window.__app;
      const pageId = this._pageId;
      if (!pageId || app?.currentPage?.id !== pageId) return;
      const when = app.formatDate ? app.formatDate(rev.created_at) : rev.created_at;
      this._restorePending = true;
      let ok;
      try {
        ok = await app.appConfirm({ message: app.t('editor.revisions.restoreConfirm', { when }) });
      } finally {
        this._restorePending = false;
      }
      if (!ok || this._pageId !== pageId) return;
      this.restoringId = rev.id;
      try {
        // Ueber contentRepo statt per rohem fetch: der Restore ist ein Body-Write
        // und muss den SW-Cache von Seite UND Revisionsliste busten. Das Repo
        // dispatcht danach `page-revisions:changed` — die Liste laedt darum ueber
        // den Listener nachgeladene Tiefe erhaltend neu, ohne zweiten Aufruf hier.
        await contentRepo.restoreRevision(pageId, rev.id);
        if (typeof app._refetchCurrentPage === 'function') {
          await app._refetchCurrentPage();
        }
        app.setStatus?.(app.t('editor.revisions.restored'), false, 4000);
        this.closeViewer();
      } catch (e) {
        console.error('[pageRevisions:restore]', e);
        app.setStatus?.(app.t('editor.revisions.restoreFailed') + ' ' + revisionErrorText(e, 'common.unknownError'), true, 6000);
      } finally {
        this.restoringId = null;
      }
    },

    // Anheften nimmt die Revision von der Retention aus; Loesen verwirft den
    // Namen (db/page-revisions.js#setPin). Die Liste laedt ueber das
    // Repo-Event neu.
    async setPinned(rev, pinned, label = null) {
      if (!rev?.id || this.pinningId || !this.canWrite() || !this._pageId) return;
      const app = window.__app;
      this.pinningId = rev.id;
      const pageId = this._pageId;
      try {
        await contentRepo.pinRevision(pageId, rev.id, { pinned, label });
      } catch (e) {
        console.error('[pageRevisions:pin]', e);
        app.setStatus?.(app.t('editor.revisions.pinFailed') + ' ' + revisionErrorText(e, 'common.unknownError'), true, 6000);
      } finally {
        this.pinningId = null;
        // Waehrend des Requests getippter Name (viewer.js#saveViewerLabel).
        // Nicht nachschicken, wenn dieser Request dieselbe Revision geloest
        // hat — sonst heftete der Name sie wieder an.
        const queued = this._queuedLabel;
        this._queuedLabel = null;
        if (queued && queued.pageId === this._pageId && queued.pageId === pageId
            && (pinned || queued.rev.id !== rev.id)) {
          this.setPinned(queued.rev, true, queued.label);
        }
      }
    },

    togglePin(rev) { return this.setPinned(rev, !rev?.pinned, rev?.label || null); },

    ...memoMethods,
    ...viewerMethods,
  }));
}
