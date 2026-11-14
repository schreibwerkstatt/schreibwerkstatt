// Alpine.data('autorenprofilCard') — Sub-Komponente „Autorenprofil": die
// stilistischen Kennzahlen der EIGENEN Buecher nebeneinander, in Werk-Reihenfolge.
// User-bound, nicht buch-bound — `showAutorenprofilCard` + `toggleAutorenprofilCard`
// leben im Root (generiert aus EXCLUSIVE_CARDS). Daten: `GET /me/author-profile`.
//
// Lifecycle ueber setupCardLifecycle mit `showNeedsBookId`/`refreshNeedsBookId:
// false` und ohne `load`/`resetState`: die Karte kennt kein Buch, ein Buchwechsel
// setzt sie weder zurueck noch laedt er sie neu (wie my-stats, my-books).
//
// Die Karte WERTET NICHT und faerbt keine Abweichung als gut/schlecht ein: eine
// kuerzere Satzlaenge ist keine Note. Gezeigt werden Wert, Median und Abstand.

import { EVT } from '../events.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { tFetchError } from '../i18n.js';
import { formatNumber, fetchJson, sendJson } from '../utils.js';
import { startPoll, runningJobStatus } from './job-helpers.js';
import { diffParts } from '../diff/diff-parts.js';

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
    apGenProgress: 0,
    apGenStatus: '',
    _apPollTimer: null,
    // KI-Ergebnis als Vorschlag (Vorschlagskarte mit Wort-Diff): der Lauf legt
    // ihn als offenen Vorschlag ab (GET /ai-proposals/autorenprofil), erst
    // «Übernehmen» speichert ({ text, konstanten, entwicklung, basis, basisSig, diff }).
    apSuggestion: null,
    // Bearbeiten: der Entwurf lebt lokal, bis gespeichert wird — sonst schreibt
    // ein Reload waehrend des Tippens den Text unter dem Cursor um.
    apEditing: false,
    apEditText: '',
    apSaving: false,
    _apMemos: {},
    _lifecycle: null,

    init() {
      // Das Ergebnis des Laufs wird zum Vorschlag. Der eigene Poller liefert
      // Fortschritt und Ergebnis; JOB_FINISHED fängt den Lauf ab, der ohne Poller
      // endete (Reload, anderer Tab); einen Lauf, der bei geschlossener App
      // endete, holt loadAutorenprofil aus den offenen Vorschlägen.
      this._onApJobFinished = (ev) => {
        if (ev?.detail?.type !== 'autorenprofil') return;
        if (this._apPollTimer) return; // der eigene Poller meldet selbst
        this._apFinish(ev.detail.job);
      };
      this._lifecycle = setupCardLifecycle(this, {
        name: 'autorenprofil',
        showFlag: 'showAutorenprofilCard',
        showNeedsBookId: false,
        refreshNeedsBookId: false,
        timerKeys: ['_apPollTimer'],
        onShow: () => { this._apReattach(); return this.loadAutorenprofil(); },
        // Reklick, Aufwachen, Reconnect: still neu laden (Skeleton nur beim ersten Mal).
        onCardRefresh: () => this.loadAutorenprofil(),
        extraListeners: [{ type: EVT.JOB_FINISHED, handler: this._onApJobFinished }],
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },

    // Skeleton nur beim ersten Laden. Ein Reload bei stehender Karte (Aufwachen
    // nach Tabwechsel/Reconnect feuert CARD_REFRESH an jede offene Karte, ebenso
    // Reklick und Job-Ende) ersetzt die Daten still: sonst tauscht das Template
    // den ganzen Inhalt gegen das Skeleton und zurueck, und die Karte springt.
    // Scheitert ein solcher Hintergrund-Reload, bleiben die alten Daten stehen.
    async loadAutorenprofil() {
      const background = !!this.apData;
      if (!background) this.apLoading = true;
      this.apError = '';
      try {
        const [data, open] = await Promise.all([
          fetchJson('/me/author-profile'),
          fetchJson('/ai-proposals/autorenprofil').catch(() => null),
        ]);
        this.apData = data;
        this._apMemos = {};
        if (!this.apSuggestion && open?.proposal?.payload) this._apSetSuggestion(open.proposal.payload);
      } catch (e) {
        if (!background) {
          this.apError = window.__app.t('autorenprofil.loadError');
          this.apData = null;
        }
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
     * KI-Lauf starten. Er schreibt nichts: das Ergebnis erscheint als
     * Vorschlag mit Wort-Diff gegen den geltenden Text, «Übernehmen» speichert.
     * Ein von Hand editierter Text braucht darum keine Rückfrage mehr.
     */
    async generateAutorenprofil() {
      if (this.apGenerating) return;
      this.apGenerating = true;
      this.apGenError = '';
      this.apGenProgress = 0;
      this.apGenStatus = '';
      this.apSuggestion = null;
      try {
        const data = await sendJson('/jobs/autorenprofil', 'POST', {});
        this.apJobId = data.jobId;
        window.dispatchEvent(new CustomEvent(EVT.JOB_ENQUEUED, {
          detail: { type: 'autorenprofil', jobId: data.jobId },
        }));
        this._apPoll(data.jobId);
      } catch (e) {
        this.apGenerating = false;
        this.apGenError = tFetchError(e);
      }
    },

    _apPoll(jobId) {
      const app = window.__app;
      startPoll(this, {
        timerProp: '_apPollTimer',
        jobId,
        progressProp: 'apGenProgress',
        onProgress: (job) => {
          this.apGenStatus = runningJobStatus((k, p) => app.t(k, p),
            job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut,
            job.progress, job.tokensPerSec, job.statusParams);
        },
        onDone: (job) => this._apFinish(job),
        onError: (job) => this._apFinish(job),
        onNotFound: () => this._apIdle(),
      });
    },

    // Laufender Lauf nach Reload/Kartenwechsel: Fortschritt wieder anhängen.
    _apReattach() {
      if (this.apGenerating || this._apPollTimer) return;
      const queued = window.Alpine?.store('jobs')?.jobQueueItems || [];
      const job = queued.find(j => j.type === 'autorenprofil');
      if (!job) return;
      this.apGenerating = true;
      this.apJobId = job.id;
      this.apGenProgress = job.progress || 0;
      this._apPoll(job.id);
    },

    _apIdle() {
      if (this._apPollTimer) { clearInterval(this._apPollTimer); this._apPollTimer = null; }
      this.apGenerating = false;
      this.apJobId = null;
      this.apGenProgress = 0;
      this.apGenStatus = '';
    },

    _apFinish(job) {
      this._apIdle();
      if (!job || job.status === 'cancelled') return;
      if (job.status === 'error') {
        this.apGenError = window.__app.t('autorenprofil.genError');
        return;
      }
      this._apSetSuggestion(job.result || {});
    },

    // Vorschlagskarte aus einem Lauf-Ergebnis (Job oder offener Vorschlag).
    _apSetSuggestion(r) {
      if (!r.profilText) return; // leerer Lauf (kein gemessenes Buch)
      const before = this.apProfile?.profil_text || '';
      this.apSuggestion = {
        text: r.profilText,
        konstanten: r.konstanten || [],
        entwicklung: r.entwicklung || [],
        basis: r.basis || [],
        basisSig: r.basisSig || null,
        diff: diffParts(before, r.profilText),
      };
    },

    async cancelAutorenprofil() {
      const id = this.apJobId;
      if (!id) return;
      await window.__app.cancelJob(id);
      this._apIdle();
    },

    // Verwerfen erledigt auch den offenen Vorschlag am Server — sonst stünde er
    // beim nächsten Öffnen wieder da.
    async discardApSuggestion() {
      this.apSuggestion = null;
      try { await fetchJson('/ai-proposals/autorenprofil', { method: 'DELETE' }); }
      catch (e) { this.apGenError = tFetchError(e); }
    },

    /** Vorschlag übernehmen: der normale Speicherweg der Karte (PUT
     *  /me/author-profile), als Lauf-Ergebnis samt Deutungs-Listen — nicht als
     *  Handarbeit (`edited` bleibt 0). */
    async applyApSuggestion() {
      const sug = this.apSuggestion;
      if (!sug || this.apSaving) return;
      this.apSaving = true;
      this.apGenError = '';
      try {
        await sendJson('/me/author-profile', 'PUT', {
          run: {
            profil_text: sug.text, konstanten: sug.konstanten, entwicklung: sug.entwicklung,
            basis: sug.basis, basis_sig: sug.basisSig,
          },
        });
        this.apSuggestion = null;
        this.apEditing = false;
        await this.loadAutorenprofil();
      } catch (e) {
        this.apGenError = tFetchError(e);
      } finally {
        this.apSaving = false;
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
        await sendJson('/me/author-profile', 'PUT', { profil_text: this.apEditText });
        this.apEditing = false;
        await this.loadAutorenprofil();
      } catch (e) {
        this.apGenError = tFetchError(e);
      } finally {
        this.apSaving = false;
      }
    },
  }));
}
