// Alpine.data('tagebuchRueckblickCard') — Sub-Komponente des Tagebuch-Rückblicks.
// Nur bei Buchtyp 'tagebuch' (Gate via feature-registry requiresBuchtyp).
//
// Eigener State: Zeitraum, Ergebnis, Lade-/Fortschritts-State, History
//   (Metadaten aller Läufe, Ergebnisse lazy in _rbResults), Coverage (Datums-
//   SSoT vom Server), aktuelles Modell, Suche, aktive Belege.
// Root behält: showTagebuchRueckblickCard (Hash-Router + Exklusivität).
// Job-Polling/run/onVisible: createCardJobFeature. Struktur-Ergebnis wird in
// onDone gespeichert und im Partial via x-for/x-text gerendert (auto-escaped).

import { tagebuchRueckblickMethods } from '../book/tagebuch-rueckblick.js';
import { createCardJobFeature } from './job-feature-card.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { runningJobStatus } from './job-helpers.js';

export function registerTagebuchRueckblickCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('tagebuchRueckblickCard', () => ({
    rueckblickZeitraum: '',
    rueckblickResult: null,
    rueckblickEmpty: false,
    rueckblickLoading: false,
    rueckblickProgress: 0,
    rueckblickStatus: '',
    rueckblickHistory: [],
    rbHistoryLoaded: false,
    rbCoverage: null,
    rbCurrentModel: '',
    selectedRueckblickId: null,
    rbHistorySearch: '',
    rbSearchIds: [],
    rbHistoryView: 'cal',
    rbBeleg: { key: null, label: '', belege: [] },
    // Geladene Ergebnisse je History-id (die Liste trägt nur Metadaten).
    _rbResults: {},
    _rueckblickPollTimer: null,
    _rbSearchTimer: null,
    _lifecycle: null,
    // Memo-Speicher von tagebuch-rueckblick.js#_memo. MUSS hier deklariert
    // sein: legt ihn erst der Helper per `this._memos = {}` an, schreibt
    // Alpines Scope-Merge die unbekannte Eigenschaft an die aeusserste
    // Komponente (die Root) — dann teilen sich fremde Karten einen Topf,
    // und ein gleichnamiger Schluessel liefert deren Eintrag zurueck.
    _memos: {},

    init() {
      const onJobReconnect = (e) => {
        const d = e.detail;
        if (d?.type !== 'rueckblick') return;
        const job = d.job;
        this.rueckblickLoading = true;
        this.rueckblickProgress = job.progress || 0;
        this.rueckblickResult = null;
        this.rueckblickEmpty = false;
        this.rueckblickStatus = runningJobStatus(
          (k, p) => window.__app.t(k, p),
          job.statusText || 'common.analysisRunning', job.tokensIn, job.tokensOut, job.maxTokensOut,
          job.progress, job.tokensPerSec, job.statusParams,
        );
        this.startTagebuchRueckblickPoll(d.jobId);
      };

      // Zeitraum-Vorauswahl aus der Overview-Heatmap (warmer Fall: Karte offen).
      // Cold-Open läuft über pendingRueckblickZeitraum im onOpen-Hook.
      const onRueckblickSelect = (e) => {
        const z = e.detail?.zeitraum;
        if (!z || !window.__app.showTagebuchRueckblickCard) return;
        this._applyRueckblickZeitraum(z);
      };

      this._lifecycle = setupCardLifecycle(this, {
        name: 'tagebuchRueckblick',
        showFlag: 'showTagebuchRueckblickCard',
        timerKeys: ['_rueckblickPollTimer', '_rbSearchTimer'],
        onShow: () => this._onVisibleRueckblick(),
        resetState: {
          rueckblickResult: null,
          rueckblickEmpty: false,
          rueckblickLoading: false,
          rueckblickProgress: 0,
          rueckblickStatus: '',
          rueckblickHistory: [],
          rbHistoryLoaded: false,
          rbCoverage: null,
          rbCurrentModel: '',
          selectedRueckblickId: null,
          rbHistorySearch: '',
          rbSearchIds: [],
          rbHistoryView: 'cal',
          _rbResults: {},
          rbBeleg: { key: null, label: '', belege: [] },
        },
        extraListeners: [
          { type: 'job:reconnect', handler: onJobReconnect },
          { type: 'rueckblick:select', handler: onRueckblickSelect },
        ],
      });

      // Permalink-Spiegel: lokaler selectedRueckblickId → Alpine.store('nav')
      // (Hash-Router liest von dort).
      this.$watch('selectedRueckblickId', (id) => {
        if (window.Alpine) window.Alpine.store('nav').rueckblickEntryId = id || null;
      });
      // Permalink-Eingang: Klick auf #…/rueckblick/<id> bei offener Karte.
      // Wird die id null (Browser-Zurück auf die Kalender-Übersicht #…/rueckblick),
      // den offenen Eintrag schliessen, damit die Anzeige der URL folgt.
      this.$watch(() => window.Alpine?.store('nav').rueckblickEntryId, (id) => {
        if (!window.__app?.showTagebuchRueckblickCard) return;
        if (id && String(id) !== String(this.selectedRueckblickId)) this._openRueckblickEntryById(id);
        else if (!id && this.selectedRueckblickId) this.closeRueckblick();
      });
      // Zeitraum-Wechsel (Combobox): vorhandenen Rückblick des Zeitraums anzeigen
      // (kein Auto-Run), sonst den Erstellen-Aufruf. Ist bereits ein Eintrag
      // desselben Zeitraums offen (z. B. per History-Klick auf einen älteren
      // Lauf), nicht auf den jüngsten umschalten.
      this.$watch('rueckblickZeitraum', (z) => {
        if (this.rueckblickLoading) return;
        const sel = (this.rueckblickHistory || []).find(e => e.id === this.selectedRueckblickId);
        if (sel && sel.zeitraum === z) return;
        const entry = (this.rueckblickHistory || []).find(e => e.zeitraum === z);
        if (entry) { this.openRueckblickHistory(entry); return; }
        this.rueckblickResult = null;
        this.rueckblickEmpty = false;
        this.selectedRueckblickId = null;
        this.clearBeleg();
      });
      // Inhaltssuche der History: serverseitig, entprellt.
      this.$watch('rbHistorySearch', (q) => {
        clearTimeout(this._rbSearchTimer);
        if (!String(q || '').trim()) { this.rbSearchIds = []; return; }
        this._rbSearchTimer = setTimeout(() => this.searchRueckblicke(q), 250);
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...tagebuchRueckblickMethods,

    ...createCardJobFeature({
      name: 'rueckblick',
      endpoint: '/jobs/rueckblick',
      timerProp: '_rueckblickPollTimer',
      methodNames: {
        start:     'startTagebuchRueckblickPoll',
        run:       'runTagebuchRueckblick',
        onVisible: '_onVisibleRueckblick',
      },
      fields: {
        show:     'showTagebuchRueckblickCard',
        loading:  'rueckblickLoading',
        progress: 'rueckblickProgress',
        status:   'rueckblickStatus',
      },
      lsKey: (bookId, self) => `rueckblick_job_${bookId}_${self.rueckblickZeitraum}`,
      i18n: {
        starting:       'rueckblick.starting',
        interrupted:    'job.interrupted',
        alreadyRunning: 'common.analysisAlreadyRunning',
      },
      progressResetDelay: 400,
      // Angezeigten Rückblick räumen (auch einen älteren Lauf), Zeitraum bleibt.
      beforeRun() {
        this.rueckblickResult = null;
        this.rueckblickEmpty = false;
        this.selectedRueckblickId = null;
        this.clearBeleg();
      },
      buildPayload() {
        return {
          book_id: parseInt(Alpine.store('nav').selectedBookId),
          zeitraum: this.rueckblickZeitraum,
        };
      },
      async onDone(job) {
        if (job.result?.empty) {
          this.rueckblickResult = null;
          this.rueckblickEmpty = true;
          this.rueckblickStatus = '';
          return;
        }
        const result = job.result?.rueckblick || null;
        this.rueckblickResult = result;
        this.rueckblickEmpty = false;
        this.rueckblickStatus = '';
        this.selectedRueckblickId = null;
        this.rbBeleg = { key: null, label: '', belege: [] };
        // History + Coverage wurden serverseitig fortgeschrieben → neu laden, dann
        // den neu entstandenen (oder bestehenden) Eintrag des Zeitraums auswählen,
        // damit Permalink und Meta-Zeile stimmen.
        await Promise.all([this.loadRueckblickHistory(), this.loadRueckblickCoverage()]);
        const fresh = (this.rueckblickHistory || []).find(en => en.zeitraum === this.rueckblickZeitraum);
        if (fresh) {
          if (result) this._rbResults[fresh.id] = result;
          this.selectedRueckblickId = fresh.id;
        }
      },
      async onOpen() {
        const nav = window.Alpine.store('nav');
        // Permalink (#…/rueckblick/<entryId>) gewinnt vor allem anderen.
        const entryId = nav.rueckblickEntryId;
        // Cold-Open via Overview-Heatmap: pending-Zeitraum übernehmen (gewinnt
        // vor dem Default). Sonst jüngster Monat als Default.
        const pending = nav.pendingRueckblickZeitraum;
        if (pending) { nav.pendingRueckblickZeitraum = null; this.rueckblickZeitraum = pending; }
        // History vor dem Default-Zeitraum: der $watch auf rueckblickZeitraum
        // sucht dort den vorhandenen Rückblick. Coverage liefert den Default.
        await Promise.all([this.loadRueckblickHistory(), this.loadRueckblickCoverage()]);
        if (!this.rueckblickZeitraum) this.rueckblickZeitraum = this.defaultZeitraum();
        if (entryId) {
          this._openRueckblickEntryById(entryId);
        } else {
          // Vorhandenen Rückblick des aktuellen Zeitraums zeigen (kein Auto-Run) —
          // sonst stünde bei gesperrter Neugenerierung eine leere Karte da.
          const existing = (this.rueckblickHistory || []).find(en => en.zeitraum === this.rueckblickZeitraum);
          if (existing) this.openRueckblickHistory(existing);
        }
      },
    }),
  }));
}
