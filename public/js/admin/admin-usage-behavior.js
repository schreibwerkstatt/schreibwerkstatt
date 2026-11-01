// Tab «Verhalten» der Admin-Usage-Karte (docs/usage-events.md).
// Wird im adminUsageCard-Scope gespreadet. Liest GET /admin/usage/behavior:
// aktive User je Woche, Funktions-Nutzung (inkl. nie geoeffneter Karten),
// KI-Ergebnisse (Jobs, Chat-Vorschlaege, Lektorat), Editor-Sitzungen, Kohorten.
// Privacy wie der Rest der Karte: keine Inhalte, keine Buchtitel.

import { loadChart } from '../lazy-libs.js';
import { barDataset, categoryAxis, chartOptions, chartPalette, valueAxis } from '../cards/chart-style.js';
import { FEATURES } from '../cards/feature-registry.js';
import { localeTag, tzOpts } from '../utils.js';

// Abgeleitete Zeilen ausserhalb des reaktiven Karten-States memoisieren
// (Muster _matrixMemo in admin-usage.js): Schluessel ist das Report-Objekt.
const _memo = new WeakMap();
function _derive(report, key, fn) {
  if (!report) return [];
  let m = _memo.get(report);
  if (!m) { m = {}; _memo.set(report, m); }
  if (!(key in m)) m[key] = fn();
  return m[key];
}

function _rate(part, whole) {
  return whole > 0 ? part / whole : null;
}

export const adminUsageBehaviorMethods = {
  async adminUsageLoadBehavior() {
    await this._adminUsageRun('behavior', () => this._adminUsageFetch('/admin/usage/behavior'), (data) => {
      this.adminUsageBehavior = data;
    });
    if (this.adminUsageBehavior) this.$nextTick(() => this._adminUsageRenderBehaviorCharts(this.adminUsageBehavior));
  },

  // Datum ohne Uhrzeit (Wochen, Kohorten). Prozent: adminUsagePct aus admin-usage.js.
  adminUsageDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso.length <= 10 ? iso + 'T12:00:00Z' : iso);
    return d.toLocaleDateString(localeTag(Alpine.store('shell').uiLocale), tzOpts({ day: '2-digit', month: '2-digit', year: 'numeric' }));
  },

  // Alle Karten der Registry, auch die ohne eine einzige Oeffnung im Zeitraum —
  // genau die Zeilen mit 0 beantworten «welche Funktionen nutzt niemand?».
  adminUsageBehaviorFeatures() {
    const b = this.adminUsageBehavior;
    return _derive(b, 'features', () => {
      const t = window.__app.t.bind(window.__app);
      const byKey = new Map((b.features || []).map(f => [f.feature, f]));
      const rows = FEATURES.filter(f => f.flag).map(f => {
        const hit = byKey.get(f.key);
        byKey.delete(f.key);
        return { feature: f.key, label: t(f.labelKey), opens: hit?.opens || 0, users: hit?.users || 0, lastAt: hit?.lastAt || null,
          palette: hit?.sources?.palette || 0, tile: hit?.sources?.tile || 0, sidebar: hit?.sources?.sidebar || 0 };
      });
      // Keys, die es in der Registry nicht mehr gibt, bleiben sichtbar statt zu verschwinden.
      for (const f of byKey.values()) rows.push({ feature: f.feature, label: f.feature, opens: f.opens, users: f.users, lastAt: f.lastAt,
        palette: f.sources?.palette || 0, tile: f.sources?.tile || 0, sidebar: f.sources?.sidebar || 0 });
      return rows;
    });
  },

  adminUsageBehaviorUnusedCount() {
    return this.adminUsageBehaviorFeatures().filter(f => !f.opens).length;
  },

  adminUsageBehaviorJobs() {
    const b = this.adminUsageBehavior;
    return _derive(b, 'jobs', () => (b.jobs || []).map(j => ({
      ...j,
      label: this._adminUsageTypeLabel(j.type),
      successRate: _rate(j.done, j.done + j.error + j.cancelled),
    })));
  },

  adminUsageBehaviorProposals() {
    const b = this.adminUsageBehavior;
    const t = window.__app.t.bind(window.__app);
    return _derive(b, 'proposals', () => (b.proposals || []).map(p => ({
      ...p,
      chatLabel: t(`admin.usage.behavior.chat.${p.chat}`),
      // Annahmequote: uebernommen gegen (uebernommen + verworfen). Offen gelassene
      // Vorschlaege kennt der Client nicht — die Quote misst nur Entscheidungen.
      acceptRate: _rate(p.applied, p.applied + p.discarded),
    })));
  },

  adminUsageBehaviorLektoratRate() {
    const l = this.adminUsageBehavior?.lektorat;
    return l ? _rate(l.selected, l.shown) : null;
  },

  adminUsageBehaviorEditors() {
    const b = this.adminUsageBehavior;
    const t = window.__app.t.bind(window.__app);
    return _derive(b, 'editors', () => (b.editors || []).map(e => ({ ...e, label: t(`admin.usage.behavior.editor.${e.editor}`) })));
  },

  adminUsageBehaviorTools() {
    const b = this.adminUsageBehavior;
    const t = window.__app.t.bind(window.__app);
    return _derive(b, 'tools', () => (b.tools || []).map(x => ({ ...x, label: t(`admin.usage.behavior.tool.${x.event}`) })));
  },

  adminUsageBehaviorCohorts() {
    return this.adminUsageBehavior?.cohorts || [];
  },

  async _adminUsageRenderBehaviorCharts(data) {
    // Gleiche Schutzregeln wie _adminUsageRenderCharts: nur auf sichtbarem
    // Canvas, ohne Animation, Tab vor und nach dem Lazy-Load pruefen.
    if (this.adminUsageTab !== 'behavior') return;
    let Chart;
    try { Chart = await loadChart(); } catch { return; }
    if (this.adminUsageTab !== 'behavior') return;
    const pal = chartPalette();
    if (!this._adminUsageCharts) this._adminUsageCharts = {};
    const visible = (el) => el && el.offsetParent !== null;
    const draw = (key, el, labels, data, color) => {
      if (!visible(el)) return;
      try { this._adminUsageCharts[key]?.destroy(); } catch {}
      const o = chartOptions(pal);
      o.animation = false;
      o.scales = {
        x: categoryAxis(pal),
        y: valueAxis(pal, { beginAtZero: true, ticks: { precision: 0 } }),
      };
      this._adminUsageCharts[key] = new Chart(el.getContext('2d'), {
        type: 'bar',
        data: { labels, datasets: [barDataset(pal, color, { data })] },
        options: o,
      });
    };
    const weekly = data.activity?.weekly || [];
    draw('behaviorWeekly', this.$refs?.chartBehaviorWeekly, weekly.map(w => this.adminUsageDate(w.week)), weekly.map(w => w.activeUsers), pal.primary);
    const hours = data.hours || [];
    if (hours.some(Boolean)) draw('behaviorHours', this.$refs?.chartBehaviorHours, hours.map((_, h) => String(h).padStart(2, '0')), hours, pal.accent);
  },
};
