// Kapitel-Dashboard — der Kennzahlen-Kopf der Kapitel-Bewertung.
//
// Die Karte konnte bisher nur EINES: das Kapitel von der KI bewerten lassen.
// Das Dashboard beantwortet die Fragen davor — wie gross ist dieses Kapitel im
// Verhaeltnis zum Buch, wer tritt darin auf, wo sitzen die Lektorats-Befunde,
// welche Seite traegt das Gewicht. Ausschliesslich aus schon vorhandenen
// Quellen aggregiert, **kein KI-Call und kein neuer Job**:
//
//   Alpine.store('nav').tree + root.tokEsts   -> Umfang, Seitenlaengen, Position
//   /history/fehler-heatmap/:book_id?mode=open -> Abdeckung, Befunde, Fehlertypen
//   /history/lektorat-time/:book_id            -> Lektoratszeit (per_chapter)
//   Alpine.store('catalog').figuren/orte/szenen -> Auftritte im Kapitel
//   kapitelReviewHistory                        -> letzte Note + Trend
//   /history/chapter-growth/:book_id           -> Entstehung (Seitenfassungen)
//   /history/style-stats/:book_id              -> Stil + Lesbarkeit (kapitel-stil.js)
//
// Zwei Regeln, die das Dashboard mit den uebrigen Messkarten teilt:
//   * **Ungeprueft ist nicht fehlerfrei.** Die Befund-Dichte rechnet gegen die
//     Woerter der GEPRUEFTEN Seiten (`words_checked`, gleiche Bezugsgroesse wie
//     lib/fehler-heatmap.js), und eine Seite ohne Lektoratslauf bekommt in der
//     Seitenliste GAR KEINE Plakette statt einer Null.
//   * **Ein leerer Index ist keine Aussage.** Fehlt eine Quelle (Heatmap noch
//     nie gelaufen, Komplettanalyse fehlt), faellt die Kachel weg, statt „0"
//     zu behaupten.
//
// Die reinen Rechenkerne sind als Funktionen exportiert (ohne `this`, ohne
// Alpine) — die Alpine-Methoden sind nur memoisierte Huellen darum.
import { fetchJson, charsToNormseiten, fmtExactDuration } from '../utils.js';
import { komplettHiddenFor } from './feature-registry.js';
import { computeGrowth } from './kapitel-growth.js';
import { computeKapitelStil } from './kapitel-stil.js';

// Lesegeschwindigkeit fuer die Lesezeit-Angabe des Umfang-Tiles. Bewusst eine
// runde, konservative Zahl fuer stilles Lesen belletristischer Prosa — die
// Angabe ist eine Groessenordnung („eine halbe Stunde"), keine Messung.
export const WORDS_PER_MINUTE = 250;

// Schluessel der Kapitel-losen Sammelspalte in der Heatmap-Antwort
// (lib/fehler-heatmap.js#UNCAT). Seiten ohne Kapitel koennen im Dashboard nie
// im Scope liegen, der Wert dient nur der korrekten Schluesselbildung.
const UNCAT = '__uncat__';

const _heatKey = (chapterId) => (chapterId == null ? UNCAT : String(chapterId));

// --- Reine Rechenkerne ------------------------------------------------------

/** Umfang der Seiten im Scope. `bookChars` liefert den Nenner fuer den Anteil
 *  am Buch; ohne ihn bleibt `sharePct` null statt 0 (ein unbekannter Anteil
 *  ist kein Anteil von null). Seiten ohne Stats-Eintrag zaehlen beim
 *  Seiten-Count mit, beim Umfang nicht — sie sind leer, nicht unbekannt. */
