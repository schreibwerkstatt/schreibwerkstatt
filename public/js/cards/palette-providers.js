// Such-Provider für die Command-Palette. Jeder Provider liefert
// für eine Query eine Liste fuzzy-gematchter Items.
//
// Item-Schema: { key, providerKey, label, sub, score, indices, run(root), available }
//   key        – stabile ID (provider:resourceId)
//   label      – Anzeigetext (highlight() bekommt indices)
//   sub        – sekundäre Zeile (Kapitel, Typ etc.)
//   score      – kleinerer = besser
//   indices    – Match-Positionen im label (für Highlight)
//   run(root)  – Aktion bei Enter/Klick
//   available  – immer true für Provider-Items (sie würden gar nicht in der Liste
//                stehen, wenn die zugrundeliegende Ressource fehlte)
//
// Optionale Hooks: prepare(root) lädt eine noch leere Datenquelle nach (die
// Palette ruft alle beim Öffnen), cancel() bricht laufende Anfragen ab (beim
// Schliessen). Prefix-Routing (`#`, `!`, `@`, `$`, `%`, `&`, `?`, `>`) parst
// `parseQuery` unten; die Sektionen baut palette-sections.js.

import { fuzzyMatch } from './palette-fuzzy.js';
import { EVT } from '../events.js';

const PER_PROVIDER_LIMIT = 8;
// Wartezeit, bevor die Volltextsuche eine Anfrage stellt — ohne sie ginge jeder
// Tastendruck als eigener FTS-Request an den Server.
const FULLTEXT_DEBOUNCE_MS = 200;

// Erster Abschnitt im Teilbaum eines Kapitels. Der Tree ist flach in
// Vorordnung (`depth`); ein Kapitel ohne eigene Abschnitte, das nur
// Unterkapitel trägt, springt so in deren ersten Abschnitt.
export function firstPageInChapter(tree, chapterId) {
  const list = Array.isArray(tree) ? tree : [];
  const at = list.findIndex(t => t.type === 'chapter' && String(t.id) === String(chapterId));
  if (at < 0) return null;
  const depth = list[at].depth || 1;
  for (let i = at; i < list.length; i++) {
    if (i > at && (list[i].depth || 1) <= depth) break;
    if (list[i].pages?.length) return list[i].pages[0];
  }
  return null;
}

// Volltextsuche-Treffer-Aktivierung. Identische Dispatch-Logik wie
// searchCard#activateHit, dupliziert hier weil die Palette keine Sub-Karten-
// Methoden aufruft — sie kennt nur den Root.
function _runFulltextHit(root, hit) {
  if (!root || !hit) return;
  switch (hit.kind) {
    case 'page':     return root.gotoPageById?.(hit.entity_id);
    case 'chapter': {
      const tree = Alpine.store('nav').tree || [];
      const ch = tree.find(t => t.type === 'chapter' && String(t.id) === String(hit.entity_id));
      if (ch && typeof root.openKapitelReviewForChapter === 'function') {
        return root.openKapitelReviewForChapter(hit.entity_id);
      }
      const first = firstPageInChapter(tree, hit.entity_id);
      if (first) return root.selectPage(first);
      return;
    }
    case 'book': {
      // FTS5 liefert book_id als String, selectedBookId ist numerisch.
      const bid = Number(hit.book_id);
      if (Number.isFinite(bid) && Alpine.store('nav').selectedBookId !== bid) Alpine.store('nav').selectedBookId = bid;
      return root.toggleBookOverviewCard?.();
    }
    // `nav_id`, nicht `entity_id`: Figuren/Schauplaetze werden ueber ihre
    // TEXT-ID adressiert (fig_id/loc_id), der Index fuehrt den INTEGER-PK.
    // Mit dem PK oeffnet die Karte zwar, die Zeile klappt aber nie auf.
    case 'figure':   return root.openFigurById?.(hit.nav_id ?? hit.entity_id);
    case 'location': return root.openOrtById?.(hit.nav_id ?? hit.entity_id);
    case 'scene':    return root.openSzeneById?.(hit.nav_id ?? hit.entity_id);
    case 'idea':
      // Idea → eigene Suche im Karten-Trigger; Palette macht's einfach: SearchCard oeffnen.
      root.toggleSearchCard?.();
      return;
  }
}

