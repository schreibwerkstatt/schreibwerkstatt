// Kontext-Slice der Referenz-Karte (Alpine.data('referenceCard'), cards/reference-card.js):
// die EINE Regel, nach der jeder Reiter entscheidet, was zur offenen Seite bzw.
// zu deren Kapitel gehoert — plus die daraus gefilterten Listen und ihr Memo.
//
// Warum als eigener Slice und nicht in der Karte: die Karte macht Laden, Tabs
// und die zwei schreibenden Wege (O-Ton, Beleg); hier steht ausschliesslich
// RECHNUNG auf schon geladenen Daten. Die Trennung haelt beide unter dem
// LOC-Deckel und macht den Kontext-Filter fuer sich testbar — er ist der Teil,
// an dem sich die Reiter systematisch unterscheiden (siehe Kopf der Karte:
// Figuren ueber figure_appearances ∪ Namensfund, Orte ueber location_chapters
// ∪ Namensfund, Szenen ueber alle drei Toepfe, Ereignisse ueber die Bruecken-
// IDs, Welt-Fakten ueber Herkunfts-Abschnitt/Subjekt ∪ Kapitel-Bruecke,
// Recherche ueber die Verknuepfungen).
//
// Der Zustand dazu (`_memos`, `_refPageText`, `_refPageTextKey`, `_refLiveHtml`,
// `_refLiveRev`) bleibt in der Karte deklariert — ein Slice spreadet Methoden, keine eigene State-Insel.
// Schreibt nie in den Buchtext.

import { containsWholeWordLower, selectScenesForView } from '../editor/notebook/entities.js';
import { memoMethods } from './card-memo.js';
import { capRefs, ctxRow, rowRefs, rowPageIds } from './reference-rows.js';
import { ortTypLabel } from '../book/ort-typen.js';
import { countryLabel } from '../country-codes.js';
import { selectWeltfaktenForPage } from './reference-weltfakten.js';

/** Herkunft einer Zeile im Kontext-Scope: 'page' = haengt an der offenen Seite,
 *  'chapter' = haengt am Kapitel (andere Seite oder ohne Seitenbezug). Jede
 *  Liste markiert ihre Zeilen damit, statt beides wortlos zu vermischen — der
 *  Autor muss sehen, was wirklich vor ihm steht und was drumherum liegt.
 *  Kopie statt Mutation: die Katalog-Objekte im Store bleiben unberuehrt. */
const markCtx = (list, refCtx, extra) =>
  list.map(x => ({ ...x, refCtx, ...(extra ? extra(x) : null) }));

/** Wie markCtx, aber mit stabiler Zeilen-Identität je Quell-Array (ctxRow) —
 *  für die Reiter, die beim Tippen neu rechnen (Namensfund im Seitentext). */
const markCtxStable = (source, list, refCtx) => list.map(x => ctxRow(source, x, refCtx));

/** Ist `id` in der Liste? Vergleich ueber Number, weil Bruecken-IDs je nach
 *  Route als Zahl oder String ankommen. Nur fuer die NUMERISCHEN Anker
 *  (page_id/chapter_id) — Figuren tragen eine TEXT-Identitaet, siehe `figKey`. */
const hasId = (ids, id) =>
  id != null && Array.isArray(ids) && ids.some(x => x != null && Number(x) === Number(id));

/** Identitaet einer Figur als Vergleichsschluessel. Die Achse ist die TEXT-
 *  `fig_id` (`/figures/:book_id` UND `/figures/chapter/:book_id/:chapter_id`
 *  liefern sie als `id`) — sie darf nie durch `Number()` laufen: 'fig_7' wird
 *  dabei zu NaN, jeder Vergleich schlaegt fehl, und die Vereinigung unten haelt
 *  dann jede Kapitel-Figur fuer unbekannt und rendert sie doppelt. */
const figKey = (f) => (f?.id == null ? '' : String(f.id));

/** HTML-Entities im Klartext auflösen. `<textarea>` parst seinen Inhalt als
 *  RCDATA: Entities werden dekodiert, nichts wird ausgeführt oder geladen. */
let _decoder = null;
function decodeEntities(s) {
  if (!s || !s.includes('&') || typeof document === 'undefined') return s || '';
  _decoder ||= document.createElement('textarea');
  _decoder.innerHTML = s;
  return _decoder.value;
}

/** Ruhe nach der letzten Eingabe, bevor der Slot den Editor-Stand neu liest.
 *  Kürzer wirkt hektisch (Figuren springen während des Tippens umher), länger
 *  träge; innerHTML einer langen Seite zu serialisieren kostet wenige ms. */
