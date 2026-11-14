// AdminUsageCard-Methods.
// Wird im adminUsageCard-Alpine-Scope gespreaded. Root-Zugriffe ueber
// `window.__app`. Privacy: Admin sieht USD/Tokens + book_id (anonym), keine
// Buchtitel.

import { loadChart } from '../lazy-libs.js';
import { barDataset, categoryAxis, chartOptions, chartPalette, seriesColor, valueAxis } from '../cards/chart-style.js';
import { localIsoDate, localeTag, fmtDateTime, formatIsoDay, fetchJson, sendJson } from '../utils.js';
import { tFetchError } from '../i18n.js';
import { featureByKey } from '../cards/feature-registry.js';

// Seitengroesse der Server-paginierten Listen (Jobs, Chat-Antworten).
const PAGE_SIZE = 50;

// Chart.js, sobald einmal geladen (lazy-libs cached ohnehin) — damit
// _adminUsageDrawChart synchron bleibt.
let _chartLib = null;

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
// Schluessel ist das rohe Breakdown-Array (neues Array = neuer Ladevorgang);
// gueltig nur fuer dieselbe UI-Sprache und dieselbe User-Liste (Labels).
const _matrixMemo = new WeakMap();

// User-Zeile aus GET /admin/usage/users plus Entwurfs-Felder des Budget-Edits.
function _userRow(u) {
  return { ...u, _draftBudget: u.monthlyBudgetUsd ?? '', _draftMode: u.budgetMode || 'none', _saving: false, _saved: false };
}

// Vorschlagstypen der fuenf Chats tragen ihre Labels in den Namensraeumen der
// jeweiligen Chat-Karte; der erste Treffer gewinnt.
const PROPOSAL_KIND_KEYS = [
  k => `chat.typ.${k}`, k => `plot.chat.type.${k}`, k => `ideenBoard.chat.type.${k}`,
  k => `recherche.chat.change.type.research_${k}`, k => `recherche.kind.${k}`,
];

