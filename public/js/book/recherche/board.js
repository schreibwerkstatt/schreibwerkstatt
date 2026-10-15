// Board-Ebene der Recherche-Karte: Laden, Reset, Fullscreen, Filter/Sortierung
// und die geteilten Item-Helfer (Listen-Mutation, Indikator-Maps, Labels).

import { fetchJson } from '../../utils.js';
import { toggleWrapFullscreen } from '../../fullscreen.js';
import { computePopoverPos, refinePopoverPos } from '../../popover-anchor.js';
import { attachDismiss, detachDismiss } from '../../cards/dismiss.js';
import { KINDS, LINK_KINDS, emptyDraft as _emptyDraft } from './shared.js';

// Fenster, in dem ein wiederholter Klick auf denselben Trigger NICHT als
// Schliessen gilt (toggleItemMenu). Kurz genug, dass die Zwei-Klick-Bedienung
// fluessig bleibt, lang genug, um einen Doppelklick zu schlucken.
const MENU_TOGGLE_GRACE_MS = 300;

export const rechercheBoardMethods = {
  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async loadRecherche() {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.items = []; return; }
    // Skeleton nur beim Erstladen (noch keine Daten). Bei Filter-/Sort-/Such-
    // Refetches bleibt die Liste stehen und wird nur gedimmt (refreshing) — sonst
    // flackert bei jedem Tastendruck das Skeleton auf und wieder weg.
    if (this.items.length > 0) this.refreshing = true; else this.loading = true;
    // Memo-Speicher der Karte leeren (Status-Buckets in recherche/status.js).
    // Die Deps haengen an der `items`-Referenz und verfallen darum ohnehin — der
    // Reset ist die Konvention, damit ein spaeterer Memo mit anderen Deps nicht
    // still ueber einen Buchwechsel hinweg gilt.
    this._memos = {};
    try {
      const qs = new URLSearchParams({ book_id: String(bookId) });
      if (this.filterKind) qs.set('kind', this.filterKind);
      if (this.filterTag) qs.set('tag', this.filterTag);
      if (this.filterLinked) qs.set('linked', this.filterLinked);
      if ((this.filterText || '').trim()) qs.set('q', this.filterText.trim());
      if (this.showArchived) qs.set('archived', '1');
      if (this.sortBy && this.sortBy !== 'updated') qs.set('sort', this.sortBy);
      const rows = await fetchJson(`/research?${qs.toString()}`);
      this.items = Array.isArray(rows) ? rows : [];
      this.errorMessage = '';
      this._loadTags();
      this.ensureLinkTargets();
      // Ideen-Plaketten (eigene Pendenzen an einem Fundstueck) — non-fatal und
      // ohne await: eine fehlende Nebenlesung darf das Board nicht aufhalten.
      this.loadIdeaBacklinks('research');
    } catch (e) {
      this.errorMessage = app.t('recherche.error.load');
      this.items = [];
    } finally {
      this.loading = false;
      this.refreshing = false;
    }
    // Deep-Link-Ziel (#…/recherche/<itemId>), das vor dem Load ankam, jetzt
    // fokussieren — das Item existiert erst nach diesem Load in `items`.
    if (this._pendingFocusItemId != null) this._focusRechercheItemById(this._pendingFocusItemId);
  },

  async _loadTags() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.tagPool = []; return; }
    try {
      const rows = await fetchJson(`/research/tags?book_id=${bookId}`);
      this.tagPool = Array.isArray(rows) ? rows : [];
    } catch { this.tagPool = []; }
  },

  async ensureLinkTargets() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this._linkTargetsBookId === bookId) return;
    try {
      this.linkTargets = await fetchJson(`/research/link-targets?book_id=${bookId}`);
      this._sortLinkTargetsByTree();
      this._linkTargetsBookId = bookId;
    } catch { this.linkTargets = {}; }
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
    this.items = [];
    this._memos = {};
    this.tagPool = [];
    this.linkTargets = {};
    this._linkTargetsBookId = null;
    this.draft = _emptyDraft();
    // Erst BEIDE Dialoge schliessen, dann die Marker nullen: ein offenes <dialog>
    // bleibt sonst im Top-Layer stehen und hält das Dokument inert.
    this.closeDetail();
    this.closeCreate();
    this._pendingFocusItemId = null;
    if (window.Alpine) window.Alpine.store('nav').rechercheItemId = null;
    // Filterleiste + Sortierung bewusst NICHT hier: sie gehören dem
    // Persistenz-Layer (RECHERCHE_FILTER_SCOPES in recherche-card.js), der sie
    // beim Buchwechsel aus dem localStorage restauriert — vor dem Nachladen.
    // Ein Reset hier gewänne gegen den restaurierten Stand. Den ausdrücklichen
    // Weg „alles zurücksetzen" gibt es weiter über `clearFilters()`.
    this.closeItemMenu();
    this.linkPickerItemId = null;
    this.suggestions = {};
    this.errorMessage = '';
    this.busy = false;
    this.refreshing = false;
    if (this._suggestTimer) { clearInterval(this._suggestTimer); this._suggestTimer = null; }
  },

  // Ganze Recherche-Karte ins Native-Vollbild — mehr Platz fürs Karten-Board.
  // Status-Sync via fullscreenchange-Listener in recherche-card.js (rechercheFullscreen).
  async toggleRechercheFullscreen() {
    try {
      await toggleWrapFullscreen(this.$root);
    } catch {
      this.errorMessage = window.__app.t('recherche.error.fullscreen');
    }
  },

  // ── Aktionsmenü (recherche-item-menu.html) ───────────────────────────────
  // Ein Menü für Liste, Detail-Dialog und Board-Karte; `key` = `${menuCtx}:${id}`.
  // Fixed am Trigger verankert statt absolut im Container: der Detail-Dialog und
  // die Listen-Container klippen per Overflow, ein kurzer Inhalt schnitt das
  // lange Menü sonst ab. Das Menü ist das Geschwister des Triggers — ein x-ref
  // taugt im x-for nicht (letzte Instanz gewinnt).
  toggleItemMenu(ev, key) {
    // Derselbe Klick binnen der Oeffnungs-Frist ist ein durchgerutschter
    // Doppelklick (schnelle Maus, unempfindliches Touch, ein Test-Runner, der
    // eine Aktion wiederholt), kein Schliessen: im Toggle-Fall waere das
    // gerade geoeffnete Menue im selben Frame wieder zu und die
    // Zwei-Klick-Bedienung unmoeglich. Danach schaltet derselbe Trigger
    // weiterhin normal.
    if (this.menuOpenId === key) {
      if (Date.now() - this._menuOpenedAt < MENU_TOGGLE_GRACE_MS) return;
      this.closeItemMenu();
      return;
    }
    const trigger = ev.currentTarget;
    const rect = trigger.getBoundingClientRect();
    this.menuPos = computePopoverPos(rect, 220, 400);
    this._menuAnchorEl = trigger;
    this._menuAnchorRect = { top: rect.top, left: rect.left };
    this._menuOpenedAt = Date.now();
    this.menuOpenId = key;
    if (!this._itemMenuDismiss) {
      // Scroll schliesst — ausser im Menü selbst (max-height + interner Scroll)
      // und ausser, wenn der Anker stehen bleibt: das Menü hängt an den
      // Viewport-Koordinaten des Triggers, ein daneben scrollender Bereich
      // (andere Liste, ein Job-Hinweis, der die Seite um ein paar Pixel
      // verschiebt) liesse es verankert und riss es sonst grundlos zu.
      const ctrl = attachDismiss(() => this.closeItemMenu(), { scroll: false });
      window.addEventListener('scroll', (e) => {
        if (e.target?.closest?.('.research-item-menu')) return;
        if (this._menuAnchorMoved()) this.closeItemMenu();
      }, { capture: true, passive: true, signal: ctrl.signal });
      this._itemMenuDismiss = ctrl;
    }
    this.$nextTick(() => {
      const pos = refinePopoverPos(trigger.nextElementSibling, rect);
      if (pos) this.menuPos = pos;
    });
  },
  closeItemMenu() {
    this.menuOpenId = null;
    this._menuAnchorEl = null;
    this._menuAnchorRect = null;
    this._menuOpenedAt = 0;
    detachDismiss(this, '_itemMenuDismiss');
  },
  // Hat sich der Trigger seit dem Oeffnen bewegt? 1px Toleranz, damit
  // Rundung und Subpixel-Rauschen den Menue-Schluss nicht ausloesen.
  _menuAnchorMoved() {
    const el = this._menuAnchorEl;
    const open = this._menuAnchorRect;
    if (!el || !open || !this.menuOpenId) return false;
    const now = el.getBoundingClientRect();
    return Math.abs(now.top - open.top) > 1 || Math.abs(now.left - open.left) > 1;
  },

  // ── Filter ───────────────────────────────────────────────────────────────
  applyFilters() { return this.loadRecherche(); },
  clearFilters() {
    this.filterKind = ''; this.filterTag = ''; this.filterText = '';
    this.filterLinked = ''; this.filterLinkedKind = ''; this.filterLinkedTargetId = '';
    return this.loadRecherche();
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
  // 'target') aus `linkTargets[filterLinkedKind]`.
  onLinkedFilterKindChange() {
    this.filterLinkedTargetId = '';
    return this.applyLinkedFilter();
  },
  applyLinkedFilter() {
    this.filterLinked = (this.filterLinkedKind && this.filterLinkedTargetId)
      ? `${this.filterLinkedKind}:${this.filterLinkedTargetId}` : '';
    return this.loadRecherche();
  },

  // Sprung vom Seiten-Indikator: alle Filter zurücksetzen und nur die mit dieser
  // Seite verknüpften Schnipsel zeigen. Beim frischen Öffnen lädt der Lifecycle
  // (rising edge) selbst; ist die Karte schon offen, hier nachladen.
  filterToPage(pageId) {
    const pid = parseInt(pageId, 10);
    if (!pid) return;
    this.filterKind = '';
    this.filterTag = '';
    this.filterText = '';
    this.showArchived = false;
    this.filterLinkedKind = 'page';
    this.filterLinkedTargetId = String(pid);
    this.filterLinked = `page:${pid}`;
    if (window.__app?.showRechercheCard) this.loadRecherche();
  },

  // Sprung vom Kapitel-Indikator: alle Filter zurücksetzen und nur die mit diesem
  // Kapitel verknüpften Schnipsel zeigen (analog filterToPage).
  filterToChapter(chapterId) {
    const cid = parseInt(chapterId, 10);
    if (!cid) return;
    this.filterKind = '';
    this.filterTag = '';
    this.filterText = '';
    this.showArchived = false;
    this.filterLinkedKind = 'chapter';
    this.filterLinkedTargetId = String(cid);
    this.filterLinked = `chapter:${cid}`;
    if (window.__app?.showRechercheCard) this.loadRecherche();
  },

  // ── Helpers ──────────────────────────────────────────────────────────────
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
      Alpine.store('badges')[cfg.storeKey] = map || {};
      if (cfg.currentPage && app.currentPage?.id) {
        app.currentPageRechercheCount = (map || {})[app.currentPage.id] || 0;
      }
    } catch { /* Indikator-Refresh ist best-effort */ }
  },
  _sortItems(arr) {
    return [...arr].sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
      return (b.updated_at || '').localeCompare(a.updated_at || '');
    });
  },
  kindLabel(k) { return window.__app.t(`recherche.kind.${k}`); },
  linkKindLabel(k) { return window.__app.t(`recherche.linkKind.${k}`); },
  hasItems() { return (this.items || []).length > 0; },
};
