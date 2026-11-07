// Alpine.data('referenceCard') — Referenz-Slot: read-only Begleitpanel neben dem
// Notebook-Editor (Companion, Mutex mit Seiten-Chat + Ideen im 420px-Slot).
// Tabs — Plan · Figuren · Orte · Szenen · Ereignisse · Recherche · Quellen · Verwandt —
// wahlweise auf den aktuellen Kontext (Seite/Kapitel) oder das ganze Buch. Nie
// schreibend (rückwärtsgewandt — nie generativ in den Buchtext).
//
// Datenquellen: Figuren/Orte/Szenen/globalZeitstrahl aus Alpine.store('catalog');
// Figuren-Kontext bevorzugt aus $app.chapterFigures (server-geladene Kapitel-
// Figuren, gleiche Quelle wie der Editor-Highlighter), sonst Namens-Treffer im
// Seitentext.
//
// KONTEXT-SCOPE — eine Regel fuer alle Reiter: eine Zeile gehoert zur offenen
// Seite ODER zu deren Kapitel, und die Karte sagt, welches von beidem. Jede
// Liste ist entsprechend zweigeteilt (Seite zuerst) und markiert ihre Zeilen mit
// `refCtx` — sichtbar ist nur 'chapter' («im Kapitel»), Zeilen der offenen
// Seite bleiben unmarkiert; `refPageIds` nennt die fremden Seiten, wo es welche
// gibt (gerendert als Abschnitts-Referenzen). Woran die
// Zugehoerigkeit haengt, ist pro Reiter verschieden — IMMER an IDs, nie an
// Namen, ausser wo es keine ID gibt:
//   Figuren    `$app.chapterFigures` (figure_appearances) ∪ Namens-Treffer —
//              die Identitaet ist die TEXT-`fig_id`, die BEIDE Routen als `id`
//              liefern; eine zweite Achse (Zeilen-ID) laesst jede Kapitel-Figur
//              als unbekannt gelten und ein zweites Mal in der Liste stehen
//   Orte       `ort.kapitel` (location_chapters) ∪ Namens-Treffer
//   Szenen     selectScenesForView — alle drei Toepfe, inkl. der seiten-
//              gebundenen Szenen desselben Kapitels
//   Ereignisse `page_ids`/`chapter_ids` (zeitstrahl_event_pages/_chapters)
//   Recherche  `links[].target_kind/target_id`
//   Plan       Beat am Kapitel; 'page' = Beat-Verankerung fand ihn hier
//   Quellen    Fund-Index (groupCitedSources), `row.onPage` → refCtx
//   Verwandt   kein Kontext-Begriff — Semantik ueber das ganze Buch
// Der Namens-Treffer ist Ergaenzung, nie Ersatz: der Index kennt eine eben
// geschriebene Erwaehnung noch nicht, und eine nur umschriebene Figur steht
// nicht im Text.
//
// Beim Einblenden geladen: Plan (/plot/), Recherche (/research), Quellen
// (/sources + /sources/citations, Gruppierung pure in sources/cited-index.js) —
// alle vorab, weil Reiter-Zähler und die Sichtbarkeit von Plan/Quellen davon
// abhängen. Jeder Lader verwirft seine Antwort, wenn das Buch inzwischen
// gewechselt hat (`_staleBook`). Die Inline-Highlights + Popover bleiben im
// editorEntitiesCard.

import { fetchJson } from '../utils.js';
import { CARET_BLOCK_SEL } from '../editor/shared/dom-block.js';
import { EVT } from '../events.js';
import { tErrorRaw, tRaw } from '../i18n.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { groupCitedSources } from '../sources/cited-index.js';
import { primaryPersonLabel } from '../sources/fields.js';
import { referenceInterviewMethods, referenceInterviewState } from './reference-interview.js';
import { referenceContextMethods } from './reference-context.js';
import { referencePlanMethods, referencePlanState } from './reference-plan.js';

const TABS = ['plan', 'figuren', 'orte', 'szenen', 'ereignisse', 'recherche', 'quellen', 'verwandt'];
// Immer sichtbarer Reiter — Rückfall, wenn der gewählte ausgeblendet ist.
const FALLBACK_TAB = 'figuren';
// Abschnitte, die eine Quellen-Zeile ausgeschrieben nennt; der Rest wird gezählt.
const QUELLE_PAGES_SHOWN = 2;

