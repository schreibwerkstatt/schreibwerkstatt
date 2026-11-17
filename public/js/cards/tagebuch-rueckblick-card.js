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
import { rueckblickVerlaufMethods } from '../book/rueckblick-verlauf.js';
import { rueckblickCalendarMethods } from '../book/rueckblick-calendar.js';
import { createCardJobFeature } from './job-feature-card.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { runningJobStatus } from './job-helpers.js';
import { EVT } from '../events.js';

// Massgeblich ist der Zeitraum DES LAUFS (job.result.zeitraum), nicht der
// gerade gewählte: nach einem Reconnect (Karte neu geöffnet → Default-
// Zeitraum) oder einem Zeitraum-Wechsel während des Laufs stünde das
// Ergebnis sonst unter dem falschen Monat, mit falschem Permalink.
export async function rueckblickOnDone(job) {
  const zeitraum = job.result?.zeitraum || this.rueckblickZeitraum;
  if (job.result?.empty) {
    this._applyRueckblickZeitraum(zeitraum);
    await this.$nextTick(); // Zeitraum-Watcher zuerst, sonst räumt er den Leerzustand
    this.rueckblickResult = null;
    this.rueckblickEmpty = true;
    this.rueckblickStatus = '';
    return;
  }
  const result = job.result?.rueckblick || null;
  this.rueckblickEmpty = false;
  this.rueckblickStatus = '';
  // Das Ergebnis erscheint im Hauptbereich; der Verlauf lädt beim nächsten
  // Öffnen neu (rbMainView-Watcher).
  this.rbVerlauf = null;
  this.rbMainView = 'period';
  // History + Coverage wurden serverseitig fortgeschrieben → neu laden, dann
  // den neu entstandenen (oder bestehenden) Eintrag des Zeitraums öffnen —
  // openRueckblickHistory setzt Auswahl vor Zeitraum, der Zeitraum-Watcher
  // öffnet darum nichts Älteres darüber.
  await Promise.all([this.loadRueckblickHistory(), this.loadRueckblickCoverage()]);
  const fresh = (this.rueckblickHistory || []).find(en => en.zeitraum === zeitraum);
  if (fresh) {
    if (result) this._rbResults[fresh.id] = result;
    await this.openRueckblickHistory(fresh);
  } else {
    this.selectedRueckblickId = null;
    this.clearBeleg();
    this.rueckblickZeitraum = zeitraum;
    await this.$nextTick(); // Zeitraum-Watcher zuerst, sonst räumt er das Ergebnis
    this.rueckblickResult = result;
  }
}

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
    // Leiste: Kalender | Liste. Hauptbereich: Zeitraum | Verlauf.
    rbHistoryView: 'cal',
    rbMainView: 'period',
    rbBeleg: { key: null, label: '', belege: [], aliase: [] },
    // Aufgeklappte Einzelnennungen je Facette ({ personen: true, … }).
    rbFacetMore: {},
    // Verlauf über die Monate (Ansicht «Verlauf», lazy beim ersten Öffnen).
    rbVerlauf: null,
    rbVerlaufFacet: 'personen',
    rbVerlaufSearch: '',
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
          rbMainView: 'period',
          _rbResults: {},
          rbBeleg: { key: null, label: '', belege: [], aliase: [] },
          rbFacetMore: {},
          rbVerlauf: null,
          rbVerlaufFacet: 'personen',
          rbVerlaufSearch: '',
        },
        extraListeners: [
          { type: EVT.JOB_RECONNECT, handler: onJobReconnect },
          { type: EVT.RUECKBLICK_SELECT, handler: onRueckblickSelect },
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
      // Zeitraum-Wechsel (Kalender, Liste, ‹ ›, Permalink): vorhandenen Rückblick des Zeitraums anzeigen
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
      // Verlauf lädt beim ersten Öffnen der Ansicht (und nach jedem neuen Lauf,
      // der rbVerlauf auf null setzt).
      this.$watch('rbMainView', (v) => {
        if (v === 'verlauf' && !this.rbVerlauf) this.loadRueckblickVerlauf();
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
    ...rueckblickCalendarMethods,
    ...rueckblickVerlaufMethods,

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
      onDone: rueckblickOnDone,
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
