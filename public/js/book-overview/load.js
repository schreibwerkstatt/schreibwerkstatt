// Load-Pipeline + Memo-Helper.
// `loadBookOverview` holt alle Tile-Daten in einer gebündelten Antwort (/overview)
// und schreibt das Resultat in den State. `_checkBookStatsStaleness` läuft
// anschliessend silent im Hintergrund; `resetBookOverview` setzt State + Memos
// beim Buchwechsel auf den Initialstand zurück.
import { fetchJsonRetry as fetchJsonRetryBase } from '../utils.js';
import { komplettHiddenFor } from '../cards/feature-registry.js';
import { memoMethods } from '../cards/card-memo.js';
import { isSelectedBook } from '../cards/book-guard.js';
import { assignCatalogList } from '../cards/catalog-store.js';

const fetchJsonRetry = (url, opts) => fetchJsonRetryBase(url, opts, 'bookOverview');

// Recent-Kachel: angezeigt werden höchstens so viele. Der Server liefert mehr
// (routes/overview.js#RECENT_LIMIT) — er kennt auch Abschnitte, die inzwischen
// gelöscht oder in ein anderes Buch verschoben sind; die fallen beim Abgleich
// mit nav.pages heraus, und die Liste bliebe sonst kürzer.
export const RECENT_SHOW_LIMIT = 5;

// Bereits geladener Katalog (Alpine.store('catalog')) für das aktuelle Buch, oder
// null. Der Katalog wird beim Buchwechsel geleert (app-view/bookscope.js#
// _resetBookScopedState) und nur von Ladern mit Buchwechsel-Guard befüllt —
// ein nicht-leerer Katalog gehört also zum offenen Buch. Leer heisst „nicht
// geladen" ODER „keine Einträge"; beides führt zum eigenen Fetch.
function _catalogList(name) {
  try {
    const list = (typeof Alpine !== 'undefined') ? Alpine.store('catalog')?.[name] : null;
    return Array.isArray(list) && list.length ? list : null;
  } catch { return null; }
}


// Teile der gebündelten Antwort (routes/overview.js), Wert = `guarded`: ein
// Ausfall zieht den Fehler-Banner, ein fehlendes Recht wird als `forbidden`
// vermerkt. Die übrigen sind optionale Planungswerkzeuge bzw. Zusatzsignale —
// ihr Fehlen ist normal (nie geplant, kein Scan, Betrachter ohne Editor-Recht),
// darum still: das Tile bleibt via x-if einfach aus.
export const OVERVIEW_PARTS = {
  coverage: true, heat: true, review: true, recent: true,
  figuren: true, szenen: true, orte: true, songs: true,
  lektorat: true, rueckblick: true,
  plot: false, motifs: false, lexicon: false, ideen: false, bookChat: false,
};

/** Pure: gebündelte Antwort `{ parts }` in Tile-Daten + Fehler-/Rechte-Listen.
 *  `bundle === null` (Request ganz ausgefallen) → ein Eintrag `overview` im
 *  Banner. Ein fehlender Teil (per `skip` ausgelassen, ohne Tile für dieses
 *  Buch) ist weder Fehler noch Recht. */
export function readOverviewBundle(bundle) {
  const data = {};
  const failed = [];
  const forbidden = [];
  if (!bundle || typeof bundle !== 'object' || !bundle.parts) {
    return { data, failed: ['overview'], forbidden };
  }
  for (const [key, guarded] of Object.entries(OVERVIEW_PARTS)) {
    const part = bundle.parts[key];
    if (!part) continue;
    if (part.forbidden) { if (guarded) forbidden.push(key); continue; }
    if (part.error) { if (guarded) failed.push(key); continue; }
    data[key] = part.data;
  }
  return { data, failed, forbidden };
}

