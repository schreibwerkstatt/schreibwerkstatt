// Alpine.data('myStatsCard') — Sub-Komponente „Meine Statistik": aggregierte
// Schreib-Kennzahlen + Entwicklungs-Chart ueber ALLE eigenen Buecher
// (role='owner'). User-bound, nicht buch-bound — `showMyStatsCard` +
// `toggleMyStatsCard` leben im Root (generiert aus EXCLUSIVE_CARDS). Daten:
// `GET /me/profile-stats` (Tiles) + `GET /me/profile-stats-history` (Chart).

import { localeTag, localIsoDate, dateTimeFormat } from '../utils.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { computeWritingTimeStreak, computeWeekdayPattern, computeDerived, computeMilestones,
         computeReadability, computeWeeklyDelta, computePerBookTime, computeEffortSplit,
         computeVolumeDelta, computeHourPattern, computeGoalAttainment, computeBookGoals,
         filterByWindow, resolveWindow } from './my-stats-compute.js';
import { computeVolumeByCategory } from './my-stats-category.js';
import { myStatsTrendMethods } from './my-stats-trends-methods.js';
import { myStatsChartMethods, BOOK_COLORS } from './my-stats-chart-methods.js';
import { memoMethods } from './card-memo.js';

// Meilenstein-Label-Keys pro Kategorie (Wert via {n} interpoliert).
const MILESTONE_LABELS = {
  chars:      'mystats.milestone.chars',
  words:      'mystats.milestone.words',
  activeDays: 'mystats.milestone.activeDays',
  books:      'mystats.milestone.books',
};

