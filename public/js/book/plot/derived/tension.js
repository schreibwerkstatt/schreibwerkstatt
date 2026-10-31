// Plot-Werkstatt — abgeleitete Reads (Teil 2): Spannungsbogen + Figuren-Fokus.
// Beats mit Intensität als Kurve (global + pro Strang), optionaler Figur-Fokus.

import { _intensityBottomPct } from '../constants.js';
import { compareText } from '../../../i18n.js';

export const tensionMethods = {
  // ── Spannungsbogen ─────────────────────────────────────────────────────────
  // Beats mit gesetzter Intensität (verworfene zählen nicht — sie formen den
  // Bogen nicht) in Board-Lesereihenfolge (Akt-Position → sort_order) zu einer
  // Kurve. Punkte als Prozent-Koordinaten + Polyline-String für die SVG-Linie.
  tensionCurve() {
    const locale = globalThis.window?.Alpine?.store('shell')?.uiLocale;
    return this._memo('tension', [this.beats, this.acts, this.threads, locale], () => {
      const actPos = new Map((this.acts || []).map(a => [a.id, a.position]));
      const actById = new Map((this.acts || []).map(a => [a.id, a]));
      const order = (a, b) =>
        ((actPos.get(a.act_id) ?? 0) - (actPos.get(b.act_id) ?? 0)) ||
        (a.sort_order - b.sort_order) || (a.id - b.id);

      // Eine Punkt-Reihe aus einer Beat-Teilmenge (verworfene + ohne Intensität raus).
      const _line = (subset, color) => {
        const seq = subset
          .filter(b => !b.verworfen && b.intensitaet != null)
          .sort(order);
        const n = seq.length;
        const pts = seq.map((b, k) => {
          const xPct = n === 1 ? 50 : +(5 + (k / (n - 1)) * 90).toFixed(2);
          const bottomPct = +_intensityBottomPct(b.intensitaet).toFixed(2);
          return {
            beat: b, act: actById.get(b.act_id) || null, color,
            xPct, bottomPct, xSvg: xPct, ySvg: +(100 - bottomPct).toFixed(2),
          };
        });
        return { points: pts, polyline: pts.map(p => `${p.xSvg},${p.ySvg}`).join(' '), count: n };
      };

      // Globale Kurve (alle Beats, Akt-Akzent pro Punkt) — Board ohne Stränge.
      const all = (this.beats || []).filter(b => !b.verworfen && b.intensitaet != null).sort(order);
      const nAll = all.length;
      const points = all.map((b, k) => {
        const act = actById.get(b.act_id) || null;
        const xPct = nAll === 1 ? 50 : +(5 + (k / (nAll - 1)) * 90).toFixed(2);
        const bottomPct = +_intensityBottomPct(b.intensitaet).toFixed(2);
        return { beat: b, act, color: this.actAccent(act), xPct, bottomPct, xSvg: xPct, ySvg: +(100 - bottomPct).toFixed(2) };
      });

      // Pro-Strang-Serien (nur wenn Stränge existieren) — je Strang eine eigene
      // farbige Polyline, dazu eine Serie für die „ohne Strang"-Lane (thread
      // null, Karten-Akzent; Beats mit unbekanntem Strang zählen dazu). So deckt
      // die Summe der Serien genau die Punkte von `count` ab — die Sichtbarkeit
      // (count >= 2) passt immer zu dem, was gerendert wird. Leere Serien raus.
      const threadList = (this.threads || []).slice().sort((a, b) => a.position - b.position);
      const known = new Set(threadList.map(t => t.id));
      const series = threadList.length ? [
        ...threadList.map(t => {
          const line = _line((this.beats || []).filter(b => b.thread_id === t.id), this.threadAccent(t));
          return { key: `t${t.id}`, thread: t, label: t.name, ...line };
        }),
        (() => {
          const line = _line((this.beats || []).filter(b => b.thread_id == null || !known.has(b.thread_id)), this.threadAccent(null));
          const label = globalThis.window?.__app?.t('plot.thread.noThread') || '';
          return { key: 'tnone', thread: null, label, ...line };
        })(),
      ].filter(s => s.count >= 1) : [];

      return { points, polyline: points.map(p => `${p.xSvg},${p.ySvg}`).join(' '), count: nAll, series };
    });
  },

  // ── Spannungsbogen-Figur-Fokus (Figurenbogen über die Kurve) ────────────────
  // Auswahl-Optionen: jede Figur (Katalog + Werkstatt), die an einem Beat mit
  // Intensität beteiligt ist — explizit ODER über die Strang-Hauptfigur. Wert
  // encodiert `c:<figId>` / `w:<draftId>`, damit beide Quellen in EINER Combobox
  // (plain) leben.
  tensionFigurOptions() {
    // Deps vollständig: Labels kommen aus dem Figuren-Katalog ($store.catalog,
    // via figurenById) und den Werkstatt-Figuren — ohne den Katalog fröre ein
    // vor dem Figuren-Load berechnetes Label als rohe ID ein.
    const catalogFiguren = globalThis.window?.Alpine?.store('catalog')?.figuren;
    return this._memo('tFigOpts', [this.beats, this.threads, this.draftFiguren, catalogFiguren], () => {
      const withInt = (this.beats || []).filter(b => !b.verworfen && b.intensitaet != null);
      const catIds = new Set(); const draftIds = new Set();
      for (const b of withInt) {
        (b.fig_ids || []).forEach(id => catIds.add(id));
        (b.draft_fig_ids || []).forEach(id => draftIds.add(String(id)));
        const t = b.thread_id != null ? this._threadById(b.thread_id) : null;
        if (t) {
          if (t.fig_id) catIds.add(t.fig_id);
          if (t.draft_figure_id != null) draftIds.add(String(t.draft_figure_id));
        }
      }
      const figById = window.__app?.figurenById;
      const opts = [];
      for (const id of catIds) {
        const f = figById?.get(id);
        opts.push({ value: `c:${id}`, label: f ? (f.kurzname || f.name) : String(id) });
      }
      for (const id of draftIds) {
        const d = this.draftFigurenById?.get(parseInt(id));
        opts.push({ value: `w:${id}`, label: d ? d.name : String(id) });
      }
      opts.sort((a, b) => compareText(a.label, b.label));
      return opts;
    });
  },

  tensionFocusActive() { return !!this.tensionFocusFigur; },

  // Gehört ein Beat zur fokussierten Figur (explizit ODER Strang-vererbt)?
  beatHasTensionFigur(beat) {
    const v = this.tensionFocusFigur;
    if (!v) return true;
    const sep = v.indexOf(':');
    const kind = v.slice(0, sep);
    const id = v.slice(sep + 1);
    if (kind === 'c') return this._beatInvolvesCatalog(beat, id);
    if (kind === 'w') return this._beatInvolvesDraft(beat, id);
    return true;
  },

  // Polyline durch NUR die Beats der fokussierten Figur — die „emotionale Reise"
  // dieser Figur über die Gesamtkurve. Nur im strang-losen Modus (eine kohärente
  // Koordinatenfolge); im Strang-Modus signalisieren allein die gedämpften Punkte.
  tensionFocusLine() {
    if (!this.tensionFocusFigur) return '';
    const tc = this.tensionCurve();
    if (tc.series.length) return '';
    return tc.points
      .filter(p => this.beatHasTensionFigur(p.beat))
      .map(p => `${p.xSvg},${p.ySvg}`)
      .join(' ');
  },
};
