// Alpine.data('worldFactsCard') — Welt-Fakten/Weltregeln-Karte.
//
// Selbstständige Karte: hält eigenen State + fetcht /world-facts/:bookId. Daten
// stammen aus der Komplettanalyse; der Autor kann Fakten anlegen, ändern und
// löschen (POST/PATCH/DELETE /world-facts/:bookId). Angelegte/geänderte Fakten
// sind «gepflegt» (manually_edited) — die nächste Analyse lässt sie stehen.
// Gruppierung nach Kategorie; Filter über Suche + Kategorie-Combobox.
import { setupCardLifecycle } from './card-lifecycle.js';
import { fetchJson } from '../utils.js';
import { memoMethods } from './card-memo.js';
import { activeFilterId, hasId } from '../chapter-filter.js';
import { startPoll } from './job-helpers.js';
import { isSelectedBook } from './book-guard.js';

// Harte Kategorie-Gruppierung — SSoT für Reihenfolge + Icon je Key. Spiegelt die
// Whitelist FAKT_KATEGORIE_WL (db/schema.js) und das Prompt-Enum
// (prompts/komplett/schema-strings.js#FAKTEN_SCHEMA). Labels via i18n
// weltfakten.kategorie.<key>. Unbekannte/leere Werte → 'sonstiges'.
export const KAT_ORDER = [
  'figur', 'ort', 'objekt', 'organisation', 'technik', 'regel',
  'kultur', 'historie', 'zeit', 'soziolekt', 'ereignis', 'sonstiges',
];
const KAT_ICON = {
  figur:        'user',
  ort:          'map-pin',
  objekt:       'package',
  organisation: 'landmark',
  technik:      'cpu',
  regel:        'scale',
  kultur:       'book-open',
  historie:     'scroll',
  zeit:         'calendar',
  soziolekt:    'quote',
  ereignis:     'zap',
  sonstiges:    'more-horizontal',
};
// Filterleiste pro Buch im localStorage (siehe public/js/filter-persist.js).
// `defaults` ist zugleich die SSoT der Feldliste — `wfFilters` gehört damit dem
// Persistenz-Layer und wird in `resetState` nicht mehr mitgesetzt.
const WF_FILTER_SCOPES = [
  { scope: 'wfFilters', key: 'wfFilters', defaults: { suche: '', kategorie: '', kapitelId: '', widerlegt: false } },
];

// Ablehnungs-Codes der Start-Route → vorhandene Hinweistexte der Faktencheck-Sektion.
const FC_START_ERROR_KEYS = {
  FACTCHECK_NOT_ENABLED_FOR_BOOK: 'weltfakten.factcheck.notEnabled',
  FACTCHECK_CLAUDE_ONLY: 'kontinuitaet.faktencheck.claudeOnly',
  FACTCHECK_NO_TOOLS: 'kontinuitaet.faktencheck.noTools',
  FACTCHECK_NO_WEBSEARCH: 'kontinuitaet.faktencheck.noWebsearch',
  FACTCHECK_DISABLED: 'kontinuitaet.faktencheck.disabled',
};

const _emptyEdit = () => ({ mode: null, id: null, draft: { kategorie: 'sonstiges', subjekt: '', fakt: '' }, busy: false, error: '' });

const _katRank = new Map(KAT_ORDER.map((k, i) => [k, i]));
function _normKat(k) {
  return _katRank.has(k) ? k : 'sonstiges';
}

