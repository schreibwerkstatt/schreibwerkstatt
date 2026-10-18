// Buchlandkarte, Tab „Landkarte": die Punkte (Abschnitte oder Passagen) als
// Chart.js-Streudiagramm. Gespreadet über book/buchlandkarte.js.
//
// ACHSEN: der Job liefert je Punkt bis zu drei Koordinaten (`projection.points[].c`)
// — PCA-Komponenten oder Pol-Achsen — und die Karte zeigt ein gewähltes Paar
// davon. Zusätzlich gibt es die Achse „Buchverlauf" (Lesereihenfolge), die kein
// Server-Wert ist, sondern die Position des Punkts in der Liste.
//
// SKALIERUNG: zwei Achsen desselben Raums (zwei PCA- oder zwei Pol-Achsen)
// teilen EINEN Faktor, sonst sähe eine gestreckte Wolke rund aus. Die
// Verlaufsachse hat keine gemeinsame Einheit mit einer Raumachse und wird für
// sich auf [-1, 1] gelegt.
//
// FÄRBUNG: nach Kapitel (Legende = Gliederung) oder nach Buchverlauf (ein
// Datensatz, Punkte in Lesereihenfolge verbunden, Farbe von Anfang nach Ende).

import { loadChart } from '../../lazy-libs.js';
import { createChartHolder, cssVar } from '../../cards/chart-holder.js';
import { chartOptions, chartPalette, seriesColor, valueAxis, withAlpha } from '../../cards/chart-style.js';

// Ausserhalb von Alpine gehalten, damit der Reaktivitäts-Proxy die Chart.js-
// Instanz nicht beschädigt (gleiche Begründung wie in book/bookstats.js).
const _map = createChartHolder();

// Punkt-Radius: Grundgrösse plus ein wenig für die Länge der Seite (Chunk-Zahl).
// Bewusst flach gedeckelt — die Karte soll Lage zeigen, nicht Umfang, und grosse
// Scheiben verdecken ihre Nachbarn. Passagen-Punkte sind klein und gleich gross.
const R_BASE = 3;
const R_MAX_BONUS = 4;
const R_CHUNK = 2;

// Unter drei Punkten gibt die Projektion nichts her (alle Koordinaten 0) —
// dieselbe Untergrenze wie im Server. Ein Bild mit zwei Punkten in der Mitte
// wäre kein Ergebnis, sondern eine Irritation.
const MIN_MAP_POINTS = 3;

// Abgeblendete Kapitel bei aktiver Hervorhebung: Alpha-Suffix der Hex-Farbe.
const ALPHA_ON = 'cc';
const ALPHA_OFF = '22';

// Verlaufsfärbung: Anfang → Ende. Zwei Serienfarben statt Theme-Tokens, weil
// beide auf Hell und Dunkel lesbar sind; dieselben zwei stehen in der Legende
// (buchlandkarte.css, .buchlandkarte-gradient).
const ORDER_FROM = '#5b6ee1';
const ORDER_TO = '#e08a3c';

/** Vom destroy() der Karte gerufen: Modul-State freigeben. */
export function _destroyBookMapChart() {
  _map.destroy();
}
export function _disconnectBookMapThemeObserver() {
  _map.disconnect();
}

// Ein Canvas kann keine CSS-Custom-Properties auflösen — beim Theme-Wechsel muss
// darum neu gezeichnet werden (gleiche Regel wie im Figuren-Graph, siehe
// graph-kit.js#observeThemeChange).
function _ensureThemeObserver(component) {
  _map.ensureThemeRedraw(() => {
    if (!window.__app?.showBuchlandkarteCard || window.__app.buchlandkarteTab !== 'map') return;
    _destroyBookMapChart();
    component.renderBookMap();
  });
}

function _hexMix(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift) => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
  return '#' + [16, 8, 0].map(s => ch(s).toString(16).padStart(2, '0')).join('');
}