// Initialer Tile-State der Karte. SSoT für BEIDE Seiten: die Card-Registrierung
// spreadet das Objekt als Startzustand, `resetBookOverview` weist es beim
// Buchwechsel erneut zu. Vorher waren das zwei handgepflegte Listen mit je 19
// Feldern, die synchron bleiben mussten.
export function initialOverviewState() {
  return {
    overviewLoading: false,
    overviewBookId: null,
    // Buch, zu dem die angezeigten Tile-Daten gehören. Weicht beim Buchwechsel
    // von `overviewBookId` ab, bis der neue Load zugewiesen hat.
    overviewDataBookId: null,
    overviewStats: [],
    overviewCoverage: null,
    overviewHeat: null,
    overviewLastReview: null,
    overviewPrevReview: null,
    overviewRecent: [],
    overviewFiguren: [],
    overviewSzenen: [],
    overviewOrte: [],
    overviewSongs: [],
    overviewLektoratTime: null,
    overviewIsFinished: false,
    overviewDailyGoalChars: null,
    overviewGoalTargetChars: null,
    overviewGoalDeadline: null,
    overviewBuchtyp: null,
    overviewRueckblickCoverage: null,
    overviewPlot: null,
    overviewIdeen: null,      // eigene Ideen des Buchs (Ideen-Tile); null = nicht ladbar (forbidden)
    overviewBookChatSessions: null, // Zahl eigener Buch-Chat-Gespräche («Nächste Schritte»); null = unbekannt
    overviewMotifs: null,
    overviewLexiconData: null,
    overviewLoadErrors: [],
    // Teile, die als `forbidden` kamen (fehlendes Recht, kein Fehler).
    overviewForbidden: [],
  };
}

// True, wenn nav.pages zum Buch `bookId` gehört und nicht leer ist. Primär
// über `_treeBookId` (gesetzt direkt nach dem Baum-Bau in tree/load.js), sonst
// über die book_id der Seiten selbst.
export function treeBelongsTo(app, bookId) {
  const pages = Alpine.store('nav').pages || [];
  if (!pages.length) return false;
  const treeBook = app?._treeBookId;
  if (treeBook != null) return String(treeBook) === String(bookId);
  return pages.every(p => p.book_id == null || String(p.book_id) === String(bookId));
}