export function registerMyStatsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('myStatsCard', () => ({
    ...myStatsTrendMethods,
    ...myStatsChartMethods,
    myStatsData: null,
    myStatsHistory: [],
    myStatsWriting: [],
    myStatsLektorat: [],
    myStatsSessions: [],
    myStatsMetric: 'chars',
    myStatsStreakMode: 'activity', // 'activity' | 'goal' — Streak-Heatmap-Faerbung
    // Globaler Zeitraum-Filter (steuert die ganze Karte). Preset-Tage
    // (30/90/365, 0 = alles) ODER freie Von/Bis-ISO-Daten — Custom hat Vorrang.
    myStatsRangeDays: 0,
    myStatsFrom: '',
    myStatsTo: '',
    myStatsChartMode: 'total', // 'total' | 'byBook'
    myStatsChartGran: 'day',   // 'day' | 'week' | 'month' — Zeitachsen-Granularitaet
    myStatsCumulative: false,  // nur fuer Metrik 'writing' (kumulierte Schreibzeit)
    myStatsLoading: false,
    myStatsError: '',
    // Leerzustand des Entwicklungs-Charts: '' | 'noData' (nichts im Zeitraum) |
    // 'noHistory' (noch kein Nacht-Snapshot). Gesetzt von renderMyStatsChart().
    myStatsChartEmpty: '',
    _memos: {},
    _lifecycle: null,

    init() {
      this.$watch(() => window.__app.showMyStatsCard, (visible) => {
        if (visible) this.loadMyStats();
        else this._destroyChart();
      });
      // Buchübergreifend: kein Reset bei book:changed/view:reset, Refresh ohne Buch.
      this._lifecycle = setupCardLifecycle(this, {
        name: 'myStats',
        refreshNeedsBookId: false,
        onCardRefresh: () => this.loadMyStats(),
      });
    },

    destroy() {
      this._lifecycle?.destroy();
      this._destroyChart();
      this._disconnectMyStatsThemeObserver();
    },

    async loadMyStats() {
      this.myStatsLoading = true;
      this.myStatsError = '';
      this._memos = {};
      try {
        const [statsR, histR] = await Promise.all([
          fetch('/me/profile-stats', { credentials: 'same-origin' }),
          fetch('/me/profile-stats-history', { credentials: 'same-origin' }),
        ]);
        if (!statsR.ok) throw new Error('HTTP ' + statsR.status);
        this.myStatsData = await statsR.json();
        const hist = histR.ok ? await histR.json() : { history: [], writing: [], lektorat: [] };
        this.myStatsHistory = Array.isArray(hist.history) ? hist.history : [];
        this.myStatsWriting = Array.isArray(hist.writing) ? hist.writing : [];
        this.myStatsLektorat = Array.isArray(hist.lektorat) ? hist.lektorat : [];
        this.myStatsSessions = Array.isArray(hist.sessions) ? hist.sessions : [];
      } catch (e) {
        console.error('[myStats load]', e);
        this.myStatsError = window.__app.t('mystats.loadError');
        this.myStatsData = null;
        this.myStatsHistory = [];
        this.myStatsWriting = [];
        this.myStatsLektorat = [];
        this.myStatsSessions = [];
      } finally {
        this.myStatsLoading = false;
      }
      // rAF in $nextTick: Canvas erst nach Layout-Pass vermessen (sonst 0×0).
      this.$nextTick(() => requestAnimationFrame(() => this.renderMyStatsChart()));
    },

    // Chart-Kachel steht, sobald es Inhalt gibt — auch ohne Historie (dann
    // erklaert der Leerzustand, dass sich der Verlauf nachts fuellt).
    get myStatsHasChart() { return this.myStatsHasContent; },

    // Eigene Buecher mit Inhalt oder erfasster Schreibzeit — Gate fuer die Kacheln.
    get myStatsHasContent() {
      const d = this.myStatsData;
      return !!d && ((Number(d.chars) || 0) > 0 || (Number(d.writing_seconds) || 0) > 0);
    },

    // Memo-Helper (cards/card-memo.js); Reset bei jedem Daten-Reload via this._memos = {} in loadMyStats().
    ...memoMethods,

    // ── Zeitraum-Filter (steuert die ganze Karte) ──────────────────────────
    // Aktives Fenster { active, from, to } — Regeln in resolveWindow
    // (my-stats-compute/series.js): Custom vor Preset, vertauschtes Von/Bis als
    // Bereich, Preset N Tage = genau N Tage inklusive heute.
    myStatsWindow() {
      return resolveWindow({ rangeDays: this.myStatsRangeDays, from: this.myStatsFrom,
                             to: this.myStatsTo, todayIso: localIsoDate() });
    },
    get myStatsWindowActive() { return this.myStatsWindow().active; },

    // Auf das Fenster gefilterte Zeitreihen (memoized; deps inkl. from/to).
    _winWriting() {
      const w = this.myStatsWindow();
      return this._memo('winWriting', [this.myStatsWriting, w.from, w.to], () =>
        filterByWindow(this.myStatsWriting, 'date', w.from, w.to));
    },
    _winLektorat() {
      const w = this.myStatsWindow();
      return this._memo('winLektorat', [this.myStatsLektorat, w.from, w.to], () =>
        filterByWindow(this.myStatsLektorat, 'date', w.from, w.to));
    },
    _sumSeconds(rows) {
      return (rows || []).reduce((s, r) => s + (Number(r.seconds) || 0), 0);
    },

    // Preset waehlen → Custom-Felder leeren. Custom setzen → Preset auf 0.
    myStatsSetPreset(days) {
      this.myStatsRangeDays = days;
      this.myStatsFrom = '';
      this.myStatsTo = '';
      this._onRangeChange();
    },
    _onRangeChange() {
      // Vertauschtes Von/Bis in den Feldern tauschen, damit Anzeige und Rechnung
      // denselben Bereich zeigen.
      if (this.myStatsFrom && this.myStatsTo && this.myStatsFrom > this.myStatsTo) {
        [this.myStatsFrom, this.myStatsTo] = [this.myStatsTo, this.myStatsFrom];
      }
      // Memos haengen an from/to → aktualisieren sich selbst; nur Chart neu zeichnen.
      this.$nextTick(() => requestAnimationFrame(() => this.renderMyStatsChart()));
    },

    // Im Zeitraum produzierter Netto-Umfang (Zeichen/Woerter/Abschnitte). Ohne
    // Filter: Live-Gesamtstand aus page_stats; mit Filter: Endstand (Live-Stand,
    // wenn das Fenster bis heute reicht) minus Snapshot-Basis vor dem Fenster.
    // `approximated`: fuer mind. ein Buch fehlt der Snapshot vor dem Fenster.
    myStatsVolume() {
      const w = this.myStatsWindow();
      if (!w.active) {
        const d = this.myStatsData || {};
        return { chars: d.chars || 0, words: d.words || 0, pages: d.pages || 0, approximated: false };
      }
      const detail = this.myStatsData?.books_detail;
      return this._memo('volume', [this.myStatsHistory, detail, w.from, w.to], () =>
        computeVolumeDelta(this.myStatsHistory, w.from, w.to, { booksDetail: detail }));
    },

    // ── Schreibrhythmus (aus der gefilterten writing-Zeitreihe) ────────────
    // Raster = letzte 52 Wochen (ungefiltert), Serien-Kennzahlen = Zeitfenster.
    myStatsStreak() {
      const win = this._winWriting();
      return this._memo('streak', [this.myStatsWriting, win], () =>
        computeWritingTimeStreak(this.myStatsWriting, new Date(), win));
    },
    myStatsWeekdays() {
      const win = this._winWriting();
      return this._memo('weekdays', [win], () => computeWeekdayPattern(win));
    },
    myStatsDerived() {
      const win = this._winWriting();
      // Tempo = Zeichen pro Schreibstunde IM Zeitraum: Volumen-Delta / gefilterte Sekunden.
      const data = this.myStatsWindowActive
        ? { chars: this.myStatsVolume().chars, writing_seconds: this._sumSeconds(win) }
        : this.myStatsData;
      return this._memo('derived', [data?.chars, data?.writing_seconds, win], () =>
        computeDerived(data, win));
    },
    // Meilensteine sind Lifetime-Achievements → immer ueber ALLE Daten, nie gefiltert.
    // `books` zaehlt dort nur Buecher mit Inhalt (books_detail).
    myStatsMilestones() {
      return this._memo('milestones', [this.myStatsData, this.myStatsWriting], () =>
        computeMilestones(this.myStatsData, computeDerived(this.myStatsData, this.myStatsWriting)));
    },

    get myStatsHasRhythm() {
      return (this.myStatsWriting || []).length > 0;
    },

    // Wochentags-Kurzlabels Mo..So (Locale-aware), memoized pro Locale.
    // Kalendertage, keine Zeitpunkte: UTC-Mittag in timeZone 'UTC' formatiert.
    myStatsWeekdayLabels() {
      const uiLocale = Alpine.store('shell').uiLocale;
      return this._memo('weekdayLabels', [uiLocale], () => {
        const fmt = dateTimeFormat(uiLocale, { weekday: 'short', timeZone: 'UTC' });
        const monRef = Date.UTC(2027, 0, 4, 12); // 2027-01-04 ist ein Montag
        return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(monRef + i * 86400000)));
      });
    },

    // ISO-Kalenderdatum lesbar formatieren (gecachter Formatter; UTC-Mittag in
    // timeZone 'UTC', damit keine Zeitzone das Datum verschiebt).
    myStatsDateLabel(iso) {
      if (!iso) return '';
      const [y, m, d] = iso.split('-').map(Number);
      const fmt = dateTimeFormat(Alpine.store('shell').uiLocale,
        { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
      return fmt.format(new Date(Date.UTC(y, m - 1, d, 12)));
    },

    // Minuten kompakt: „2 h 10 min" / „45 min".
    myStatsMinFmt(min) {
      const total = Math.max(0, Math.round(Number(min) || 0));
      const h = Math.floor(total / 60), m = total % 60;
      const t = window.__app.t;
      return h > 0 ? t('mystats.hm', { h: this._myStatsFmt(h), m }) : t('mystats.m', { m });
    },

    myStatsMilestoneLabel(category, target) {
      return this._myStatsPlural(MILESTONE_LABELS[category] || 'mystats.milestone.chars', target);
    },

    // i18n mit Einzahl: n === 1 → Key + 'One' (Konvention wie sidebar.pagesCountOne).
    // `{n}` wird locale-formatiert; weitere Parameter via `params`.
    _myStatsPlural(key, n, params = {}) {
      const num = Number(n) || 0;
      return window.__app.t(num === 1 ? key + 'One' : key, { ...params, n: this._myStatsFmt(num) });
    },

    // Geltungsbereich einer Kachel als Tag-Text:
    //   'window'   folgt dem Zeitraum-Filter („im Zeitraum" bzw. „gesamt")
    //   'lifetime' immer gesamt
    //   'grid'     Heatmap-Raster (letzte 52 Wochen)
    //   'current'  aktueller Stand (live)
    //   'today'    nur heute
    myStatsScope(kind) {
      const t = window.__app.t;
      if (kind === 'window') return this.myStatsWindowActive ? t('mystats.scope.window') : t('mystats.scope.lifetime');
      return t('mystats.scope.' + kind);
    },

    // ── Lesbarkeit (1), Aufwand (2), Pro-Buch-Zeit (3), Wochen-Delta (4) ────
    myStatsReadability() {
      return this._memo('readability', [this.myStatsHistory], () => computeReadability(this.myStatsHistory));
    },
    myStatsWeekDelta() {
      const detail = this.myStatsData?.books_detail;
      return this._memo('weekDelta', [this.myStatsHistory, detail], () =>
        computeWeeklyDelta(this.myStatsHistory, new Date(), detail));
    },
    // Tooltip der Trendpfeile: welcher Stand der Vergleich ist.
    myStatsTrendTip(refIso) {
      return refIso ? window.__app.t('mystats.trendTip', { date: this.myStatsDateLabel(refIso) }) : '';
    },
    myStatsEffort() {
      if (!this.myStatsWindowActive) {
        return this._memo('effort', [this.myStatsData], () =>
          computeEffortSplit(this.myStatsData?.writing_seconds, this.myStatsData?.lektorat_seconds));
      }
      const win = this._winWriting(), winL = this._winLektorat();
      return this._memo('effortWin', [win, winL], () =>
        computeEffortSplit(this._sumSeconds(win), this._sumSeconds(winL)));
    },
    myStatsPerBookTime() {
      const win = this._winWriting();
      return this._memo('perBook', [win], () =>
        computePerBookTime(win).map(r => ({ ...r, name: this._bookName(r.book_id) })));
    },

    // ── Lektorat-Qualitaet (Fundstellen-Dichte + 30-Tage-Trend) ─────────────
    // Server liefert vorab aggregiert (myStatsData.lektorat) — Lifetime-Befund,
    // kein Zeitraum-Filter (analog Lesbarkeit).
    myStatsQuality() { return this.myStatsData?.lektorat || null; },
    get myStatsHasQuality() { return !!this.myStatsData?.lektorat; },

    get myStatsHasReadability() { return this.myStatsReadability().hasData; },
    get myStatsHasPerBook() { return this.myStatsPerBookTime().length > 1; },

    // ── Tageszeit-Muster (lebenslanges writing_hour-Histogramm, 24 Buckets) ──
    myStatsHours() {
      return this._memo('hours', [this.myStatsData?.by_hour], () =>
        computeHourPattern(this.myStatsData?.by_hour));
    },
    get myStatsHasHours() { return this.myStatsHours().hasData; },

    // Stundenlabel: nur jede dritte Stunde beschriften (0,3,…21) — sonst zu dicht.
    myStatsHourLabel(h) { return (h % 3 === 0) ? String(h) : ''; },
    // Tooltip: „07:00–08:00 · 25 min gesamt". Das „gesamt" ist Pflicht, nicht
    // Kosmetik: der Balken ist die lebenslange Summe dieser Stunde (writing_hour
    // hat keine Datums-Dimension), sieht aber wie ein Tageswert aus. Ohne den
    // Qualifier liest man einen 10-h-Balken als „10 h an einem Tag geschrieben".
    // Gleiche Konvention wie `mystats.weekdayTip`.
    myStatsHourTip(h, min) {
      const from = String(h).padStart(2, '0'), to = String((h + 1) % 24).padStart(2, '0');
      return window.__app.t('mystats.hourTip', { from, to, time: this.myStatsMinFmt(min) });
    },

    // ── Tagesziel (Minuten/Tag) ─────────────────────────────────────────────
    myStatsGoal() {
      return this._memo('goal',
        [this.myStatsWriting, this.myStatsData?.daily_goal_minutes, this.myStatsData?.today_writing_seconds],
        () => computeGoalAttainment(this.myStatsWriting, this.myStatsData?.daily_goal_minutes,
                                    this.myStatsData?.today_writing_seconds));
    },
    get myStatsHasGoal() { return this.myStatsGoal().active; },

    // ── Pro-Buch-Ziele: geschriebener Umfang + Gesamtziel-Erreichung ─────────
    // Lifetime-Bestand (kein Zeitraum-Filter): zeigt den aktuellen Stand pro
    // Buch gegen das gesetzte Gesamtziel, daher aus dem Live-books_detail.
    myStatsBookGoals() {
      return this._memo('bookGoals', [this.myStatsData?.books_detail, this.myStatsHistory], () =>
        computeBookGoals(this.myStatsData?.books_detail, this.myStatsHistory)
          .map(r => ({ ...r, name: this._bookName(r.book_id) })));
    },
    get myStatsHasBookGoals() { return this.myStatsBookGoals().length > 0; },

    // ── Umfang nach Kategorie ────────────────────────────────────────────────
    // Lifetime-Bestand pro Kategorie (Live-Umfang aus books_detail; kein
    // Zeitraum-Filter, analog Pro-Buch-Zielen). Sammel-Bucket „Ohne Kategorie"
    // bekommt das Default-Label, Gruppen ohne eigene Farbe eine Palettenfarbe.
    myStatsByCategory() {
      return this._memo('byCategory', [this.myStatsData?.books_detail], () =>
        computeVolumeByCategory(this.myStatsData?.books_detail).map((r, i) => ({
          ...r,
          name: r.categoryId == null ? window.__app.t('mystats.category.none') : r.name,
          color: r.color || BOOK_COLORS[i % BOOK_COLORS.length],
        })));
    },
    // Mindestens zwei Gruppen ODER eine echte Kategorie → Aufschluesselung lohnt.
    get myStatsHasCategories() {
      const g = this.myStatsByCategory();
      return g.length > 1 || (g.length === 1 && g[0].categoryId != null);
    },

    // Frist lesbar (oder Gedankenstrich, wenn keine gesetzt).
    myStatsDeadlineLabel(iso) { return iso ? this.myStatsDateLabel(iso) : '–'; },

    // Status-Klartext pro Buch (erreicht / überfällig / Tage übrig / offen / kein Ziel).
    myStatsGoalStatusLabel(row) {
      const t = window.__app.t;
      if (row.status === 'reached') return t('mystats.bookGoals.reached');
      if (row.status === 'overdue') return t('mystats.bookGoals.overdue');
      if (row.status === 'due')     return this._myStatsPlural('mystats.bookGoals.due', row.daysRemaining);
      if (row.status === 'open')    return t('mystats.bookGoals.open');
      return t('mystats.bookGoals.none');
    },

    // Fertigstellungs-Prognose in Klartext: „fertig ~ 12. Aug 2026" bzw. bei
    // fehlendem/zu langsamem Tempo der Stillstand-Hinweis.
    // Mit Frist zusaetzlich „im Plan"/„hinter Plan" als Text (nicht nur Farbe).
    myStatsForecastLabel(row) {
      const t = window.__app.t;
      if (row.forecastStalled) return t('mystats.bookGoals.forecastStalled');
      if (!row.forecastDate) return '';
      const base = t('mystats.bookGoals.forecast', { date: this.myStatsDateLabel(row.forecastDate) });
      if (row.onTrack === true) return base + ' · ' + t('mystats.bookGoals.onTrack');
      if (row.onTrack === false) return base + ' · ' + t('mystats.bookGoals.behind');
      return base;
    },

    // Das Tempo hinter der Prognose: „⌀ 1’200 Z/Tag, letzte 30 T".
    myStatsPaceLabel(row) {
      if (!row.paceDays || !(row.recentDailyChars > 0)) return '';
      return this._myStatsPlural('mystats.bookGoals.pace', row.paceDays,
        { chars: this._myStatsFmt(row.recentDailyChars), days: row.paceDays });
    },

    // Zahl mit einer Nachkommastelle (Lesbarkeitswerte), Locale-aware.
    myStatsDec(n) {
      if (n == null) return '–';
      const loc = localeTag(Alpine.store('shell').uiLocale);
      return Number(n).toLocaleString(loc, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    },

    // Flesch-DE in Klartext-Band (4 Stufen).
    myStatsFleschLabel(v) {
      if (v == null) return '';
      const key = v >= 70 ? 'easy' : v >= 50 ? 'medium' : v >= 30 ? 'hard' : 'veryHard';
      return window.__app.t('mystats.flesch.' + key);
    },

    // Trend-Richtung → Sprite-Icon (richtungsneutral, ohne Wertung).
    myStatsTrendIcon(dir) {
      return dir > 0 ? 'arrow-up' : dir < 0 ? 'arrow-down' : 'minus';
    },


    // Locale-aware Tausender-Trennung (Swiss: de-CH = Apostroph).
    _myStatsFmt(n) {
      const loc = localeTag(Alpine.store('shell').uiLocale);
      return Number(n || 0).toLocaleString(loc);
    },

    // Normseite = 1500 Zeichen (primaere Umfangs-Kennzahl) — zeitraum-bewusst.
    myStatsNormpages() {
      return this._myStatsFmt(Math.round((this.myStatsVolume().chars || 0) / 1500));
    },

    // Schreibzeit kompakt: „12 h 30 min" bzw. „45 min" — im Zeitraum bzw. gesamt.
    myStatsWritingTime() {
      const sec = this.myStatsWindowActive
        ? this._sumSeconds(this._winWriting())
        : (this.myStatsData?.writing_seconds || 0);
      const total = Math.max(0, Math.round(sec / 60));
      const h = Math.floor(total / 60);
      const m = total % 60;
      const t = window.__app.t;
      if (h > 0) return t('mystats.hm', { h: this._myStatsFmt(h), m });
      return t('mystats.m', { m });
    },

    get myStatsIsEmpty() {
      return !this.myStatsLoading && !this.myStatsError && !this.myStatsHasContent;
    },
  }));
}