const LIVE_TEXT_DEBOUNCE_MS = 800;

/** Zeilen-Ende (Verweise + «in Abschnitten») je Zeilen-Objekt: Template fragt
 *  pro Zeile mehrfach (x-show, x-for, «+N»). Schlüssel ist das Objekt — im
 *  Kontext-Scope eine Kopie aus dem Listen-Memo, im Buch-Scope der Katalog-
 *  Eintrag; beide werden bei neuem Stand ersetzt, nie mutiert. */
const _rowTailCache = new WeakMap();
function rowTailCached(row, key, fn) {
  if (!row || typeof row !== 'object') return fn();
  let m = _rowTailCache.get(row);
  if (!m) { m = new Map(); _rowTailCache.set(row, m); }
  if (!m.has(key)) m.set(key, fn());
  return m.get(key);
}

export const referenceContextMethods = {
  // ── Memo (cards/card-memo.js) ──────────────────────────────────────────────
  ...memoMethods,

  _pageKey() {
    const p = window.__app?.currentPage;
    return p ? (p.id + ':' + (p.updated_at || '') + ':' + this._refLiveRev) : '';
  },

  // ── Live-Stand im Bearbeitungsmodus ────────────────────────────────────────
  // `originalHtml` ist der zuletzt gespeicherte Stand; eine eben getippte
  // Figur fehlte sonst bis zum nächsten (Auto-)Save in der Liste. Der Slot
  // liest darum nach einer Eingabepause das HTML des Editors selbst — nur bei
  // offenem Slot, nur aus dem Notebook-Editor (`.page-content-view`).
  _installReferenceLiveText(signal) {
    let timer = null;
    const capture = () => {
      timer = null;
      const app = window.__app;
      if (!app?.editMode || !app.showReferenceCard) return;
      const el = app._getEditEl?.();
      if (!el) return;
      this._refLiveHtml = el.innerHTML;
      this._refLiveRev++;
    };
    document.addEventListener('input', (e) => {
      if (!e.target?.closest?.('.page-content-view')) return;
      clearTimeout(timer);
      timer = setTimeout(capture, LIVE_TEXT_DEBOUNCE_MS);
    }, { capture: true, signal });
    signal.addEventListener('abort', () => clearTimeout(timer));
    // Bearbeitung beendet oder anderer Abschnitt: ab jetzt gilt wieder der
    // gespeicherte Stand.
    this.$watch(() => [window.__app?.editMode, window.__app?.currentPage?.id].join('|'),
      () => this._resetReferenceLiveText());
  },

  _resetReferenceLiveText() {
    if (!this._refLiveHtml) return;
    this._refLiveHtml = '';
    this._refLiveRev++;
  },

  // Plaintext der aktuellen Seite (Namens-Treffer für Figuren/Orte im Kontext):
  // im Bearbeitungsmodus der Live-Stand, sonst der gespeicherte.
  // Tags werden zu Leerzeichen (sonst klebten Wörter an Blockgrenzen zusammen
  // und die Wortgrenzen-Prüfung schlüge fehl), danach Entities dekodiert —
  // `&amp;`/`&nbsp;` stünden sonst als Wortzeichen im Text.
  _pageText() {
    const app = window.__app;
    if (!app?.currentPage) return '';
    const key = this._pageKey();
    if (this._refPageTextKey === key) return this._refPageText;
    const html = (app.editMode && this._refLiveHtml) || app.originalHtml || '';
    this._refPageText = decodeEntities(html.replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ').toLowerCase();
    this._refPageTextKey = key;
    return this._refPageText;
  },

  // Ganzes Wort, gleiche Regel wie die Editor-Highlights (containsWholeWord).
  _nameInPage(names) {
    const txt = this._pageText();
    if (!txt) return false;
    // `_pageText()` ist schon kleingeschrieben — nicht je Name neu.
    return names.some(n => containsWholeWordLower(txt, n));
  },

  _currentChapterName() {
    const cid = window.__app?.currentPage?.chapter_id;
    if (!cid) return '';
    const ch = (Alpine.store('nav').tree || []).find(c => c.id === cid);
    return ch?.name || '';
  },

  // ── Gefilterte Listen (memoized — im Template + in referenceCount genutzt) ─
  // Vereinigung statt Entweder-oder: der Namens-Treffer im Seitentext UND die
  // server-geladene Kapitel-Figurenliste. `chapterFigures` ist der Index
  // (`figure_appearances`) und kennt eine eben erst geschriebene Erwaehnung
  // noch nicht; der Namensfund kennt umgekehrt keine Figur, die auf dieser
  // Seite nur umschrieben wird. Gerendert werden die Katalog-Objekte — sie
  // tragen das volle Dossier, `chapterFigures` nur einen Spaltenausschnitt.
  referenceFiguren() {
    const app = window.__app;
    const all = Alpine.store('catalog').figuren || [];
    // Rückfall-Liste (Kapitel ohne Auftritts-Index = ganze Besetzung) sagt
    // nichts über das Kapitel — sonst stünde jede Figur «im Kapitel».
    const chapterFigs = app?.chapterFiguresFallback ? [] : (app?.chapterFigures || []);
    return this._memo('figuren', [this.referenceScope, this._pageKey(), all, chapterFigs], () => {
      if (!this._contextActive()) return all;
      const chapKeys = new Set(chapterFigs.map(figKey).filter(Boolean));
      const chapNames = new Set(chapterFigs.map(f => String(f?.name || '').toLowerCase()).filter(Boolean));
      const inChap = (f) => chapKeys.has(figKey(f)) || chapNames.has(String(f?.name || '').toLowerCase());
      const onPage = [];
      const inChapter = [];
      const known = new Set();
      for (const f of all) {
        const k = figKey(f);
        if (k) known.add(k);
        if (this._nameInPage([f.name, f.kurzname])) onPage.push(f);
        else if (inChap(f)) inChapter.push(f);
      }
      // Kapitel-Figuren ohne Katalog-Gegenstueck: der Slot laedt den Katalog
      // asynchron nach — bis dahin darf die Liste nicht leer wirken. Beide
      // Listen sprechen dieselbe Identitaet (`figKey`), sonst ist hier JEDE
      // Kapitel-Figur ein Waisenkind und steht ein zweites Mal in der Liste.
      const orphans = chapterFigs.filter(f => !figKey(f) || !known.has(figKey(f)));
      return [...markCtxStable(all, onPage, 'page'), ...markCtxStable(all, [...inChapter, ...orphans], 'chapter')];
    });
  },

  // Zwei Wege in den Kontext, wie bei den Figuren: die Kapitel-Zuordnung
  // (`location_chapters`, kommt als `ort.kapitel` mit) UND der Namens-Treffer
  // im Seitentext. Vereinigung statt Entweder-oder — der Namensfund holt Orte,
  // deren Index noch nicht nachgezogen ist, die Kapitel-Kante holt jene, die
  // auf dieser Seite nur umschrieben werden ("die Burg").
  referenceOrte() {
    const all = Alpine.store('catalog').orte || [];
    const cid = window.__app?.currentPage?.chapter_id ?? null;
    return this._memo('orte', [this.referenceScope, this._pageKey(), cid, all], () => {
      if (!this._contextActive()) return all;
      const onPage = [];
      const inChapter = [];
      for (const o of all) {
        if (this._nameInPage([o.name])) onPage.push(o);
        else if (this._ortInChapter(o, cid)) inChapter.push(o);
      }
      return [...markCtxStable(all, onPage, 'page'), ...markCtxStable(all, inChapter, 'chapter')];
    });
  },

  /** Haengt der Ort ueber `location_chapters` am aktuellen Kapitel?
   *  `ort.kapitel` liefert /locations/:book_id als [{ chapter_id, name, … }];
   *  ohne explizite Zuordnung steht dort der aus der Erstnennung abgeleitete
   *  Eintrag — beides zaehlt gleich. */
  _ortInChapter(ort, chapterId) {
    const kap = Array.isArray(ort?.kapitel) ? ort.kapitel : [];
    return hasId(kap.map(k => k?.chapter_id), chapterId);
  },

  // Alle drei Kontext-Toepfe, nicht nur zwei: eine Szene, die dem Kapitel UND
  // einer anderen Seite desselben Kapitels gehoert, fiel bisher aus der Liste.
  // Reihenfolge: diese Seite → kapitelweit ungebunden → andere Seite im Kapitel.
  referenceSzenen() {
    const all = Alpine.store('catalog').szenen || [];
    const app = window.__app;
    const pid = app?.currentPage?.id;
    const cid = app?.currentPage?.chapter_id;
    return this._memo('szenen', [this.referenceScope, pid, cid, all], () => {
      if (!this._contextActive()) return all;
      const v = selectScenesForView(all, pid, cid);
      return [
        ...markCtx(v.onPage, 'page'),
        ...markCtx(v.inChapter, 'chapter'),
        ...markCtx(v.inChapterOtherPage, 'chapter',
          (s) => ({ refPageIds: s.page_id != null ? [s.page_id] : [] })),
      ];
    });
  },

  /** An welchen ANDEREN Abschnitten eine Zeile im Kontext-Scope haengt (IDs,
   *  gerendert als Abschnitts-Referenzen). Leer, wenn sie zu diesem Abschnitt
   *  gehoert oder kapitelweit gilt — dann waere die Angabe nur Rauschen.
   *  Geteilt von Szenen, Ereignissen und Quellen. */
  referenceRowPageIds(row) {
    return Array.isArray(row?.refPageIds) ? row.refPageIds : [];
  },

  /** Verweis-Zeile einer Zeile (Grammatik: cards/reference-rows.js), gekappt
   *  als `{ shown, more }`. Plan-Beats bringen ihre Besetzung aus dem Plan-
   *  Slice mit; sie hängt am Katalog-Stand und wird dort memoisiert. */
  referenceRowRefs(kind, row) {
    if (kind === 'beat') {
      return capRefs([...this.referencePlanCast(row), ...this.referencePlanMotifs(row)]);
    }
    if (kind === 'recherche') {
      return capRefs(this.referenceRechercheLinks(row)
        .filter(l => l?.target_kind !== 'page')
        .map(l => ({ type: l.target_kind, id: l.ref_id ?? l.target_id, label: l.label })));
    }
    if (kind === 'weltfakt') return capRefs(this.referenceWeltfaktChapters(row));
    return rowTailCached(row, 'refs:' + kind, () => capRefs(rowRefs(kind, row)));
  },

  /** Ort-Typ als Kopf-Chip (wie in der Schauplatz-Liste). */
  referenceOrtTyp(ort) {
    return ort?.typ ? ortTypLabel(ort.typ, (k, p) => window.__app.t(k, p)) : '';
  },

  /** Meta-Zeile eines Orts: Land · Stimmung. */
  referenceOrtMeta(ort) {
    const lang = Alpine.store('session')?.uiLocale || 'de';
    return [ort?.land ? countryLabel(ort.land, lang) : '', ort?.stimmung].filter(Boolean).join(' · ');
  },

  /** «in Abschnitten»-Zeile, gekappt als `{ shown, more }`. */
  referenceRowPages(kind, row) {
    const ctx = this._contextActive();
    const pid = window.__app?.currentPage?.id ?? null;
    return rowTailCached(row, `pages:${kind}:${ctx ? pid : 'book'}`,
      () => capRefs(rowPageIds(kind, row, { contextActive: ctx, pageId: pid })));
  },

  // Ereignisse tragen ihre Anker als IDs (`page_ids`/`chapter_ids`, Bruecken
  // zeitstrahl_event_pages/_chapters) — danach wird gefiltert, nicht mehr nach
  // dem Kapitel-NAMEN: der verwechselt gleichnamige Kapitel und faellt nach
  // jeder Umbenennung aus. Seitenanker zuerst, Kapitelanker danach.
  referenceEreignisse() {
    const all = Alpine.store('catalog').globalZeitstrahl || [];
    const app = window.__app;
    const pid = app?.currentPage?.id ?? null;
    const cid = app?.currentPage?.chapter_id ?? null;
    const chapName = this._currentChapterName();
    return this._memo('ereignisse', [this.referenceScope, pid, cid, chapName, all], () => {
      if (!this._contextActive()) return all;
      const onPage = [];
      const inChapter = [];
      for (const ev of all) {
        if (hasId(ev?.page_ids, pid)) onPage.push(ev);
        else if (this._evtInChapter(ev, cid, chapName)) inChapter.push(ev);
      }
      return [
        ...markCtx(onPage, 'page'),
        ...markCtx(inChapter, 'chapter',
          (ev) => ({ refPageIds: this._evtOtherPageIds(ev, pid) })),
      ];
    });
  },

  /** Kapitel-Zugehoerigkeit eines Ereignisses. `chapter_ids` ist die Wahrheit;
   *  der Namensvergleich bleibt nur als Rueckfall fuer Eintraege ganz ohne
   *  IDs — er ist die Regel, die dieser Reiter gerade losgeworden ist. */
  _evtInChapter(ev, chapterId, chapterName) {
    // Anker sind Listen — die Kanonform stellt cards/ereignisse/model.js an den
    // beiden Schreibstellen des Stores her (book/ereignisse.js).
    // Ein Paar ohne ID steht als `null` an seinem Platz (Name ↔ ID-Paare).
    const ids = (ev?.chapter_ids || []).filter(x => x != null);
    if (ids.length) return hasId(ids, chapterId);
    if (!chapterName) return false;
    const cl = String(chapterName).toLowerCase();
    return (ev?.kapitel || []).some(k => String(k).toLowerCase() === cl);
  },

  /** Seiten, an denen ein Kapitel-Ereignis sonst noch haengt (ohne die offene).
   *  Leer, wenn es gar keinen Seitenanker hat — dann ist es kapitelweit. */
  _evtOtherPageIds(ev, pageId) {
    return (ev?.page_ids || []).filter(x => x != null && Number(x) !== Number(pageId));
  },

  /** Kapitel eines Ereignisses als Referenz-Specs: `kapitel[i]` gehoert zu
   *  `chapter_ids[i]` (Kanonform aus cards/ereignisse/model.js); ohne ID
   *  loest die Referenz ueber den Namen auf. */
  referenceEventChapters(ev) {
    const names = Array.isArray(ev?.kapitel) ? ev.kapitel : [];
    const ids = Array.isArray(ev?.chapter_ids) ? ev.chapter_ids : [];
    return names.map((name, i) => ({ type: 'kapitel', id: ids[i] ?? undefined, name }))
      .filter(r => r.id != null || r.name);
  },

  // Welt-Fakten: Herkunfts-Abschnitt/Subjekt im Text → 'page', Kapitel-Bruecke
  // → 'chapter'. Regel pure in cards/reference-weltfakten.js#selectWeltfaktenForPage.
  referenceWeltfaktenItems() {
    const all = this.referenceWeltfakten || [];
    const page = window.__app?.currentPage;
    const cid = page?.chapter_id ?? null;
    const pageName = page?.name || '';
    return this._memo('weltfakten', [this.referenceScope, this._pageKey(), cid, pageName, all], () => {
      if (!this._contextActive()) return all;
      return selectWeltfaktenForPage(all, {
        pageName, chapterId: cid, inText: (name) => this._nameInPage([name]),
      });
    });
  },

  // Dieselbe Zweiteilung wie die Geschwister-Reiter: die Verknuepfung zeigt
  // entweder auf diese Seite oder auf ihr Kapitel. Gefiltert wurde schon
  // vorher nach beidem — neu ist, dass die Zeile sagt, welches von beiden.
  referenceRechercheItems() {
    const all = this.referenceRecherche || [];
    const app = window.__app;
    const pid = app?.currentPage?.id;
    const cid = app?.currentPage?.chapter_id;
    return this._memo('recherche', [this.referenceScope, pid, cid, all], () => {
      if (!this._contextActive()) return all;
      const onPage = [];
      const inChapter = [];
      for (const it of all) {
        const links = Array.isArray(it?.links) ? it.links : [];
        if (pid != null && links.some(l => l.target_kind === 'page' && Number(l.target_id) === Number(pid))) {
          onPage.push(it);
        } else if (cid != null && links.some(l => l.target_kind === 'chapter' && Number(l.target_id) === Number(cid))) {
          inChapter.push(it);
        }
      }
      return [...markCtxStable(all, onPage, 'page'), ...markCtxStable(all, inChapter, 'chapter')];
    });
  },

  /** Verknüpfungen eines Fundstücks als Chips. Im Kontext-Scope ohne die auf
   *  die offene Seite — sie ist der Grund, warum die Zeile hier steht, und als
   *  Chip nur ein Sprung an den Ort, an dem man schon ist. */
  referenceRechercheLinks(item) {
    const links = Array.isArray(item?.links) ? item.links : [];
    const pid = window.__app?.currentPage?.id;
    if (!this._contextActive() || pid == null) return links;
    return links.filter(l => !(l?.target_kind === 'page' && Number(l.target_id) === Number(pid)));
  },

  referenceCount(tab) {
    switch (tab) {
      case 'plan':       return this.referencePlanBeats().length;
      case 'figuren':    return this.referenceFiguren().length;
      case 'orte':       return this.referenceOrte().length;
      case 'szenen':     return this.referenceSzenen().length;
      case 'ereignisse': return this.referenceEreignisse().length;
      case 'weltfakten': return this.referenceWeltfaktenItems().length;
      case 'recherche':  return this.referenceRechercheItems().length;
      case 'quellen':    return this.referenceQuellen().length;
      case 'verwandt':   return this.verwandtResults().length;
      default:           return 0;
    }
  },
};
