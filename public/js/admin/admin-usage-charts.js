// Chart-Infrastruktur der Admin-Usage-Karte (Summary + Verhalten): Chart.js
// lazy laden, auf sichtbare Canvas warten, zeichnen, abraeumen. Die Methoden
// werden in adminUsageCard gespreadet; was gezeichnet wird, steht in
// admin-usage.js (_adminUsageRenderCharts) bzw. admin-usage-behavior.js.

import { loadChart } from '../lazy-libs.js';
import { yieldToPaint } from '../app/view-switch.js';

// Chart.js, sobald einmal geladen (lazy-libs cached ohnehin) — damit
// _adminUsageDrawChart synchron bleibt.
let _chartLib = null;

// Frames, die _adminUsageDrawCharts hoechstens auf das Einblenden wartet.
const MAX_PAINT_WAITS = 20;

// Chart.js im Hintergrund anstossen (Summary + Verhalten), Fehler meldet erst
// _adminUsageDrawCharts.
export function _adminUsagePreloadChart() {
  if (!_chartLib) loadChart().then(lib => { _chartLib = lib; }, () => {});
}

// Liegende Balken bekommen je Balken eine Zeile Hoehe: die CSS-Regel von
// .admin-usage-chart-canvas rechnet aus --chart-rows die Hoehe (mit
// Mindesthoehe), damit viele Kategorien nicht ineinanderlaufen.
export function setChartRows(el, rows) {
  el?.parentElement?.style.setProperty('--chart-rows', String(rows || 0));
}

function _whileHidden() {
  return new Promise(r => document.addEventListener('visibilitychange', r, { once: true }));
}

export const adminUsageChartMethods = {
  _adminUsageDestroyCharts() {
    if (!this._adminUsageCharts) return;
    for (const k of Object.keys(this._adminUsageCharts)) {
      try { this._adminUsageCharts[k]?.destroy?.(); } catch {}
    }
    this._adminUsageCharts = {};
  },

  // Alle Charts eines Tabs zeichnen. `charts` = [{ key, el, config }],
  // `config` null = leer (das Template zeigt dann den Leerzustand).
  //
  // Vor dem Zeichnen auf die Canvas warten, die gezeichnet werden sollen —
  // nicht nur auf das Tab-Pane: Alpine blendet `x-show` erst im naechsten
  // requestAnimationFrame ein, nicht im $nextTick. Liefe das Zeichnen davor,
  // stuende die Canvas noch auf display:none, _adminUsageDrawChart
  // uebersprange sie, und die Kaesten blieben leer. Ein Chart auf einem
  // versteckten Canvas zu instanziieren loest zudem Chart.js' Resize-Crash aus
  // ("Cannot read properties of null (reading 'ownerDocument')").
  //
  // Im Hintergrund-Tab feuert kein requestAnimationFrame — also auch Alpines
  // Einblenden nicht. Dort auf `visibilitychange` warten, statt den Deckel
  // abzulaufen und still nichts zu zeichnen.
  //
  // Nach jedem Warten pruefen, dass der Tab noch aktiv ist; sonst abbrechen.
  async _adminUsageDrawCharts(tab, charts) {
    if (this.adminUsageTab !== tab) return;
    try { _chartLib = await loadChart(); } catch { return; }
    const wanted = charts.filter(c => c.config && c.el);
    for (let i = 0; i < MAX_PAINT_WAITS; i++) {
      while (document.hidden) await _whileHidden();
      await yieldToPaint();
      if (this.adminUsageTab !== tab) return;
      if (wanted.every(c => c.el.offsetParent !== null)) break;
    }
    if (this.adminUsageTab !== tab) return;
    for (const c of charts) this._adminUsageDrawChart(c.key, c.el, c.config);
  },

  // Ein Chart der Karte: alten IMMER zuerst zerstoeren — auch wenn die neuen
  // Daten leer sind, sonst bliebe der Stand des vorigen Zeitraums stehen. Nur
  // auf sichtbarem Canvas zeichnen (offsetParent === null ⇒ display:none-
  // Vorfahr). Immer animation:false: Chart.js' Animations-rAF-Loop haelt sonst
  // eine Referenz auf den Chart; wird der beim Tab-Wechsel via destroy()
  // (ctx=null) abgeraeumt, zeichnet ein noch eingereihter Frame auf den
  // null-Context und zerschiesst den Render.
  _adminUsageDrawChart(key, el, config) {
    if (!this._adminUsageCharts) this._adminUsageCharts = {};
    try { this._adminUsageCharts[key]?.destroy?.(); } catch {}
    delete this._adminUsageCharts[key];
    if (!config || !_chartLib || !el || el.offsetParent === null) return;
    config.options = { ...(config.options || {}), animation: false };
    this._adminUsageCharts[key] = new _chartLib(el.getContext('2d'), config);
  },
};