export const mapMethods = {
  /** Reicht die Datenlage für eine Karte? Sonst nur die Kennzahlen darunter. */
  bookMapHasMap() {
    return (this.bookMapResult?.projection?.points?.length || 0) >= MIN_MAP_POINTS;
  },

  /**
   * Punkte für das gewählte Achsenpaar: `{ x, y, pageId, chapterId, ix, order }`,
   * x/y in [-1, 1], `order` = Anteil der Lesereihenfolge (0 = Anfang).
   */
  _bookMapPoints() {
    const pts = this.bookMapResult?.projection?.points || [];
    const [a, b] = this._bookMapPair();
    const n = pts.length;
    const col = (k) => pts.map(p => p.c?.[k] ?? 0);
    const orderCol = () => pts.map((_, i) => (n > 1 ? 1 - (2 * i) / (n - 1) : 0));
    const maxAbs = (vs) => vs.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    let xs = col(a);
    let ys = b === 'order' ? orderCol() : col(b);
    if (b === 'order') {
      const f = maxAbs(xs) || 1;
      xs = xs.map(v => v / f);
    } else {
      const f = Math.max(maxAbs(xs), maxAbs(ys)) || 1;
      xs = xs.map(v => v / f);
      ys = ys.map(v => v / f);
    }
    return pts.map((p, i) => ({
      x: xs[i], y: ys[i], pageId: p.id, chapterId: p.chapterId ?? null,
      ix: p.ix ?? null, order: n > 1 ? i / (n - 1) : 0,
    }));
  },

  // `chunksById`: Abschnitt → Zahl seiner Passagen, einmal je Zeichnen gebaut.
  _bookMapRadius(pt, chunksById) {
    if (pt.ix != null) return R_CHUNK;
    return R_BASE + Math.min(R_MAX_BONUS, Math.max(0, (chunksById.get(pt.pageId) || 1) - 1));
  },

  /**
   * Punkte nach Kapitel in Chart.js-Datasets gruppieren. Reihenfolge = Buch-
   * Reihenfolge (aus der Navigationsliste), damit die Legende der Gliederung
   * folgt. Die Farbe hängt an der Position des Kapitels in der GLIEDERUNG,
   * nicht an der Zahl der Kapitel mit Punkten — sonst verschöbe die erste
   * indizierte Seite eines frühen Kapitels alle Farben dahinter.
   * Seiten ohne Kapitel kommen als letzte, neutral gefärbte Gruppe.
   */
  _bookMapDatasets(points, chunksById) {
    const order = [];
    const seen = new Set();
    for (const p of (Alpine.store('nav').pages || [])) {
      const key = p.chapter_id == null ? '' : String(p.chapter_id);
      if (seen.has(key)) continue;
      seen.add(key);
      order.push(p.chapter_id ?? null);
    }
    // Kapitel, die die Navigationsliste nicht kennt (Seite verschoben, Liste
    // noch nicht neu geladen), hinten anhängen statt verschweigen.
    for (const pt of points) {
      const key = pt.chapterId == null ? '' : String(pt.chapterId);
      if (!seen.has(key)) { seen.add(key); order.push(pt.chapterId ?? null); }
    }

    const groups = new Map();
    for (const pt of points) {
      const key = pt.chapterId == null ? '' : String(pt.chapterId);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(pt);
    }

    const muted = cssVar('--color-muted');
    const surface = cssVar('--color-surface');
    const out = [];
    let colorIx = 0;
    for (const chapterId of order) {
      const key = chapterId == null ? '' : String(chapterId);
      const pts = groups.get(key);
      const color = chapterId == null ? muted : seriesColor(colorIx++);
      if (!pts?.length) continue;
      out.push({
        label: this.bookMapChapterName(chapterId),
        chapterId: chapterId ?? null,
        _color: color,
        data: pts.map(pt => ({ ...pt, r: this._bookMapRadius(pt, chunksById) })),
        backgroundColor: color + ALPHA_ON,
        // Fuge in Flächenfarbe trennt überlappende Punkte, statt sie zu verkleben.
        borderColor: surface,
        borderWidth: 1,
        pointRadius: ctx => ctx.raw?.r ?? R_BASE,
        pointHoverRadius: ctx => (ctx.raw?.r ?? R_BASE) + 3,
      });
    }
    return out;
  },

  /**
   * Verlaufsfärbung: EIN Datensatz in Lesereihenfolge, verbunden durch eine
   * dünne Linie — so wird sichtbar, ob das Buch wandert, kreist oder an einen
   * Ort zurückkehrt. Die Kapitel-Hervorhebung blendet hier Punkte einzeln ab.
   */
  _bookMapOrderDataset(points, pal, chunksById) {
    const data = points.map(pt => ({ ...pt, r: this._bookMapRadius(pt, chunksById), _color: _hexMix(ORDER_FROM, ORDER_TO, pt.order) }));
    return [{
      label: window.__app?.t?.('buchlandkarte.color.order') || '',
      chapterId: undefined,
      data,
      showLine: true,
      borderColor: withAlpha(pal.muted, 0.35),
      borderWidth: 1,
      pointBackgroundColor: data.map(d => d._color + ALPHA_ON),
      pointBorderColor: pal.surface,
      pointBorderWidth: 1,
      pointRadius: ctx => ctx.raw?.r ?? R_BASE,
      pointHoverRadius: ctx => (ctx.raw?.r ?? R_BASE) + 3,
    }];
  },

  async renderBookMap() {
    if (!this.bookMapHasMap()) return;
    const canvas = document.getElementById('bookMapCanvas');
    if (!canvas) return;
    try { await loadChart(); } catch { return; }
    _destroyBookMapChart();
    _ensureThemeObserver(this);

    const pal = chartPalette();
    const t = (k, p) => window.__app?.t?.(k, p) || k;
    const points = this._bookMapPoints();
    const chunksById = new Map((this.bookMapResult?.pages || []).map(p => [p.id, p.chunks]));
    const byOrder = this.bookMapColorMode === 'order';
    const [a, b] = this._bookMapPair();

    const base = chartOptions(pal, { legend: !byOrder, legendKind: 'items' });
    base.plugins.tooltip.callbacks = {
      label: ctx => {
        const raw = ctx.raw || {};
        const chapter = this.bookMapChapterName(raw.chapterId);
        const passage = raw.ix != null ? ' · ' + t('buchlandkarte.passage', { n: raw.ix + 1 }) : '';
        return ` ${this.bookMapPageName(raw.pageId)}${passage} — ${chapter}`;
      },
    };
    const axisTitle = (key) => ({ display: true, text: this.bookMapAxisTitle(key) });
    _map.set(new Chart(canvas, {
      type: 'scatter',
      data: { datasets: byOrder ? this._bookMapOrderDataset(points, pal, chunksById) : this._bookMapDatasets(points, chunksById) },
      options: {
        ...base,
        // Streudiagramm: der Punkt unter dem Zeiger, nicht alle mit gleichem Index.
        interaction: { mode: 'nearest', intersect: true },
        onClick: (_evt, elements) => {
          const el = elements?.[0];
          if (!el) return;
          const pt = _map.get()?.data?.datasets?.[el.datasetIndex]?.data?.[el.index];
          if (pt?.pageId) this.bookMapGotoPage(pt.pageId);
        },
        scales: {
          // FESTER Wertebereich auf BEIDEN Achsen, nicht Chart.js' Auto-Fit.
          // Die Koordinaten sind schon so skaliert, dass zwei Achsen desselben
          // Raums denselben Faktor teilen; liesse man Chart.js selbst skalieren,
          // streckte es eine schmale y-Streuung auf die volle Canvas-Höhe — und
          // genau die Verzerrung, die die Projektion vermeidet, käme zurück.
          // Zusammen mit dem quadratischen Rahmen (buchlandkarte.css,
          // aspect-ratio: 1) ergibt das gleiche Einheiten auf beiden Achsen.
          // Zahlenwerte sind bedeutungslos → keine Ticks; die Beschriftung
          // sagt, was die Achse trennt.
          x: valueAxis(pal, { min: -1, max: 1, ticks: { display: false }, title: axisTitle(a) }),
          y: valueAxis(pal, { min: -1, max: 1, ticks: { display: false }, title: axisTitle(b) }),
        },
      },
    }));
    // Für Screenreader und als Titel-Attribut: das Canvas selbst ist stumm.
    canvas.setAttribute('aria-label', t('buchlandkarte.canvasAria', { n: points.length }));
    // Nach Theme-Redraw oder Cache-Restore die Hervorhebung wieder anlegen.
    this._applyBookMapFocus();
  },

  // ── Hervorhebung ──────────────────────────────────────────────────────────

  /**
   * Kapitel hervorheben: es selbst und sein nächstes Kapitel in voller Farbe,
   * alle anderen abgeblendet — so wird „liegen die zwei Wolken übereinander?"
   * sichtbar statt nur als Zahl. Zweiter Klick hebt die Hervorhebung auf.
   */
  bookMapToggleFocus(chapterId) {
    this.bookMapFocusChapter = this.bookMapFocusChapter === chapterId ? null : chapterId;
    this._applyBookMapFocus();
  },

  bookMapIsFocused(chapterId) {
    return this.bookMapFocusChapter != null && this.bookMapFocusChapter === chapterId;
  },

  _applyBookMapFocus() {
    const chart = _map.get();
    if (!chart) return;
    const focus = this.bookMapFocusChapter;
    const nearest = focus == null ? null
      : (this.bookMapResult?.chapters || []).find(c => c.chapterId === focus)?.nearestChapterId ?? null;
    const isOn = (cid) => focus == null || cid === focus || (nearest != null && cid === nearest);
    for (const ds of chart.data.datasets) {
      if (ds.chapterId === undefined) {
        ds.pointBackgroundColor = ds.data.map(d => d._color + (isOn(d.chapterId) ? ALPHA_ON : ALPHA_OFF));
        continue;
      }
      const on = isOn(ds.chapterId);
      ds.backgroundColor = ds._color + (on ? ALPHA_ON : ALPHA_OFF);
      ds.borderWidth = on ? 1 : 0;
    }
    chart.update('none');
  },

  // ── Aussagekraft ──────────────────────────────────────────────────────────

  /**
   * Hinweis zur Aussagekraft des gezeigten Achsenpaars. Zwei PCA-Achsen sind
   * orthogonal, ihre Anteile addieren sich; unter einem Drittel ist das Bild
   * eine Skizze und darf keine Nähe behaupten. Pol-Achsen sind nicht
   * orthogonal — ihre Anteile stehen einzeln da. Mit der Verlaufsachse zählt
   * nur die eine Raumachse.
   */
  bookMapVarianceInfo() {
    const proj = this.bookMapResult?.projection;
    if (!proj) return { cls: 'ok', text: '' };
    const t = (k, p) => window.__app?.t?.(k, p) || k;
    const [a, b] = this._bookMapPair();
    const pct = (k) => Math.round((proj.axes?.[k]?.variance || 0) * 100);
    if (proj.mode === 'poles') {
      if (b === 'order') return { cls: 'ok', text: t('buchlandkarte.variance.pole', { pct: pct(a) }) };
      return { cls: 'ok', text: t('buchlandkarte.variance.poles', { x: pct(a), y: pct(b) }) };
    }
    if (b === 'order') return { cls: 'ok', text: t('buchlandkarte.variance.single', { pct: pct(a) }) };
    const sum = pct(a) + pct(b);
    const band = sum >= 50 ? 'strong' : sum >= 30 ? 'ok' : 'weak';
    return { cls: band, text: t('buchlandkarte.variance.' + band, { pct: sum }) };
  },
};
