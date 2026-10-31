// Alpine.data('figurenCard') — Sub-Komponente der Figurenübersicht.
//
// Eigener State:
//   - Reiter (figurenGraphModus: Liste, drei Graphen, drei Tabellen) und
//     Graph-State (figurenGraphKapitelId, figurenGraphFullscreen)
//   - Alterstabelle (figurenAlterData/-Filters/-Loading/-Progress/-Status,
//     figurenAlterOpenId) — der Index wird erst beim Oeffnen des Reiters geholt
//   - Lebenslauf (figurenLebenslaufIds/-Filters) — reine Anzeige-Wahl; die Daten
//     kommen aus dem Katalog, der Alters-Index liefert nur bessere Geburtsjahre
//   - vis-network-Internals (_figurenNetwork, _figurenHash, _figurenNodes, _figurenEdges)
//   - aufgelöste Canvas-Farben (_graphTheme) + Theme-Observer (_themeObserver)
//
// Geteilt:
//   - `figuren` (Alpine.store('catalog'))
//   - `figurenFilters`/`selectedFigurId`/`figurenLoading/Progress/Status`
//     (Alpine.store('catalogUi') — app-navigation/Hash-Router/checkPendingJobs
//     schreiben darauf)
// Root behält:
//   - `loadFiguren` (von vielen Modulen gerufen)

import { graphMethods } from '../graph.js';
import { presenceMethods } from '../book/figuren-presence.js';
import { figurenAlterMethods } from '../book/figuren-alter.js';
import { figurenLebenslaufMethods } from '../book/figuren-lebenslauf.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { CARD_REQUEST } from './card-request.js';
import { attachFullscreenSync } from '../fullscreen.js';
import { observeThemeChange } from '../graph-kit.js';
// Datums-Anzeige der Lebensereignisse: dieselbe reine Funktion wie in der
// Ereignisse-Karte. Der Figuren-Detailbereich zeigt dieselben `figure_events` —
// mit einer zweiten Formatierung liest derselbe Datensatz sich je Karte anders
// (und ein Ereignis, dessen Datum NUR strukturiert vorliegt, bliebe ohne Datum).
import { formatEventDateParts } from './ereignisse/date.js';
import { subtypIcon } from './ereignisse/subtyp.js';
import { typRank, compareNames } from '../book/figur-typen.js';
import { memoMethods } from './card-memo.js';
import { activeFilterId, sameId } from '../chapter-filter.js';
import { plotBacklinkMethods } from '../book/plot-backlinks.js';
import { figurPflegeMethods } from '../book/figuren-pflege.js';
import { figurenSchulwegMethods } from '../book/figuren-schulweg.js';

// Felder, die die Listensuche trifft. Der Typ zählt mit seinem angezeigten
// Label (`typLabel`), nicht dem Persistenz-Key — gesucht wird, was man liest.
const SEARCH_FIELDS = ['name', 'kurzname', 'beschreibung', 'rolle', 'beruf'];

function matchesSuche(f, q, typLabel) {
  for (const k of SEARCH_FIELDS) if ((f[k] ?? '').toLowerCase().includes(q)) return true;
  if ((f.eigenschaften ?? []).some(e => String(e).toLowerCase().includes(q))) return true;
  return !!typLabel && (typLabel(f.typ) ?? '').toLowerCase().includes(q);
}

// Auftritte im ganzen Buch: Summe der Kapitel-Häufigkeiten (wie die Präsenz-Heatmap).
const auftritte = (f) => (f.kapitel ?? []).reduce((s, k) => s + (k.haeufigkeit || 1), 0);