// Lazy-Nachladen einer leeren Datenquelle, einmal pro Buch. Zwei Guards:
// `_inFlight` gegen Parallel-Starts, `_loadedList` gegen Wiederholung, wenn die
// Antwort schlicht leer war (Buch ohne Orte) — sonst lüde jeder Aufruf neu.
// Gemerkt wird die Listen-REFERENZ nach dem Laden: setzt ein Buchwechsel die
// Quelle zurück (Loader und Resets weisen neu zu, nie push), ist sie eine andere
// und darf erneut laden.
const _inFlight = new Set();
const _loadedList = new Map();
function _ensureLoaded(providerKey, getList, runner) {
  const bookId = Alpine.store('nav').selectedBookId;
  if (!bookId || getList().length) return;
  const tag = providerKey + ':' + bookId;
  if (_inFlight.has(tag) || _loadedList.get(tag) === getList()) return;
  _inFlight.add(tag);
  const done = () => { _inFlight.delete(tag); _loadedList.set(tag, getList()); };
  let p;
  try { p = runner(bookId); } catch { done(); return; }
  Promise.resolve(p).catch(() => {}).finally(done);
}

// Anzeigename eines Kapitels (disambiguiert, tree/build.js#_chapterLabelMap).
export function chapterLabel(root, chapterId) {
  if (chapterId == null || chapterId === '') return '';
  return root?._chapterLabelMap?.get?.(Number(chapterId)) || '';
}

function rank(items) {
  return items
    .filter(Boolean)
    .sort((a, b) => a.score - b.score)
    .slice(0, PER_PROVIDER_LIMIT);
}

