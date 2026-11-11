// Board-Ebene der Recherche-Karte: Laden, Reset, Fullscreen, Filter/Sortierung
// und die geteilten Item-Helfer (Listen-Mutation, Indikator-Maps, Labels).

import { fetchJson } from '../../utils.js';
import { sameData } from '../../utils/same-data.js';
import { isSelectedBook, loadToken } from '../../cards/book-guard.js';
import { toggleWrapFullscreen } from '../../fullscreen.js';
import { KINDS, LINK_KINDS, emptyDraft as _emptyDraft } from './shared.js';
import { rechercheBulkState } from './bulk.js';
import { rechercheCrosscheckState } from './crosscheck.js';

export const rechercheBoardMethods = {
  // ── Lifecycle ──────────────────────────────────────────────────────────────
  /** `silent`: Tab-Rueckkehr — nicht dimmen, gleiche Daten verwerfen, Fehler
   *  lassen den alten Stand stehen. Liefert true, wenn `items` neu gesetzt wurde. */
  async loadRecherche({ silent = false } = {}) {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.items = []; return true; }
    // Sequenz + Buch-Guard: Filter-/Such-Refetches laufen parallel (jeder
    // Tastendruck), und eine ältere Antwort — oder die des vorigen Buchs — darf
    // die jüngere nicht überschreiben.
    const isCurrent = loadToken(this, '_rechercheLoadSeq', bookId);
    // Skeleton nur beim Erstladen (noch keine Daten). Bei Filter-/Sort-/Such-
    // Refetches bleibt die Liste stehen und wird nur gedimmt (refreshing) — sonst
    // flackert bei jedem Tastendruck das Skeleton auf und wieder weg.
    if (this.items.length === 0) this.loading = true;
    else if (!silent) this.refreshing = true;
    // Memo-Speicher der Karte leeren (Status-Buckets in recherche/status.js).
    // Die Deps haengen an der `items`-Referenz und verfallen darum ohnehin — der
    // Reset ist die Konvention, damit ein spaeterer Memo mit anderen Deps nicht
    // still ueber einen Buchwechsel hinweg gilt.
    if (!silent) this._memos = {};
    let changed = false;
    try {
      const qs = new URLSearchParams({ book_id: String(bookId) });
      if (this.filterKind) qs.set('kind', this.filterKind);
      if (this.filterTag) qs.set('tag', this.filterTag);
      if (this.filterLinked) qs.set('linked', this.filterLinked);
      if ((this.filterText || '').trim()) qs.set('q', this.filterText.trim());
      if (this.showArchived) qs.set('archived', '1');
      if (this.sortBy && this.sortBy !== 'updated') qs.set('sort', this.sortBy);
      // Bestand ohne Filter parallel (non-fatal): ohne ihn ist «Filter trifft
      // nichts» nicht von «Buch hat noch nichts» zu unterscheiden.
      const [rows, totals] = await Promise.all([
        fetchJson(`/research?${qs.toString()}`),
        fetchJson(`/research/count?book_id=${bookId}`).catch(() => null),
      ]);
      if (!isCurrent()) return false;
      if (totals) this.researchTotals = totals;
      const next = Array.isArray(rows) ? rows : [];
      if (silent && sameData(next, this.items)) return false;
      changed = true;
      this._memos = {};
      this.items = next;
      this._rechercheLoadedBookId = bookId;
      // Offene Zeile nicht mehr in der Liste (Filter, von anderswo gelöscht):
      // zuklappen, damit der Permalink nicht auf eine unsichtbare Zeile zeigt.
      // Ein offenes Bearbeiten bleibt — dessen Entwurf verwirft kein Reload.
      if (this.detailItemId != null && !this.detailEditing && !next.some(i => i.id === this.detailItemId)) {
        this.closeDetail();
      }
      this.errorMessage = '';
      this._loadTags();
      this.ensureLinkTargets();
      // Ideen-Plaketten (eigene Pendenzen an einem Fundstueck) — non-fatal und
      // ohne await: eine fehlende Nebenlesung darf das Board nicht aufhalten.
      this.loadIdeaBacklinks('research');
    } catch (e) {
      if (!isCurrent() || silent) return false;
      changed = true;
      // 503 SEARCH_FAILED (Volltextsuche gescheitert) sagt mehr als „Laden fehlgeschlagen".
      this.errorMessage = this._rechercheErrorText(e, 'recherche.error.load');
      this.items = [];
    } finally {
      // Nur der jüngste Load räumt die Ladeanzeige; ein überholter liesse sie
      // sonst mitten im laufenden Refetch verschwinden.
      if (isCurrent.latest()) { this.loading = false; this.refreshing = false; }
    }
    if (!isCurrent()) return changed;
    // Deep-Link-Ziel (#…/recherche/<itemId>), das vor dem Load ankam, jetzt
    // fokussieren — das Item existiert erst nach diesem Load in `items`.
    if (this._pendingFocusItemId != null) this._focusRechercheItemById(this._pendingFocusItemId);
    return changed;
  },

  async _loadTags() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.tagPool = []; return; }
    try {
      const rows = await fetchJson(`/research/tags?book_id=${bookId}`);
      if (!isSelectedBook(bookId)) return;
      this.tagPool = Array.isArray(rows) ? rows : [];
    } catch { if (isSelectedBook(bookId)) this.tagPool = []; }
  },

  async ensureLinkTargets() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this._linkTargetsBookId === bookId) return;
    try {
      const targets = await fetchJson(`/research/link-targets?book_id=${bookId}`);
      if (!isSelectedBook(bookId)) return;
      this.linkTargets = targets;
      this._sortLinkTargetsByTree();
      this._linkTargetsBookId = bookId;
    } catch { if (isSelectedBook(bookId)) this.linkTargets = {}; }
  },

  // Seiten + Kapitel im Picker/Filter in Buchtree-Reihenfolge bringen (identisch
  // zur Sidebar), statt in der flachen `position`-Server-Sortierung, die die
  // Kapitel-Hierarchie nicht abbildet. Welt-Entitäten (Figuren/Orte/Szenen/
  // Beats/Stränge) behalten ihre kuratierte bzw. gewichtete Server-Sortierung.
  _sortLinkTargetsByTree() {
    const nav = Alpine.store('nav');
    const pageOrder = window.__app?._pageIdOrderMap;
    if (pageOrder && Array.isArray(this.linkTargets.page)) {
      const rank = (id) => pageOrder.has(id) ? pageOrder.get(id) : Number.MAX_SAFE_INTEGER;
      this.linkTargets.page = [...this.linkTargets.page].sort((a, b) => rank(a.id) - rank(b.id));
    }
    if (Array.isArray(nav?.tree) && Array.isArray(this.linkTargets.chapter)) {
      const chapterOrder = new Map();
      let i = 0;
      for (const item of nav.tree) {
        if (item.type === 'chapter' && !item.solo) chapterOrder.set(item.id, i++);
      }
      const rank = (id) => chapterOrder.has(id) ? chapterOrder.get(id) : Number.MAX_SAFE_INTEGER;
      this.linkTargets.chapter = [...this.linkTargets.chapter].sort((a, b) => rank(a.id) - rank(b.id));
    }
  },

  resetRecherche() {
    // Laufende Poller zuerst: ein Tick des alten Buchs schriebe sonst in die
    // frisch geleerte Karte. startPoll erkennt den genullten Handle als „abgeräumt".
    this._stopSuggestPolls();
    for (const k of ['_linkCheckTimer', '_crosscheckTimer']) {
      if (this[k]) { clearInterval(this[k]); this[k] = null; }
    }
    this.items = [];
    this.researchTotals = null;
    this.noticeMessage = '';
    this.formError = '';
    this._archivedByJump = false;
    this._rechercheLoadedBookId = null;
    this._memos = {};
    this.tagPool = [];
    this.linkTargets = {};
    this._linkTargetsBookId = null;
    this.draft = _emptyDraft();
    // Offene Zeile zuklappen und Anlegen schliessen, dann die Marker nullen.
    this.closeDetail();
    this.closeCreate();
    this._pendingFocusItemId = null;
    if (window.Alpine) window.Alpine.store('nav').rechercheItemId = null;
    // Filterleiste + Sortierung bewusst NICHT hier: sie gehören dem
    // Persistenz-Layer (RECHERCHE_FILTER_SCOPES in recherche-card.js), der sie
    // beim Buchwechsel aus dem localStorage restauriert — vor dem Nachladen.
    // Ein Reset hier gewänne gegen den restaurierten Stand. Den ausdrücklichen
    // Weg „alles zurücksetzen" gibt es weiter über `clearFilters()`.
    this.closeActionMenu();
    this.cancelLinkPicker();
    this.suggestions = {};
    this.suggestRunning = {};
    this.errorMessage = '';
    this.busy = false;
    this.refreshing = false;
    this.detailEditing = false;
    this.linkCheckRunning = false;
    this.linkCheckStatus = '';
    Object.assign(this, rechercheCrosscheckState(), rechercheBulkState());
  },

  // Ist die Liste für das gewählte Buch geladen und kein Refetch unterwegs?
  // Erst dann heisst „Fundstück fehlt in `items`" wirklich „nicht in der Liste".
  _rechercheListSettled() {
    const bookId = Alpine.store('nav').selectedBookId;
    return !!bookId && String(this._rechercheLoadedBookId) === String(bookId)
      && !this.loading && !this.refreshing;
  },
  _rechercheFiltersActive() {
    return !!(this.filterKind || this.filterTag || this.filterLinked || (this.filterText || '').trim());
  },

  // Recherche-Karte samt Chat-Leiste ins Native-Vollbild — mehr Platz fürs Karten-Board.
  // Status-Sync via fullscreenchange-Listener in recherche-card.js (rechercheFullscreen).
  async toggleRechercheFullscreen() {
    try {
      await toggleWrapFullscreen(this.$root);
    } catch {
      this.errorMessage = window.__app.t('recherche.error.fullscreen');
    }
  },

  // ── Aktionsmenü (recherche-item-menu.html) ───────────────────────────────
  // EIN Menü für Liste (auch aufgeklappt) und Board-Karte (action-menu.js);
  // Schlüssel `${ctx}:${id}`, Ziel { ctx, id }. Geöffnet per ⋯-Knopf und per
  // Rechtsklick/Long-Press auf Listenzeile bzw. Board-Karte.
  // `only = 'status'`: dasselbe Menü, nur der Status-Abschnitt — geöffnet von
  // der Status-Plakette der Listenzeile (ein Klick setzt die Stufe, darum
  // Kontextmenü und kein Picker-Popover). Eigener Schlüssel, damit Plakette
  // und ⋯-Knopf sich nicht gegenseitig als «zweiter Klick» schliessen.
  openItemMenu(ev, ctx, item, only = null) {
    this.openActionMenu(ev, `${ctx}:${item.id}${only ? ':' + only : ''}`, { ctx, id: item.id, only });
  },
  // Das Fundstück des offenen Menüs als 0/1-Liste (x-for im Menü, Schlüssel =
  // actionMenuKey: ein anderes Fundstück rendert den Inhalt neu).
  itemMenuItems() {
    const id = this.actionMenuTarget?.id;
    if (id == null) return [];
    const it = (this.items || []).find(i => i.id === id);
    return it ? [it] : [];
  },

  // ── Filter ───────────────────────────────────────────────────────────────
  applyFilters() { this.noticeMessage = ''; return this.loadRecherche(); },
  // Tag-Chip (zugeklappte und aufgeklappte Zeile): filtert die Liste. Die
  // offene Zeile bleibt offen, solange sie im Filter liegt — sie trägt den Tag ja.
  filterByTag(tag) {
    this.filterTag = tag;
    return this.applyFilters();
  },
  clearFilters() {
    this.filterKind = ''; this.filterTag = ''; this.filterText = '';
    this.filterLinked = ''; this.filterLinkedKind = ''; this.filterLinkedTargetId = '';
    this.noticeMessage = '';
    return this.loadRecherche();
  },

  // ── Bestand vs. Treffer ──────────────────────────────────────────────────
  // `items` ist die GEFILTERTE Liste. Ob das Buch überhaupt Fundstücke hat,
  // sagt `researchTotals` (GET /research/count); solange der fehlt, gilt die
  // Liste als Bestand. Umschalter, Auswählen und Werkzeuge hängen am Bestand —
  // sonst verschwänden sie bei jeder Suche ohne Treffer, und die Toolbar spränge.
  hasBestand() {
    const t = this.researchTotals;
    return t ? (t.active + t.archived) > 0 : this.items.length > 0;
  },
  // Wie viele Fundstücke die Liste ohne Filter zeigen würde (Archiv-Schalter zählt mit).
  bestandCount() {
    const t = this.researchTotals;
    if (!t) return this.items.length;
    return t.active + (this.showArchived ? t.archived : 0);
  },
  // Kein Treffer, obwohl es Fundstücke gibt: Filter oder ausgeblendetes Archiv.
  isFilteredEmpty() {
    return !this.loading && !this.errorMessage && this.items.length === 0 && this.hasBestand();
  },
  // Nur das ausgeblendete Archiv hält die Liste leer (kein Filter aktiv).
  onlyArchivedHidden() {
    return !this.showArchived && !this._rechercheFiltersActive()
      && (this.researchTotals?.archived || 0) > 0;
  },
  showArchivedNow() { this.showArchived = true; return this.applyFilters(); },
  countLabel() {
    const app = window.__app;
    const n = this.items.length;
    const total = this.bestandCount();
    return n < total
      ? app.tn('recherche.countFiltered', n, { total })
      : app.tn('recherche.count', n);
  },
  // Bestand nach Anlegen/Löschen/Archivieren nachziehen, ohne die Liste neu zu laden.
  async _loadResearchTotals() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    try {
      const t = await fetchJson(`/research/count?book_id=${bookId}`);
      if (isSelectedBook(bookId)) this.researchTotals = t;
    } catch { /* Zähler ist best-effort */ }
  },
  kindOptions() {
    const t = window.__app.t;
    return KINDS.map(k => ({ value: k, label: t(`recherche.kind.${k}`) }));
  },
  tagFilterOptions() {
    return (this.tagPool || []).map(r => ({ value: r.tag, label: `${r.tag} (${r.n})` }));
  },

  // Alle Verknüpfungs-Kategorien (geteilt zwischen Filter + Sortierung).
  linkKinds() {
    return LINK_KINDS.map(k => ({ value: k, label: this.linkKindLabel(k) }));
  },
  // Kategorien im Verknüpfen-Picker: Seite zuerst (häufigstes Ziel).
  linkPickerKinds() {
    const ordered = ['page', ...LINK_KINDS.filter(k => k !== 'page')];
    return ordered.map(k => ({ value: k, label: this.linkKindLabel(k) }));
  },
  // Sortier-Modi: feste Felder + „nach verknüpfter Entität" (link:<dimension>).
  sortOptions() {
    const t = window.__app.t;
    const opts = ['updated', 'created', 'title', 'kind'].map(s => ({ value: s, label: t(`recherche.sort.${s}`) }));
    for (const k of LINK_KINDS) opts.push({ value: `link:${k}`, label: t(`recherche.sort.by`, { kind: this.linkKindLabel(k) }) });
    return opts;
  },
  applySort() { return this.loadRecherche(); },

  // Filter „nach Verknüpfung": Kategorie + konkreter Eintrag → filterLinked.
  // Die Ziel-Optionen baut die generische entityPicker-Komponente (entity
  // 'target') aus `linkTargets[filterLinkedKind]`. Den neuen Wert reicht das
  // Template aus `$event.detail` durch: x-modelable synct erst im Effect-Flush,
  // im combobox-change-Handler stünde sonst noch der alte Wert.
  onLinkedFilterKindChange(kind) {
    this.filterLinkedKind = kind ?? '';
    return this.applyLinkedFilter('');
  },
  applyLinkedFilter(targetId) {
    this.filterLinkedTargetId = targetId ?? '';
    this.filterLinked = (this.filterLinkedKind && this.filterLinkedTargetId)
      ? `${this.filterLinkedKind}:${this.filterLinkedTargetId}` : '';
    return this.loadRecherche();
  },

  // Sprung vom Seiten- bzw. Kapitel-Indikator (`kind` 'page' | 'chapter'): alle
  // Filter zurücksetzen und nur die mit diesem Ziel verknüpften Schnipsel zeigen.
  // Beim frischen Öffnen lädt der Lifecycle (rising edge) selbst; ist die Karte
  // schon offen, hier nachladen.
  filterToLinked(kind, rawId) {
    const id = parseInt(rawId, 10);
    if (!id) return;
    this.filterKind = '';
    this.filterTag = '';
    this.filterText = '';
    this.showArchived = false;
    this.filterLinkedKind = kind;
    this.filterLinkedTargetId = String(id);
    this.filterLinked = `${kind}:${id}`;
    if (window.__app?.showRechercheCard) this.loadRecherche();
  },

  // ── Helpers ──────────────────────────────────────────────────────────────
  // Fehlertext eines fetchJson-Fehlers: der übersetzte `error_code` des Servers
  // (`error.<CODE>`, z.B. INVALID_URL, INVALID_FIELD, SEARCH_FAILED) hat Vorrang,
  // weil er sagt, was zu korrigieren ist; ohne Übersetzung der Karten-Fallback.
  _rechercheErrorText(e, fallbackKey) {
    const t = window.__app.t;
    if (e?.code) {
      const key = `error.${e.code}`;
      const msg = t(key, e.body?.params || {});
      if (msg !== key) return msg;
    }
    return t(fallbackKey);
  },
  _replaceItem(row) { this.items = this.items.map(i => (i.id === row.id ? row : i)); },
  // Indikator-Maps (Seiten + Kapitel) nach Link-/Archiv-/Lösch-Änderungen frisch
  // ziehen. Buchweit geteilt → ein leichter Request hält alle Editoren sync.
  // `targetKind` wählt die Achse: 'page' speist Sidebar + Editor, 'chapter' nur
  // die Sidebar. Beide Endpunkte liefern eine id→n-Map; die Store-Keys liegen
  // dicht beieinander, darum ein gemeinsamer Pfad statt zweier Methoden.
  async _refreshRechercheCounts(targetKind) {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    const cfg = {
      page:    { url: '/research/page-counts',    storeKey: 'rechercheCounts',        currentPage: true },
      chapter: { url: '/research/chapter-counts', storeKey: 'chapterRechercheCounts', currentPage: false },
    }[targetKind];
    if (!cfg) return;
    try {
      const map = await fetchJson(`${cfg.url}?book_id=${bookId}`);
      // Buch inzwischen gewechselt → die Zählung gehört nicht in die Indikatoren des neuen.
      if (!isSelectedBook(bookId)) return;
      Alpine.store('badges')[cfg.storeKey] = map || {};
      if (cfg.currentPage && app.currentPage?.id) {
        app.currentPageRechercheCount = (map || {})[app.currentPage.id] || 0;
      }
    } catch { /* Indikator-Refresh ist best-effort */ }
  },
  kindLabel(k) { return window.__app.t(`recherche.kind.${k}`); },
  linkKindLabel(k) { return window.__app.t(`recherche.linkKind.${k}`); },
  hasItems() { return (this.items || []).length > 0; },

  // Ansichts-Menü der Filterleiste (view-menu.html, Vertrag in view-menu.js).
  // Archivierte lädt der Server nur auf Wunsch (`archived=1`) — darum lädt der
  // Schalter die Liste neu. Gemerkt pro Buch über RECHERCHE_FILTER_SCOPES.
  viewMenuSpec() {
    const t = (k, p) => window.__app.t(k, p);
    return {
      tip: t('recherche.view.tip'),
      items: [{ kind: 'toggle', key: 'archived', on: this.showArchived, label: t('recherche.filter.showArchived'),
        toggle: () => { this.showArchived = !this.showArchived; this._archivedByJump = false; this.applyFilters(); } }],
    };
  },
};
