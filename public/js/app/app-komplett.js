import { fetchJson, clearStatusAfter, formatLastRun, localeTag } from '../utils.js';
import { EVT } from '../events.js';
import { tFetchError } from '../i18n.js';
import { KOMPLETT_STEPS, KOMPLETT_CORE_STEPS, KOMPLETT_STEP_KEYS, KOMPLETT_PHASES,
         normalizeKomplettScope, isFullKomplettScope } from '../komplett-scope.js';

// Komplett-Analyse-Pipeline-UI: Start, Polling, Phasen-Indikator,
// Last-Run-Anzeige, Kapitel-Cache-Reset.
// Server-seitiger Job-Typ: `komplett-analyse` (siehe routes/jobs/komplett.js).
export const appKomplettMethods = {
  async clearChapterCache() {
    if (!this.$store.nav.selectedBookId) return;
    if (!await this.appConfirm({
      message: this.t('app.cacheClearConfirm'),
      confirmLabel: this.t('common.delete'),
      danger: true,
    })) return;
    const { deleted } = await fetchJson(`/jobs/chapter-cache/${this.$store.nav.selectedBookId}`, { method: 'DELETE' });
    await this.appAlert({ message: this.t('app.cacheCleared', { n: deleted }) });
  },

  // Einstiegspunkt aller Auslöser (Header-Knopf, Leer-Zustand der Katalog-Karten,
  // Command-Palette): das Modal fragt den Umfang und ersetzt damit die frühere
  // Ja/Nein-Bestätigung — es beantwortet dieselbe Frage genauer.
  async alleAktualisieren() {
    if (!this.$store.nav.selectedBookId || this.$store.jobs.alleAktualisierenLoading) return;
    // Leeres Buch: Hinweis statt Umfangs-Dialog mit «Lauf empfohlen».
    if (this.bookHasNoText?.()) {
      this.setStatus(this.t('header.updateAllEmptyBook'), false, 6000);
      return;
    }
    this.showKomplettStatus = false;
    this.komplettScopeForce = false;
    this.komplettScopeLoading = true;
    // Partial lazy nachladen, BEVOR das Flag gesetzt wird — der Dialog gehoert
    // nicht in den Cold-Boot-Satz (die meisten Sitzungen oeffnen ihn nie).
    // _ensurePartial wirft nicht, sondern liefert false (Fetch fehlgeschlagen):
    // dann kein Flag ohne Markup — der Knopf wirkte sonst tot.
    if (!await this._ensurePartial('komplett-scope')) {
      this.komplettScopeLoading = false;
      this.setStatus(this.t('app.komplettScopeLoadError'), false, 6000);
      return;
    }
    this.komplettScopeOpen = true;
    const bookId = this.$store.nav.selectedBookId;
    // Indikation parallel — sie liest das ganze Buch und darf die Schalter nicht aufhalten.
    this._loadKomplettDelta(bookId);
    try {
      // Vorbelegung ist der zuletzt GESTARTETE Umfang (serverseitig, pro Buch + User).
      const { scope } = await fetchJson(`/jobs/komplett-scope/${bookId}`);
      // Buchwechsel während des Fetches: die Antwort gehört dann zum alten Buch.
      if (this.$store.nav.selectedBookId !== bookId) return;
      this.komplettScope = normalizeKomplettScope(scope);
    } catch (e) {
      console.error('[komplettScope]', e);
      // Ohne Vorbelegung der vollständige Lauf — er lässt nichts aus.
      this.komplettScope = normalizeKomplettScope(null);
    } finally {
      this.komplettScopeLoading = false;
    }
  },

  async _loadKomplettDelta(bookId) {
    this.komplettDelta = null;
    this.komplettDeltaState = 'loading';
    try {
      const delta = await fetchJson(`/jobs/komplett-delta/${bookId}`);
      if (this.$store.nav.selectedBookId !== bookId) return;
      this.komplettDelta = delta;
      this.komplettDeltaState = 'ready';
    } catch (e) {
      console.error('[komplettDelta]', e);
      if (this.$store.nav.selectedBookId === bookId) this.komplettDeltaState = 'error';
    }
  },

  komplettDeltaLevel() { return this.komplettDelta?.verdict?.level || null; },

  komplettDeltaLastRunText() {
    const run = this.komplettDelta?.lastRun;
    if (!run) return '';
    const when = formatLastRun(run.endedAt, (k, p) => this.t(k, p), this.$store.shell.uiLocale);
    // Kosten nur für Admins; Autor:innen sehen keine Preise.
    return this.$store.session.currentUser?.isAdmin && run.usd != null && run.usd > 0
      ? this.t('komplett.delta.lastRunCost', { when, usd: run.usd.toFixed(2) })
      : this.t('komplett.delta.lastRun', { when });
  },

  komplettDeltaChangedText() {
    const d = this.komplettDelta;
    if (!d?.changedChars) return '';
    const ratio = d.totalChars > 0 ? (d.changedChars / d.totalChars) * 100 : 100;
    const pct = new Intl.NumberFormat(localeTag(this.$store.shell.uiLocale), {
      maximumFractionDigits: ratio < 10 ? 1 : 0,
    }).format(Math.min(ratio, 100));
    return this.t('komplett.delta.changed', { pct, pages: d.changedPages, chapters: d.chapterCount });
  },

  // Schritte, die dem User angeboten werden. Die Cloud-Klasse ist dieselbe Bedingung,
  // unter der `/config` die Karten ausblendet und der Job die Phase überspringt —
  // ein Schalter für etwas, das ohnehin nicht läuft, wäre eine Falschaussage.
  komplettScopeSteps(group) {
    const cloud = this.$store.config.effectiveProviderClass === 'cloud';
    return KOMPLETT_STEPS.filter(s => s.group === group && (cloud || !s.cloudOnly));
  },

  komplettCoreSteps() { return KOMPLETT_CORE_STEPS; },

  // Wie viele Schritte laufen — Beschriftung des Start-Knopfs. Zählt nur, was
  // überhaupt angeboten wird (ein lokaler Provider hat keine Urteils-Phasen).
  komplettScopeCount() {
    const offered = [...this.komplettScopeSteps('katalog'), ...this.komplettScopeSteps('pruefung')];
    return { on: offered.filter(s => this.komplettScope[s.key]).length, total: offered.length };
  },

  komplettScopeIsFull() { return isFullKomplettScope(this.komplettScope); },

  // Voreinstellungen. «Nur Katalog» ist der häufige Fall nach einer Kapitel-Änderung:
  // Entitäten auffrischen, die teuren Urteils-Phasen später oder gar nicht.
  setKomplettScopePreset(preset) {
    const next = {};
    for (const s of KOMPLETT_STEPS) next[s.key] = preset === 'all' ? true : s.group === 'katalog';
    this.komplettScope = next;
  },

  async startKomplettRun() {
    this.komplettScopeOpen = false;
    if (!this.$store.nav.selectedBookId || this.$store.jobs.alleAktualisierenLoading) return;
    this.$store.jobs.alleAktualisierenLoading = true;
    this.$store.jobs.alleAktualisierenProgress = 0;
    this.$store.jobs.alleAktualisierenTokIn = 0;
    this.$store.jobs.alleAktualisierenTokOut = 0;
    this.$store.jobs.alleAktualisierenTps = null;
    this.$store.jobs.alleAktualisierenPassMode = null;
    this.$store.jobs.alleAktualisierenWarnings = [];
    this.$store.jobs.alleAktualisierenCoverage = null;
    this.$store.jobs.alleAktualisierenCost = null;
    this.showKomplettStatus = true;
    const bookId = this.$store.nav.selectedBookId;
    const bookName = this.selectedBookName;
    const scope = Object.fromEntries(KOMPLETT_STEP_KEYS.map(k => [k, this.komplettScope[k] !== false]));
    this.$store.jobs.alleAktualisierenScope = scope;
    try {
      this.$store.jobs.alleAktualisierenStatus = this.t('komplett.started');
      const { jobId } = await fetchJson('/jobs/komplett-analyse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: parseInt(bookId), book_name: bookName,
          // Lauf-Umfang: der Server normalisiert nach, wir schicken nur die bekannten
          // Schlüssel. Er wird zugleich als Vorbelegung des nächsten Laufs gespeichert.
          scope,
          force: !!this.komplettScopeForce,
        }),
      });
      // Sofort-Refresh des Footer-Polls, sonst sieht die Job-Queue-Bar den Job
      // erst nach bis zu 5 s und driftet so lange gegen die 2-s-Karten-Bar.
      window.dispatchEvent(new CustomEvent(EVT.JOB_ENQUEUED, { detail: { type: 'komplett-analyse', jobId } }));
      this._startKomplettPoll(jobId, bookId);
    } catch (e) {
      console.error('[startKomplettRun]', e);
      // Server-Fehler (z. B. 409 KOMPLETT_STEP_JOB_RUNNING) über ihren error_code übersetzen.
      this.$store.jobs.alleAktualisierenStatus = `${this.t('common.errorColon')}${tFetchError(e)}`;
      this.$store.jobs.alleAktualisierenLoading = false;
    }
  },

  _startKomplettPoll(jobId, bookId) {
    this._startPoll({
      timerProp: '_komplettPollTimer',
      progressProp: 'alleAktualisierenProgress',
      progressTarget: this.$store.jobs,
      jobId,
      lsKey: null,
      onProgress: (job) => {
        if (job.statusText) this.$store.jobs.alleAktualisierenStatus = this.t(job.statusText, job.statusParams);
        if (job.tokensIn != null) this.$store.jobs.alleAktualisierenTokIn = job.tokensIn;
        if (job.tokensOut != null) this.$store.jobs.alleAktualisierenTokOut = job.tokensOut;
        if (job.tokensPerSec != null) this.$store.jobs.alleAktualisierenTps = job.tokensPerSec;
        if (job.passMode) this.$store.jobs.alleAktualisierenPassMode = job.passMode;
        if (job.komplettScope) this.$store.jobs.alleAktualisierenScope = job.komplettScope;
      },
      onNotFound: () => {
        this.$store.jobs.alleAktualisierenLoading = false;
        this.$store.jobs.alleAktualisierenStatus = this.t('komplett.interrupted');
      },
      onError: (job) => {
        this.$store.jobs.alleAktualisierenLoading = false;
        this.$store.jobs.alleAktualisierenStatus = `${this.t('common.errorColon')}${job.error ? this.t(job.error, job.errorParams) : this.t('app.jobFailed')}`;
      },
      onDone: async (job) => {
        // Non-critical-Degradierungen (Soziogramm/P3b/Kontinuität) persistent im
        // Status-Panel zeigen – sonst ununterscheidbar von „alles ok".
        this.$store.jobs.alleAktualisierenWarnings = Array.isArray(job?.result?.warnings) ? job.result.warnings : [];
        // Coverage-Self-Audit (F2): Recall-Score der Stichprobe im Status-Panel zeigen.
        this.$store.jobs.alleAktualisierenCoverage = job?.result?.coverage || null;
        // Kosten pro Call-Klasse: neben dem Coverage-Score, damit „billiger geworden"
        // und „schlechterer Recall" im selben Blick vergleichbar sind.
        this.$store.jobs.alleAktualisierenCost = job?.result?.costByPhase || null;
        // Die Prüfung (Kontinuität, Erzählprofil) hat die Analyse als eigene Jobs
        // eingereiht — die Footer-Queue sofort nachladen, damit sie sichtbar sind.
        const pruefJobs = job?.result?.pruefJobs || {};
        for (const [type, pJobId] of Object.entries(pruefJobs)) {
          window.dispatchEvent(new CustomEvent(EVT.JOB_ENQUEUED, { detail: { type, jobId: pJobId } }));
        }
        try {
          // _loadKontinuitaetHistory lebt auf kontinuitaetCard (nicht im Root) —
          // Card per card:refresh-Event reloaden lassen (Lifecycle hört darauf).
          window.dispatchEvent(new CustomEvent(EVT.CARD_REFRESH, { detail: { name: 'kontinuitaet' } }));
          await Promise.all([
            this.loadFiguren(bookId),
            this.loadOrte(bookId),
            this.loadSzenen(bookId),
            this.loadSongs(bookId),
            this.loadLastKomplettRun(bookId),
            this._reloadZeitstrahl(),
          ]);
        } finally {
          // Loading-Flag MUSS auch dann zurück, wenn ein Sibling-Reload wirft —
          // sonst bleibt Button-Ring + Status-Panel auf "running" hängen.
          this.$store.jobs.alleAktualisierenLoading = false;
          const doneMsg = Object.keys(pruefJobs).length
            ? this.t('komplett.pruefungEingereiht')
            : this.t('common.finished');
          this.$store.jobs.alleAktualisierenStatus = doneMsg;
          clearStatusAfter(this.$store.jobs, 'alleAktualisierenStatus', doneMsg, 4000);
        }
      },
    });
  },

  async loadLastKomplettRun(bookId, { signal } = {}) {
    if (!bookId) return;
    try {
      const { lastRun } = await fetchJson(`/jobs/last-run?type=komplett-analyse&book_id=${bookId}`, { signal });
      this.$store.jobs.alleAktualisierenLastRun = lastRun ? formatLastRun(lastRun, (k, p) => this.t(k, p), this.$store.shell.uiLocale) : null;
    } catch (e) {
      if (e?.name === 'AbortError') return;
      console.error('[loadLastKomplettRun]', e);
      this.$store.jobs.alleAktualisierenLastRun = null;
    }
  },

  // Phasen und ihre Grenzen: KOMPLETT_PHASES (komplett-scope.js) — der Job meldet
  // dieselben Werte über PHASE_END, hier wird nur abgelesen.
  // Im Single-Pass faellt Phase 3b weg (Server setzt passMode='single'). Eine Phase,
  // deren Schritte alle abgewaehlt sind, faellt WEG statt als erledigt abgehakt zu
  // werden — die Bar rueckt ueber den Bereich hinweg vor, und ein Haken waere eine
  // Falschaussage ueber eine Phase, die gar nicht lief. Massgeblich ist der Umfang
  // des Laufs (Store), nicht der Dialog: der ist nach einem Neuladen zurueckgesetzt.
  // «Aktiv» nur, solange ein Lauf laeuft — sonst stuende nach einem Neuladen
  // (Fortschritt 0, nur der letzte Lauf bekannt) die erste Phase als laufend da.
  _komplettPhasen() {
    const jobs = this.$store.jobs;
    const p = jobs.alleAktualisierenProgress;
    const scope = jobs.alleAktualisierenScope || {};
    const inScope = (ph) => !ph.scope || ph.scope.some(k => scope[k] !== false);
    const visible = KOMPLETT_PHASES.filter(ph =>
      !(ph.onlyMulti && jobs.alleAktualisierenPassMode === 'single') && inScope(ph));
    return visible.map((ph, i) => {
      const done = p >= ph.end;
      const prevEnd = i === 0 ? 0 : visible[i - 1].end;
      const active = jobs.alleAktualisierenLoading && !done && p >= prevEnd;
      return { key: ph.key, label: this.t('phase.' + ph.key), done, active };
    });
  },
};
