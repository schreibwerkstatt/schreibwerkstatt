// Motiv-Werkstatt — Breite des Seitenpanels neben der Konstellation per Griff.
// Mechanik (Ziehen, Pfeiltasten, Home/End, Doppelklick = zurück) aus dem geteilten
// column-resize.js; hier nur Messung, Grenzen und Speicherort. Eigene Breite statt
// der globalen Leisten-Breite der `.aside-split`s: das Panel ist ein Editor neben
// einer Zeichenfläche, keine Chat-/Ideen-Leiste.

import { bindColumnResize } from '../../column-resize.js';
import { lsGet, lsSet, lsRemove } from '../../safe-storage.js';

const KEY = 'sw:motiv:panel-width';
export const PANEL_W_MIN = 260;
export const PANEL_W_MAX = 720;

export function clampPanelWidth(w) {
  return Math.max(PANEL_W_MIN, Math.min(PANEL_W_MAX, Math.round(w)));
}

export const panelResizeMethods = {
  _readPanelWidth() {
    const v = parseInt(lsGet(KEY), 10);
    return Number.isFinite(v) ? clampPanelWidth(v) : null;
  },
  // Inline-Variable am Layout; ohne Wahl gilt der CSS-Default.
  motivPanelVars() {
    return this.motivPanelWidth ? { '--motiv-panel-w': this.motivPanelWidth + 'px' } : {};
  },
  _initPanelResize(handle) {
    if (!handle || handle._motivResizeBound) return;
    handle._motivResizeBound = true;
    const panel = () => handle.parentElement?.querySelector('.motiv-panel');
    const redraw = () => requestAnimationFrame(() => this._motivNetwork?.redraw());
    bindColumnResize(handle, {
      min: PANEL_W_MIN,
      max: PANEL_W_MAX,
      grow: -1,
      measure: () => Math.round(panel()?.getBoundingClientRect().width || 0),
      apply: (w) => { this.motivPanelWidth = clampPanelWidth(w); },
      persist: () => {
        if (this.motivPanelWidth) lsSet(KEY, String(this.motivPanelWidth));
        redraw();
      },
      reset: () => { this.motivPanelWidth = null; lsRemove(KEY); redraw(); },
    });
    handle.setAttribute('aria-label', window.__app.t('motiv.panel.resize'));
  },
};