export function registerWorldFactsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('worldFactsCard', () => ({
    fakten: [],
    wfUpdatedAt: null,
    wfLoading: false,
    // Lief die Komplettanalyse schon? Trennt „nie analysiert" von „analysiert,
    // nichts gefunden" — sonst fordert der Leer-Zustand einen Lauf, der lief.
    wfScanned: false,
    wfFilters: { suche: '', kategorie: '', kapitelId: '', widerlegt: false },
    wfOpenGroups: {},
    // Faktencheck-Sektion: Buch-Opt-in (vom Server) + Laufzustand + Ergebnis des letzten Laufs.
    wfFactcheck: { bookOptIn: false },
    wfFcRunning: false,
    wfFcProgress: 0,
    wfFcStatusKey: '',
    wfFcStatusParams: null,
    wfFcResult: null,
    wfFcError: '',
    _wfFcPollTimer: null,
    // Pflegeformular: mode null | 'new' | 'edit' (id = world_facts.id).
    wfEdit: _emptyEdit(),
    _lifecycle: null,
    // _memos: nicht-reaktiver Memo-Cache (lazy via _memo, Reset in loadWorldFacts) —
    // bewusst nicht im reaktiven Initial-State, analog book-overview/load.js.

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'weltfakten',
        showFlag: 'showWorldFactsCard',
        timerKeys: ['_wfFcPollTimer'],
        resetState: {
          fakten: [], wfUpdatedAt: null, wfLoading: false, wfScanned: false, wfOpenGroups: {},
          wfFactcheck: { bookOptIn: false }, wfFcRunning: false, wfFcProgress: 0,
          wfFcStatusKey: '', wfFcStatusParams: null, wfFcResult: null, wfFcError: '',
          wfEdit: _emptyEdit(),
        },
        filterScopes: WF_FILTER_SCOPES,
        load: () => this.loadWorldFacts(),
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },

    async loadWorldFacts() {
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId) return;
      this.wfLoading = true;
      try {
        const data = await fetchJson('/world-facts/' + bookId);
        this.fakten = data?.fakten || [];
        this.wfUpdatedAt = data?.updated_at || null;
        this.wfScanned = !!data?.scanned;
        this.wfFactcheck = { bookOptIn: !!data?.factcheck?.bookOptIn };
        this._memos = {};
        // Glossar startet aufgeklappt — reine Nachschlage-Ansicht, alle Gruppen offen.
        const open = {};
        for (const k of this.wfKategorieListe) open[k] = true;
        this.wfOpenGroups = open;
      } catch (e) {
        console.error('[loadWorldFacts]', e);
      } finally {
        this.wfLoading = false;
      }
    },

    // Memo-Helper (cards/card-memo.js); Reset bei Reload.
    ...memoMethods,

    // Einmal pro fakten-Satz: Counts je Kategorie + vorhandene Kategorien (kanonisch sortiert).
    get _wfIndex() {
      return this._memo('index', [this.fakten], () => {
        const counts = {};
        for (const f of this.fakten) {
          const k = _normKat(f.kategorie);
          counts[k] = (counts[k] || 0) + 1;
        }
        return { counts, present: KAT_ORDER.filter(k => counts[k]) };
      });
    },

    // Vorhandene Kategorien in kanonischer Reihenfolge (KAT_ORDER), nicht alphabetisch.
    get wfKategorieListe() {
      return this._wfIndex.present;
    },

    // i18n-Label + Lucide-Icon je Kategorie-Key (für Gruppen-Köpfe + Filter-Tabs).
    wfKatLabel(key) {
      return window.__app.t('weltfakten.kategorie.' + _normKat(key));
    },
    wfKatIcon(key) {
      return KAT_ICON[_normKat(key)] || KAT_ICON.sonstiges;
    },
    wfKatCount(key) {
      return this._wfIndex.counts[_normKat(key)] || 0;
    },

    wfToggleGroup(key) {
      this.wfOpenGroups[key] = !this.wfOpenGroups[key];
    },
    // Gruppe sichtbar, wenn explizit aufgeklappt — oder zwangsoffen: bei aktiver
    // Suche/Kapitel-Filter (Treffer müssen sichtbar sein) und bei aktivem
    // Kategorie-Tab (Gruppen-Kopf ist dort ausgeblendet, Liste zeigt direkt).
    wfGroupOpen(key) {
      if (this.wfFilters.kategorie || this._wfKapitelFilter() || this.wfFilters.widerlegt || this.wfFilters.suche.trim()) return true;
      return !!this.wfOpenGroups[key];
    },

    // Kapitel der Fakten als Filter-Optionen (ID + Label, Buchreihenfolge).
    get wfKapitelOptionen() {
      const root = window.__app;
      return this._memo('kapOpt', [this.fakten, root._chapterLabelMap, root._chapterIdOrderMap],
        () => root._kapitelOptionen(this.fakten.flatMap(f => f.chapter_ids || [])));
    },
    // Wirksamer Kapitel-Filter (nur ein angebotener Wert, chapter-filter.js#activeFilterId).
    _wfKapitelFilter() {
      return activeFilterId(this.wfFilters.kapitelId, this.wfKapitelOptionen);
    },

    // Als real widerlegt belegte Fakten (Faktencheck mit Quelle, nicht vom Autor verworfen).
    get wfRefutedCount() {
      return this._memo('refuted', [this.fakten], () => this.fakten.filter(f => f.widerlegt).length);
    },

    get wfFiltered() {
      const { suche, kategorie, widerlegt } = this.wfFilters;
      const kapitelId = this._wfKapitelFilter();
      const locale = Alpine.store('shell').uiLocale;
      return this._memo('filtered', [this.fakten, suche, kategorie, kapitelId, widerlegt, locale], () => {
        const q = suche.trim().toLowerCase();
        return this.fakten.filter(f => {
          if (widerlegt && !f.widerlegt) return false;
          if (kategorie && _normKat(f.kategorie) !== kategorie) return false;
          if (kapitelId && !hasId(f.chapter_ids, kapitelId)) return false;
          if (!q) return true;
          return (f.fakt || '').toLowerCase().includes(q)
            || (f.subjekt || '').toLowerCase().includes(q)
            || (f.seite || '').toLowerCase().includes(q)
            || (f.kapitel || []).some(k => k.toLowerCase().includes(q))
            || this.wfKatLabel(f.kategorie).toLowerCase().includes(q);
        });
      });
    },

    // Faktencheck aus der Karte starten (dieselbe Route wie in der Kontinuitäts-Karte;
    // Befunde landen dort als typ='faktenfehler', hier als Markierung am Fakt).
    async wfFactcheckRun() {
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId || this.wfFcRunning) return;
      this.wfFcRunning = true;
      this.wfFcProgress = 1;
      this.wfFcError = '';
      this.wfFcResult = null;
      this.wfFcStatusKey = 'weltfakten.factcheck.starting';
      this.wfFcStatusParams = null;
      try {
        const resp = await fetch('/jobs/faktencheck', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ book_id: bookId, book_name: window.__app.selectedBookName || '' }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!isSelectedBook(bookId)) return;
        if (!resp.ok || !data.jobId) {
          // 401 behandelt der globale fetch-Wrapper (Session-Banner).
          this._wfFcStop(resp.status === 401 ? '' : this._wfFcErrorText(data?.error_code, data?.params));
          return;
        }
        startPoll(this, {
          jobId: data.jobId,
          timerProp: '_wfFcPollTimer',
          progressProp: 'wfFcProgress',
          onProgress: (job) => {
            this.wfFcStatusKey = job.statusText || 'weltfakten.factcheck.starting';
            this.wfFcStatusParams = job.statusParams || null;
          },
          onDone: async (job) => {
            this._wfFcStop('');
            const r = job?.result || {};
            this.wfFcResult = {
              checked: r.checked || 0, count: r.count || 0, remaining: r.remaining || 0,
              warnings: Array.isArray(r.warnings) ? r.warnings : [],
            };
            await this.loadWorldFacts();
          },
          onError: (job) => {
            if (job?.status === 'cancelled' || job?.error === 'job.cancelled') { this._wfFcStop(''); return; }
            this._wfFcStop(this._wfFcErrorText(job?.error, job?.errorParams, true));
          },
          onNotFound: () => this._wfFcStop(''),
        });
      } catch (e) {
        if (!isSelectedBook(bookId)) return;
        this._wfFcStop(window.__app.t('weltfakten.factcheck.failed'));
        console.error('[wfFactcheckRun]', e);
      }
    },

    _wfFcStop(errorText) {
      this.wfFcRunning = false;
      this.wfFcProgress = 0;
      this.wfFcStatusKey = '';
      this.wfFcStatusParams = null;
      this.wfFcError = errorText || '';
    },

    // Fehlercode der Start-Antwort (`error.CODE`) bzw. Fehler-Key des Jobs → Text; sonst generisch.
    _wfFcErrorText(code, params, isKey = false) {
      const t = (k, p) => window.__app.t(k, p || {});
      const key = code ? (isKey ? code : (FC_START_ERROR_KEYS[code] || 'error.' + code)) : '';
      const msg = key ? t(key, params) : key;
      return key && msg !== key ? msg : t('weltfakten.factcheck.failed');
    },

    // ── Pflege ──────────────────────────────────────────────────────────────
    wfKatOptions() {
      return KAT_ORDER.map(k => ({ value: k, label: this.wfKatLabel(k) }));
    },

    wfStartCreate() {
      this.wfEdit = { ..._emptyEdit(), mode: 'new' };
    },

    wfStartEdit(f) {
      this.wfEdit = {
        ..._emptyEdit(), mode: 'edit', id: f.id,
        draft: { kategorie: _normKat(f.kategorie), subjekt: f.subjekt || '', fakt: f.fakt || '' },
      };
    },

    wfCancelEdit() {
      this.wfEdit = _emptyEdit();
    },

    async wfSaveEdit() {
      const bookId = Alpine.store('nav').selectedBookId;
      const e = this.wfEdit;
      if (!bookId || !e.mode || e.busy || !e.draft.fakt.trim()) return;
      e.busy = true;
      e.error = '';
      try {
        const url = e.mode === 'new' ? `/world-facts/${bookId}` : `/world-facts/${bookId}/${e.id}`;
        const r = await fetch(url, {
          method: e.mode === 'new' ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(e.draft),
        });
        const data = await r.json().catch(() => null);
        if (!isSelectedBook(bookId)) return;
        if (!r.ok) throw new Error(window.__app.tError(data));
        this.wfEdit = _emptyEdit();
        await this.loadWorldFacts();
      } catch (err) {
        if (isSelectedBook(bookId)) { this.wfEdit.error = err.message; this.wfEdit.busy = false; }
      }
    },

    async wfDelete(f) {
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId) return;
      if (!await window.__app.appConfirm({
        message: window.__app.t(f.manuell ? 'weltfakten.edit.deleteConfirm' : 'weltfakten.edit.deleteConfirmKi'),
        confirmLabel: window.__app.t('common.delete'),
        danger: true,
      })) return;
      const r = await fetch(`/world-facts/${bookId}/${f.id}`, { method: 'DELETE' });
      if (!isSelectedBook(bookId)) return;
      if (r.ok) await this.loadWorldFacts();
    },

    // Gefilterte Fakten nach Kategorie gruppiert, in kanonischer Reihenfolge:
    // [{ kategorie (Key), fakten[] }].
    get wfGrouped() {
      const filtered = this.wfFiltered;
      return this._memo('grouped', [filtered], () => {
        const groups = new Map();
        for (const f of filtered) {
          const k = _normKat(f.kategorie);
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(f);
        }
        return KAT_ORDER
          .filter(k => groups.has(k))
          .map(k => ({ kategorie: k, fakten: groups.get(k) }));
      });
    },
  }));
}
