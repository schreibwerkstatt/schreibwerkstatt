// Card-Getter fuer die neueren „Meine Statistik"-Kacheln — in myStatsCard
// gespreadet (`...myStatsTrendMethods`). Ausgelagert, damit my-stats-card.js
// unter dem 600-LOC-Cap bleibt. Zugriff auf Card-State via `this` (Spread teilt
// den Alpine-Scope): this._memo, this.myStatsWindow(), this.myStatsHistory,
// this.myStatsWriting, this.myStatsSessions, this.myStatsBookGoals().
import { localIsoDate } from '../utils.js';
import { filterByWindow } from './my-stats-compute.js';
import { computePeriodComparison, computeSessionStats,
         computeOverallForecast, computeVocabTrend } from './my-stats-trends.js';

export const myStatsTrendMethods = {
  // ── Vorperioden-Vergleich (nur bei aktivem, nach vorne begrenztem Zeitraum) ──
  // Vergleicht den aktiven Zeitraum mit der gleich langen Periode davor. Braucht
  // ein gesetztes `from`; ein offenes `to` faellt auf heute zurueck.
  myStatsPeriodComparison() {
    const w = this.myStatsWindow();
    const from = w.from;
    const to = w.to || localIsoDate();
    if (!w.active || !from) return { available: false };
    const detail = this.myStatsData?.books_detail;
    return this._memo('periodCmp', [this.myStatsHistory, this.myStatsWriting, detail, from, to], () =>
      computePeriodComparison(this.myStatsHistory, this.myStatsWriting, from, to, { booksDetail: detail }));
  },
  myStatsHasPeriodCmp() { return this.myStatsPeriodComparison().available; },
  // Delta als Anzeige-Text: Prozent, wenn eine Vergleichsbasis existiert; sonst
  // der absolute Zuwachs mit Vorzeichen (Vorperiode war leer → % waere sinnlos).
  myStatsCmpText(d) {
    if (!d) return '';
    if (d.pct == null) return (d.delta > 0 ? '+' : '') + this._myStatsFmt(d.delta);
    return (d.pct > 0 ? '+' : '') + d.pct + '%';
  },

  // ── Session-Kennzahlen (zeitraum-bewusst; Filter auf das Session-Startdatum) ──
  _winSessions() {
    const w = this.myStatsWindow();
    return this._memo('winSessions', [this.myStatsSessions, w.from, w.to], () =>
      filterByWindow(this.myStatsSessions, 'date', w.from, w.to));
  },
  myStatsSessionStats() {
    const win = this._winSessions();
    return this._memo('sessionStats', [win], () => computeSessionStats(win));
  },
  myStatsHasSessions() { return this.myStatsSessionStats().hasData; },

  // ── Gesamt-Prognose ueber alle Buecher mit offenem Gesamtziel (Lifetime) ──────
  myStatsOverallForecast() {
    const goals = this.myStatsBookGoals();
    return this._memo('overallForecast', [goals], () => computeOverallForecast(goals));
  },
  myStatsHasOverallForecast() { return this.myStatsOverallForecast().hasData; },
  myStatsOverallForecastLabel() {
    const f = this.myStatsOverallForecast();
    if (!f.hasData) return '';
    if (f.stalled) return this._myStatsPlural('mystats.overallForecast.stalled', f.booksOpen);
    return this._myStatsPlural('mystats.overallForecast.eta', f.booksOpen, {
      date: this.myStatsDateLabel(f.forecastDate),
      chars: this._myStatsFmt(Math.round(f.dailyChars)),
    });
  },

  // ── Streak-Heatmap-Zellenklasse je Modus ─────────────────────────────────────
  // 'activity' faerbt nach Schreibminuten-Quartil (level 0..4). 'goal' faerbt
  // binaer gegen das Tagesziel: erreicht (goal-hit) / aktiv-aber-verfehlt
  // (goal-miss) / inaktiv (lvl0). Zukunftszellen bleiben ausgegraut. Vergleich
  // in Sekunden — dieselbe Regel wie die Ziel-Serie (computeGoalAttainment);
  // gerundete Minuten liessen 29:30 min als „30 min erreicht" durchgehen.
  myStatsStreakCellClass(cell) {
    if (!cell) return 'overview-streak-cell--empty';
    if (cell.future) return 'overview-streak-cell--future';
    if (this.myStatsStreakMode === 'goal' && this.myStatsHasGoal) {
      if (!cell.active) return 'overview-streak-cell--lvl0';
      const goalSec = (this.myStatsGoal().goalMinutes || 0) * 60;
      return (cell.seconds || 0) >= goalSec ? 'overview-streak-cell--goal-hit' : 'overview-streak-cell--goal-miss';
    }
    return 'overview-streak-cell--lvl' + cell.level;
  },

  // ── Wortschatz-Trend (Lifetime, analog Lesbarkeit) ───────────────────────────
  myStatsVocabTrend() {
    return this._memo('vocabTrend', [this.myStatsHistory], () => computeVocabTrend(this.myStatsHistory));
  },
  myStatsHasVocab() { return this.myStatsVocabTrend().hasData; },

  // ── Zugaengliche Kurzfassungen (Screenreader) ────────────────────────────────
  // Heatmap: Zusammenfassung der sichtbaren 52 Wochen statt 364 stummer Zellen.
  myStatsStreakAria() {
    const s = this.myStatsStreak();
    return window.__app.t('mystats.streakAria', {
      active: this._myStatsFmt(s.gridActiveDays),
      current: this._myStatsPlural('mystats.days', s.gridCurrentStreak),
      longest: this._myStatsPlural('mystats.days', s.gridLongestStreak),
    });
  },
  // Aufwands-Balken: beide Anteile, nicht nur das Schreiben.
  myStatsEffortAria() {
    const e = this.myStatsEffort();
    return window.__app.t('mystats.effortAria', { write: e.writingPct, edit: e.lektoratPct });
  },
};