// Pure Filter+Sort der Figurenliste. Aus dem memoized Wrapper extrahiert, damit
// sie ohne Alpine-Root testbar bleibt. `chapterIdx(id)` = Lese-Reihenfolge einer
// Kapitel-ID (root._chapterIdIdx). `kapitelId`/`seiteId` sind die bereits
// wirksamen Filterwerte (activeFilterId); Kapitel und Abschnitte per ID
// (chapter-filter.js), Abschnitte aus den Szenen der Figur (f.seiten).
// `sort`: '' (Buchreihenfolge) | 'name' | 'typ' | 'haeufigkeit'; jede Sortierung
// fällt bei Gleichstand auf die Buchreihenfolge zurück.
export function computeFilteredFiguren(figuren, chapterIdx, { suche = '', kapitelId = '', seiteId = '', typ = '', sort = '', typLabel = null } = {}) {
  let result = figuren ?? [];
  const q = (suche || '').trim().toLowerCase();
  if (q) result = result.filter(f => matchesSuche(f, q, typLabel));
  if (typ) result = result.filter(f => f.typ === typ);
  if (kapitelId) result = result.filter(f => (f.kapitel ?? []).some(k => sameId(k.chapter_id, kapitelId)));
  if (kapitelId && seiteId) result = result.filter(f =>
    (f.seiten ?? []).some(s => sameId(s.chapter_id, kapitelId) && sameId(s.page_id, seiteId)));

  // minChapterIdx pro Figur einmal vorab berechnen (kein Math.min(...spread) im Comparator).
  const minIdx = new Map();
  const idxOf = (f) => {
    let m = minIdx.get(f);
    if (m !== undefined) return m;
    m = 9999;
    const ks = f.kapitel;
    if (ks && chapterIdx) for (let i = 0; i < ks.length; i++) {
      const v = chapterIdx(ks[i].chapter_id) ?? 9999;
      if (v < m) m = v;
    }
    minIdx.set(f, m);
    return m;
  };
  const buchFolge = (a, b) => {
    const aK = idxOf(a);
    const bK = idxOf(b);
    if (aK !== bK) return aK - bK;
    const aT = typRank(a.typ);
    const bT = typRank(b.typ);
    if (aT !== bT) return aT - bT;
    return compareNames(a.name, b.name);
  };
  const cmp = {
    name: (a, b) => compareNames(a.name, b.name) || buchFolge(a, b),
    typ: (a, b) => (typRank(a.typ) - typRank(b.typ)) || buchFolge(a, b),
    haeufigkeit: (a, b) => (auftritte(b) - auftritte(a)) || buchFolge(a, b),
  }[sort] ?? buchFolge;
  return [...result].sort(cmp);
}

// Pure: Abschnitts-IDs eines Kapitels über alle Figuren (Filter-Combobox).
export function computeFigurenSeiten(figuren, kapitelId) {
  const ids = new Set();
  for (const f of (figuren || [])) {
    for (const s of (f.seiten || [])) {
      if (sameId(s.chapter_id, kapitelId) && s.page_id != null) ids.add(s.page_id);
    }
  }
  return ids;
}

