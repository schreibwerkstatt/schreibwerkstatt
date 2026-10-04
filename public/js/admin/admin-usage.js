// AdminUsageCard-Methods.
// Wird im adminUsageCard-Alpine-Scope gespreaded. Root-Zugriffe ueber
// `window.__app`. Privacy: Admin sieht USD/Tokens + book_id (anonym), keine
// Buchtitel.

import { loadChart } from '../lazy-libs.js';
import { localIsoDate, tzOpts, localeTag, fetchJson, sendJson } from '../utils.js';
import { tFetchErrorRaw } from '../i18n.js';

function _fmt(n, locale, opts) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(locale, opts).format(n);
}

function _money(n, locale) {
  return _fmt(n, locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _int(n, locale) {
  return _fmt(n, locale, { maximumFractionDigits: 0 });
}

// Matrix-Memo ausserhalb des reaktiven Karten-States: ein Schreiben in den
// Scope waehrend des Renderns wuerde die lesenden Effekte erneut anstossen.
// Schluessel ist das rohe Breakdown-Array (neues Array = neuer Ladevorgang).
const _matrixMemo = new WeakMap();

function _hhmm(seconds) {
  if (!seconds || seconds < 60) return seconds ? '< 1 min' : '0 min';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h <= 0) return `${m} min`;
  return `${h}h ${m}m`;
}

export const adminUsageMethods = {
  // ── Locale-Helper (Templates rufen so) ────────────────────────────────────
  adminUsageMoney(n) { return _money(n, this._adminUsageLocale()); },
  adminUsageInt(n)   { return _int(n,   this._adminUsageLocale()); },
  adminUsageHhmm(seconds) { return _hhmm(seconds); },
  _adminUsageLocale() {
    return localeTag(Alpine.store('shell').uiLocale);
  },
  // Job-Typ-String (DB-Wert aus job_runs.type) → übersetztes Label. Fallback: roher Typ.
  _adminUsageTypeLabel(type) {
    const key = `admin.usage.jobType.${type}`;
    const label = window.__app?.t?.(key);
    return (label && label !== key) ? label : type;
  },

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async adminUsageEnter() {
    if (!this.adminUsageInitialized) {
      this.adminUsageInitialized = true;
      // Default: aktueller Monat in app.timezone (matcht Server-Buckets).
      this.adminUsageFrom = this._adminUsageMonthStart();
      this.adminUsageTo = '';
    }
    await this.adminUsageLoadTab();
  },

  _adminUsageMonthStart() {
    return localIsoDate().slice(0, 7) + '-01';
  },

  // Laden uebernimmt der `adminUsageTab`-Watcher in admin-usage-card.js.
  adminUsageSelectTab(tab) {
    this.adminUsageTab = tab;
  },

  // Options-Liste fuer den User-Filter-Combobox in Jobs/Chat-Tabs.
  // Bezieht Users aus dem Users-Tab; laedt lazy, wenn der Tab noch nicht
  // besucht wurde.
  adminUsageUserFilterOptions() {
    const list = this.adminUsageUsersList || [];
    return list.map(u => ({
      value: u.email,
      label: u.displayName ? `${u.displayName} (${u.email})` : u.email,
    }));
  },

  async _adminUsageEnsureUsers() {
    if (this.adminUsageUsersList.length) return;
    try {
      const data = await this._adminUsageFetch('/admin/usage/users');
      this.adminUsageUsersList = (data.users || []).map(u => ({
        ...u,
        _draftBudget: u.monthlyBudgetUsd ?? '',
        _draftMode: u.budgetMode || 'none',
        _saving: false,
        _savedAt: 0,
      }));
    } catch {}
  },

  adminUsageRemoveFilterUser(email) {
    this.adminUsageFilterUsers = (this.adminUsageFilterUsers || []).filter(e => e !== email);
  },

  adminUsageDrillDownToJobs(email) {
    this.adminUsageFilterUsers = [email];
    this.adminUsageSelectTab('jobs');
  },

  async adminUsageLoadTab() {
    this.adminUsageError = '';
    const tab = this.adminUsageTab;
    if (tab === 'users')    return this.adminUsageLoadUsers();
    if (tab === 'summary')  return this.adminUsageLoadSummary();
    if (tab === 'jobs')     return this.adminUsageLoadJobs();
    if (tab === 'chat')     return this.adminUsageLoadChat();
    if (tab === 'features') return this.adminUsageLoadFeatures();
    if (tab === 'time')     return this.adminUsageLoadTime();
    if (tab === 'billing')  return this.adminUsageLoadBilling();
  },

  _adminUsageQuery() {
    const qs = new URLSearchParams();
    if (this.adminUsageFrom) qs.set('from', this.adminUsageFrom);
    if (this.adminUsageTo)   qs.set('to',   this.adminUsageTo);
    if (this.adminUsageIncludeAdmins) qs.set('includeAdmins', '1');
    return qs.toString();
  },

  async _adminUsageFetch(path) {
    const qs = this._adminUsageQuery();
    const url = path + (qs ? (path.includes('?') ? '&' : '?') + qs : '');
    return fetchJson(url);
  },

  // Rahmen fuer jeden Tab-Load. Pro Tab zaehlt eine Sequenz mit: kommt eine
  // Antwort an, nachdem fuer DENSELBEN Tab schon ein neuerer Load gestartet
  // wurde (Filter/Datum/Seite geaendert), wird sie verworfen. Loads
  // verschiedener Tabs blockieren sich nicht — eine gemeinsame Sperre liess den
  // Load des neuen Tabs verpuffen, solange der vorige noch lief (schneller
  // Tab-Klick, Deep-Link). `adminUsageLoading` bleibt true, bis alle fertig sind.
  async _adminUsageRun(tab, fetchFn, applyFn) {
    const seq = (this._adminUsageSeq[tab] || 0) + 1;
    this._adminUsageSeq[tab] = seq;
    this._adminUsagePending++;
    this.adminUsageLoading = true;
    try {
      const data = await fetchFn();
      if (seq === this._adminUsageSeq[tab]) applyFn(data);
    } catch (e) {
      if (seq === this._adminUsageSeq[tab]) this.adminUsageError = tFetchErrorRaw(e);
    } finally {
      this._adminUsagePending--;
      this.adminUsageLoading = this._adminUsagePending > 0;
    }
  },

  // ── Tab: Users (Liste + Budget-Edit) ───────────────────────────────────────
  async adminUsageLoadUsers() {
    await this._adminUsageRun('users', () => Promise.all([
      this._adminUsageFetch('/admin/usage/users'),
      this._adminUsageFetch('/admin/usage/breakdown'),
    ]), ([data, breakdown]) => {
      this.adminUsageBreakdown = (breakdown.rows || []).map(r => ({ ...r, email: r.email || '' }));
      this.adminUsageUsersList = (data.users || []).map(u => ({
        ...u,
        _draftBudget: u.monthlyBudgetUsd ?? '',
        _draftMode: u.budgetMode || 'none',
        _saving: false,
        _savedAt: 0,
      }));
    });
  },

  // ── Users-Tab: Kosten je User x Job-Typ ───────────────────────────────────
  adminUsageShowBreakdown(email) {
    const key = email || '';
    this.adminUsageBreakdownUser = this.adminUsageBreakdownUser === key ? null : key;
    if (this.adminUsageBreakdownUser !== null) {
      this.$nextTick(() => this.$refs.breakdownDetail?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    }
  },

  adminUsageUserLabel(email) {
    if (!email) return window.__app.t('admin.usage.breakdown.noUser');
    const u = this.adminUsageUsersList.find(x => x.email === email);
    return u?.displayName || email;
  },

  adminUsagePct(share) {
    if (share === null || share === undefined) return '—';
    return `${_fmt(share * 100, this._adminUsageLocale(), { maximumFractionDigits: 1 })} %`;
  },

  adminUsageBreakdownDetail() {
    const email = this.adminUsageBreakdownUser;
    if (email === null) return [];
    const rows = this.adminUsageBreakdown.filter(r => r.email === email);
    const total = rows.reduce((s, r) => s + r.usd, 0);
    return rows.map(r => ({
      ...r,
      key: `${r.source}:${r.type}`,
      // Chat-Arten (page/book/research) haben eigene jobType-Keys („Seiten-Chat" …).
      label: this._adminUsageTypeLabel(r.type),
      share: total > 0 ? r.usd / total : null,
    }));
  },

  // Matrix User x die sechs teuersten Job-Typen des Zeitraums, Rest in „Übrige".
  // Memoisiert auf die Breakdown-Liste: thead, tbody und der sortableTable-Getter
  // lesen sie pro Render mehrfach.
  adminUsageMatrix() {
    const src = this.adminUsageBreakdown;
    const raw = window.Alpine?.raw ? window.Alpine.raw(src) : src;
    const hit = _matrixMemo.get(raw);
    if (hit) return hit;
    const TOP = 6;
    const byType = new Map();
    for (const r of src) {
      const key = `${r.source}:${r.type}`;
      const v = byType.get(key) || { key, label: this._adminUsageTypeLabel(r.type), usd: 0 };
      v.usd += r.usd;
      byType.set(key, v);
    }
    const cols = [...byType.values()].sort((a, b) => b.usd - a.usd).slice(0, TOP);
    const colIndex = new Map(cols.map((c, i) => [c.key, i]));
    const byUser = new Map();
    for (const r of src) {
      const row = byUser.get(r.email) || {
        id: r.email || '__none__', email: r.email, label: this.adminUsageUserLabel(r.email), total: 0, other: 0,
      };
      const i = colIndex.get(`${r.source}:${r.type}`);
      if (i === undefined) row.other += r.usd;
      else row['c' + i] = (row['c' + i] || 0) + r.usd;
      row.total += r.usd;
      byUser.set(r.email, row);
    }
    const val = { cols, rows: [...byUser.values()] };
    _matrixMemo.set(raw, val);
    return val;
  },

  async adminUsageSaveBudget(row) {
    row._saving = true;
    this.adminUsageError = '';
    try {
      const usd = (row._draftBudget === '' || row._draftBudget == null) ? null : Number(row._draftBudget);
      const body = { monthly_budget_usd: usd, budget_mode: row._draftMode };
      const j = await sendJson(`/admin/users/${encodeURIComponent(row.email)}`, 'PUT', body);
      row.monthlyBudgetUsd = j.user.monthly_budget_usd;
      row.budgetMode = j.user.budget_mode || 'none';
      row.overrun = !!(row.monthlyBudgetUsd && row.budgetMode !== 'none' && row.usd >= row.monthlyBudgetUsd);
      row._savedAt = Date.now();
    } catch (e) { this.adminUsageError = tFetchErrorRaw(e); }
    finally { row._saving = false; }
  },

  // ── Tab: Jobs ──────────────────────────────────────────────────────────────
  async adminUsageLoadJobs() {
    this._adminUsageEnsureUsers();
    const qs = new URLSearchParams();
    for (const email of (this.adminUsageFilterUsers || [])) {
      if (email) qs.append('user', email);
    }
    qs.set('limit', '50');
    qs.set('offset', String(this.adminUsageJobsOffset || 0));
    await this._adminUsageRun('jobs', () => this._adminUsageFetch(`/admin/usage/jobs?${qs.toString()}`), (data) => {
      this.adminUsageJobsList = data.rows || [];
      this.adminUsageJobsTotal = data.total || 0;
    });
  },

  // ── Tab: Chat ──────────────────────────────────────────────────────────────
  async adminUsageLoadChat() {
    this._adminUsageEnsureUsers();
    const qs = new URLSearchParams();
    for (const email of (this.adminUsageFilterUsers || [])) {
      if (email) qs.append('user', email);
    }
    qs.set('limit', '50');
    qs.set('offset', String(this.adminUsageChatOffset || 0));
    if (this.adminUsageChatFeedback) qs.set('feedback', this.adminUsageChatFeedback);
    // Chat-Qualitaet je Chat-Art (Zeitraum, ohne User-Filter) laeuft im selben
    // Load mit — eine Sequenz pro Tab, damit eine spaete Antwort nicht ueber
    // einen neueren Zeitraum schreibt.
    await this._adminUsageRun('chat', () => Promise.all([
      this._adminUsageFetch(`/admin/usage/chat?${qs.toString()}`),
      this._adminUsageFetch('/admin/usage/chat-quality'),
    ]), ([data, quality]) => {
      this.adminUsageChatList = data.rows || [];
      this.adminUsageChatTotal = data.total || 0;
      this.adminUsageChatQuality = (quality.rows || []).map(r => ({
        ...r, label: this._adminUsageTypeLabel(r.kind),
      }));
    });
  },

  // Optionen fuer den Bewertungs-Filter der Chat-Liste; '' (alle) liefert der
  // Combobox ueber `emptyLabel`.
  adminUsageFeedbackFilterOptions() {
    const t = window.__app.t;
    return [
      { value: 'down', label: t('admin.usage.filter.feedbackDown') },
      { value: 'up',   label: t('admin.usage.filter.feedbackUp') },
    ];
  },

  adminUsageFeedbackLabel(v) {
    if (v === -1) return window.__app.t('admin.usage.chatQuality.down');
    if (v === 1)  return window.__app.t('admin.usage.chatQuality.up');
    return '—';
  },

  // ── Tab: Abrechnung (Anthropic Cost-Report vs. Ledger) ─────────────────────
  async adminUsageLoadBilling() {
    await this._adminUsageRun('billing', () => this._adminUsageFetch('/admin/usage/billing'), (data) => {
      this.adminUsageBilling = data;
    });
  },

  async adminUsageBillingSync() {
    this.adminUsageBillingSyncing = true;
    this.adminUsageError = '';
    try {
      try {
        await sendJson('/admin/usage/billing/sync', 'POST');
      } catch (e) {
        this.adminUsageError = this.adminUsageBillingErrorText({ code: e.code, status: e.body?.status });
      }
      await this.adminUsageLoadBilling();
    } finally {
      this.adminUsageBillingSyncing = false;
    }
  },

  adminUsageBillingErrorText(err) {
    if (!err) return '';
    const t = window.__app.t.bind(window.__app);
    const key = `admin.usage.billing.error.${err.code}`;
    const msg = t(key);
    return (msg && msg !== key ? msg : t('admin.usage.billing.error.BILLING_FETCH_FAILED'))
      + (err.status ? ` (HTTP ${err.status})` : '');
  },

  // Rechnung minus Ledger, z. B. "+$1.20 (+4.1 %)".
  adminUsageBillingDiff(usd, pct) {
    if (usd === null || usd === undefined) return '—';
    const locale = this._adminUsageLocale();
    const sign = usd > 0 ? '+' : '';
    const money = sign + _money(usd, locale);
    if (pct === null || pct === undefined) return money;
    return `${money} (${sign}${_fmt(pct * 100, locale, { maximumFractionDigits: 1 })} %)`;
  },

  // Ab 5 % Abweichung markieren: darunter liegen Rundung und die wenigen
  // Minuten Verzug, mit denen Anthropic die juengsten Calls bucht.
  adminUsageBillingDiffClass(pct) {
    if (pct === null || pct === undefined || Math.abs(pct) < 0.05) return '';
    return 'admin-usage-diff--off';
  },

  adminUsageBillingModelLabel(key) {
    if (key && key.startsWith('cost:')) {
      const t = window.__app.t.bind(window.__app);
      const k = `admin.usage.billing.costType.${key.slice(5)}`;
      const label = t(k);
      return label && label !== k ? label : key.slice(5);
    }
    return key === 'unknown' ? window.__app.t('admin.usage.billing.unknownModel') : key;
  },

  adminUsageDateTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString(this._adminUsageLocale(), tzOpts({ dateStyle: 'short', timeStyle: 'short' }));
  },

  // ── Tab: Summary (mit Charts) ──────────────────────────────────────────────
  async adminUsageLoadSummary() {
    await this._adminUsageRun('summary', () => this._adminUsageFetch('/admin/usage/summary'), (data) => {
      this.adminUsageSummary = data;
    });
    if (this.adminUsageSummary) {
      this.$nextTick(() => this._adminUsageRenderCharts(this.adminUsageSummary));
    }
  },

  _adminUsageDestroyCharts() {
    if (!this._adminUsageCharts) return;
    for (const k of Object.keys(this._adminUsageCharts)) {
      try { this._adminUsageCharts[k]?.destroy?.(); } catch {}
    }
    this._adminUsageCharts = {};
  },

  async _adminUsageRenderCharts(data) {
    // Tab koennte waehrend des nextTick/await schon gewechselt haben. Charts auf
    // einem via x-show versteckten Canvas zu instanziieren loest Chart.js'
    // Resize-Crash aus ("Cannot read properties of null (reading 'ownerDocument')").
    // Alle Charts laufen mit animation:false. Chart.js' Animations-rAF-Loop haelt
    // sonst eine Referenz auf den Chart; wird der beim Tab-Wechsel via destroy()
    // (ctx=null) abgeraeumt, zeichnet ein noch eingereihter Frame auf den null-Context
    // ("Cannot read properties of null (reading 'save')") und zerschiesst den Render.
    if (this.adminUsageTab !== 'summary') return;
    let Chart;
    try { Chart = await loadChart(); } catch { return; }
    if (this.adminUsageTab !== 'summary') return;
    const palette = ['#5b8def', '#23bf81', '#f0a23a', '#e85c79', '#9b7ce3', '#23b0bf'];

    const destroy = (key) => {
      if (this._adminUsageCharts?.[key]) {
        try { this._adminUsageCharts[key].destroy(); } catch {}
      }
    };
    if (!this._adminUsageCharts) this._adminUsageCharts = {};

    // Nur auf sichtbarem Canvas instanziieren (offsetParent === null ⇒ display:none-Vorfahr).
    const visible = (el) => el && el.offsetParent !== null;

    // Top-User-Bar
    const topUsers = (data.topUsers || []).slice(0, 10);
    const elUsers = this.$refs?.chartUsers;
    if (visible(elUsers) && topUsers.length) {
      destroy('users');
      this._adminUsageCharts.users = new Chart(elUsers.getContext('2d'), {
        type: 'bar',
        data: {
          labels: topUsers.map(u => u.email),
          datasets: [{
            label: 'USD',
            data: topUsers.map(u => Number(u.usd?.toFixed?.(4) || u.usd || 0)),
            backgroundColor: palette[0],
          }],
        },
        options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } } },
      });
    }
    // Pro-Modell-Pie
    const byModel = data.byModel || [];
    const elModel = this.$refs?.chartModel;
    if (visible(elModel) && byModel.length) {
      destroy('model');
      this._adminUsageCharts.model = new Chart(elModel.getContext('2d'), {
        type: 'doughnut',
        data: {
          labels: byModel.map(m => m.model),
          datasets: [{ data: byModel.map(m => Number(m.usd?.toFixed?.(4) || m.usd || 0)), backgroundColor: palette }],
        },
        options: { responsive: true, maintainAspectRatio: false, animation: false },
      });
    }
    // Pro-Job-Typ-Bar
    const byType = data.byType || [];
    const elType = this.$refs?.chartType;
    if (visible(elType) && byType.length) {
      destroy('type');
      this._adminUsageCharts.type = new Chart(elType.getContext('2d'), {
        type: 'bar',
        data: {
          labels: byType.map(t => this._adminUsageTypeLabel(t.type)),
          datasets: [{ label: 'USD', data: byType.map(t => Number(t.usd?.toFixed?.(4) || t.usd || 0)), backgroundColor: palette[2] }],
        },
        options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } } },
      });
    }
  },

  // ── Tab: Features ──────────────────────────────────────────────────────────
  async adminUsageLoadFeatures() {
    await this._adminUsageRun('features', () => this._adminUsageFetch('/admin/usage/features'), (data) => {
      this.adminUsageFeatureItems  = data.items  || [];
      this.adminUsageFeatureTotals = data.totals || [];
    });
  },

  // ── Tab: Zeit ──────────────────────────────────────────────────────────────
  async adminUsageLoadTime() {
    await this._adminUsageRun('time', () => this._adminUsageFetch('/admin/usage/time'), (data) => {
      this.adminUsageTimeItems = data.items || [];
      this.adminUsageTimeSeries = [];
      this.adminUsageTimeSeriesKey = '';
    });
  },

  async adminUsageLoadTimeSeries(row) {
    const key = `${row.email}:${row.bookId}`;
    if (this.adminUsageTimeSeriesKey === key) {
      this.adminUsageTimeSeriesKey = '';
      this.adminUsageTimeSeries = [];
      return;
    }
    try {
      const data = await this._adminUsageFetch(
        `/admin/usage/time/${encodeURIComponent(row.email)}/${row.bookId}/series`
      );
      this.adminUsageTimeSeries = data.series || [];
      this.adminUsageTimeSeriesKey = key;
    } catch (e) { this.adminUsageError = tFetchErrorRaw(e); }
  },
};
