import { contentRepo } from '../../repo/content.js';
import { getDeviceId } from '../../device-id.js';
import { EVT } from '../../events.js';

// Leiser Nachzug des Seitenbaums — die zweite Haelfte von Stale-While-Revalidate.
//
// DAS PROBLEM, DAS DIESE DATEI LOEST: der SW liefert `/content/*` als SWR aus.
// Der Cache-Hit geht an die UI, die Netzantwort nur in den Cache. Fuer den
// Kaltstart ist das genau richtig (Sidebar sofort, offline ueberhaupt) — aber
// die schon gerenderte Sidebar erfaehrt vom frischen Stand nie. Deshalb zeigt
// der erste Reload den Baum vom letzten Besuch und erst der zweite den
// aktuellen. Die Antwort ist NICHT „alles frisch lesen" (das kostet das
// Offline-Versprechen und die sofortige Sidebar), sondern: den Baum nachziehen,
// sobald bekannt ist, dass er abweicht.
//
// DREI MELDER, EIN NACHZUG:
//   1. der SW selbst    — Revalidierung != ausgelieferter Stand (EVT.CONTENT_UPDATED)
//   2. der Collab-Feed  — eine Aenderung an einer Seite, die im Baum fehlt (= neu angelegt)
//   3. die Drift-Probe  — `/changes` seit dem Stand des Baums, unabhaengig vom
//                         5s-Poll (der laeuft nur bei GLEICHZEITIG offenen Geraeten)
//
// „Leise" heisst: kein `treeLoading` (kein Dimmen, keine Klick-Sperre), kein
// State-Clearing, kein Plaketten-Refetch. Der Baum wird ersetzt, sonst nichts.
// Der Aufklapp-Zustand ueberlebt, weil `_buildTreeFromResponse` ihn aus
// localStorage liest und jeder Toggle dort sofort landet (tree/open-state.js).

// Entprellung: die drei Melder koennen dicht hintereinander feuern (SW-Meldung
// + Collab-Tick auf denselben Schreibvorgang). Ein Fetch reicht.
const CATCH_UP_DEBOUNCE_MS = 800;
// Wie oft der Nachzug einem laufenden Voll-Load ausweicht, bevor er aufgibt.
// Gedeckelt, damit ein haengender Load (verwaister Abbruch) keine Dauerschleife
// treibt; 5 x 800 ms decken einen langsamen Boot ab.
const CATCH_UP_MAX_RETRIES = 5;
// Melder, nach denen der Cache-Eintrag bereits stimmt: der SW legt die neue
// Antwort ab, BEVOR er meldet — dort reicht ein normaler Read, und der Nachzug
// kostet gar keinen Roundtrip. Die beiden anderen Melder wissen nur, DASS sich
// etwas geaendert hat; ihr Cache-Eintrag ist noch der alte, sie brauchen `fresh`.
const CACHE_IS_FRESH_FOR = new Set(['sw-revalidate']);
// Dieselbe Frage (Buch + Cursor) nicht zweimal kurz hintereinander stellen: beim
// Boot fragen `loadPages` und der erste Geraete-Ping, spaeter jeder Seitenwechsel
// (`_pingDevicePresenceNow`) mit unveraendertem Baum. Kuerzer als der 40-s-Tick,
// damit die periodische Probe nie in das Fenster faellt.
const DRIFT_PROBE_DEDUP_MS = 30_000;

// Als reine Funktion herausgezogen — gleiche Bauart wie `readsFresh` in
// tree/load.js: die Regel ist eine Aussage ueber Melder, keine Implementierung.
export function catchUpReadsFresh(reason) {
  return !CACHE_IS_FRESH_FOR.has(reason);
}

