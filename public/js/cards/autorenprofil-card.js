// Alpine.data('autorenprofilCard') — Sub-Komponente „Autorenprofil": die
// stilistischen Kennzahlen der EIGENEN Buecher nebeneinander, in Werk-Reihenfolge.
// User-bound, nicht buch-bound — `showAutorenprofilCard` + `toggleAutorenprofilCard`
// leben im Root (generiert aus EXCLUSIVE_CARDS). Daten: `GET /me/author-profile`.
//
// Lifecycle bewusst von Hand statt ueber setupCardLifecycle: der Helper ist fuer
// buch-skopierte Karten gebaut und haengt `book:changed`-Reset-Handler an. Diese
// Karte kennt kein Buch — ein Buchwechsel darf sie nicht zuruecksetzen. Gleiche
// Entscheidung wie in my-stats-card.js und my-books-card.js.
//
// Die Karte WERTET NICHT und faerbt keine Abweichung als gut/schlecht ein: eine
// kuerzere Satzlaenge ist keine Note. Gezeigt werden Wert, Median und Abstand.

import { EVT } from '../events.js';
import { formatNumber } from '../utils.js';

export function registerAutorenprofilCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('autorenprofilCard', () => ({
    apData: null,
    apLoading: false,
    apError: '',
    // Deutung (Stufe 2): eigener KI-Lauf ueber die Messung + die Buch-Stilprofile.
    apGenerating: false,
    apJobId: null,
    apGenError: '',
    // Bearbeiten: der Entwurf lebt lokal, bis gespeichert wird — sonst schreibt
    // ein Reload waehrend des Tippens den Text unter dem Cursor um.
    apEditing: false,
    apEditText: '',
    apSaving: false,
    _apMemos: {},

    init() {
      this.$watch(() => window.__app.showAutorenprofilCard, (visible) => {
        if (visible) this.loadAutorenprofil();
      });
      this._onApRefresh = (ev) => {
        if (ev?.detail?.name === 'autorenprofil') this.loadAutorenprofil();
      };
      window.addEventListener(EVT.CARD_REFRESH, this._onApRefresh);

      // Der Lauf persistiert serverseitig — nach dem Job wird neu geladen statt
      // das Job-Result in den State zu kopieren. So ist die Karte auch dann
      // richtig, wenn der Lauf in einem anderen Tab lief.
      this._onApJobFinished = (ev) => {
        if (ev?.detail?.type !== 'autorenprofil') return;
        this.apGenerating = false;
        this.apJobId = null;
        if (ev.detail.job?.status === 'error') {
          this.apGenError = window.__app.t('autorenprofil.genError');
        } else {
          this.loadAutorenprofil();
        }
      };
      window.addEventListener(EVT.JOB_FINISHED, this._onApJobFinished);
    },

    destroy() {
      window.removeEventListener(EVT.CARD_REFRESH, this._onApRefresh);
      window.removeEventListener(EVT.JOB_FINISHED, this._onApJobFinished);
    },

    async loadAutorenprofil() {
      this.apLoading = true;
      this.apError = '';
      try {
        const r = await fetch('/me/author-profile');
        if (!r.ok) throw new Error(String(r.status));
        this.apData = await r.json();
        this._apMemos = {};
      } catch (e) {
        this.apError = window.__app.t('autorenprofil.loadError');
        this.apData = null;
      } finally {
        this.apLoading = false;
      }
    },

    // ── Buchnamen ────────────────────────────────────────────────────────────
    // Die Route liefert bewusst keine Namen (Content-Store-Regel) — sie kommen
    // aus `$store.nav.books`, gleiche Konvention wie „Meine Buecher".
    apBookName(bookId) {
      const books = window.__app.$store.nav.books || [];
      const hit = books.find(b => String(b.book_id ?? b.id) === String(bookId));
      return hit?.name || window.__app.t('autorenprofil.unknownBook', { id: bookId });
    },

    apBookNames(ids) {
      return (ids || []).map(id => this.apBookName(id)).join(', ');
    },

    // ── Formatierung ─────────────────────────────────────────────────────────
    // `null` wird zu „–", nicht zu „0": null heisst „nicht messbar", nicht
    // „gemessen, Ergebnis null". Gleiche Regel wie in der Wortschatz-Karte.
    apNum(v, decimals = 1) {
      return formatNumber(v == null ? null : Number(v), Alpine.store('shell').uiLocale, decimals);
    },

    /** Kennzahl nach ihrer eigenen Spec formatieren (Prozent-Flag + Nachkommastellen). */
    apValue(value, spec) {
      if (value == null || !Number.isFinite(Number(value))) return '–';
      const v = Number(value);
      return spec?.percent
        ? this.apNum(v * 100, spec.decimals ?? 1) + '%'
        : this.apNum(v, spec?.decimals ?? 1);
    },

    /** Abstand zum Median in Prozent, mit Vorzeichen. Leer, wenn es keinen gibt. */
    apDeviation(book, key) {
      const d = book?.deviation?.[key];
      if (d == null || !Number.isFinite(Number(d))) return '';
      const v = Number(d);
      if (Math.abs(v) < 0.5) return '±0%';
      return (v > 0 ? '+' : '') + this.apNum(v, 0) + '%';
    },

    /** Richtung ueber die Werk-Reihenfolge — nur ab drei gemessenen Buechern. */
    apTrend(metric) {
      const tr = metric?.trend;
      if (!tr || tr.pct == null || !Number.isFinite(Number(tr.pct))) return '';
      const v = Number(tr.pct);
      if (Math.abs(v) < 1) return '±0%';
      return (v > 0 ? '+' : '') + this.apNum(v, 0) + '%';
    },

    apTrendClass(metric) {
      const tr = metric?.trend;
      if (!tr || tr.pct == null) return '';
      const v = Number(tr.pct);
      if (Math.abs(v) < 1) return 'ap-trend--flat';
      // Richtungs-, KEINE Wertklasse: rauf/runter, nicht gut/schlecht.
      return v > 0 ? 'ap-trend--up' : 'ap-trend--down';
    },

    // ── Gruppierung ──────────────────────────────────────────────────────────
    // Memoisiert: das Template rendert die Gruppen je Render mehrfach.
    _apMemo(key, deps, fn) {
      const prev = this._apMemos[key];
      if (prev && prev.deps.length === deps.length && prev.deps.every((d, i) => d === deps[i])) {
        return prev.value;
      }
      const value = fn();
      this._apMemos[key] = { deps, value };
      return value;
    },

    /** Kennzahlen eines Vergleichsabschnitts nach Gruppe (Satzbau, Wortschatz, …). */
    apGroups(section) {
      return this._apMemo('groups:' + (section?.kind || '') + ':' + (section?.language || ''),
        [this.apData, section], () => {
          const order = [];
          const byGroup = new Map();
          for (const m of section?.metrics || []) {
            if (!byGroup.has(m.group)) { byGroup.set(m.group, []); order.push(m.group); }
            byGroup.get(m.group).push(m);
          }
          return order.map(g => ({ group: g, metrics: byGroup.get(g) }));
        });
    },

    /** Bücher eines Abschnitts in Werk-Reihenfolge. */
    apSectionBooks(section) {
      const ids = new Set(section?.bookIds || []);
      return this.apBooks.filter(b => ids.has(b.book_id));
    },

    /** Überschrift eines Abschnitts — nur bei mehrsprachigem Werk. */
    apSectionTitle(section) {
      const t = window.__app.t;
      if (section?.kind === 'language') return t('lang.' + section.language);
      if (section?.kind === 'crossLanguage') return t('autorenprofil.section.crossLanguage');
      return '';
    },

    get apSections() { return this.apData?.sections || []; },
    get apMultiLanguage() { return !!this.apData?.multiLanguage; },
    get apBooks() { return this.apData?.books || []; },
    get apCounts() { return this.apData?.counts || { total: 0, measured: 0 }; },
    get apSkipped() { return this.apData?.skipped || { excluded: [], unscanned: [], tooShort: [] }; },
    get apHasSkipped() {
      const s = this.apSkipped;
      return (s.excluded?.length || 0) + (s.unscanned?.length || 0) + (s.tooShort?.length || 0) > 0;
    },
    /** Nichts gemessen — nicht dasselbe wie „Fehler" und nicht dasselbe wie „kein Stil". */
    get apIsEmpty() {
      return !this.apLoading && !this.apError && (this.apData ? this.apCounts.measured === 0 : false);
    },
    /** Genau ein Buch: Werte ja, Vergleich nein. Wird ausgewiesen statt kaschiert. */
    get apSingleBook() {
      return !!this.apData && this.apCounts.measured === 1;
    },

    // ── Deutung ──────────────────────────────────────────────────────────────
    get apProfile() { return this.apData?.profile || null; },
    /** Der Text steht, aber die Buecher darunter haben sich seither bewegt. */
    get apProfileStale() { return !!this.apData?.profileStale; },

    /**
     * KI-Lauf starten. `force` ueberschreibt einen von Hand editierten Text —
     * der Server verlangt das Flag (409), die Karte fragt vorher.
     */
    async generateAutorenprofil(force = false) {
      if (this.apGenerating) return;
      this.apGenerating = true;
      this.apGenError = '';
      try {
        const res = await fetch('/jobs/autorenprofil', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(force ? { force: true } : {}),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 409 && data?.error_code === 'AUTHOR_PROFILE_EDITED') {
          this.apGenerating = false;
          const ok = await window.__app.appConfirm({
            message: window.__app.t('autorenprofil.overwriteConfirm'),
            confirmLabel: window.__app.t('autorenprofil.overwriteConfirmYes'),
            danger: true,
          });
          if (ok) await this.generateAutorenprofil(true);
          return;
        }
        if (!res.ok) throw new Error(window.__app.tError(data) || `HTTP ${res.status}`);
        this.apJobId = data.jobId;
        window.dispatchEvent(new CustomEvent(EVT.JOB_ENQUEUED, {
          detail: { type: 'autorenprofil', jobId: data.jobId },
        }));
      } catch (e) {
        this.apGenerating = false;
        this.apGenError = e.message;
      }
    },

    // ── Bearbeiten ───────────────────────────────────────────────────────────
    startApEdit() {
      this.apEditText = this.apProfile?.profil_text || '';
      this.apEditing = true;
    },

    cancelApEdit() {
      this.apEditing = false;
      this.apEditText = '';
    },

    async saveApText() {
      if (this.apSaving) return;
      this.apSaving = true;
      this.apGenError = '';
      try {
        const res = await fetch('/me/author-profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profil_text: this.apEditText }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(window.__app.tError(data) || `HTTP ${res.status}`);
        this.apEditing = false;
        await this.loadAutorenprofil();
      } catch (e) {
        this.apGenError = e.message;
      } finally {
        this.apSaving = false;
      }
    },
  }));
}