export function registerFigurenCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('figurenCard', () => ({
    // Map fig_id → Beats der Plot-Werkstatt (Detail „Im Plot“); non-fatal geladen.
    plotBacklinks: {},
    // Anzeige-Datum eines Lebensereignisses (Figuren-Detail, Zeitstrahl-Block).
    formatEventDate(ev) {
      return formatEventDateParts(ev, (k, p) => window.__app.t(k, p));
    },
    subtypIcon,
    // Aktiver Reiter. 'liste' (Figurenliste) ist der Einstieg; die übrigen sind
    // Graph- (GRAPH_MODES in graph/constants.js) oder Tabellen-Ansichten.
    figurenGraphModus: 'liste',
    figurenGraphKapitelId: null,
    figurenGraphFullscreen: false,
    // Alterstabelle (5. Reiter). `figurenAlterData` = { figuren, scan } aus
    // GET /figures/:id/alter; null heisst „noch nicht geladen", nicht „leer".
    figurenAlterData: null,
    figurenAlterFilters: { suche: '', typ: '', nur: '' },
    figurenAlterLoading: false,
    figurenAlterProgress: 0,
    figurenAlterStatus: '',
    figurenAlterOpenId: null,
    _figurenAlterPollTimer: null,
    _figurenAlterLoadedBookId: null,
    // Lebenslauf (6. Reiter): NUR die Anzeige-Wahl. Die Matrix selbst faellt aus
    // `catalog.figuren` — kein eigener Fetch, kein eigener Index, kein Job.
    // Leeres `figurenLebenslaufIds` heisst „noch nichts gewaehlt"; die erste
    // Oeffnung fuellt es mit den praesentesten Figuren.
    figurenLebenslaufIds: [],
    figurenLebenslaufFilters: { suche: '', typ: '' },
    // Katalog-Pflege (book/figuren-pflege.js): Steckbrief-Formular einer Figur
    // (`figurEditId` = fig_id der Figur in Bearbeitung) und «zusammenführen mit…»
    // einer ausgemusterten Figur (`figurMergeSourceId`).
    figurEditId: null,
    figurEditDraft: {},
    figurEditBusy: false,
    figurEditError: '',
    figurMergeSourceId: null,
    figurMergeTargetId: '',
    figurMergeBusy: false,
    figurMergeError: '',
    figurPflegeMessage: '',
    // Schullaufbahn (book/figuren-schulweg.js): `figurSchulData` = { schulsystem,
    // wege, geburten, handlungsjahr } aus GET /figures/:id/schulwege; null = nicht
    // geladen. Bearbeiten wie die Katalog-Pflege (eine Figur zur Zeit), dazu der
    // Vorschlags-Job und die Jahr-Abfrage im Lebenslauf.
    figurSchulData: null,
    figurSchulEditId: null,
    figurSchulDraft: {},
    figurSchulBusy: false,
    figurSchulError: '',
    figurSchulMessage: '',
    figurSchulAbfrageJahr: null,
    figurSchulJobLoading: false,
    figurSchulJobProgress: 0,
    figurSchulJobStatus: '',
    _figurSchulPollTimer: null,
    _figurenNetwork: null,
    _figurenHash: null,
    _figurenNodes: null,
    _figurenEdges: null,
    // Aufgelöste Canvas-Farben (Hell/Dunkel). Wird pro Render in renderFigurGraph
    // gesetzt; Overlays + Kapitel-Filter lesen daraus, statt selbst zu messen.
    _graphTheme: null,
    _themeObserver: null,
    // Ein Memo-Helper pro Modul (CLAUDE.md): filteredFiguren()/figurenKapitelOptionen()/
    // figurenSeitenOptionen() werden im Template (inkl. Combobox-x-effect) mehrfach pro
    // Render gelesen → Cache mit shallow-Array-Deps. Reset via this._memos = {} im load-Pfad.
    _memos: {},
    _lifecycle: null,

    init() {
      const destroyNet = () => {
        if (this._figurenNetwork) { this._figurenNetwork.destroy(); this._figurenNetwork = null; }
        // vis-network DataSets halten Referenzen aufs alte Buch; ohne null
        // bleiben sie bis zum nächsten view:reset im Speicher.
        this._figurenNodes = null;
        this._figurenEdges = null;
        this._figurenHash = null;
      };

      this._lifecycle = setupCardLifecycle(this, {
        name: 'figuren',
        showFlag: 'showFiguresCard',
        load: async (root) => {
          this._memos = {};
          if (this.figurenGraphModus === 'alter') this.ensureFigurenAlter();
          this.loadPlotBacklinks('figure');
          this.loadFigurenSchulwege();
          await root.loadFiguren(Alpine.store('nav').selectedBookId);
          await this.$nextTick();
          this.renderFigurGraph();
        },
        // book:changed: Netzwerk wegwerfen + Kapitelfilter resetten, dann neu
        // rendern. loadFiguren läuft zwar parallel aus
        // _resetBookScopedState (loadPages), ist aber ein Netz-Fetch — book:changed
        // feuert synchron davor. Ein blosses $nextTick würde rendern, solange
        // figuren noch [] ist → Leer-Platzhalter + gecachter Leer-Hash, und der
        // Reactive-Update löst keinen erneuten Render aus. Darum hier den Load
        // explizit awaiten (idempotent zum loadPages-Load) und erst dann rendern.
        onBookChanged: async (e, ctx, root) => {
          destroyNet();
          ctx._memos = {};
          ctx.figurenGraphKapitelId = null;
          ctx._resetFigurenAlter();
          ctx._resetFigurPflege();
          ctx._resetFigurSchulweg();
          if (!root.showFiguresCard) return;
          const bookId = Alpine.store('nav').selectedBookId;
          if (!bookId) return;
          ctx.plotBacklinks = {};
          ctx.loadPlotBacklinks('figure');
          ctx.loadFigurenSchulwege();
          await root.loadFiguren(bookId);
          // Schneller Folge-Buchwechsel: Ergebnis verwerfen, der neue
          // book:changed-Handler rendert.
          if (String(Alpine.store('nav').selectedBookId) !== String(bookId)) return;
          // Buchwechsel ohne resetView (Hash-Navigation, Browser-Zurück): die Karte
          // bleibt offen, der Reiter auch — dessen Daten fürs neue Buch nachladen.
          if (ctx.figurenGraphModus === 'alter') ctx.ensureFigurenAlter();
          else if (ctx.figurenGraphModus === 'lebenslauf') {
            ctx.ensureFigurenAlter().then(() => ctx.figurenLebenslaufEnsureAuswahl());
          }
          await ctx.$nextTick();
          ctx.renderFigurGraph();
        },
        onViewReset: (e, ctx) => {
          destroyNet();
          ctx._resetFigurenAlter();
          ctx._resetFigurPflege();
          ctx._resetFigurSchulweg();
          ctx.figurenGraphModus = 'liste';
          ctx.figurenGraphKapitelId = null;
          ctx.figurenGraphFullscreen = false;
        },
        // Sprung auf einen Reiter (Figur in der Liste, Job-Queue: figur-alter → «Alter»).
        tabRequest: { key: CARD_REQUEST.FIGUREN_TAB, apply: (mode) => this.setFigurenGraphModus(mode) },
      });

      // Reiter „Alter" ist der einzige, der Daten nachlaedt (der Alters-Index
      // gehoert nicht in den heissen Katalog-Fetch). Darum hier und nicht in
      // graph/core.js#setFigurenGraphModus — die Methode teilt sich die Karte mit
      // dem Graph-Modul und weiss nichts von der Tabelle.
      this.$watch('figurenGraphModus', (mode) => {
        if (mode === 'alter') this.ensureFigurenAlter();
        if (mode === 'lebenslauf') {
          // Derselbe Index wie der Alter-Reiter, aus demselben einen GET: er
          // kennt auch ein NUR im Text gefundenes Geburtsjahr und macht damit
          // Figuren einsortierbar, die der Katalog allein nicht platzieren kann.
          // Non-fatal — ohne Lauf traegt der Katalog die Matrix allein.
          this.ensureFigurenAlter().then(() => this.figurenLebenslaufEnsureAuswahl());
        }
      });

      // Sprachwechsel → Graph-Labels neu rendern (uiLocale Teil des Hash).
      this.$watch(() => Alpine.store('shell').uiLocale, () => {
        if (window.__app.showFiguresCard && Alpine.store('catalog').figuren?.length) {
          this.renderFigurGraph();
        }
      });

      // Figuren-Daten aendern sich auch bei OFFENER Karte: Einzel-Delete einer
      // stale-Figur (root#deleteStaleFigur) und jeder loadFiguren nach einem Job,
      // der Figuren neu abgleicht. Ohne diesen Watcher rendert der Graph nur beim
      // Oeffnen/Buchwechsel/Modus-/Sprachwechsel — die geloeschte Figur bleibt als
      // Knoten stehen, obwohl ihre Listenzeile weg ist. Die Render-Signatur in
      // core.js#renderFigurGraph faengt den No-op-Fall ab, ein Watcher-Lauf ohne
      // layout-relevante Aenderung kostet also nichts.
      // Leeres Array bewusst uebersprungen (wie beim uiLocale-Watcher): waehrend
      // book:changed steht figuren kurz auf [] — rendern wuerde dort nur den
      // Leer-Platzhalter aufblitzen lassen. Faellt die letzte Figur weg, blendet
      // das Partial den ganzen Graph-Block ohnehin aus (figuren.length > 0).
      this.$watch(() => Alpine.store('catalog').figuren, (figuren) => {
        if (window.__app.showFiguresCard && figuren?.length) this.renderFigurGraph();
      });

      // Theme-Wechsel (Hell/Dunkel) → neu zeichnen. Die Canvas-Farben stecken im
      // gezeichneten Bild; ein CSS-Wechsel erreicht sie nicht.
      this._themeObserver = observeThemeChange(() => {
        if (window.__app.showFiguresCard && Alpine.store('catalog').figuren?.length) {
          this.renderFigurGraph();
        }
      });

      // Native Fullscreen-API: State spiegeln, Canvas neu fitten, beim Verlassen
      // (Esc / Browser-UI) Toggle-Flag sauber zurücksetzen.
      attachFullscreenSync({
        resolveWrap: () => document.getElementById('figuren-graph')?.closest('.figuren-graph-wrap'),
        signal: this._lifecycle.signal,
        onChange: (active) => {
          this.figurenGraphFullscreen = active;
          if (this._figurenNetwork) {
            // vis-network hört auf window.resize → Canvas an neuen Container anpassen.
            window.dispatchEvent(new Event('resize'));
            requestAnimationFrame(() => {
              this._figurenNetwork?.fit({ animation: { duration: 200, easingFunction: 'easeInOutQuad' } });
            });
          }
        },
      });
    },

    destroy() {
      // Falls Karte im Vollbild abgebaut wird (Buchwechsel etc.): zuerst Browser-Fullscreen verlassen.
      if (document.fullscreenElement?.classList?.contains?.('figuren-graph-wrap')) {
        try { document.exitFullscreen?.(); } catch {}
      }
      this._lifecycle?.destroy();
      if (this._figurenAlterPollTimer) { clearInterval(this._figurenAlterPollTimer); this._figurenAlterPollTimer = null; }
      if (this._figurSchulPollTimer) { clearInterval(this._figurSchulPollTimer); this._figurSchulPollTimer = null; }
      this._themeObserver?.disconnect();
      this._themeObserver = null;
      if (this._figurenNetwork) { this._figurenNetwork.destroy(); this._figurenNetwork = null; }
      this._graphTheme = null;
    },

    // Memo-Helper (cards/card-memo.js); Reset über this._memos = {} (load-Pfad / book:changed).
    ...memoMethods,

    // UI-Helper: aus Comboboxen via x-effect mehrfach pro Render gerufen
    // (für _disabled + options), ausserdem Spaltenachse von Präsenz-Heatmap und
    // Graph-Swimlane. Memo auf Identität der Quell-Daten + Label-/Reihenfolge-Map
    // (tree/build.js setzt beide bei jedem Build neu) — ohne sie bliebe nach
    // Umsortieren oder Umbenennen die alte Kapitelfolge stehen.
    figurenKapitelOptionen() {
      const root = window.__app;
      const figuren = Alpine.store('catalog').figuren;
      return this._memo('kapitel', [figuren, root._chapterLabelMap, root._chapterIdOrderMap],
        () => root._kapitelOptionen((figuren || []).flatMap(f => (f.kapitel || []).map(k => k.chapter_id))));
    },

    _figurenKapitelFilter() {
      return activeFilterId(Alpine.store('catalogUi').figurenFilters.kapitelId, this.figurenKapitelOptionen());
    },

    figurenSeitenOptionen() {
      const root = window.__app;
      const figuren = Alpine.store('catalog').figuren;
      const kapitelId = this._figurenKapitelFilter();
      return this._memo('seiten', [figuren, kapitelId, root._pageIdOrderMap, root.$store.nav.pages], () => {
        if (!kapitelId) return [];
        return root._seitenOptionen([...computeFigurenSeiten(figuren, kapitelId)]);
      });
    },

    filteredFiguren() {
      const root = window.__app;
      const f = Alpine.store('catalogUi').figurenFilters;
      const figuren = root.$store.catalog.figuren;
      const orderMap = root._chapterIdOrderMap;
      const suche = f.suche ?? '';
      const typ = f.typ ?? '';
      const sort = f.sort ?? '';
      const locale = Alpine.store('shell').uiLocale;
      const kapitelId = this._figurenKapitelFilter();
      const seiteId = kapitelId ? activeFilterId(f.seiteId, this.figurenSeitenOptionen()) : '';
      return this._memo('filtered', [figuren, orderMap, suche, typ, sort, locale, kapitelId, seiteId],
        () => computeFilteredFiguren(figuren, id => orderMap?.get(id), {
          suche, typ, sort, kapitelId, seiteId,
          typLabel: (t) => (t ? root.t('figuren.type.' + t) : ''),
        }));
    },

    // i18n aus einer Sub-Methode: `t` haengt am Root, die Karte greift ueber
    // window.__app darauf zu. Ein Helfer statt `window.__app?.t?.(…)` an jeder
    // Aufrufstelle — die Optional-Chaining-Kette verleitete zu hartcodierten
    // Fallback-Strings ("Fehler"), und die stehen dann ausserhalb der Locale-
    // Dateien (harte Regel „UI-Strings nur in i18n"). Alle drei gespreadeten
    // Reiter-Module (alter/lebenslauf/presence) nutzen ihn.
    _t(key, params) {
      return window.__app?.t?.(key, params) ?? '';
    },

    // Buchwechsel/View-Reset: geladener Index gehoert zum alten Buch, ein
    // laufender Poll zu einem Job, dessen Ergebnis niemand mehr anzeigt.
    _resetFigurenAlter() {
      if (this._figurenAlterPollTimer) { clearInterval(this._figurenAlterPollTimer); this._figurenAlterPollTimer = null; }
      this.figurenAlterData = null;
      this._figurenAlterLoadedBookId = null;
      this.figurenAlterLoading = false;
      this.figurenAlterProgress = 0;
      this.figurenAlterStatus = '';
      this.figurenAlterOpenId = null;
      this.figurenAlterFilters = { suche: '', typ: '', nur: '' };
      // Die Spaltenwahl zeigt auf Figuren des alten Buchs — sie muss mit, sonst
      // steht die Matrix beim naechsten Oeffnen leer da, ohne zu sagen warum.
      this.figurenLebenslaufIds = [];
      this.figurenLebenslaufFilters = { suche: '', typ: '' };
    },

    ...graphMethods,
    ...presenceMethods,
    ...figurenAlterMethods,
    ...figurenLebenslaufMethods,
    ...plotBacklinkMethods,
    ...figurPflegeMethods,
    ...figurenSchulwegMethods,
  }));
}