// Fehlercode der semantischen Route → eigener i18n-Key des Verwandt-Reiters
// (gleiche Sätze wie die Such-Karte); übrige Codes über `error.<CODE>`.
const VERWANDT_ERROR_KEYS = {
  EMBED_UNAVAILABLE: 'search.semantic.unavailable',
  LIKE_ENTITY_NOT_FOUND: 'search.semantic.entityNotFound',
};

export function registerReferenceCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('referenceCard', () => ({
    referenceTab: 'figuren',
    // O-Toene aus Interview-Transkripten (Slice cards/reference-interview.js).
    ...referenceInterviewState(),
    // Plan-Reiter: Beats des Beat-Boards (Slice cards/reference-plan.js).
    ...referencePlanState(),
    referenceScope: 'page',            // 'page' (aktueller Kontext) | 'book'
    referenceRecherche: [],
    referenceRechercheLoading: false,
    referenceRechercheError: '',
    // Quellen-Tab: die Quellen des Buchs (Anzeigedaten) + der Fund-Index
    // (welche Quelle steht auf welcher Seite). Beides buchweit geladen, die
    // Scope-Umschaltung filtert clientseitig.
    referenceSources: [],
    referenceCitations: [],
    referenceSourcesLoading: false,
    referenceSourcesError: '',
    // Verwandt-Tab (Semantik): auf Knopfdruck ähnliche bestehende Seiten zur
    // ganzen Seite (like-Modus, embedding-frei) oder zum markierten Absatz
    // (Freitext-q, Live-Embedding). Read-only, rückwärtsgewandt.
    verwandtBasis: 'page',            // 'page' (ganze Seite) | 'absatz' (Auswahl/Absatz)
    verwandtHits: [],
    verwandtLoading: false,
    verwandtError: '',
    verwandtSearched: false,
    verwandtNotIndexed: false,
    _verwandtAbort: null,
    _verwandtSelText: '',             // zuletzt in .page-content-view erfasste Auswahl/Absatz
    _refPageText: '',
    _refPageTextKey: null,
    _memos: {},
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showReferenceCard',
        onShow: () => this._onVisibleReference(),
        // Reset + bei offenem Slot neu laden. Der Event kommt aus
        // _resetBookScopedState, BEVOR dort der Katalog geleert wird — erst
        // danach (Microtask) laden, sonst hielte _onVisibleReference den alten
        // Katalog für geladen.
        onBookChanged: () => {
          this._resetReference();
          if (window.__app?.showReferenceCard) queueMicrotask(() => this._onVisibleReference());
        },
        onViewReset: () => this._resetReference(),
        // Quelle angelegt/entfernt/geändert (Quellen-Karte oder Beleg-Picker im
        // Editor): das Tab zeigt sonst den Stand von vorhin.
        extraListeners: [
          {
            type: EVT.SOURCES_CHANGED,
            handler: () => { if (window.__app?.showReferenceCard) this._loadReferenceSources(); },
          },
        ],
      });
      // Verwandt-Tab: „Ganze Seite" verhält sich wie die Geschwister-Tabs und
      // sucht automatisch beim Öffnen bzw. beim Seitenwechsel (embedding-frei).
      this.$watch('referenceTab', (tab) => { if (tab === 'verwandt') this._maybeAutoVerwandt(); });
      // Basis-Wechsel: Treffer stammen aus dem anderen Modus → hart zurücksetzen
      // (kein Stehenbleiben alter Ergebnisse), dann „ganze Seite" neu suchen.
      this.$watch('verwandtBasis', () => {
        if (this.referenceTab !== 'verwandt') return;
        this._resetVerwandt();
        this._maybeAutoVerwandt();
      });
      this.$watch(() => window.__app?.currentPage?.id, () => {
        // Treffer und Auswahl gehören zur alten Seite; „ganze Seite" neu suchen.
        // Ein Save derselben Seite lässt die Treffer stehen — sie sollen beim
        // Schreiben nicht verschwinden; neu sucht der Knopf.
        this._resetVerwandt();
        this._verwandtSelText = '';
        if (this.referenceTab === 'verwandt' && window.__app?.showReferenceCard) this._maybeAutoVerwandt();
      });
      // Der Fund-Index wird serverseitig bei jedem Seiten-Write neu gebaut. Eine
      // neue `updated_at` heisst also: gerade gespeichert, ein eben eingefügter
      // Quellennachweis ist jetzt im Index. Nur die Fundstellen nachladen (die
      // Quellenliste selbst ändert ein Seiten-Save nicht) und nur mit offenem
      // Slot + Tab — beim Einblenden lädt _onVisibleReference ohnehin frisch.
      this.$watch(() => window.__app?.currentPage?.updated_at, () => {
        if (window.__app?.showReferenceCard && this.referenceTab === 'quellen'
            && this.referenceSources.length) {
          this._loadReferenceCitations();
        }
      });
      // Auswahl/Absatz laufend mitschreiben, solange der Cursor im Editor-Text
      // steht. Beim Klick auf den Suchen-Button ist die Live-Selection bereits
      // verloren (Fokus-Steal) — darum den zuletzt erfassten Text puffern.
      document.addEventListener('selectionchange', () => this._captureVerwandtSel(),
        { signal: this._lifecycle.signal });
    },

    destroy() { this._verwandtAbort?.abort(); this._lifecycle?.destroy(); },

    _resetReference() {
      this.referenceRecherche = [];
      this.referenceRechercheLoading = false;
      this.referenceRechercheError = '';
      Object.assign(this, referencePlanState(), referenceInterviewState());
      this.referenceSources = [];
      this.referenceCitations = [];
      this.referenceSourcesLoading = false;
      this.referenceSourcesError = '';
      this._resetVerwandt();
      this._verwandtSelText = '';
      this._refPageText = '';
      this._refPageTextKey = null;
      this._memos = {};
    },

    _resetVerwandt() {
      this._verwandtAbort?.abort();
      this.verwandtHits = [];
      this.verwandtLoading = false;
      this.verwandtError = '';
      this.verwandtSearched = false;
      this.verwandtNotIndexed = false;
    },

    /** Prädikat für Lader: hat das Buch seit `bookId` gewechselt? Nach jedem
     *  await prüfen — eine Antwort des alten Buchs darf das neue nicht füllen. */
    _staleBook(bookId) {
      return Alpine.store('nav').selectedBookId !== bookId;
    },

    // Beim Sichtbarwerden: Katalog-Daten defensiv nachladen (der Slot lebt
    // eigenständig neben dem Editor — die Fach-Karten wurden evtl. nie geöffnet)
    // + Recherche fetchen.
    _onVisibleReference() {
      const app = window.__app;
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId) return;
      const cat = Alpine.store('catalog');
      if (!(cat.figuren || []).length) app.loadFiguren?.(bookId);
      if (!(cat.orte || []).length) app.loadOrte?.(bookId);
      if (!(cat.szenen || []).length) app.loadSzenen?.(bookId);
      if (!(cat.globalZeitstrahl || []).length) app._reloadZeitstrahl?.();
      this._ensureVisibleTab();
      this._loadReferenceRecherche();
      this._loadReferenceSources();
      this._loadReferencePlan();
    },

    async _loadReferenceRecherche() {
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId) { this.referenceRecherche = []; return; }
      this.referenceRechercheLoading = true;
      this.referenceRechercheError = '';
      try {
        const rows = await fetchJson(`/research?book_id=${encodeURIComponent(bookId)}`);
        if (this._staleBook(bookId)) return;
        this.referenceRecherche = Array.isArray(rows) ? rows : [];
      } catch {
        if (this._staleBook(bookId)) return;
        // Fehler sagen statt «Keine Recherche-Einträge» — sonst sieht ein
        // Netzausfall aus wie ein leeres Buch.
        this.referenceRecherche = [];
        this.referenceRechercheError = window.__app.t('reference.recherche.loadError');
      } finally {
        if (!this._staleBook(bookId)) this.referenceRechercheLoading = false;
      }
    },

    // ── Quellen-Tab ─────────────────────────────────────────────────────────
    // Zwei Roundtrips pro Buch: die Quellen (Anzeigedaten) und der Fund-Index
    // (wo sie belegt sind). Archivierte kommen mit — eine archivierte Quelle
    // kann im Text weiter belegt sein, und dann gehört sie in die Liste.
    // Ohne Quellen entfällt der zweite Aufruf: ein Roman hat keine, und das Tab
    // bleibt dann ohnehin verborgen.
    //
    // Bewusst NICHT über sources/source-cache.js: der Cache hält die Menge des
    // Beleg-Pickers (nur aktive Quellen — eine archivierte soll man nicht neu
    // einfügen können). Hier ist die Obermenge nötig, siehe oben. Zwei Mengen,
    // zwei Fetches; ein gemeinsamer Cache müsste beide Fassungen führen und
    // wäre teurer als der gesparte Roundtrip.
    async _loadReferenceSources() {
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId) { this.referenceSources = []; this.referenceCitations = []; return; }
      this.referenceSourcesLoading = true;
      this.referenceSourcesError = '';
      try {
        const list = await fetchJson(`/sources?book_id=${encodeURIComponent(bookId)}&archived=1`);
        if (this._staleBook(bookId)) return;
        this.referenceSources = Array.isArray(list) ? list : [];
        if (this.referenceSources.length) await this._loadReferenceCitations();
        else this.referenceCitations = [];
      } catch {
        if (this._staleBook(bookId)) return;
        this.referenceSources = [];
        this.referenceCitations = [];
        this.referenceSourcesError = window.__app.t('reference.quellen.loadError');
      } finally {
        if (!this._staleBook(bookId)) {
          this.referenceSourcesLoading = false;
          this._ensureVisibleTab();
        }
      }
    },

    /** Nur den Fund-Index nachladen — nach einem Seiten-Save hat sich die
     *  Quellenliste nicht geändert, wohl aber, wo belegt wird. */
    async _loadReferenceCitations() {
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId) { this.referenceCitations = []; return; }
      try {
        const rows = await fetchJson(`/sources/citations?book_id=${encodeURIComponent(bookId)}`);
        if (this._staleBook(bookId)) return;
        this.referenceCitations = Array.isArray(rows) ? rows : [];
      } catch {
        if (this._staleBook(bookId)) return;
        this.referenceCitations = [];
        this.referenceSourcesError = window.__app.t('reference.quellen.loadError');
      }
    },

    // Tab-Sichtbarkeit: ohne Quellen im Buch gibt es nichts zu zeigen (analog
    // zum Verwandt-Tab, das an der Semantik-Konfiguration hängt). Ein
    // Ladefehler zeigt den Reiter trotzdem — sonst verschwände die Meldung.
    referenceHasSources() { return this.referenceSources.length > 0 || !!this.referenceSourcesError; },

    // Fund-Index → Zeilen mit derselben Kontext-Markierung wie die Geschwister-
    // Reiter: refCtx ('page' = auf der offenen Seite belegt, sonst 'chapter')
    // und refPageIds (die übrigen Fundstellen-Seiten in Leserichtung).
    referenceQuellen() {
      const app = window.__app;
      const pages = Alpine.store('nav').pages || [];
      const pid = app?.currentPage?.id ?? null;
      const cid = app?.currentPage?.chapter_id ?? null;
      const scope = this._contextActive() ? 'page' : 'book';
      return this._memo('quellen',
        [scope, pid, cid, this.referenceSources, this.referenceCitations, pages],
        () => groupCitedSources({
          sources: this.referenceSources,
          citations: this.referenceCitations,
          pages, scope, pageId: pid, chapterId: cid,
        }).map(row => ({
          ...row,
          refCtx: scope === 'page' ? (row.onPage ? 'page' : 'chapter') : null,
          refPageIds: row.pages.filter(p => !p.onPage).map(p => p.pageId),
        })));
    },

    referenceQuelleTitle(row) {
      return row?.source?.title || window.__app.t('sources.untitled');
    },

    /** Urheber · Jahr · Gattung — dieselben Angaben, an denen der Autor die
     *  Quelle im Verzeichnis wiedererkennt. */
    referenceQuelleMeta(row) {
      const s = row?.source;
      if (!s) return '';
      const app = window.__app;
      const type = s.csl_type ? app.t(`sources.type.${s.csl_type}`) : '';
      return [primaryPersonLabel(s), s.year, type].filter(Boolean).join(' · ');
    },

    referenceQuelleCount(row) {
      return window.__app.t('sources.citedN', { n: row?.count || 0 });
    },

    /** Wo sonst im Ausschnitt belegt: die ersten Seiten als Referenz, der Rest
     *  gezählt (die vollständige Liste steht im Quellenverzeichnis). */
    referenceQuellePages(row) {
      return (row?.refPageIds || []).slice(0, QUELLE_PAGES_SHOWN);
    },
    referenceQuelleMore(row) {
      const n = (row?.refPageIds || []).length - QUELLE_PAGES_SHOWN;
      return n > 0 ? window.__app.tn('reference.quellen.morePages', n) : '';
    },

    /** Sprung ins Quellenverzeichnis auf genau diesen Eintrag. Deep-Link-Hash als
     *  SSoT — der Hash-Router öffnet die Karte, setzt Exklusivität und fokussiert
     *  die Quelle (analog openRechercheItem). */
    openReferenceSource(row) {
      const bookId = Alpine.store('nav').selectedBookId;
      const id = row?.source?.id;
      if (!bookId || id == null) return;
      location.hash = `#book/${bookId}/quellen/${id}`;
    },

    // ── Tabs + Scope ────────────────────────────────────────────────────────
    referenceTabs() { return TABS; },
    setReferenceTab(tab) { if (TABS.includes(tab)) this.referenceTab = tab; },

    /** Ist der Reiter gerade sichtbar? Plan und Quellen hängen an Daten, Verwandt
     *  an der Semantik-Konfiguration. Eine Stelle für Template und Rückfall. */
    referenceTabVisible(tab) {
      switch (tab) {
        case 'plan':     return this.referenceHasPlan();
        case 'quellen':  return this.referenceHasSources();
        case 'verwandt': return !!Alpine.store('config')?.semanticSearchEnabled;
        default:         return TABS.includes(tab);
      }
    },

    /** Gewählter Reiter ausgeblendet (Buch ohne Quellen/Plan, Semantik aus) →
     *  auf den Rückfall-Reiter, sonst wäre kein Reiter markiert und darunter
     *  stünde ein verwaistes Panel. Erst nach dem Laden aufgerufen: während des
     *  Ladens sind Plan/Quellen noch unbekannt und sollen den gemerkten Reiter
     *  nicht wegschieben. */
    _ensureVisibleTab() {
      if (this.referencePlanLoading || this.referenceSourcesLoading) return;
      if (!this.referenceTabVisible(this.referenceTab)) this.referenceTab = FALLBACK_TAB;
    },
    toggleReferenceScope() {
      this.referenceScope = this.referenceScope === 'page' ? 'book' : 'page';
    },
    referenceHasContext() { return !!window.__app?.currentPage; },
    // Kontext-Filter greift nur, wenn Scope='page' UND eine Seite offen ist —
    // sonst wird immer das ganze Buch gezeigt (nichts zu filtern).
    _contextActive() { return this.referenceScope === 'page' && this.referenceHasContext(); },

    // ── Verwandt-Tab (Semantik) ───────────────────────────────────────────────
    // Ergebnisse gehören zur Seite: der Seitenwechsel-Watcher in init() verwirft
    // sie, ein Save derselben Seite lässt sie stehen.
    verwandtResults() { return this.verwandtHits; },
    verwandtScoreLabel(hit) {
      return Math.round((hit?.score || 0) * 100) + '%';
    },
    activateVerwandt(hit) {
      if (hit?.entity_id != null) window.__app?.gotoPageById?.(hit.entity_id);
    },

    // Text der aktuellen Auswahl bzw. des Absatzes am Cursor — nur innerhalb des
    // Notebook-Editor-Textkörpers (.page-content-view, view + edit teilen die Klasse).
    // Puffer: der Suchen-Button stiehlt beim Klick den Fokus und kollabiert die
    // Live-Selection, darum liefern wir den zuletzt erfassten Text.
    _verwandtSelectionText() {
      return this._verwandtSelText;
    },
    // Läuft auf jedem `selectionchange`: steht der Cursor/die Auswahl im Editor-
    // Text, den Absatz-/Auswahltext puffern; sonst den letzten Wert behalten
    // (Fokuswechsel auf die Karte darf ihn nicht löschen).
    _captureVerwandtSel() {
      const sel = window.getSelection?.();
      if (!sel || !sel.anchorNode) return;
      const startEl = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode;
      if (!startEl?.closest?.('.page-content-view')) return;
      const selText = sel.toString().replace(/\s+/g, ' ').trim();
      if (!sel.isCollapsed && selText) { this._verwandtSelText = selText; return; }
      const block = startEl.closest(CARET_BLOCK_SEL);
      this._verwandtSelText = (block?.textContent || '').replace(/\s+/g, ' ').trim();
    },

    // Auto-Suche für „Ganze Seite" (embedding-frei) — beim Tab-Öffnen bzw.
    // Seitenwechsel. Absatz-Modus braucht eine Auswahl und bleibt manuell.
    _maybeAutoVerwandt() {
      if (this.verwandtBasis !== 'page') return;
      if (!Alpine.store('config')?.semanticSearchEnabled) return;
      if (!window.__app?.currentPage?.id) return;
      if (this.verwandtLoading || this.verwandtSearched) return;
      this.runVerwandt();
    },

    async runVerwandt() {
      const app = window.__app;
      const bookId = Alpine.store('nav').selectedBookId;
      const pageId = app?.currentPage?.id;
      if (!Alpine.store('config')?.semanticSearchEnabled || !bookId || !pageId) return;

      const params = new URLSearchParams({ book_id: String(bookId), kind: 'page', limit: '10' });
      if (this.verwandtBasis === 'absatz') {
        const text = this._verwandtSelectionText();
        if (!text) {
          this._verwandtAbort?.abort();
          this.verwandtLoading = false;
          this.verwandtHits = [];
          this.verwandtSearched = true;
          this.verwandtNotIndexed = false;
          this.verwandtError = app.t('reference.verwandt.noSelection');
          return;
        }
        params.set('q', text.slice(0, 500));
      } else {
        params.set('like_kind', 'page');
        params.set('like_id', String(pageId));
      }

      this._verwandtAbort?.abort();
      const ctrl = new AbortController();
      this._verwandtAbort = ctrl;
      // Alte Treffer sofort leeren — während des Ladens bleibt nur der
      // Ladeindikator sichtbar (keine stehengebliebenen Ergebnisse).
      this.verwandtHits = [];
      this.verwandtLoading = true;
      this.verwandtError = '';
      this.verwandtNotIndexed = false;
      this.verwandtSearched = true;

      try {
        const r = await fetch('/search/semantic?' + params.toString(), { credentials: 'same-origin', signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          // Fehlercode → Satz; rohe HTTP-Status erreichen den User nie.
          const own = VERWANDT_ERROR_KEYS[j.error_code];
          this.verwandtError = own ? app.t(own)
            : j.error_code ? tErrorRaw(j) : app.t('search.semantic.failed');
          this.verwandtHits = [];
          return;
        }
        const data = await r.json();
        if (data.notIndexed) {
          this.verwandtNotIndexed = true;
          this.verwandtHits = [];
          return;
        }
        // Freitext-Modus schliesst die Quellseite nicht serverseitig aus.
        this.verwandtHits = (Array.isArray(data.hits) ? data.hits : [])
          .filter(h => !(h.kind === 'page' && String(h.entity_id) === String(pageId)));
      } catch (e) {
        if (e.name === 'AbortError' || ctrl.signal.aborted) return;
        // fetch wirft nur bei Netzausfall (HTTP-Fehler landen oben).
        this.verwandtError = tRaw('common.networkError');
        this.verwandtHits = [];
      } finally {
        if (!ctrl.signal.aborted) this.verwandtLoading = false;
      }
    },

    // ── Render-Helfer ─────────────────────────────────────────────────────────
    referenceEventDate(ev) {
      if (ev?.datum_label) return ev.datum_label;
      if (ev?.datum_year != null) return String(ev.datum_year);
      return '';
    },
    referenceRechercheKind(item) {
      const app = window.__app;
      return item?.kind ? app.t('recherche.kind.' + item.kind) : '';
    },
    referenceRechercheText(item) {
      return item?.title || item?.body || '';
    },
    // Klick auf einen Recherche-Schnipsel im Referenz-Slot: zur Recherche-Karte
    // springen und das Item öffnen. Deep-Link-Hash als SSoT — der Hash-Router
    // öffnet die Karte, setzt Exklusivität und fokussiert das Item (analog gotoLink).
    openRechercheItem(item) {
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId || item?.id == null) return;
      location.hash = `#book/${bookId}/recherche/${item.id}`;
    },

    ...referenceInterviewMethods,
    ...referencePlanMethods,
    // Kontext-Regel + gefilterte Listen (Slice cards/reference-context.js).
    ...referenceContextMethods,
  }));
}