export function computeUmfang(pages, tokEsts, bookChars) {
  let chars = 0, words = 0, tok = 0;
  let longest = null, shortest = null;
  for (const p of pages || []) {
    const e = (tokEsts || {})[p.id];
    const c = Number(e?.chars) || 0;
    chars += c;
    words += Number(e?.words) || 0;
    tok   += Number(e?.tok)   || 0;
    // `page` traegt das Original-Objekt mit: der Sprung in den Editor laeuft
    // ueber `selectPage(page)` und braucht mehr als Name und ID.
    if (!longest  || c > longest.chars)  longest  = { page: p, name: p.name, chars: c };
    if (!shortest || c < shortest.chars) shortest = { page: p, name: p.name, chars: c };
  }
  const count = (pages || []).length;
  return {
    pages: count,
    chars, words, tok,
    normseiten: charsToNormseiten(chars),
    avgChars: count > 0 ? Math.round(chars / count) : 0,
    sharePct: Number(bookChars) > 0 ? Math.round((chars / bookChars) * 1000) / 10 : null,
    minutes: words > 0 ? Math.max(1, Math.round(words / WORDS_PER_MINUTE)) : 0,
    longest, shortest,
  };
}

/** Lektorats-Lage im Scope aus der Heatmap-Antwort.
 *  `ids === null` rechnet ueber das ganze Buch (Vergleichswert des Tiles).
 *  Gibt `null` zurueck, solange keine Heatmap vorliegt — der Aufrufer blendet
 *  die Kachel dann aus, statt eine Null zu zeigen. */
export function computeLektorat(heat, ids) {
  if (!heat || !Array.isArray(heat.chapters)) return null;
  let pagesTotal = 0, pagesChecked = 0, words = 0, wordsChecked = 0;
  const typen = new Map();
  const byPage = new Map();
  for (const ch of heat.chapters) {
    const key = _heatKey(ch.chapter_id);
    if (ids && !ids.has(key)) continue;
    pagesTotal   += Number(ch.pages_total)   || 0;
    pagesChecked += Number(ch.pages_checked) || 0;
    words        += Number(ch.words)         || 0;
    wordsChecked += Number(ch.words_checked) || 0;
    const row = (heat.matrix || {})[key] || {};
    for (const [typ, cell] of Object.entries(row)) {
      typen.set(typ, (typen.get(typ) || 0) + (Number(cell?.count) || 0));
      for (const d of (heat.details || {})[`${key}:${typ}`] || []) {
        byPage.set(d.page_id, (byPage.get(d.page_id) || 0) + (Number(d.count) || 0));
      }
    }
  }
  let findings = 0;
  for (const n of typen.values()) findings += n;
  return {
    pagesTotal, pagesChecked, words, wordsChecked, findings, byPage,
    pct: pagesTotal > 0 ? Math.round((pagesChecked / pagesTotal) * 100) : 0,
    // Dichte gegen die gepruefte Wortmenge — gleiche Bezugsgroesse wie
    // lib/fehler-heatmap.js. Ohne geprueften Text ist sie unbekannt, nicht 0.
    per1k: wordsChecked > 0 ? Math.round((findings / wordsChecked) * 1000 * 10) / 10 : null,
    typen: [...typen.entries()]
      .map(([typ, count]) => ({ typ, count }))
      .sort((a, b) => b.count - a.count || a.typ.localeCompare(b.typ)),
  };
}

/** Top-N der Fehlertypen mit Balkenanteil relativ zum haeufigsten Typ. */
export function topTypen(lektorat, limit = 6) {
  const all = lektorat?.typen || [];
  const top = all.slice(0, limit);
  const max = top[0]?.count || 0;
  return top.map(t => ({ ...t, pct: max > 0 ? Math.round((t.count / max) * 100) : 0 }));
}

/** Rangliste der Entitaeten (Figuren/Schauplaetze/Songs) im Scope.
 *  Alle drei tragen dieselbe `kapitel: [{ chapter_id, haeufigkeit }]`-Achse —
 *  bei Figuren ist das `figure_appearances`, der abgeleitete Kapitel-Index.
 *  `extraCounts` haengt eine zweite Zahl an (Szenen der Figur im Kapitel). */
