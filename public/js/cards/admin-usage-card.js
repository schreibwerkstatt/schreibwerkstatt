// Alpine-Sub-Komponente fuer die Admin-Usage-Karte. Sichtbarkeit ueber
// $store.session.currentUser.isAdmin; State + Lifecycle hier, Show-Flag
// (`showAdminUsageCard`) im Root.

import { adminUsageMethods } from '../admin/admin-usage.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerAdminUsageCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminUsageCard', () => ({
    adminUsageInitialized: false,
    // adminUsageTab lebt am Root (Hash-Router liest/schreibt es). Getter/Setter
    // halten den Sub-Scope kompatibel, ohne den State zu duplizieren.
    get adminUsageTab() { return window.__app?.adminUsageTab ?? 'users'; },
    set adminUsageTab(v) { if (window.__app) window.__app.adminUsageTab = v; },
    adminUsageLoading: false,
    // Buchhaltung fuer `_adminUsageRun`: letzte Load-Sequenz je Tab + Zahl
    // laufender Loads.
    _adminUsageSeq: {},
    _adminUsagePending: 0,
    adminUsageError: '',
    adminUsageFrom: '',
    adminUsageTo: '',

    // Admin-Konten in alle Auswertungen einbeziehen (Server: ?includeAdmins=1).
    // Default an: nutzt ein Admin die KI-Funktionen, stehen seine Calls auf der
    // Anthropic-Rechnung — ohne ihn fehlten sie in jeder User-Summe.
    adminUsageIncludeAdmins: true,

    // Users-Tab
    adminUsageUsersList: [],
    // Kosten je User x Job-Typ (Ledger) + gewaehlter User der Aufschluesselung
    // (null = zu, '' = Calls ohne User).
    adminUsageBreakdown: [],
    adminUsageBreakdownUser: null,

    // Filter fuer Jobs/Chat-Drilldown — Array von Emails (Multi-Select).
    adminUsageFilterUsers: [],

    // Jobs-Tab
    adminUsageJobsList: [],
    adminUsageJobsTotal: 0,
    adminUsageJobsOffset: 0,

    // Chat-Tab
    adminUsageChatList: [],
    adminUsageChatTotal: 0,
    adminUsageChatOffset: 0,
    adminUsageChatFeedback: '',   // '' | 'down' | 'up' — Filter der Chat-Liste
    // Chat-Qualitaet je Chat-Art (partials/admin-usage-chat-quality.html)
    adminUsageChatQuality: [],

    // Summary-Tab
    adminUsageSummary: null,

    // Abrechnungs-Tab (Anthropic Cost-Report vs. Ledger)
    adminUsageBilling: null,
    adminUsageBillingSyncing: false,

    // Features-Tab
    adminUsageFeatureItems: [],
    adminUsageFeatureTotals: [],

    // Zeit-Tab
    adminUsageTimeItems: [],
    adminUsageTimeSeries: [],
    adminUsageTimeSeriesKey: '',

    _lifecycle: null,

    init() {
      this.$watch(() => window.__app.showAdminUsageCard, async (visible) => {
        // Beim Schliessen der ganzen Karte (Hash-Router wechselt auf ein anderes
        // Admin-Pane, ohne den Tab zu aendern) bleibt der Summary-Tab aktiv und
        // die Charts haengen sonst mit aktivem ResizeObserver am versteckten
        // Canvas -> Chart.js crasht beim naechsten Resize ("ownerDocument of null").
        if (!visible) { this._adminUsageDestroyCharts(); return; }
        await this.adminUsageEnter();
      });
      // Tab-Wechsel laedt hier, nicht im Klick-Handler: der Hash-Router setzt
      // `adminUsageTab` erst NACH dem Oeffnen der Karte (Deep-Link
      // #admin/usage/billing, Back/Forward) — `adminUsageEnter` hat da schon den
      // alten Tab geladen, der neue bliebe sonst leer.
      // Summary-Charts beim Verlassen des Tabs zerstoeren (Klick UND Hash-Router),
      // damit Chart.js' ResizeObserver nicht auf dem versteckten Canvas crasht.
      this.$watch(() => this.adminUsageTab, (tab, prev) => {
        if (prev === 'summary' && tab !== 'summary') this._adminUsageDestroyCharts();
        if (window.__app.showAdminUsageCard) this.adminUsageLoadTab();
      });
      this.$watch(() => this.adminUsageFrom, () => { if (window.__app.showAdminUsageCard) this.adminUsageLoadTab(); });
      this.$watch(() => this.adminUsageTo,   () => { if (window.__app.showAdminUsageCard) this.adminUsageLoadTab(); });
      // Multi-Select-Filter: bei jeder Array-Veraenderung Pagination zuruecksetzen
      // und (falls Jobs/Chat-Tab offen) neu laden. JSON-Stringify als Deps, weil
      // Alpine $watch auf primitiver Gleichheit prueft, nicht auf Array-Inhalt.
      this.$watch(() => this.adminUsageChatFeedback, () => {
        this.adminUsageChatOffset = 0;
        if (this.adminUsageTab === 'chat') this.adminUsageLoadTab();
      });
      this.$watch(() => JSON.stringify(this.adminUsageFilterUsers), () => {
        this.adminUsageJobsOffset = 0;
        this.adminUsageChatOffset = 0;
        if (this.adminUsageTab === 'jobs' || this.adminUsageTab === 'chat') this.adminUsageLoadTab();
      });
      this._lifecycle = setupCardLifecycle(this, {
        onViewReset: () => {
          this.adminUsageError = '';
          this.adminUsageTimeSeries = [];
          this.adminUsageTimeSeriesKey = '';
        },
      });
    },

    destroy() {
      this._lifecycle?.destroy();
      this._adminUsageDestroyCharts();
    },

    ...adminUsageMethods,
  }));
}
