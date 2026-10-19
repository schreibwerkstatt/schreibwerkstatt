// Buchlandkarte, Tab „Verlauf": Ähnlichkeitsmatrix aller Abschnitte in
// Lesereihenfolge, darunter die Novelty-Kurve mit den Bruchstellen und die
// Echos. Mathematik im Server (lib/book-map/matrix.js); hier wird dekodiert und
// gezeichnet. Gespreadet über book/buchlandkarte.js.
//
// LESART: die Matrix projiziert nicht — jede Zelle ist eine Paar-Ähnlichkeit im
// Vollraum (zentriert: „teilen diese zwei, was sie vom Rest abhebt"). Helle
// Blöcke an der Diagonale sind zusammenhängende Teile, ein heller Fleck abseits
// ist eine Wiederaufnahme. Dünne Linien = Kapitelgrenzen, Marken am Rand =
// gefundene Bruchstellen, Ringe = Echos.
//
// KONTRAST: die Farbskala reicht vom 2. bis zum 98. Perzentil der Zellen
// abseits der Diagonale. Mit der vollen Spanne [-1, 1] läge fast das ganze Buch
// in einem schmalen Mittelband und die Matrix wäre einfarbig.
//
// Das Canvas zeichnet in Gerätepixeln selbst (kein Chart.js): bei 1000×1000
// Zellen wäre ein Datenpunkt je Zelle für Chart.js zu viel, ein Bild ist es nicht.

import { loadChart } from '../../lazy-libs.js';
import { createChartHolder, cssVar } from '../../cards/chart-holder.js';
import { chartOptions, chartPalette, lineDataset, valueAxis, categoryAxis, withAlpha } from '../../cards/chart-style.js';

const _novelty = createChartHolder();
const _decoded = new WeakMap();
// Abschnitt → Kapitel je Ergebnis: die Matrix fragt beim Zeichnen für jede
// Zeile nach, ein `.find()` über alle Abschnitte wäre dort quadratisch.
const _chapterIndex = new WeakMap();
const _rgbCache = new Map();

const P_LO = 0.02;
const P_HI = 0.98;

export function _destroyBookMatrix() {
  _novelty.destroy();
}
export function _disconnectBookMatrixThemeObserver() {
  _novelty.disconnect();
}

// Beliebige CSS-Farbe → [r, g, b] über ein 1×1-Canvas (Token können hex, rgb()
// oder oklch() sein; das Canvas normiert alle).
function _rgb(color) {
  if (_rgbCache.has(color)) return _rgbCache.get(color);
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color || '#000';
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  const out = [r, g, b];
  _rgbCache.set(color, out);
  return out;
}