export function computeEntityRanking(entities, ids, { limit = 6, extraCounts = null } = {}) {
  const rows = [];
  for (const e of entities || []) {
    let count = 0;
    for (const k of e?.kapitel || []) {
      if (k?.chapter_id == null || !ids.has(String(k.chapter_id))) continue;
      count += Number(k.haeufigkeit) || 1;
    }
    if (count <= 0) continue;
    rows.push({
      id: e.id,
      name: e.kurzname || e.name,
      fullName: e.name,
      typ: e.typ || null,
      count,
      extra: extraCounts ? (extraCounts.get(e.id) || 0) : 0,
    });
  }
  rows.sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)));
  const top = rows.slice(0, limit);
  const max = top[0]?.count || 0;
  return {
    total: rows.length,
    rows: top.map(r => ({ ...r, pct: max > 0 ? Math.round((r.count / max) * 100) : 0 })),
  };
}

/** Szenen im Scope: Anzahl, Wertungsverteilung, Kurzliste, Figuren-Zaehler.
 *  Als „stale" markierte Szenen (im Text nicht mehr auffindbar) zaehlen nicht
 *  mit — sie sind ein Aufraeum-Hinweis, keine Szene des Kapitels. */
export function computeSzenen(szenen, ids, { limit = 6 } = {}) {
  const inScope = (szenen || []).filter(s =>
    !s.stale && s.chapter_id != null && ids.has(String(s.chapter_id)));
  const wertung = { stark: 0, mittel: 0, schwach: 0, ohne: 0 };
  const figCounts = new Map();
  for (const s of inScope) {
    if (wertung[s.wertung] != null) wertung[s.wertung]++;
    else wertung.ohne++;
    for (const fid of s.fig_ids || []) figCounts.set(fid, (figCounts.get(fid) || 0) + 1);
  }
  return { total: inScope.length, wertung, figCounts, list: inScope.slice(0, limit) };
}

/** Lektoratszeit (Sekunden) der Kapitel im Scope aus `/history/lektorat-time`. */
export function computeLektoratSeconds(lektoratTime, ids) {
  let seconds = 0;
  for (const row of lektoratTime?.per_chapter || []) {
    if (row?.chapter_id == null || !ids.has(String(row.chapter_id))) continue;
    seconds += Number(row.seconds) || 0;
  }
  return seconds;
}

// --- Alpine-Methoden --------------------------------------------------------

// Initialer Dashboard-State. SSoT fuer beide Seiten: die Karte spreadet ihn
// als Startzustand, `resetKapitelDashboard` weist ihn beim Buchwechsel erneut zu.
export function initialKapitelDashboardState() {
  return {
    kdHeat: null,
    kdLektoratTime: null,
    kdGrowthData: null,
    kdStilData: null,
    kdBookId: null,
    kdLoading: false,
  };
}