export const PROVIDERS = [
  {
    key: 'pages',
    prefix: '#',
    sectionKey: 'palette.section.pages',
    list(root) {
      return Array.isArray(Alpine.store('nav').pages) ? Alpine.store('nav').pages : [];
    },
    search(root, q, _t) {
      const pages = this.list(root);
      if (!pages.length) return [];
      const out = [];
      for (const p of pages) {
        const m = fuzzyMatch(q, p.name || '');
        if (!m) continue;
        out.push({
          key: 'page:' + p.id,
          providerKey: 'pages',
          label: p.name || '',
          sub: chapterLabel(root, p.chapter_id) || p.chapterName || '',
          score: m.score,
          indices: m.indices,
          available: true,
          run: (r) => r.gotoPageById(p.id),
        });
      }
      return rank(out);
    },
  },
  {
    key: 'chapters',
    prefix: '!',
    sectionKey: 'palette.section.chapters',
    list(root) {
      return Array.isArray(Alpine.store('nav').tree) ? Alpine.store('nav').tree.filter(t => t.type === 'chapter' && !t.solo) : [];
    },
    search(root, q, t) {
      const chapters = this.list(root);
      if (!chapters.length) return [];
      const out = [];
      for (const c of chapters) {
        // Label wie in allen Kapitel-Filtern: gleichnamige Kapitel mit dem
        // Elternkapitel davor (tree/build.js#_chapterLabelMap). Gesucht wird im
        // Label, damit die Treffer-Indizes zur angezeigten Zeichenkette passen.
        const label = chapterLabel(root, c.id) || c.name || '';
        const m = fuzzyMatch(q, label);
        if (!m) continue;
        // Abschnitte im ganzen Unterbaum — wie das Kapitel-Tag der Sidebar.
        const pageCount = c.pageTotal ?? (c.pages?.length || 0);
        out.push({
          key: 'chapter:' + c.id,
          providerKey: 'chapters',
          label,
          sub: t(pageCount === 1 ? 'palette.chapter.pageCountOne' : 'palette.chapter.pageCountOther', { n: pageCount }),
          score: m.score,
          indices: m.indices,
          available: true,
          run: (r) => {
            // Buch qualifiziert → Kapitel-Review; sonst erste Seite.
            if (typeof r.openKapitelReviewForChapter === 'function'
                && typeof r.kapitelReviewChapterOptions === 'function'
                && r.kapitelReviewChapterOptions().some(x => String(x.id) === String(c.id))) {
              r.openKapitelReviewForChapter(c.id);
            } else {
              const first = firstPageInChapter(Alpine.store('nav').tree, c.id);
              if (first) r.selectPage(first);
            }
          },
        });
      }
      return rank(out);
    },
  },
  {
    key: 'figuren',
    prefix: '@',
    sectionKey: 'palette.section.figuren',
    list(root) {
      return Array.isArray(root.$store.catalog.figuren) ? root.$store.catalog.figuren : [];
    },
    drafts(root) {
      const list = root.$store.nav.werkstattDrafts;
      return Array.isArray(list) ? list : [];
    },
    // Defensive: Falls beim Buch-Wechsel der Reset durchläuft bevor loadFiguren
    // fertig ist. Werkstatt-Drafts werden ebenfalls einmal pro Buch nachgeladen,
    // damit die Palette sie auch findet, wenn die Werkstatt-Karte nie geöffnet
    // wurde.
    prepare(root) {
      if (typeof root.loadFiguren === 'function') {
        _ensureLoaded('figuren', () => this.list(root), (bookId) => root.loadFiguren(bookId));
      }
      _ensureLoaded('werkstatt-drafts', () => this.drafts(root), async (bookId) => {
        const r = await fetch(`/draft-figures/${bookId}`, { credentials: 'same-origin' });
        if (!r.ok) return;
        const data = await r.json();
        // Buch inzwischen gewechselt → Antwort gehört nicht mehr in den Store.
        if (Alpine.store('nav').selectedBookId !== bookId) return;
        root.$store.nav.werkstattDrafts = Array.isArray(data) ? data : [];
      });
    },
    search(root, q, t) {
      const items = this.list(root);
      const drafts = this.drafts(root);
      if (!items.length && !drafts.length) return [];
      const out = [];
      for (const f of items) {
        const name = f.name || f.kurzname || '';
        const m = fuzzyMatch(q, name);
        if (!m) continue;
        out.push({
          key: 'figur:' + f.id,
          providerKey: 'figuren',
          label: name,
          sub: f.typ || f.rolle || '',
          score: m.score,
          indices: m.indices,
          available: true,
          run: (r) => r.openFigurById(f.id),
        });
      }
      const werkstattLabel = t('palette.figur.werkstatt') || 'Werkstatt';
      for (const d of drafts) {
        const name = d.name || '';
        const m = fuzzyMatch(q, name);
        if (!m) continue;
        const archetype = d.archetype || '';
        out.push({
          key: 'werkstatt:' + d.id,
          providerKey: 'figuren',
          label: name,
          sub: archetype ? (archetype + ' · ' + werkstattLabel) : werkstattLabel,
          score: m.score,
          indices: m.indices,
          available: true,
          run: (r) => r.openWerkstattDraftById(d.id),
        });
      }
      return rank(out);
    },
  },
  {
    key: 'orte',
    prefix: '$',
    sectionKey: 'palette.section.orte',
    list(root) {
      return Array.isArray(root.$store.catalog.orte) ? root.$store.catalog.orte : [];
    },
    // Orte werden sonst nur beim Öffnen der Orte-Karte geladen.
    prepare(root) {
      if (typeof root.loadOrte !== 'function') return;
      _ensureLoaded('orte', () => this.list(root), (bookId) => root.loadOrte(bookId));
    },
    search(root, q, _t) {
      const items = this.list(root);
      if (!items.length) return [];
      const out = [];
      for (const o of items) {
        const m = fuzzyMatch(q, o.name || '');
        if (!m) continue;
        out.push({
          key: 'ort:' + o.id,
          providerKey: 'orte',
          label: o.name || '',
          sub: o.typ || '',
          score: m.score,
          indices: m.indices,
          available: true,
          run: (r) => r.openOrtById(o.id),
        });
      }
      return rank(out);
    },
  },
  {
    // Volltextsuche-Provider. Async: `request` stellt die Anfrage entprellt,
    // bricht die vorige ab und übernimmt nur die Antwort zur JÜNGSTEN Query —
    // eine spät eintreffende ältere Antwort würde sonst den Cache überschreiben.
    // Treffer landen in `_cache`; 'palette:rerender' lässt die Palette neu rechnen.
    key: 'fulltext',
    prefix: '?',
    sectionKey: 'palette.section.fulltext',
    _cache: { key: '', items: [] },
    _wantKey: '',
    _timer: null,
    _abort: null,
    list() { return []; },
    request(q, bookId) {
      const key = q + '|' + bookId;
      if (this._cache.key === key || this._wantKey === key) return;
      this.cancel();
      this._wantKey = key;
      this._timer = setTimeout(() => {
        this._timer = null;
        const ctrl = new AbortController();
        this._abort = ctrl;
        const url = new URLSearchParams({ q, kind: 'page,chapter,figure,location,scene,idea', limit: '12' });
        if (bookId) url.set('book_id', String(bookId));
        fetch('/search?' + url.toString(), { credentials: 'same-origin', signal: ctrl.signal })
          .then(r => r.ok ? r.json() : { hits: [] })
          .catch(e => (e?.name === 'AbortError' ? null : { hits: [] }))
          .then(data => {
            if (!data || this._wantKey !== key) return;
            this._cache = { key, items: Array.isArray(data.hits) ? data.hits : [] };
            this._wantKey = '';
            window.dispatchEvent(new CustomEvent(EVT.PALETTE_RERENDER));
          })
          .finally(() => { if (this._abort === ctrl) this._abort = null; });
      }, FULLTEXT_DEBOUNCE_MS);
    },
    cancel() {
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
      this._abort?.abort();
      this._abort = null;
      this._wantKey = '';
    },
    search(root, q, t) {
      const query = (q || '').trim();
      if (query.length < 2) return [];
      const bookId = Alpine.store('nav').selectedBookId || '';
      this.request(query, bookId);
      if (this._cache.key !== query + '|' + bookId) return [];
      return this._cache.items.slice(0, PER_PROVIDER_LIMIT).map(h => ({
        key: 'fts:' + h.kind + ':' + h.entity_id,
        providerKey: 'fulltext',
        label: h.title || (t('search.untitled') || ''),
        sub: t('search.kind.' + h.kind) || h.kind,
        snippet: h.snippet || '',
        score: 0,
        indices: [],
        available: true,
        run: (r) => _runFulltextHit(r, h),
      }));
    },
  },
  {
    key: 'szenen',
    prefix: '%',
    sectionKey: 'palette.section.szenen',
    list(root) {
      return Array.isArray(root.$store.catalog.szenen) ? root.$store.catalog.szenen : [];
    },
    // Szenen werden sonst nur beim Öffnen der Szenen-Karte geladen.
    prepare(root) {
      if (typeof root.loadSzenen !== 'function') return;
      _ensureLoaded('szenen', () => this.list(root), (bookId) => root.loadSzenen(bookId));
    },
    search(root, q, _t) {
      const items = this.list(root);
      if (!items.length) return [];
      const out = [];
      for (const s of items) {
        const m = fuzzyMatch(q, s.titel || '');
        if (!m) continue;
        out.push({
          key: 'szene:' + (s.id || s.titel),
          providerKey: 'szenen',
          label: s.titel || '',
          sub: s.kapitel ? (s.kapitel + (s.seite ? ' · ' + s.seite : '')) : '',
          score: m.score,
          indices: m.indices,
          available: true,
          run: (r) => r.openSzeneById(s.id),
        });
      }
      return rank(out);
    },
  },
  {
    key: 'ereignisse',
    prefix: '&',
    sectionKey: 'palette.section.ereignisse',
    list(root) {
      return Array.isArray(root.$store.catalog.globalZeitstrahl) ? root.$store.catalog.globalZeitstrahl : [];
    },
    // Der Zeitstrahl wird sonst nur beim Öffnen der Ereignisse-Karte geladen.
    prepare(root) {
      if (typeof root._reloadZeitstrahl !== 'function') return;
      _ensureLoaded('ereignisse', () => this.list(root), () => root._reloadZeitstrahl());
    },
    search(root, q, _t) {
      const items = this.list(root);
      if (!items.length) return [];
      const out = [];
      for (const ev of items) {
        // Ohne `id` ist das Ereignis nicht adressierbar: solche Einträge stammen
        // aus dem Figuren-Fallback (`_buildGlobalZeitstrahl`) eines noch nicht
        // konsolidierten Buchs und stehen in keiner `zeitstrahl_events`-Zeile.
        if (ev.id == null) continue;
        const m = fuzzyMatch(q, ev.ereignis || '');
        if (!m) continue;
        // Kanonform: `kapitel` ist immer eine Liste (cards/ereignisse/model.js).
        const kapitel = ev.kapitel?.[0];
        out.push({
          key: 'ereignis:' + ev.id,
          providerKey: 'ereignisse',
          label: ev.ereignis || '',
          sub: [ev.datum_label || ev.datum || '', kapitel || ''].filter(Boolean).join(' · '),
          score: m.score,
          indices: m.indices,
          available: true,
          run: (r) => r.openEreignisById(ev.id),
        });
      }
      return rank(out);
    },
  },
];

const BY_PREFIX = new Map(PROVIDERS.filter(p => p.prefix).map(p => [p.prefix, p]));

// Erkennt führendes Prefix in der Query, gibt Provider + restliche Query zurück.
// Pure Befehls-Suche: `>` schaltet in den Befehls-Modus (kind:'action' only).
export function parseQuery(raw) {
  const trimmed = (raw || '').trimStart();
  if (!trimmed) return { mode: 'all', q: '' };
  const first = trimmed[0];
  if (first === '>') return { mode: 'commands', q: trimmed.slice(1).trimStart() };
  const provider = BY_PREFIX.get(first);
  if (provider) return { mode: 'provider', provider, q: trimmed.slice(1).trimStart() };
  return { mode: 'all', q: trimmed };
}