export const adminUsageMethods = {
  // ── Locale-Helper (Templates rufen so) ────────────────────────────────────
  adminUsageMoney(n) { return _money(n, this._adminUsageLocale()); },
  adminUsageInt(n)   { return _int(n,   this._adminUsageLocale()); },
  adminUsageHhmm(seconds) {
    const t = window.__app.t.bind(window.__app);
    if (!seconds || seconds < 60) return t(seconds ? 'admin.usage.duration.underMinute' : 'admin.usage.duration.zero');
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h <= 0 ? t('admin.usage.duration.minutes', { m }) : t('admin.usage.duration.hoursMinutes', { h, m });
  },
  _adminUsageLocale() {
    return localeTag(Alpine.store('shell').uiLocale);
  },
  // Erster uebersetzte Key aus `keys`, sonst `fallback` (roher DB-Wert).
  _adminUsageLabel(keys, fallback) {
    const t = window.__app?.t;
    for (const key of keys) {
      const label = t?.call(window.__app, key);
      if (label && label !== key) return label;
    }
    return fallback ?? '—';
  },
  // Job-Typ-String (DB-Wert aus job_runs.type) → übersetztes Label. Fallback: roher Typ.
  _adminUsageTypeLabel(type) {
    return this._adminUsageLabel([`admin.usage.jobType.${type}`], type);
  },
  // Chat-Art (chat_sessions.kind: page/book/research/plot/ideen).
  adminUsageChatKindLabel(kind) {
    return this._adminUsageLabel([`admin.usage.behavior.chat.${kind}`, `admin.usage.jobType.${kind}`], kind);
  },
  // Vorschlagstyp eines Chat-Vorschlags (usage_events chat.proposal `kind`).
  adminUsageProposalKindLabel(kind) {
    if (!kind) return '—';
    return this._adminUsageLabel(PROPOSAL_KIND_KEYS.map(f => f(kind)), kind);
  },
  // Feature-Key der Karten-Registry (feature_usage.feature_key).
  adminUsageFeatureLabel(key) {
    const f = featureByKey(key);
    return f?.labelKey ? this._adminUsageLabel([f.labelKey], key) : key;
  },

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async adminUsageEnter() {
    if (!this.adminUsageInitialized) {
      this.adminUsageInitialized = true;
      // Default: aktueller Monat in app.timezone (matcht Server-Buckets).
      this.adminUsageFrom = this._adminUsageMonthStart();
      this.adminUsageTo = '';
    }
    await this.adminUsageLoadTab(true);
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
      this.adminUsageUsersList = (data.users || []).map(_userRow);
    } catch {}
  },

  adminUsageRemoveFilterUser(email) {
    this.adminUsageFilterUsers = (this.adminUsageFilterUsers || []).filter(e => e !== email);
  },

  adminUsageDrillDownToJobs(email) {
    this.adminUsageFilterUsers = [email];
    this.adminUsageSelectTab('jobs');
  },

  // Ohne `force` laedt ein Tab nur, wenn sich seit seinem letzten Load etwas
  // an Zeitraum/Filtern geaendert hat — ein Tab-Wechsel zeigt sonst den
  // vorhandenen Stand, statt ihn neu zu holen und auszutauschen. Charts sind
  // beim Verlassen zerstoert und werden aus dem Stand neu gezeichnet.
  async adminUsageLoadTab(force = false) {
    const tab = this.adminUsageTab;
    // Fehler gehoert zum zuletzt geladenen Tab — beim Wechsel nicht stehen lassen.
    this.adminUsageError = '';
    if (!force && this._adminUsageKeys[tab] === this._adminUsageStateKey()) {
      if (tab === 'summary' && this.adminUsageSummary) this.$nextTick(() => this._adminUsageRenderCharts(this.adminUsageSummary));
      if (tab === 'behavior' && this.adminUsageBehavior) this.$nextTick(() => this._adminUsageRenderBehaviorCharts(this.adminUsageBehavior));
      return;
    }
    if (tab === 'users')    return this.adminUsageLoadUsers();
    if (tab === 'summary')  return this.adminUsageLoadSummary();
    if (tab === 'jobs')     return this.adminUsageLoadJobs();
    if (tab === 'chat')     return this.adminUsageLoadChat();
    if (tab === 'features') return this.adminUsageLoadFeatures();
    if (tab === 'time')     return this.adminUsageLoadTime();
    if (tab === 'behavior') return this.adminUsageLoadBehavior();
    if (tab === 'billing')  return this.adminUsageLoadBilling();
  },

  _adminUsageQuery() {
    const qs = new URLSearchParams();
    if (this.adminUsageFrom) qs.set('from', this.adminUsageFrom);
    if (this.adminUsageTo)   qs.set('to',   this.adminUsageTo);
    if (this.adminUsageIncludeAdmins) qs.set('includeAdmins', '1');
    return qs.toString();
  },

  // Alles, was das Ergebnis eines Tab-Loads bestimmt.
  _adminUsageStateKey() {
    return JSON.stringify([this._adminUsageQuery(), this.adminUsageFilterUsers, this.adminUsageChatFeedback]);
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
    // Schon beim Start gesetzt: ein zweiter Aufruf fuer denselben Stand (Hash-
    // Router oeffnet die Karte und setzt den Tab) laeuft nicht doppelt.
    this._adminUsageKeys[tab] = this._adminUsageStateKey();
    this._adminUsagePending++;
    this.adminUsageLoading = true;
    try {
      const data = await fetchFn();
      if (seq === this._adminUsageSeq[tab]) applyFn(data);
    } catch (e) {
      if (seq === this._adminUsageSeq[tab]) {
        this.adminUsageError = tFetchError(e);
        delete this._adminUsageKeys[tab];
      }
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
      this.adminUsageUsersList = (data.users || []).map(_userRow);
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
    const locale = Alpine.store('shell').uiLocale;
    const users = window.Alpine?.raw ? window.Alpine.raw(this.adminUsageUsersList) : this.adminUsageUsersList;
    const hit = _matrixMemo.get(raw);
    if (hit && hit.locale === locale && hit.users === users) return hit.val;
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
    _matrixMemo.set(raw, { locale, users, val });
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
      // «Gespeichert» zwei Sekunden lang, dann wieder «Speichern».
      row._saved = true;
      clearTimeout(row._savedTimer);
      row._savedTimer = setTimeout(() => { row._saved = false; }, 2000);
    } catch (e) { this.adminUsageError = tFetchError(e); }
    finally { row._saving = false; }
  },

  // ── Tab: Jobs ──────────────────────────────────────────────────────────────
  // Query der paginierten Listen: User-Filter, Seite ab `offset`, beim Chat
  // zusaetzlich der Bewertungs-Filter.
  _adminUsageListPath(tab, offset) {
    const qs = new URLSearchParams();
    for (const email of (this.adminUsageFilterUsers || [])) {
      if (email) qs.append('user', email);
    }
    qs.set('limit', String(PAGE_SIZE));
    qs.set('offset', String(offset));
    if (tab === 'chat' && this.adminUsageChatFeedback) qs.set('feedback', this.adminUsageChatFeedback);
    return `/admin/usage/${tab}?${qs.toString()}`;
  },

  async adminUsageLoadJobs() {
    this._adminUsageEnsureUsers();
    await this._adminUsageRun('jobs', () => this._adminUsageFetch(this._adminUsageListPath('jobs', 0)), (data) => {
      this.adminUsageJobsList = data.rows || [];
      this.adminUsageJobsTotal = data.total || 0;
    });
  },

  // «Weitere laden»: naechste Seite ab der Zahl geladener Zeilen anhaengen.
  // Laeuft in derselben Sequenz wie der Tab-Load — ein neuerer Load (Filter,
  // Zeitraum) verwirft die Antwort; der Knopf ist waehrend eines Loads gesperrt.
  async adminUsageLoadMore(tab) {
    const listKey = tab === 'jobs' ? 'adminUsageJobsList' : 'adminUsageChatList';
    const totalKey = tab === 'jobs' ? 'adminUsageJobsTotal' : 'adminUsageChatTotal';
    const offset = this[listKey].length;
    await this._adminUsageRun(tab, () => this._adminUsageFetch(this._adminUsageListPath(tab, offset)), (data) => {
      this[listKey] = [...this[listKey], ...(data.rows || [])];
      this[totalKey] = data.total || 0;
    });
  },

  // ── Tab: Chat ──────────────────────────────────────────────────────────────
  async adminUsageLoadChat() {
    this._adminUsageEnsureUsers();
    // Chat-Qualitaet je Chat-Art (Zeitraum, ohne User-Filter) laeuft im selben
    // Load mit — eine Sequenz pro Tab, damit eine spaete Antwort nicht ueber
    // einen neueren Zeitraum schreibt.
    await this._adminUsageRun('chat', () => Promise.all([
      this._adminUsageFetch(this._adminUsageListPath('chat', 0)),
      this._adminUsageFetch('/admin/usage/chat-quality'),
    ]), ([data, quality]) => {
      this.adminUsageChatList = data.rows || [];
      this.adminUsageChatTotal = data.total || 0;
      this.adminUsageChatQuality = (quality.rows || []).map(r => ({
        ...r, label: this.adminUsageChatKindLabel(r.kind),
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
    return fmtDateTime(iso, Alpine.store('shell').uiLocale, { dateStyle: 'short', timeStyle: 'short' });
  },

  // Datum ohne Uhrzeit. Reiner Kalendertag (YYYY-MM-DD) als Kalenderangabe in
  // UTC (formatIsoDay), Zeitstempel in appTimezone.
  adminUsageDate(iso) {
    if (!iso) return '—';
    const opts = { day: '2-digit', month: '2-digit', year: 'numeric' };
    const locale = Alpine.store('shell').uiLocale;
    return iso.length <= 10 ? (formatIsoDay(iso, locale, opts) || iso) : fmtDateTime(iso, locale, opts);
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

  // Chart.js laden und pruefen, dass der Tab noch aktiv ist (vor und nach dem
  // Lazy-Load). Charts auf einem via x-show versteckten Canvas zu
  // instanziieren loest Chart.js' Resize-Crash aus ("Cannot read properties of
  // null (reading 'ownerDocument')").
  async _adminUsageChartReady(tab) {
    if (this.adminUsageTab !== tab) return false;
    try { _chartLib = await loadChart(); } catch { return false; }
    return this.adminUsageTab === tab;
  },

  // Ein Chart der Karte (Summary + Verhalten): alten IMMER zuerst zerstoeren —
  // auch wenn die neuen Daten leer sind, sonst bliebe der Stand des vorigen
  // Zeitraums stehen. `config` null = leer (das Template zeigt dann den
  // Leerzustand statt des Canvas). Nur auf sichtbarem Canvas zeichnen
  // (offsetParent === null ⇒ display:none-Vorfahr). Immer animation:false:
  // Chart.js' Animations-rAF-Loop haelt sonst eine Referenz auf den Chart; wird
  // der beim Tab-Wechsel via destroy() (ctx=null) abgeraeumt, zeichnet ein noch
  // eingereihter Frame auf den null-Context und zerschiesst den Render.
  _adminUsageDrawChart(key, el, config) {
    if (!this._adminUsageCharts) this._adminUsageCharts = {};
    try { this._adminUsageCharts[key]?.destroy?.(); } catch {}
    delete this._adminUsageCharts[key];
    if (!config || !_chartLib || !el || el.offsetParent === null) return;
    config.options = { ...(config.options || {}), animation: false };
    this._adminUsageCharts[key] = new _chartLib(el.getContext('2d'), config);
  },

  async _adminUsageRenderCharts(data) {
    if (!(await this._adminUsageChartReady('summary'))) return;
    const pal = chartPalette();
    const tag = localeTag(Alpine.store('shell').uiLocale);
    const usd = new Intl.NumberFormat(tag, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
    const usdAxis = new Intl.NumberFormat(tag, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
    const usdTip = ctx => ` ${usd.format(ctx.parsed?.x ?? ctx.parsed?.y ?? ctx.parsed ?? 0)}`;
    const num = v => Number(v?.toFixed?.(4) || v || 0);

    // Balken mit langen Labels (E-Mails, Job-Typen) liegend: Text bleibt lesbar.
    const barOptions = () => {
      const o = chartOptions(pal);
      o.indexAxis = 'y';
      o.interaction = { mode: 'nearest', axis: 'y', intersect: false };
      o.plugins.tooltip.callbacks = { label: usdTip };
      o.scales = {
        x: valueAxis(pal, { beginAtZero: true, ticks: { maxRotation: 0, callback: v => usdAxis.format(v) } }),
        y: categoryAxis(pal, { ticks: { autoSkip: false, maxTicksLimit: undefined } }),
      };
      return o;
    };
    const bar = (labels, values, color) => ({
      type: 'bar',
      data: { labels, datasets: [barDataset(pal, color, { label: 'USD', data: values })] },
      options: barOptions(),
    });

    const topUsers = (data.topUsers || []).slice(0, 10);
    this._adminUsageDrawChart('users', this.$refs?.chartUsers, topUsers.length
      ? bar(topUsers.map(u => u.email), topUsers.map(u => num(u.usd)), pal.primary) : null);

    const byModel = data.byModel || [];
    let modelConfig = null;
    if (byModel.length) {
      const o = chartOptions(pal, { legend: true, legendKind: 'items' });
      o.cutout = '68%';
      o.interaction = { mode: 'nearest', intersect: true };
      o.plugins.tooltip.callbacks = { label: usdTip };
      modelConfig = {
        type: 'doughnut',
        data: {
          labels: byModel.map(m => m.model),
          datasets: [{
            data: byModel.map(m => num(m.usd)),
            backgroundColor: byModel.map((_, i) => seriesColor(i)),
            borderColor: pal.surface,
            borderWidth: 2,
            borderRadius: 3,
            hoverOffset: 4,
          }],
        },
        options: o,
      };
    }
    this._adminUsageDrawChart('model', this.$refs?.chartModel, modelConfig);

    const byType = data.byType || [];
    this._adminUsageDrawChart('type', this.$refs?.chartType, byType.length
      ? bar(byType.map(t => this._adminUsageTypeLabel(t.type)), byType.map(t => num(t.usd)), pal.accent) : null);
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

  // Tagesverlauf einer Zeile (User x Buch). Laeuft ueber die Sequenz des
  // Zeit-Tabs: ein neuerer Tab-Load oder eine andere Zeile verwirft die Antwort.
  async adminUsageLoadTimeSeries(row) {
    if (!row.bookId) return;
    const key = `${row.email}:${row.bookId}`;
    if (this.adminUsageTimeSeriesKey === key) {
      this.adminUsageTimeSeriesKey = '';
      this.adminUsageTimeSeries = [];
      return;
    }
    await this._adminUsageRun('time', () => this._adminUsageFetch(
      `/admin/usage/time/${encodeURIComponent(row.email)}/${row.bookId}/series`
    ), (data) => {
      this.adminUsageTimeSeries = data.series || [];
      this.adminUsageTimeSeriesKey = key;
    });
  },
};