export const kapitelDashboardMethods = {
  // --- Laden ----------------------------------------------------------------

  // Zwei kleine Aggregat-Endpunkte; Figuren/Orte/Szenen kommen aus dem
  // geteilten Catalog-Store und werden nur geholt, wenn sie noch leer sind
  // (gleiches Muster wie `loadDeps` der uebrigen Karten). Ein Ausfall ist
  // nicht fatal: die betroffene Kachel faellt weg.
  async loadKapitelDashboard(bookId, { fresh = false } = {}) {
    if (!bookId) return;
    if (!fresh && this.kdBookId === bookId && this.kdHeat) return;
    this.kdBookId = bookId;
    this.kdLoading = true;
    try {
      const catalog = Alpine.store('catalog');
      const root = window.__app;
      // Im Ressort (Buchtyp `journalismus`) gibt es die narrativen Ableitungen
      // nicht — dieselbe Grenze, hinter der auch die Komplettanalyse gar nicht
      // erst angeboten wird. Die drei Endpunkte antworteten dort mit 403 bzw.
      // leer, und die Kacheln faellen ohnehin weg.
      const narrativ = !komplettHiddenFor(root?.currentBuchtyp?.());
      const [heat, lektoratTime, growth, stil] = await Promise.all([
        fetchJson(`/history/fehler-heatmap/${bookId}?mode=open`).catch((e) => {
          console.warn('[kapitelDashboard] Heatmap nicht ladbar', e);
          return null;
        }),
        fetchJson(`/history/lektorat-time/${bookId}`).catch((e) => {
          console.warn('[kapitelDashboard] Lektoratszeit nicht ladbar', e);
          return null;
        }),
        fetchJson(`/history/chapter-growth/${bookId}`).catch((e) => {
          console.warn('[kapitelDashboard] Entstehung nicht ladbar', e);
          return null;
        }),
        fetchJson(`/history/style-stats/${bookId}`).catch((e) => {
          console.warn('[kapitelDashboard] Stil-Werte nicht ladbar', e);
          return null;
        }),
        narrativ && !catalog.figuren.length ? root?.loadFiguren?.(bookId) : null,
        narrativ && !catalog.orte.length    ? root?.loadOrte?.(bookId)    : null,
        narrativ && !catalog.szenen.length  ? root?.loadSzenen?.(bookId)  : null,
      ]);
      // Buchwechsel waehrend des Ladens: Antwort des alten Buchs verwerfen.
      if (this.kdBookId !== bookId) return;
      this.kdHeat = heat;
      this.kdLektoratTime = lektoratTime;
      this.kdGrowthData = growth;
      this.kdStilData = stil;
      this._memos = {};
    } finally {
      if (this.kdBookId === bookId) this.kdLoading = false;
    }
  },

  resetKapitelDashboard() {
    Object.assign(this, initialKapitelDashboardState());
    this._memos = {};
  },

  // --- Scope ----------------------------------------------------------------

  // Kapitel-IDs, ueber die das Dashboard rechnet: das gewaehlte Kapitel, plus
  // seine Nachfahren, wenn „Inkl. Sub-Kapitel" aktiv ist. Dieselbe Achse, die
  // auch der Bewertungs-Job und die Kopfzeilen-Statistik verwenden — sonst
  // spraeche das Dashboard ueber einen anderen Text als die Note darunter.
  // Memoisiert, damit die Menge eine STABILE Referenz hat: sie ist die Dep
  // fast aller Kacheln unten, und ein pro Aufruf frisch gebautes Set waere
  // fuer den Memo-Vergleich immer neu — jede Kachel rechnete bei jedem Render
  // erneut, inklusive der O(Baum^2)-Nachfahrensuche.
  kdScopeIds() {
    const tree = Alpine.store('nav').tree || [];
    const id = window.__app.kapitelReviewChapterId;
    const subs = this.kapitelReviewIncludeSubchapters(id);
    return this._memo('kdScopeIds', [tree, id, subs], () => {
      if (!id) return new Set();
      return subs ? this._kapitelReviewDescendantIds(id) : new Set([String(id)]);
    });
  },

  // Seiten im Scope in Lese-Reihenfolge des Baums.
  kdScopePages() {
    const tree = Alpine.store('nav').tree || [];
    const ids = this.kdScopeIds();
    return this._memo('kdPages', [tree, ids], () => {
      const out = [];
      for (const it of tree) {
        if (it.type !== 'chapter' || it.solo) continue;
        if (!ids.has(String(it.id))) continue;
        for (const p of it.pages || []) out.push(p);
      }
      return out;
    });
  },

  // Das Dashboard braucht ein gewaehltes Kapitel und mindestens eine Seite —
  // ohne Text gibt es nichts zu verdichten, und die Karte zeigt stattdessen
  // ihren bestehenden Leer-Hinweis.
  kdReady() {
    return !!window.__app.kapitelReviewChapterId && this.kdScopePages().length > 0;
  },

  // --- Kacheln --------------------------------------------------------------

  kdUmfang() {
    const pages = this.kdScopePages();
    const tokEsts = window.__app.tokEsts || {};
    const bookChars = window.__app.tokTotals?.chars || 0;
    return this._memo('kdUmfang', [pages, tokEsts, bookChars],
      () => computeUmfang(pages, tokEsts, bookChars));
  },

  // „Kapitel 4 von 17" — Position in der Lese-Reihenfolge. Gezaehlt werden
  // alle echten Kapitel des Baums (auch Sub-Kapitel), damit die Zahl zu dem
  // passt, was die Seitenleiste zeigt.
  kdPosition() {
    const tree = Alpine.store('nav').tree || [];
    const id = window.__app.kapitelReviewChapterId;
    return this._memo('kdPosition', [tree, id], () => {
      const chapters = tree.filter(i => i.type === 'chapter' && !i.solo);
      const idx = chapters.findIndex(c => String(c.id) === String(id));
      return idx < 0 ? null : { index: idx + 1, total: chapters.length };
    });
  },

  // Entstehung des Kapitels: Groesse ueber die Zeit aus den Seitenfassungen.
  // `null` heisst „dazu gibt es keine Historie" (nie in der App gespeichert,
  // Verlauf kuerzer als ein Tag) — die Kachel faellt dann weg, statt eine
  // gerade Linie zu zeigen, die nach „nichts passiert" aussieht.
  // Die Punkt-Beschriftung wird hier einmal gebaut und nicht im Template: sie
  // haengt an der UI-Sprache, und `_uiLocale()` gehoert darum in die Deps.
  kdGrowth() {
    const data = this.kdGrowthData;
    const ids = this.kdScopeIds();
    const pages = this.kdScopePages();
    const tokEsts = window.__app.tokEsts || {};
    return this._memo('kdGrowth', [data, ids, pages, tokEsts, this._uiLocale()], () => {
      const g = computeGrowth(data?.chapters, ids, pages, tokEsts);
      if (!g) return null;
      const dateFmt = this._dateFmt({ day: 'numeric', month: 'short', year: 'numeric' });
      const numFmt = this._numFmt();
      const unit = window.__app?.t?.('bookstats.unit.z') || 'Z';
      return {
        ...g,
        color: g.net > 0 ? 'var(--color-success)'
             : g.net < 0 ? 'var(--color-err-border)'
             :             'var(--color-accent)',
        points: g.points.map(p => ({
          ...p,
          // Mittags-Anker: ein Mitternachts-Anker koennte in der App-Zeitzone
          // auf den Vortag kippen (gleiche Regel wie die Buch-Sparkline).
          label: dateFmt.format(new Date(p.iso + 'T12:00:00'))
               + ': ' + numFmt.format(p.chars) + ' ' + unit,
        })),
      };
    });
  },

  // Tages-Datum (YYYY-MM-DD) fuer die Entwicklungs-Kachel. NICHT `$app.formatDate`:
  // das haengt eine Uhrzeit an, die eine Tagesangabe nicht hat, und legt den
  // Wert auf UTC-Mitternacht — der Mittags-Anker haelt die Angabe in der
  // App-Zeitzone auf demselben Tag.
  kdDateLabel(iso) {
    if (!iso) return '';
    return this._dateFmt({ day: '2-digit', month: '2-digit', year: 'numeric' })
      .format(new Date(iso + 'T12:00:00'));
  },

  // Stil + Lesbarkeit des Scopes neben dem Buchschnitt (Kachel „Stil",
  // partials/kapitelreview-dash-stil.html). Rechenkern + Abweichungs-Regel:
  // kapitel-stil.js.
  kdStil() {
    const data = this.kdStilData;
    const ids = this.kdScopeIds();
    return this._memo('kdStil', [data, ids], () => computeKapitelStil(data, ids));
  },

  kdLektorat() {
    const heat = this.kdHeat;
    const ids = this.kdScopeIds();
    return this._memo('kdLektorat', [heat, ids], () => computeLektorat(heat, ids));
  },

  // Buchweite Befund-Dichte als Vergleichswert neben der des Kapitels.
  kdBookPer1k() {
    const heat = this.kdHeat;
    return this._memo('kdBookPer1k', [heat], () => computeLektorat(heat, null)?.per1k ?? null);
  },

  kdTopTypen() {
    const lek = this.kdLektorat();
    return this._memo('kdTopTypen', [lek], () => topTypen(lek));
  },

  // Lektoratszeit des Scopes als lesbare Dauer ('1 h 23 min'). Leerer String,
  // solange nichts verbucht ist — die Zeile faellt dann weg.
  kdLektoratTimeLabel() {
    const sec = this.kdLektoratSeconds();
    return sec > 0 ? fmtExactDuration(sec) : '';
  },

  kdLektoratSeconds() {
    const lt = this.kdLektoratTime;
    const ids = this.kdScopeIds();
    return this._memo('kdLektoratSeconds', [lt, ids], () => computeLektoratSeconds(lt, ids));
  },

  kdSzenen() {
    const sz = Alpine.store('catalog').szenen || [];
    const ids = this.kdScopeIds();
    return this._memo('kdSzenen', [sz, ids], () => computeSzenen(sz, ids));
  },

  kdFiguren() {
    const figs = Alpine.store('catalog').figuren || [];
    const szenen = this.kdSzenen();
    const ids = this.kdScopeIds();
    return this._memo('kdFiguren', [figs, szenen, ids],
      () => computeEntityRanking(figs, ids, { limit: 6, extraCounts: szenen.figCounts }));
  },

  kdOrte() {
    const orte = Alpine.store('catalog').orte || [];
    const ids = this.kdScopeIds();
    return this._memo('kdOrte', [orte, ids], () => computeEntityRanking(orte, ids, { limit: 6 }));
  },

  // Letzte Bewertung dieses Kapitels + Notendifferenz zum Lauf davor.
  kdLastReview() {
    const list = this.kapitelReviewCurrentHistory();
    if (!list.length) return null;
    return { entry: list[0], delta: this.kapitelReviewNoteDelta(0) };
  },

  // --- Seitenliste ----------------------------------------------------------

  // Laengenbalken einer Seite, relativ zur laengsten Seite im Scope. Gedeckelt,
  // weil die Sub-Kapitel-Listen auch Seiten zeigen, die NICHT im Scope liegen
  // (Schalter „Inkl. Sub-Kapitel" aus) und laenger sein koennen als das Maximum.
  kdPageBar(pageId) {
    const max = this.kdUmfang().longest?.chars || 0;
    const chars = Number(window.__app.tokEsts?.[pageId]?.chars) || 0;
    return max > 0 ? Math.min(100, Math.round((chars / max) * 100)) : 0;
  },

  // Befunde je Seite ueber das GANZE Buch — nicht ueber den Scope. Die
  // Seitenliste der Karte zeigt auch die Seiten der Sub-Kapitel, und die
  // liegen bei ausgeschaltetem „Inkl. Sub-Kapitel" nicht im Scope: aus der
  // Scope-Rechnung gelesen saehe jede von ihnen befundfrei aus.
  kdFindingsByPage() {
    const heat = this.kdHeat;
    return this._memo('kdFindingsByPage', [heat],
      () => computeLektorat(heat, null)?.byPage || new Map());
  },

  // Offene Lektorats-Befunde einer Seite. `null` = die Seite wurde nie
  // geprueft; die Plakette bleibt dann weg, statt „0" zu behaupten.
  kdPageFindings(pageId) {
    if (!window.__app.pageLastChecked?.[pageId]) return null;
    return this.kdFindingsByPage().get(Number(pageId)) || 0;
  },
};