function _quantile(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

/** Oberes Dreieck (Bytes, base64) → volle Matrix + Kontrastgrenzen; je Ergebnis einmal. */
export function decodeBookMatrix(mx) {
  if (!mx?.size) return null;
  if (_decoded.has(mx)) return _decoded.get(mx);
  const m = mx.size;
  const bin = atob(mx.data || '');
  const full = new Float32Array(m * m);
  const off = [];
  let k = 0;
  for (let i = 0; i < m; i++) {
    for (let j = i; j < m; j++) {
      const v = bin.charCodeAt(k++) / 127.5 - 1;
      full[i * m + j] = v;
      full[j * m + i] = v;
      if (j > i) off.push(v);
    }
  }
  off.sort((a, b) => a - b);
  let lo = _quantile(off, P_LO);
  let hi = _quantile(off, P_HI);
  if (!(hi > lo)) { lo = -1; hi = 1; }
  const out = { m, full, lo, hi };
  _decoded.set(mx, out);
  return out;
}

export const matrixMethods = {
  bookMapHasMatrix() {
    return (this.bookMapResult?.matrix?.size || 0) >= 2;
  },

  _bookMatrixBins() {
    return this.bookMapResult?.matrix?.bins || [];
  },

  _bookMatrixChapterOf(binIx) {
    const res = this.bookMapResult;
    if (!res) return undefined;
    let idx = _chapterIndex.get(res);
    if (!idx) {
      idx = new Map((res.pages || []).map(p => [p.id, p.chapterId ?? null]));
      _chapterIndex.set(res, idx);
    }
    const id = this._bookMatrixBins()[binIx]?.[0];
    return idx.has(id) ? idx.get(id) : undefined;
  },

  /** Name einer Matrix-Zeile: ein Abschnitt oder ein Fach aufeinanderfolgender Abschnitte. */
  bookMatrixBinName(ix) {
    const ids = this._bookMatrixBins()[ix] || [];
    if (ids.length <= 1) return this.bookMapPageName(ids[0]);
    const t = (k, p) => window.__app?.t?.(k, p) || k;
    return t('buchlandkarte.matrix.bin', {
      first: this.bookMapPageName(ids[0]), last: this.bookMapPageName(ids[ids.length - 1]), n: ids.length,
    });
  },

  async renderBookMatrix() {
    this._drawBookMatrix();
    await this._renderBookNovelty();
  },

  _drawBookMatrix() {
    const d = decodeBookMatrix(this.bookMapResult?.matrix);
    const canvas = document.getElementById('bookMatrixCanvas');
    if (!d || !canvas) return;
    const css = canvas.clientWidth;
    if (!css) return;
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(css * dpr);
    canvas.width = px;
    canvas.height = px;
    const { m, full, lo, hi } = d;

    const off = document.createElement('canvas');
    off.width = off.height = m;
    const octx = off.getContext('2d');
    const img = octx.createImageData(m, m);
    const low = _rgb(cssVar('--color-surface'));
    const high = _rgb(cssVar('--color-primary'));
    const span = hi - lo;
    for (let i = 0; i < m * m; i++) {
      const t = Math.max(0, Math.min(1, (full[i] - lo) / span));
      img.data[i * 4] = low[0] + (high[0] - low[0]) * t;
      img.data[i * 4 + 1] = low[1] + (high[1] - low[1]) * t;
      img.data[i * 4 + 2] = low[2] + (high[2] - low[2]) * t;
      img.data[i * 4 + 3] = 255;
    }
    octx.putImageData(img, 0, 0);

    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, px, px);
    ctx.drawImage(off, 0, 0, px, px);
    const cell = px / m;
    const pal = chartPalette();

    // Kapitelgrenzen als dünne Linien in beide Richtungen.
    ctx.strokeStyle = withAlpha(pal.text, 0.28);
    ctx.lineWidth = Math.max(1, dpr * 0.75);
    ctx.beginPath();
    for (let i = 1; i < m; i++) {
      if (this._bookMatrixChapterOf(i) === this._bookMatrixChapterOf(i - 1)) continue;
      const p = Math.round(i * cell) + 0.5;
      ctx.moveTo(p, 0); ctx.lineTo(p, px);
      ctx.moveTo(0, p); ctx.lineTo(px, p);
    }
    ctx.stroke();

    // Bruchstellen: Marken am oberen und linken Rand.
    ctx.fillStyle = pal.accent;
    const s = 6 * dpr;
    for (const b of this.bookMapResult.matrix.boundaries || []) {
      const p = b.ix * cell;
      ctx.beginPath(); ctx.moveTo(p - s, 0); ctx.lineTo(p + s, 0); ctx.lineTo(p, s * 1.4); ctx.fill();
      ctx.beginPath(); ctx.moveTo(0, p - s); ctx.lineTo(0, p + s); ctx.lineTo(s * 1.4, p); ctx.fill();
    }

    // Echos: Ringe an beiden symmetrischen Zellen.
    ctx.strokeStyle = pal.accent;
    ctx.lineWidth = Math.max(1.5, dpr * 1.5);
    const r = Math.max(5 * dpr, cell);
    for (const e of this.bookMapResult.matrix.echoes || []) {
      for (const [row, col] of [[e.a, e.b], [e.b, e.a]]) {
        ctx.beginPath();
        ctx.arc((col + 0.5) * cell, (row + 0.5) * cell, r, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Gewählte Zelle.
    const pick = this.bookMapMatrixPick;
    if (pick) {
      ctx.strokeStyle = pal.text;
      ctx.lineWidth = Math.max(1.5, dpr * 1.5);
      const w = Math.max(cell, 4 * dpr);
      ctx.strokeRect((pick.col + 0.5) * cell - w / 2, (pick.row + 0.5) * cell - w / 2, w, w);
    }
    canvas.setAttribute('aria-label', (window.__app?.t?.('buchlandkarte.matrix.aria', { n: m })) || '');
  },

  _bookMatrixCellAt(evt) {
    const d = decodeBookMatrix(this.bookMapResult?.matrix);
    const rect = evt.currentTarget.getBoundingClientRect();
    if (!d || !rect.width) return null;
    const col = Math.floor(((evt.clientX - rect.left) / rect.width) * d.m);
    const row = Math.floor(((evt.clientY - rect.top) / rect.height) * d.m);
    if (row < 0 || col < 0 || row >= d.m || col >= d.m) return null;
    return { row, col, score: d.full[row * d.m + col] };
  },

  bookMatrixHover(evt) {
    const c = this._bookMatrixCellAt(evt);
    const h = this.bookMapMatrixHover;
    if (c && h && c.row === h.row && c.col === h.col) return;
    this.bookMapMatrixHover = c;
  },

  bookMatrixPick(evt) {
    const c = this._bookMatrixCellAt(evt);
    if (!c) return;
    this.bookMapMatrixPick = c;
    this._drawBookMatrix();
  },

  /** Zeile unter der Matrix: Zelle unter dem Zeiger, sonst die gewählte. */
  bookMatrixCellText() {
    const c = this.bookMapMatrixHover || this.bookMapMatrixPick;
    if (!c) return '';
    return `${this.bookMatrixBinName(c.row)} × ${this.bookMatrixBinName(c.col)} — ${Math.round(c.score * 100)}%`;
  },

  bookMatrixPickRefs() {
    const c = this.bookMapMatrixPick;
    if (!c) return [];
    const bins = this._bookMatrixBins();
    const ids = [bins[c.row]?.[0], bins[c.col]?.[0]].filter(id => id != null);
    return [...new Set(ids)].map(id => ({ id, name: this.bookMapPageName(id) }));
  },

  // ── Novelty-Kurve ─────────────────────────────────────────────────────────

  async _renderBookNovelty() {
    const mx = this.bookMapResult?.matrix;
    const canvas = document.getElementById('bookNoveltyCanvas');
    if (!canvas || !mx?.novelty?.some(v => v != null)) { _novelty.destroy(); return; }
    try { await loadChart(); } catch { return; }
    // Nach dem await: ein paralleler Render (Theme-Wechsel, Tab-Klick) kann den
    // Canvas inzwischen belegt haben — Chart.js wirft sonst «Canvas is already in use».
    _novelty.destroy();
    _novelty.ensureThemeRedraw(() => {
      if (!window.__app?.showBuchlandkarteCard || window.__app.buchlandkarteTab !== 'matrix') return;
      this.renderBookMatrix();
    });
    const pal = chartPalette();
    const labels = mx.novelty.map((_, i) => this.bookMatrixBinName(i));
    const marks = mx.novelty.map(() => null);
    for (const b of mx.boundaries || []) marks[b.ix] = mx.novelty[b.ix];
    const t = (k, p) => window.__app?.t?.(k, p) || k;
    const base = chartOptions(pal, { legend: false });
    base.plugins.tooltip.callbacks = {
      title: items => labels[items[0]?.dataIndex] || '',
      label: ctx => (ctx.datasetIndex === 1
        ? ` ${t('buchlandkarte.matrix.boundaryMark')}`
        : ` ${Math.round((ctx.raw ?? 0) * 100)}`),
    };
    _novelty.set(new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          lineDataset(pal, pal.primary, { data: mx.novelty, spanGaps: false }),
          {
            type: 'line', data: marks, showLine: false,
            pointRadius: 5, pointHoverRadius: 7,
            backgroundColor: cssVar('--color-accent') || pal.accent, borderColor: pal.surface, borderWidth: 1,
          },
        ],
      },
      options: {
        ...base,
        onClick: (_evt, elements) => {
          const ix = elements?.[0]?.index;
          const id = this._bookMatrixBins()[ix]?.[0];
          if (id != null) this.bookMapGotoPage(id);
        },
        scales: {
          x: categoryAxis(pal, { ticks: { display: false } }),
          y: valueAxis(pal, { ticks: { display: false }, title: { display: true, text: t('buchlandkarte.matrix.noveltyAxis') } }),
        },
      },
    }));
  },

  // ── Tabellen ──────────────────────────────────────────────────────────────

  bookMapBoundaryRows() {
    const mx = this.bookMapResult?.matrix;
    if (!mx?.boundaries?.length) return [];
    const t = (k, p) => window.__app?.t?.(k, p) || k;
    const max = Math.max(...mx.boundaries.map(b => b.score), 1e-9);
    return mx.boundaries.map(b => {
      const id = this._bookMatrixBins()[b.ix]?.[0];
      const before = this._bookMatrixChapterOf(b.ix - 1);
      const after = this._bookMatrixChapterOf(b.ix);
      const atChapter = before !== after;
      return {
        ix: b.ix,
        pageId: id,
        name: this.bookMapPageName(id),
        // Relativ zur stärksten Bruchstelle: der Rohwert hat keine Einheit, die
        // ein Autor lesen könnte, die Rangfolge schon.
        strengthPct: Math.round((b.score / max) * 100),
        atChapter,
        place: atChapter ? t('buchlandkarte.matrix.atChapter') : t('buchlandkarte.matrix.inChapter', { chapter: this.bookMapChapterName(after) }),
      };
    });
  },

  /** „Von n Kapitelgrenzen fallen k mit einer Bruchstelle zusammen." */
  bookMapBoundarySummary() {
    const bins = this._bookMatrixBins();
    if (bins.length < 2) return '';
    let chapterBreaks = 0;
    for (let i = 1; i < bins.length; i++) {
      if (this._bookMatrixChapterOf(i) !== this._bookMatrixChapterOf(i - 1)) chapterBreaks++;
    }
    const rows = this.bookMapBoundaryRows();
    const hit = rows.filter(r => r.atChapter).length;
    const t = (k, p) => window.__app?.t?.(k, p) || k;
    return t('buchlandkarte.matrix.summary', {
      found: rows.length, chapters: chapterBreaks, hit, inside: rows.length - hit,
    });
  },

  bookMapEchoRows() {
    const mx = this.bookMapResult?.matrix;
    if (!mx?.echoes?.length) return [];
    const bins = this._bookMatrixBins();
    return mx.echoes.map(e => {
      let gap = 0;
      for (let i = e.a; i < e.b; i++) gap += bins[i]?.length || 0;
      const aId = bins[e.a]?.[0];
      const bId = bins[e.b]?.[0];
      return {
        key: `${e.a}-${e.b}`,
        aId, aName: this.bookMapPageName(aId),
        bId, bName: this.bookMapPageName(bId),
        scorePct: Math.round(e.score * 100),
        gap,
      };
    });
  },
};