export const treeCatchUpMethods = {
  // Jüngster Seitenstand im aktuell gerenderten Baum. Cursor der Drift-Probe:
  // die Frage ist „hat jemand nach DIESEM Stand geschrieben", nicht „seit wann
  // laeuft dieser Tab". Leerer Baum → kein Cursor → keine Probe (ein `since`
  // zu raten hiesse, jedes Buch einmal als veraendert zu melden).
  _treeSince() {
    let max = '';
    for (const p of this.$store.nav.pages) {
      const u = p.updated_at || '';
      if (u > max) max = u;
    }
    return max || null;
  },

  _scheduleTreeCatchUp(reason, attempt = 0) {
    if (this._treeCatchUpTimer) return;
    this._treeCatchUpTimer = setTimeout(() => {
      this._treeCatchUpTimer = null;
      this._catchUpTree(reason, attempt);
    }, CATCH_UP_DEBOUNCE_MS);
  },

  async _catchUpTree(reason, attempt = 0) {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId) return;
    // Ein laufender Voll-Load (oder ein laufender Nachzug) besitzt den Baum.
    // NICHT verwerfen, sondern ausweichen: der Boot-Load endet typischerweise
    // auf einem CACHE-Stand — genau die Abweichung, um derentwillen wir hier
    // sind, bliebe sonst stehen. `_treeCatchUpInflight` ist ein kurzlebiger
    // Re-Entry-Guard, `treeLoading` gehoert `loadPages`.
    if (this.treeLoading || this._treeCatchUpInflight) {
      if (attempt < CATCH_UP_MAX_RETRIES) this._scheduleTreeCatchUp(reason, attempt + 1);
      return;
    }
    this._treeCatchUpInflight = true;
    const loadGen = this._treeLoadGen || 0;
    try {
      // Ob `fresh` noetig ist, haengt am Melder (siehe CACHE_IS_FRESH_FOR).
      // Wo es noetig ist, umgeht es den Eintrag, von dem wir WISSEN, dass er
      // abweicht — und zieht ihn dabei nach (public/sw.js, `__fresh`-Zweig),
      // sodass die Offline-Kopie mitwandert statt alt stehen zu bleiben.
      const tree = await contentRepo.bookTree(bookId, { fresh: catchUpReadsFresh(reason) });
      if (this.$store.nav.selectedBookId !== bookId) return;
      // Waehrend des Fetch hat ein Voll-Load uebernommen — laufend oder schon
      // fertig: seiner ist juenger. `treeLoading` allein sieht den zweiten Fall
      // nicht, die Generation schon.
      if (this.treeLoading || (this._treeLoadGen || 0) !== loadGen) return;
      const before = new Map(this.$store.nav.pages.map(p => [p.id, p.updated_at]));
      this._buildTreeFromResponse(tree, bookId);
      // Anderswo bearbeitete Abschnitte: ihr Schaetzwert ist der alte Umfang.
      // Verwerfen, damit der Nachlauf unten sie wie fehlende neu holt (der
      // Server rechnet veraltete page_stats dabei nach, routes/sync.js).
      const stale = this._staleTokEstIds(before);
      if (stale.length) {
        const next = { ...this.tokEsts };
        for (const id of stale) delete next[id];
        this.tokEsts = next;
      }
      // Neue und veraltete Seiten haben keinen Token-Schaetzwert — ohne das
      // bliebe ihre Plakette und die Σ-Zeile der Sidebar leer bzw. alt.
      // Idempotent, holt nur Fehlendes.
      this.loadTokenEstimates(this._tokenEstGen);
      window.dispatchEvent(new CustomEvent(EVT.PAGES_LOADED, { detail: { bookId } }));
    } catch (e) {
      // Nachzug ist Kuer: schlaegt er fehl, bleibt der bisherige Baum stehen.
      // Ihn hier zu leeren waere die schlechtere Antwort — er ist nicht falsch,
      // nur moeglicherweise unvollstaendig.
      console.warn('[treeCatchUp]', reason, e?.message || e);
    } finally {
      this._treeCatchUpInflight = false;
    }
  },

  // IDs der Seiten mit Schaetzwert, deren `updated_at` vom Stand `before`
  // (Map id → updated_at vor dem Neubau) abweicht.
  _staleTokEstIds(before) {
    const out = [];
    for (const p of this.$store.nav.pages) {
      if (!this.tokEsts[p.id] || !before.has(p.id)) continue;
      if ((before.get(p.id) || '') !== (p.updated_at || '')) out.push(p.id);
    }
    return out;
  },

  // Drift-Probe: hat eine ANDERE Partei seit dem Stand dieses Baums geschrieben?
  //
  // WARUM ES DIESE PROBE BRAUCHT, obwohl es den Collab-Poll gibt: der volle
  // 5s-Poll startet erst, wenn eine zweite Partei GLEICHZEITIG am Buch ist
  // (`_selfBookDeviceCount > 1`), und dieser Zaehler kennt nur Geraete, die in
  // den letzten 90 s gepingt haben. Das haeufigste Muster faellt damit durch:
  // gestern am Mac-Client geschrieben, heute im Browser geoeffnet. Die Probe
  // kostet einen indexierten Read mit 200-Zeilen-Deckel.
  //
  // Fuer andere Seiten zeigt sie bewusst KEINE Toasts — „wer hat was geaendert"
  // ist die Aufgabe des vollen Polls, der dafuer seinen eigenen Cursor fuehrt.
  // Hier geht es um die Frage, ob der Baum nachgezogen werden muss; einzig die
  // OFFENE Seite reicht sie an den Collab-Pfad weiter (siehe unten). Sie ist selbstbegrenzend:
  // nach dem Nachzug steht `_treeSince()` hinter der Aenderung.
  // `force`: ein Anstoss des Event-Streams meldet eine NEUE Aenderung — die
  // Dedup-Regel (gleiche Frage, gleicher Cursor) greift dann nicht.
  async _checkTreeDrift(bookId, { force = false } = {}) {
    if (!bookId || String(bookId) !== String(this.$store.nav.selectedBookId)) return;
    const since = this._treeSince();
    if (!since) return;
    const key = `${bookId}|${since}`;
    const now = Date.now();
    const last = this._lastDriftProbe;
    if (!force && last?.key === key && now - last.ts < DRIFT_PROBE_DEDUP_MS) return;
    this._lastDriftProbe = { key, ts: now };
    const params = new URLSearchParams({ since, device_id: getDeviceId() });
    try {
      const r = await fetch(`/content/books/${bookId}/changes?${params}`);
      if (!r.ok) return;
      const data = await r.json();
      if (String(bookId) !== String(this.$store.nav.selectedBookId)) return;
      // Strukturstand zuerst: ein Umbau (Kapitel angelegt/verschoben, Order-PUT
      // eines anderen Tabs) aendert keine Seite und stuende darum nie in `changes`.
      if (this._structureDrifted(data?.structure_at)) this._scheduleTreeCatchUp('structure');
      if (!Array.isArray(data?.changes) || data.changes.length === 0) return;
      this._scheduleTreeCatchUp('drift');
      // Ausnahme vom „nur Baum": die OFFENE Seite. Der erste Save eines Geraets,
      // das das Buch vorher nicht offen hatte, erreicht sonst nie den Editor —
      // der volle Poll, den dieser Save anstoesst, setzt seine Basis dahinter.
      // Der Vergleich mit dem Seiten-Stempel macht es wiederholbar: nach dem
      // Nachladen steht der Stempel auf dem Remote-Stand.
      const cur = this.currentPage;
      const hit = cur?.id && cur.updated_at
        ? data.changes.filter(c => c?.page_id === cur.id && c.updated_at > cur.updated_at).pop()
        : null;
      if (hit) this._onCurrentPageRemoteEdit(hit);
    } catch { /* offline / Netzfehler: der naechste Tick fragt erneut */ }
  },

  // ── Strukturstand (Version der Kapitel-/Abschnitts-Ordnung) ────────────────
  //
  // Der Server zaehlt einen Strukturstand weiter, sobald sich Ordnung oder
  // Bestand aendert (Kapitel anlegen/umbenennen/loeschen/ausschliessen, Order-PUT,
  // Abschnitt anlegen/loeschen/verschieben). Der Baum kennt den Stand, auf dem er
  // beruht (`order_updated_at` der Tree-Antwort, tree/build.js); `/changes`
  // meldet den aktuellen (`structure_at`). Weichen sie ab, wird der Baum leise
  // nachgezogen — so sieht ein zweiter Tab den Umbau des ersten. Der Organizer
  // schickt den Stand als `expected_updated_at` mit seinem Order-PUT
  // (book-organizer/persist.js) und ueberschreibt so keinen fremden Umbau.
  //
  // `undefined` = unbekannt (Server ohne Feld): dann wird weder verglichen noch
  // geprueft. Eigene Writes: der Order-PUT liefert den neuen Stand selbst
  // (`_noteStructureVersion`); alle anderen Struktur-Writes melden nur, DASS der
  // Stand veraltet ist (EVT.STRUCTURE_WRITTEN aus repo/content.js) — die naechste
  // Probe zieht den Baum dann einmal nach, ein Order-PUT davor holt den Stand.
  _noteStructureVersion(at) {
    if (at !== undefined) this._treeStructureAt = at;
    this._structureOwnWrite = false;
  },

  _onStructureWritten(detail) {
    const bookId = detail?.bookId;
    if (bookId != null && String(bookId) !== String(this.$store.nav.selectedBookId)) return;
    this._structureOwnWrite = true;
  },

  // Meldet `structure_at` einen anderen Stand als den des Baums? Je gemeldetem
  // Wert hoechstens einmal true — ein Nachzug, der ihn nicht einholt (Cache,
  // abweichendes Format), darf keine Schleife treiben.
  _structureDrifted(at) {
    if (at === undefined || this._treeStructureAt === undefined) return false;
    if (at === this._treeStructureAt || at === this._structureCatchUpFor) return false;
    this._structureCatchUpFor = at;
    return true;
  },

  // Stand fuer `expected_updated_at` eines Order-PUT. Nach einem eigenen
  // Struktur-Write (der Baum enthaelt ihn schon, der Stand nicht) einmal frisch
  // beim Server erfragen. `undefined` → PUT ohne Pruefung.
  async _structureVersionForWrite(bookId) {
    if (String(bookId) !== String(this._treeBookId ?? this.$store.nav.selectedBookId)) return undefined;
    if (this._structureOwnWrite) {
      try {
        const order = await contentRepo.loadOrder(bookId, { fresh: true });
        this._noteStructureVersion(order?.updated_at);
      } catch { return undefined; }
    }
    return this._treeStructureAt;
  },

  // EVT.CONTENT_UPDATED aus boot/content-updated.js.
  _onContentUpdated(detail) {
    if (!detail) return;
    if (detail.kind === 'tree') {
      if (String(detail.bookId) !== String(this.$store.nav.selectedBookId)) return;
      this._scheduleTreeCatchUp('sw-revalidate');
      return;
    }
    if (detail.kind === 'page') return void this._catchUpCurrentPage(detail.pageId);
    if (detail.kind === 'books') this._catchUpBooks();
  },

  // Offenen Abschnitt nachziehen, wenn der SW einen veralteten Stand ausgeliefert
  // hat. Ohne das bliebe die Lese-Ansicht auf dem Stand des letzten Besuchs, und
  // ein Edit-Start nähme ihn als Basis. Gleiche Weiche wie der Collab-Treffer
  // (app-collab.js#_onCurrentPageRemoteEdit), nur ohne Toast — es hat niemand
  // gerade geschrieben, die Ansicht war bloss alt.
  _catchUpCurrentPage(pageId) {
    if (!pageId || String(this.currentPage?.id) !== String(pageId)) return;
    if (this.editMode) return void this._pullRemoteIntoEditor?.();
    this._refetchCurrentPage?.().catch(() => {});
  },

  // Buchliste nachziehen. Direkt-Zuweisung statt `loadBooks()`: die Liste
  // speist Buchwahl-Combobox und Regal-Zustand (pinned/archived) — ein
  // Voll-Load wuerde daneben Startbuch-Wahl, Status-Meldung und den Seitenbaum
  // anfassen, alles drei ohne Anlass. Der Read ist NICHT `fresh`: der SW-Cache
  // haelt bereits die Antwort, ueber deren Abweichung er uns informiert hat.
  async _catchUpBooks() {
    try {
      const books = await contentRepo.listBooks();
      if (Array.isArray(books)) this.$store.nav.books = books;
    } catch { /* siehe _catchUpTree: der bisherige Bestand bleibt stehen */ }
  },
};
