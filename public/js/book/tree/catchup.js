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
      this._buildTreeFromResponse(tree, bookId);
      // Neue Seiten haben noch keinen Token-Schaetzwert — ohne das bliebe ihre
      // Plakette und die Σ-Zeile der Sidebar leer. Idempotent, holt nur Fehlendes.
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

  // Drift-Probe: hat eine ANDERE Partei seit dem Stand dieses Baums geschrieben?
  //
  // WARUM ES DIESE PROBE BRAUCHT, obwohl es den Collab-Poll gibt: der volle
  // 5s-Poll startet erst, wenn eine zweite Partei GLEICHZEITIG am Buch ist
  // (`_selfBookDeviceCount > 1`), und dieser Zaehler kennt nur Geraete, die in
  // den letzten 90 s gepingt haben. Das haeufigste Muster faellt damit durch:
  // gestern am Mac-Client geschrieben, heute im Browser geoeffnet. Die Probe
  // kostet einen indexierten Read mit 200-Zeilen-Deckel.
  //
  // Sie zeigt bewusst KEINE Toasts — „wer hat was geaendert" ist die Aufgabe des
  // vollen Polls, der dafuer seinen eigenen Cursor fuehrt. Hier geht es nur um
  // die Frage, ob der Baum nachgezogen werden muss. Sie ist selbstbegrenzend:
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
      if (!Array.isArray(data?.changes) || data.changes.length === 0) return;
      if (String(bookId) !== String(this.$store.nav.selectedBookId)) return;
      this._scheduleTreeCatchUp('drift');
    } catch { /* offline / Netzfehler: der naechste Tick fragt erneut */ }
  },

  // EVT.CONTENT_UPDATED aus boot/content-updated.js.
  _onContentUpdated(detail) {
    if (!detail) return;
    if (detail.kind === 'tree') {
      if (String(detail.bookId) !== String(this.$store.nav.selectedBookId)) return;
      this._scheduleTreeCatchUp('sw-revalidate');
      return;
    }
    if (detail.kind === 'books') this._catchUpBooks();
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
