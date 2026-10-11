// Alpine.data('bookStatsCard') — Sub-Komponente der Buchstatistik-Karte.
//
// Chart.js-Instanz + Theme-Observer leben als Modul-State in bookstats.js —
// ein Alpine-Reaktivitäts-Proxy würde die Chart-Instanz beschädigen. destroy()
// räumt beide auf.

import { bookstatsMethods, _destroyStatsChart, _disconnectThemeObserver } from '../book/bookstats.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { getUserPref, setUserPref } from '../local-prefs.js';

const METRIC_PREF_KEY = 'bookStatsMetric';
const METRIC_DEFAULT = 'chars';
const AVG_PREF_KEY = 'bookStatsShowAvg';

export function registerBookStatsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('bookStatsCard', () => ({
    bookStatsData: [],
    bookStatsLoading: false,
    bookStatsSyncStatus: '',
    bookStatsMetric: METRIC_DEFAULT,
    bookStatsRange: 0,
    bookStatsShowAvg: true,
    bookStatsAvg: null,
    bookStatsCoverage: null,
    bookStatsDelta: null,
    writingTimeData: null,
    lektoratTimeData: null,
    sttTimeData: null,
    statusHistoryData: null,
    _lifecycle: null,

    init() {
      // Metric-Pref (per-user, book-unabhängig) aus localStorage holen,
      // damit User die zuletzt gewählte Chart-Metrik wieder bekommt.
      const email = Alpine.store('session').currentUser?.email;
      this.bookStatsMetric = getUserPref(email, METRIC_PREF_KEY, METRIC_DEFAULT);
      this.$watch('bookStatsMetric', (v) => {
        setUserPref(Alpine.store('session').currentUser?.email, METRIC_PREF_KEY, v);
      });
      this.bookStatsShowAvg = getUserPref(email, AVG_PREF_KEY, true) !== false;
      this.$watch('bookStatsShowAvg', (v) => {
        setUserPref(Alpine.store('session').currentUser?.email, AVG_PREF_KEY, v);
      });

      // Deep-Link aus Overview-Tiles: metric + range vorab setzen, damit der
      // Chart direkt mit dem gewünschten Filter rendert. Daten sind ggf. schon
      // geladen (renderStatsChart() reicht), sonst zieht der showBookStatsCard-
      // Watcher loadBookStats nach.
      const onSelect = (e) => {
        const detail = e.detail || {};
        if (detail.metric) this.bookStatsMetric = detail.metric;
        if (detail.range != null) this.bookStatsRange = detail.range;
        if (this.bookStatsData.length > 0) {
          this.$nextTick(() => this.renderStatsChart());
        }
      };

      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showBookStatsCard',
        load: (root) => this.loadBookStats(Alpine.store('nav').selectedBookId),
        resetState: {
          bookStatsData: [],
          bookStatsAvg: null,
          bookStatsCoverage: null,
          bookStatsDelta: null,
          writingTimeData: null,
          lektoratTimeData: null,
          sttTimeData: null,
          statusHistoryData: null,
        },
        onViewReset: (e, ctx) => {
          ctx.bookStatsData = [];
          ctx.bookStatsSyncStatus = '';
          ctx.bookStatsAvg = null;
          ctx.bookStatsCoverage = null;
          ctx.bookStatsDelta = null;
          ctx.writingTimeData = null;
          ctx.lektoratTimeData = null;
          ctx.sttTimeData = null;
          ctx.statusHistoryData = null;
          _destroyStatsChart();
        },
        extraListeners: [{ type: 'book-stats:select', handler: onSelect }],
      });

      // Chart beim Ausblenden der Karte zerstoeren, damit Chart.js'
      // Resize-Handler (responsive) nicht auf dem versteckten Canvas crasht.
      // Reopen baut es ohnehin frisch (renderStatsChart destroy + new).
      this.$watch(() => window.__app.showBookStatsCard, (visible) => {
        if (!visible) _destroyStatsChart();
      });
    },

    destroy() {
      this._lifecycle?.destroy();
      _destroyStatsChart();
      _disconnectThemeObserver();
    },

    ...bookstatsMethods,
  }));
}