export const loadMethods = {
  // `_memo(key, deps, fn)` — geteilter Helper (cards/card-memo.js). Cache-Hit
  // nur, wenn ALLE Source-Refs (deps) identisch zur letzten Compute sind.
  // Wichtig für Tiles, die zusätzlich zu `overviewXxx` auch
  // `Alpine.store('nav').tree`/`app.figuren` lesen — sonst wird ein Compute mit
  // leerem `tree` (während loadPages noch läuft) als `null` gecached und das
  // Tile bleibt aus, obwohl `tree` danach befüllt wird (Haupt-Source-Ref
  // unverändert). Memos, die lokalisierte Strings backen, führen zusätzlich
  // `_uiLocale()` in den Deps.
  ...memoMethods,

  async loadBookOverview(bookId, opts = {}) {
    if (!bookId) return;
    // Dedupe: laufender Load fürs gleiche Buch wird nicht verdoppelt. Ein
    // ausdrücklicher Refresh (`fresh`) während des Loads wird aber gemerkt und
    // läuft danach einmal — der laufende Load kann den Stand vor der Änderung
    // tragen (und hat ggf. den Katalog-Cache benutzt). Buchwechsel setzt
    // _loadingBookId auf die neue ID; In-flight-Antworten fürs alte Buch fallen
    // durch den overviewBookId-Guard raus, ein gemerkter Refresh verfällt.
    if (this._loadingBookId != null && String(this._loadingBookId) === String(bookId)) {
      if (opts.fresh) this._pendingFreshLoad = { bookId, opts: { ...opts } };
      return;
    }
    if (this._pendingFreshLoad && String(this._pendingFreshLoad.bookId) !== String(bookId)) {
      this._pendingFreshLoad = null;
    }
    await this._loadBookOverviewOnce(bookId, opts);
    const pending = this._pendingFreshLoad;
    if (pending && this._loadingBookId == null
        && String(pending.bookId) === String(bookId)
        && String(this.overviewBookId) === String(bookId)) {
      this._pendingFreshLoad = null;
      await this.loadBookOverview(bookId, pending.opts);
    }
  },

  async _loadBookOverviewOnce(bookId, opts) {
    this._loadingBookId = bookId;
    // `opts.silent` (Tab-Rueckkehr): kein Spinner, und der Fehler-Banner bleibt
    // bis zur Antwort stehen, statt kurz zu verschwinden.
    if (!opts.silent) this.overviewLoading = true;
    this.overviewBookId = bookId;
    // Fehlerstand des vorigen Loads verwerfen: der Banner gilt dem laufenden.
    if (!opts.silent) this.overviewLoadErrors = [];
    // Ausgefallene Teile sammeln (nach dem einen Retry aus fetchJsonRetry), statt
    // sie still zu schlucken — die Overview zeigt danach einen dezenten Hinweis +
    // Retry, damit ein ausgefallenes Tile nicht als „keine Daten" missverstanden wird.
    const failed = [];
    const forbidden = [];
    // Figuren, Schauplätze, Szenen: liegt der Katalog fürs offene Buch schon vor
    // (loadPages lädt die Figuren, Orte-/Szenen-Karte und Palette den Rest), dieselbe
    // Antwort wiederverwenden statt erneut zu holen (`skip`). Der ausdrückliche
    // Refresh (`fresh`) fragt immer den Server.
    const cachedFiguren = opts.fresh ? null : _catalogList('figuren');
    const cachedOrte = opts.fresh ? null : _catalogList('orte');
    const cachedSzenen = opts.fresh ? null : _catalogList('szenen');
    const skip = [cachedFiguren && 'figuren', cachedOrte && 'orte', cachedSzenen && 'szenen'].filter(Boolean);
    try {
      // Alle Tile-Daten in EINER Antwort (routes/overview.js); Snapshot-Verlauf +
      // Buch-Einstellungen parallel aus dem geteilten Loader.
      const [shared, bundle] = await Promise.all([
        this._loadSharedBookStats(bookId, opts),
        fetchJsonRetry(`/overview/${bookId}${skip.length ? `?skip=${skip.join(',')}` : ''}`).catch((e) => {
          console.warn('[bookOverview] overview fehlgeschlagen', e);
          return null;
        }),
      ]);
      if (this.overviewBookId !== bookId) return;
      const read = readOverviewBundle(bundle);
      failed.push(...(shared?.failed || []), ...read.failed);
      forbidden.push(...read.forbidden);
      const d = read.data;
      const figuren = cachedFiguren ? { figuren: cachedFiguren } : d.figuren;
      const szenen = cachedSzenen ? { szenen: cachedSzenen } : d.szenen;
      const orte = cachedOrte ? { orte: cachedOrte, fromCatalog: true } : d.orte;
      const settings = shared?.settings || null;
      this.overviewStats = Array.isArray(shared?.stats) ? shared.stats : [];
      this.overviewCoverage = d.coverage || null;
      this.overviewHeat = d.heat || null;
      const reviewArr = Array.isArray(d.review) ? d.review : [];
      this.overviewLastReview = reviewArr[0] || null;
      this.overviewPrevReview = reviewArr[1] || null;
      this.overviewRecent = Array.isArray(d.recent) ? d.recent : [];
      this.overviewFiguren = Array.isArray(figuren?.figuren) ? figuren.figuren : [];
      // Nur Szenen, die im Text stehen — stale-Einträge zählen in keiner Kachel
      // (gleiche Regel wie die Szenen-Karte, book/szenen-stats.js).
      this.overviewSzenen = Array.isArray(szenen?.szenen) ? szenen.szenen.filter(s => !s.stale) : [];
      this.overviewOrte = Array.isArray(orte?.orte) ? orte.orte : [];
      // Die Schauplatz-Kachel zeigt ihre Top-Orte als Entitäts-Referenzen, die
      // Name und Sprungziel aus `catalog.orte` auflösen. Den lädt sonst nur die
      // Orte-Karte — ohne ihn stünde in der Kachel die loc_-ID. Gleiche Antwort
      // wie loadOrte, also einspeisen, solange der Katalog leer ist.
      if (!orte?.fromCatalog && Array.isArray(orte?.orte) && !Alpine.store('catalog').orte?.length) {
        assignCatalogList('orte', bookId, orte.orte);
        Alpine.store('catalogUi').orteUpdatedAt = orte.updated_at || null;
      }
      this.overviewSongs = Array.isArray(d.songs?.songs) ? d.songs.songs : [];
      this.overviewLektoratTime = d.lektorat || null;
      this.overviewIsFinished = !!settings?.is_finished;
      this.overviewDailyGoalChars = settings?.daily_goal_chars != null ? Number(settings.daily_goal_chars) : null;
      this.overviewGoalTargetChars = settings?.goal_target_chars != null ? Number(settings.goal_target_chars) : null;
      this.overviewGoalDeadline = settings?.goal_deadline || null;
      this.overviewBuchtyp = settings?.buchtyp || null;
      this.overviewPlot = d.plot && Array.isArray(d.plot.beats) ? d.plot : null;
      this.overviewIdeen = d.ideen && Array.isArray(d.ideen.ideen) ? d.ideen.ideen : null;
      this.overviewBookChatSessions = Number.isFinite(d.bookChat?.count) ? d.bookChat.count : null;
      this.overviewMotifs = d.motifs && Array.isArray(d.motifs.motifs) ? d.motifs : null;
      this.overviewLexiconData = d.lexicon && typeof d.lexicon === 'object' && !Array.isArray(d.lexicon) ? d.lexicon : null;
      // Rückblick-Heatmap-Coverage liefert der Server nur für Tagebücher.
      this.overviewRueckblickCoverage = d.rueckblick || null;
      this.overviewDataBookId = bookId;
      this._memos = {};
      this.overviewLoadErrors = failed;
      this.overviewForbidden = forbidden;
    } catch (e) {
      console.error('[loadBookOverview]', e);
      // Unerwarteter Fehler beim Zuweisen: Hinweis + Retry zeigen, statt den
      // Fehlerstand des vorigen Loads (oder gar keinen) stehen zu lassen.
      if (this.overviewBookId === bookId) this.overviewLoadErrors = [...failed, 'unexpected'];
    } finally {
      if (this._loadingBookId === bookId) this._loadingBookId = null;
      if (this.overviewBookId === bookId) this.overviewLoading = false;
    }
    // Background-Auto-Sync: vergleiche pages[].updated_at gegen page_stats-Cache.
    // Wenn Seiten seit dem letzten Sync editiert wurden → /sync/book im Hintergrund,
    // danach Overview-Tiles refreshen. Silent (kein Spinner / Status).
    this._checkBookStatsStaleness(bookId);
  },

  // Snapshot-Verlauf + Buch-Einstellungen kommen aus dem GETEILTEN Loader
  // (app-view/bookscope.js#loadDailyProgress) — es sind exakt die zwei
  // Antworten, die auch der Header-Donut braucht. `reuse` beim normalen
  // Oeffnen, frisch beim ausdruecklichen Refresh (Knopf / Re-Klick auf die
  // Karte). Was sich waehrend der Sitzung am Umfang aendert, faengt ohnehin
  // der Staleness-Check unten ab, nicht ein erneuter Fetch derselben Liste.
  //
  // Fallback auf eigene Fetches, solange kein App-Root steht: die Karte darf
  // sich nicht darauf verlassen, und die Unit-Tests mounten die Methoden ohne
  // Wurzel.
  async _loadSharedBookStats(bookId, { fresh = false } = {}) {
    const app = typeof window !== 'undefined' ? window.__app : null;
    if (app?.loadDailyProgress) return app.loadDailyProgress(bookId, { reuse: !fresh });
    const failed = [];
    const grab = (key, fallback) => (e) => {
      failed.push(key);
      console.warn(`[bookOverview] ${key} fehlgeschlagen`, e);
      return fallback;
    };
    const [stats, settings] = await Promise.all([
      fetchJsonRetry(`/history/book-stats/${bookId}`).catch(grab('stats', [])),
      fetchJsonRetry(`/booksettings/${bookId}`).catch(grab('settings', null)),
    ]);
    return { stats: Array.isArray(stats) ? stats : [], settings: settings || null, failed };
  },

  // True, sobald die Karte zerstört wurde (Lifecycle-AbortController). Die
  // Hintergrund-Kette unten prüft das an jedem await-Punkt, damit ein Unmount
  // während des Wartens keinen /sync/book mehr nachschiebt.
  _overviewAborted() {
    return this._lifecycle?.signal?.aborted === true;
  },

  // Silent background staleness check + auto-sync. Re-Entry-sicher via _staleCheckBookId
  // und _statsSyncBookId. Während des Post-Sync-Reloads bleibt _statsSyncBookId gesetzt,
  // damit der rekursive Check sofort returnt (kein Loop).
  //
  // Das Stale-Urteil fällt der Server (`POST /history/stats-stale`) — SSoT über
  // page_stats + book_stats_history. Der Client liefert nur seine autoritative
  // Content-Store-Seitenliste ({ id, updated_at }).
  async _checkBookStatsStaleness(bookId) {
    if (!bookId) return;
    if (typeof window === 'undefined') return;
    const app = window.__app;
    if (!app) return;
    if (this._statsSyncBookId === bookId) return;
    if (this._staleCheckBookId === bookId) return;
    this._staleCheckBookId = bookId;
    try {
      // Nach Buchwechsel steht in nav.pages noch der Baum des VORIGEN Buchs,
      // bis loadPages den neuen gebaut hat. Kurz pollen, bis der Baum zum
      // aktuellen Buch gehört, dann aufgeben — mit fremden Seiten-IDs fiele das
      // Server-Urteil zwangsläufig auf „stale" und stiesse einen unnötigen
      // /sync/book an.
      for (let i = 0; i < 30 && !treeBelongsTo(app, bookId); i++) {
        await new Promise(r => setTimeout(r, 100));
        if (this._overviewAborted()) return;
        if (!isSelectedBook(bookId)) return;
      }
      if (!treeBelongsTo(app, bookId)) return;
      const pages = Alpine.store('nav').pages || [];
      const payload = pages.map(p => ({ id: p.id, updated_at: p.updated_at }));
      const verdict = await fetchJsonRetry(`/history/stats-stale/${bookId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pages: payload }),
      }).catch(() => null);
      if (!verdict?.stale) return;
      if (this._overviewAborted()) return;
      if (!isSelectedBook(bookId)) return;
      this._statsSyncBookId = bookId;
      try {
        const res = await fetch(`/sync/book/${bookId}`, { method: 'POST' });
        if (!res.ok) return;
        if (this._overviewAborted()) return;
        if (!app.showBookOverviewCard || !isSelectedBook(bookId)) return;
        // Gezielter Reload: nur die stats-abhängigen Tiles + tokEsts, NICHT alle
        // Endpoints — Figuren/Orte/Szenen/Reviews/… ändert ein Stats-Sync nicht.
        await this._reloadStatsTiles(bookId, pages, app);
      } finally {
        if (this._statsSyncBookId === bookId) this._statsSyncBookId = null;
      }
    } catch (e) {
      console.warn('[bookOverview] staleness auto-sync failed', e);
    } finally {
      if (this._staleCheckBookId === bookId) this._staleCheckBookId = null;
    }
  },

  // Refresh nach Auto-Sync: nur Snapshot-Verlauf + Coverage neu holen und tokEsts
  // aktualisieren. tokEsts REASSIGN (nicht Index-Assign): book-overview-Methoden
  // memoizen mit der tokEsts-Ref als Source — dieselbe Referenz behalten hiesse
  // Cache-Hit → stale Compute (Streak-Heatmap: heutige Cell fehlt). Reassign
  // triggert Memo-Invalidate. Gleicher tokEsts-Pfad wie syncBookStats in bookstats.js.
  async _reloadStatsTiles(bookId, pages, app) {
    const [stats, coverage, fresh] = await Promise.all([
      fetchJsonRetry(`/history/book-stats/${bookId}`).catch(() => null),
      fetchJsonRetry(`/history/coverage/${bookId}`).catch(() => null),
      fetchJsonRetry(`/history/page-stats/${bookId}`).catch(() => null),
    ]);
    if (this._overviewAborted()) return;
    if (this.overviewBookId !== bookId || !isSelectedBook(bookId)) return;
    if (Array.isArray(stats)) {
      this.overviewStats = stats;
      // Der Header-Donut liest dieselbe Zeitreihe aus dem geteilten Store.
      // Ohne dieses Nachziehen zeigte er nach dem Hintergrund-Sync weiter den
      // Stand von davor, waehrend die Kachel daneben schon den neuen hatte.
      app.publishDailyProgressStats?.(bookId, stats);
    }
    if (coverage) this.overviewCoverage = coverage;
    if (fresh) {
      const updated = { ...app.tokEsts };
      for (const p of pages) {
        const c = fresh[p.id];
        if (c && c.updated_at === p.updated_at) {
          updated[p.id] = { tok: c.tok, words: c.words, chars: c.chars };
        }
      }
      app.tokEsts = updated;
    }
    this._memos = {};
  },

  // Tagebücher (buchtyp 'tagebuch') sind Ich-Perspektive + datierte Einträge ohne
  // Ensemble/Dramaturgie — die narrativen Analyse-Tiles (Figuren-/Schauplatz-Matrix,
  // Szenen-Wertung, Kapitel-Verteilung/-Findings) sind dort bedeutungslos und werden
  // ausgeblendet. Schreibstats/Streak, Lektorat, Bewertung, Recent und die
  // Figuren-/Orte-Top-Listen bleiben.
  overviewIsTagebuch() {
    return this.overviewBuchtyp === 'tagebuch';
  },

  // True, wenn das Buch Seiten hat, die Komplettanalyse (Figuren/Schauplätze/
  // Szenen) aber noch nie gelaufen ist — dann zeigt die Overview ein einzelnes
  // CTA-Tile statt drei leerer Zählkacheln kommentarlos auszublenden. Tagebücher
  // sind ausgenommen: dort sind die Zählkacheln ausgeblendet, die Analyse ist
  // optional (Figuren/Orte als Rückblick-Kontext) und kein Pflichtschritt; Buchtypen, in
  // denen die Komplettanalyse gar nicht angeboten wird (Ressort), ebenfalls —
  // ein Handlungsaufruf ohne erreichbares Ziel wäre eine Sackgasse.
  overviewNeedsAnalysis() {
    if (this.overviewIsTagebuch()) return false;
    // Ohne Leserecht auf die Analyse-Ergebnisse (Betrachter: `forbidden`) sind die
    // Zählkacheln nicht leer, sondern unsichtbar — kein Handlungsaufruf.
    if ((this.overviewForbidden || []).length) return false;
    if (komplettHiddenFor(this.overviewBuchtyp)) return false;
    if (!(Alpine.store('nav').pages || []).length) return false;
    return this.overviewFigurenCount() === 0
      && this.overviewSzenenCount() === 0
      && this.overviewOrteCount() === 0;
  },

  // True, solange das Grid noch die Daten eines anderen Buchs zeigt
  // (Buchwechsel, Load läuft). Refresh desselben Buchs zählt nicht.
  overviewShowsOtherBook() {
    return this.overviewLoading && this.overviewDataBookId !== this.overviewBookId;
  },

  resetBookOverview() {
    Object.assign(this, initialOverviewState());
    this._memos = {};
  },

  // Rollup-Helfer: alle per-Kapitel-Tiles aggregieren Sub-Kapitel auf ihr
  // Wurzel-Kapitel (Top-Level, depth=1). Tree ist flach + depth-annotiert
  // (siehe tree.js#loadPages). Solo-Wrapper (Spezialseiten ohne Kapitel)
  // ausgeklammert — verzerren sonst Median/Skalierung. Name-Map als
  // Fallback NUR für Server-Rows, die gar keine `chapter_id` liefern
  // (Backfill-Lücken), und nur für eindeutige Namen. Eine vorhandene ID, die
  // nicht aufgeht (ausgeschlossen, gelöscht), fällt nie auf den Namen zurück.
  //
  // Von Export und Analyse ausgeschlossene Kapitel (`excluded`, kaskadiert auf
  // alle Unterkapitel wie lib/load-contents.js#_excludedChapterIds) zählen in
  // keiner Kapitel-Kachel: sie fehlen in `roots`, und `rootOf`/`rootOfName`
  // liefern für sie `null` — Verteilung, Präsenz-Matrizen, Findings,
  // Lektoratszeit und alle Mediane sehen sie nicht. `anyRootOf` ignoriert den
  // Ausschluss (Hero: die Gliederung des Buchs zählt alle Kapitel).
  //
  // `excluded` wird im Baum in place umgeschaltet (tree-context-menu.js#
  // setChapterExcluded), ohne `tree` neu zuzuweisen — darum steckt die Menge
  // der ausgeschlossenen IDs als Signatur in den Deps. Konsumenten-Memos
  // führen das Rollup-Objekt selbst als Dep.
  _chapterRollup() {
    const tree = Alpine.store('nav').tree || [];
    let exSig = '';
    for (const i of tree) if (i.type === 'chapter' && i.excluded) exSig += i.id + ',';
    return this._memo('rollup', [tree, exSig], () => {
      const chs = tree.filter(i => i.type === 'chapter' && !i.solo);
      const byId = new Map(chs.map(c => [Number(c.id), c]));
      // Nur eindeutige Namen: «Einleitung» in Teil I und Teil II sind zwei Orte,
      // ein Name→Kapitel-Treffer müsste raten (docs/chapter-hierarchy.md).
      const byName = new Map();
      const dupNames = new Set();
      for (const c of chs) {
        if (byName.has(c.name)) dupNames.add(c.name);
        else byName.set(c.name, c);
      }
      for (const n of dupNames) byName.delete(n);
      const rootCache = new Map();
      const exCache = new Map();
      const anyRootOf = (id) => {
        if (id == null) return null;
        const key = Number(id);
        if (rootCache.has(key)) return rootCache.get(key);
        let cur = byId.get(key);
        const path = [key];
        while (cur?.parent_id != null) {
          const pid = Number(cur.parent_id);
          path.push(pid);
          cur = byId.get(pid);
        }
        for (const k of path) rootCache.set(k, cur || null);
        return cur || null;
      };
      const isExcluded = (id) => {
        if (id == null) return false;
        const key = Number(id);
        if (exCache.has(key)) return exCache.get(key);
        let cur = byId.get(key);
        let out = false;
        for (let guard = 0; cur && guard < 64; guard++) {
          if (cur.excluded) { out = true; break; }
          cur = cur.parent_id != null ? byId.get(Number(cur.parent_id)) : null;
        }
        exCache.set(key, out);
        return out;
      };
      const rootOf = (id) => (isExcluded(id) ? null : anyRootOf(id));
      const rootOfName = (name) => {
        if (!name) return null;
        const ch = byName.get(name);
        return ch ? rootOf(ch.id) : null;
      };
      // Fundstelle in einem ausgeschlossenen Kapitel? Für Zählungen ohne
      // Kapitel-Zeilen (Top-Listen): dieselbe ID-vor-Name-Regel wie rootOf/rootOfName.
      const isExcludedRef = (id, name) => {
        if (id != null) return isExcluded(id);
        const ch = name ? byName.get(name) : null;
        return ch ? isExcluded(ch.id) : false;
      };
      // Root = ohne parent_id. Stabiler als depth===1 (legacy/tree-Fixtures
      // ohne depth-Annotation funktionieren weiter; Tree-Walker setzt depth=1
      // genau dann, wenn parent_id === null).
      const roots = chs.filter(c => c.parent_id == null && !c.excluded);
      return { roots, rootOf, rootOfName, anyRootOf, isExcluded, isExcludedRef, byId, byName };
    });
  },
};
