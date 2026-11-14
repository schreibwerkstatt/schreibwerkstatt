// Tab «Verhalten» der Admin-Usage-Karte (docs/usage-events.md).
// Wird im adminUsageCard-Scope gespreadet. Liest GET /admin/usage/behavior:
// aktive User je Woche, Funktions-Nutzung (inkl. nie geoeffneter Karten),
// KI-Ergebnisse (Jobs, Chat-Vorschlaege, Lektorat), Editor-Sitzungen, Kohorten,
// Verweildauern (Karten, Werkzeuge am Abschnitt, Abschnitts-Besuche) und Reibung.
// Privacy wie der Rest der Karte: keine Inhalte, keine Buchtitel.

import { barDataset, categoryAxis, chartOptions, chartPalette, valueAxis } from '../cards/chart-style.js';
import { FEATURES } from '../cards/feature-registry.js';

// Abgeleitete Zeilen ausserhalb des reaktiven Karten-States memoisieren
// (Muster _matrixMemo in admin-usage.js): Schluessel ist das Report-Objekt,
// je Eintrag zusaetzlich die UI-Sprache — die Zeilen tragen uebersetzte Labels.
// Das Lesen von uiLocale hier haengt den lesenden Effekt an den Sprachwechsel.
const _memo = new WeakMap();
function _derive(report, key, fn) {
  if (!report) return [];
  const k = `${key}|${Alpine.store('shell').uiLocale}`;
  let m = _memo.get(report);
  if (!m) { m = {}; _memo.set(report, m); }
  if (!(k in m)) m[k] = fn();
  return m[k];
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

  // Datum (adminUsageDate) und Prozent (adminUsagePct) kommen aus admin-usage.js.

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
          palette: hit?.sources?.palette || 0, tile: hit?.sources?.tile || 0, sidebar: hit?.sources?.sidebar || 0,
          medianSec: hit?.medianSec ?? null, totalSec: hit?.totalSec || 0 };
      });
      // Keys, die es in der Registry nicht mehr gibt, bleiben sichtbar statt zu verschwinden.
      for (const f of byKey.values()) rows.push({ feature: f.feature, label: f.feature, opens: f.opens, users: f.users, lastAt: f.lastAt,
        palette: f.sources?.palette || 0, tile: f.sources?.tile || 0, sidebar: f.sources?.sidebar || 0,
        medianSec: f.medianSec ?? null, totalSec: f.totalSec || 0 });
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
      kindLabel: this.adminUsageProposalKindLabel(p.kind),
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

  // Chat-Runden (ein Job je Runde), davon fertige mit und ohne Vorschlag
  // (Server zaehlt beides, db/usage-events/index.js#_chatTurns).
  adminUsageBehaviorChatTurns() {
    const b = this.adminUsageBehavior;
    const t = window.__app.t.bind(window.__app);
    return _derive(b, 'chatTurns', () => (b.chatTurns || []).map(c => ({
      ...c,
      chatLabel: t(`admin.usage.behavior.chat.${c.chat}`),
    })));
  },

  // Im Buch angelegt: Quelle, Idee, Beat, Abschnitt, Kapitel, Figur-Entwurf.
  adminUsageBehaviorCreation() {
    const b = this.adminUsageBehavior;
    const t = window.__app.t.bind(window.__app);
    return _derive(b, 'creation', () => (b.creation || []).map(c => ({
      ...c, label: t(`admin.usage.behavior.created.${c.kind}`),
    })));
  },

  // Geteilt: Share-Links und die Aktionen an den Kommentaren der Leser:innen.
  adminUsageBehaviorSharing() {
    const b = this.adminUsageBehavior;
    const t = window.__app.t.bind(window.__app);
    return _derive(b, 'sharing', () => (b.sharing || []).map(s => ({
      ...s, label: t(`admin.usage.behavior.sharing.${s.key}`),
    })));
  },

  // Abschnitts-Revisionen: Viewer, Vergleich, Wiederherstellen nach Alter, Anheften.
  // Feste Reihenfolge der Kennzahlen (Server), darum ohne Sortierung.
  adminUsageBehaviorRevisions() {
    const b = this.adminUsageBehavior;
    const t = window.__app.t.bind(window.__app);
    return _derive(b, 'revisions', () => (b.revisions || []).map(r => ({
      ...r, label: t(`admin.usage.behavior.revision.${r.key}`),
    })));
  },

  // Leseaktivitaet je Person (kumuliert, nicht periodisch).
  adminUsageBehaviorReading() {
    return this.adminUsageBehavior?.reading?.perUser || [];
  },

  // Werkzeuge am Abschnitt je Editor (panel.open/panel.close).
  adminUsageBehaviorPanels() {
    const b = this.adminUsageBehavior;
    const t = window.__app.t.bind(window.__app);
    return _derive(b, 'panels', () => (b.panels || []).map(p => ({
      ...p,
      label: t(`admin.usage.behavior.panelName.${p.panel}`),
      editorLabel: p.editor ? t(`admin.usage.behavior.editor.${p.editor}`) : '—',
    })));
  },

  // Abschnitts-Besuche je Person (page.view), Lese- und Schreibzeit getrennt.
  adminUsageBehaviorPageViews() {
    return this.adminUsageBehavior?.pageViews?.perUser || [];
  },

  // Reibung: feste Kennzahlen in Server-Reihenfolge, auch bei 0.
  adminUsageBehaviorFriction() {
    const b = this.adminUsageBehavior;
    const t = window.__app.t.bind(window.__app);
    return _derive(b, 'friction', () => (b.friction || []).map(r => ({
      ...r, label: t(`admin.usage.behavior.frictionRow.${r.key}`),
    })));
  },

  async _adminUsageRenderBehaviorCharts(data) {
    // Gleiche Schutzregeln wie _adminUsageRenderCharts (admin-usage.js).
    if (!(await this._adminUsageChartReady('behavior'))) return;
    const pal = chartPalette();
    const bar = (labels, values, color) => {
      const o = chartOptions(pal);
      o.scales = {
        x: categoryAxis(pal),
        y: valueAxis(pal, { beginAtZero: true, ticks: { precision: 0 } }),
      };
      return { type: 'bar', data: { labels, datasets: [barDataset(pal, color, { data: values })] }, options: o };
    };
    const weekly = data.activity?.weekly || [];
    this._adminUsageDrawChart('behaviorWeekly', this.$refs?.chartBehaviorWeekly, weekly.length
      ? bar(weekly.map(w => this.adminUsageDate(w.week)), weekly.map(w => w.activeUsers), pal.primary) : null);
    const hours = data.hours || [];
    this._adminUsageDrawChart('behaviorHours', this.$refs?.chartBehaviorHours, hours.some(Boolean)
      ? bar(hours.map((_, h) => String(h).padStart(2, '0')), hours, pal.accent) : null);
  },
};
