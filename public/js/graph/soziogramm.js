import { SCHICHT_COLOR, DEFAULT_FONT } from './constants.js';
import { computeSoziogrammLayout, schichtOf } from './soziogramm-layout.js';
import { graphPlaceholder, parseColor, rgba } from '../graph-kit.js';

// Soziogramm: nach Sozialschicht gefärbt, Schicht-Rows, Machtpfeile.
export const soziogrammMethods = {
  _renderSoziogramm(container) {
    const figuren = this._graphFiguren();
    const theme = this._theme();
    // Guard: noch keine Sozialschichten vorhanden → Placeholder statt leerem Graph
    const hasSchicht = figuren.some(f => schichtOf(f) !== 'andere');
    if (!hasSchicht) {
      if (this._figurenNetwork) { this._figurenNetwork.destroy(); this._figurenNetwork = null; }
      graphPlaceholder(container, window.__app.t('graph.empty.sozialschicht'), 'muted-msg soziogramm-placeholder');
      return;
    }

    const { posById, bands } = computeSoziogrammLayout(figuren);

    const nodes = new vis.DataSet(figuren.map(f => {
      const { x, y } = posById.get(f.id);
      return {
        ...this._baseNode(f),
        color: this._schichtNodeColor(schichtOf(f)),
        font: this._schichtNodeFont(schichtOf(f)),
        x, y,
        fixed: { x: false, y: true }, // Schicht-Zeile fixieren; horizontal löst Physics Überlappungen
      };
    }));

    const { edgeList } = this._buildEdges(/* soziogrammModus */ true);
    const edges = new vis.DataSet(edgeList);
    this._figurenNodes = nodes;
    this._figurenEdges = edges;

    const options = {
      physics: { solver: 'repulsion', repulsion: { nodeDistance: 140 }, stabilization: { iterations: 150 } },
      layout: { randomSeed: 7 },
      interaction: { hover: true, tooltipDelay: 100 },
      edges: { smooth: { type: 'curvedCW', roundness: 0.15 } },
    };

    const network = new vis.Network(container, { nodes, edges }, options);
    this._figurenNetwork = network;
    network.once('stabilizationIterationsDone', () => network.setOptions({ physics: false }));

    const BAND_EXTENT = 9000;

    // Band-Streifen: die Palette hält den hellen Wasch für hellen Grund. Auf dunklem
    // Grund wäre er ein Leuchtbalken — dort stattdessen die gesättigte Schicht-Border
    // schwach eingeblendet (gleiche Farbfamilie, passende Richtung).
    const bandFill = (schicht) => {
      const style = SCHICHT_COLOR[schicht] || SCHICHT_COLOR.andere;
      if (!theme.dark) return style.band;
      const rgb = parseColor(style.border);
      return rgb ? rgba(rgb, 0.18) : style.band;
    };

    network.on('beforeDrawing', (ctx) => {
      // 1) Farbige Streifen + Trennlinien in Netzwerk-Koordinaten
      ctx.save();
      for (const { schicht, y, half } of bands) {
        ctx.fillStyle = bandFill(schicht);
        ctx.fillRect(-BAND_EXTENT, y - half, BAND_EXTENT * 2, half * 2);
        // Trennlinie unten
        ctx.strokeStyle = theme.bandLine;
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(-BAND_EXTENT, y + half);
        ctx.lineTo( BAND_EXTENT, y + half);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();

      // 2) Schicht-Labels: linke Kante des Canvas, in Bildschirm-Koordinaten
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const dpr = window.devicePixelRatio || 1;
      const cHeightCss = ctx.canvas.height / dpr;
      const schichtFs  = Math.max(10, Math.min(15, cHeightCss / 65));
      ctx.font = `bold ${schichtFs * dpr}px ${DEFAULT_FONT.face}`;
      ctx.textBaseline = 'middle';
      const padY  = (schichtFs * 0.9) * dpr;
      const pillH = (schichtFs * 1.6) * dpr;
      for (const { schicht, y } of bands) {
        const domY = network.canvasToDOM({ x: 0, y }).y;
        if (domY < -16 || domY > cHeightCss + 16) continue;
        // Hintergrund-Pill (rounded rect, compat-safe) – Koordinaten in Canvas-Pixeln (× dpr)
        const label = window.__app.t('figuren.schicht.' + schicht);
        const tw    = ctx.measureText(label).width;
        const cY = domY * dpr;
        const px = 6 * dpr, py = cY - padY, pw = tw + 12 * dpr, ph = pillH, pr = 4 * dpr;
        ctx.fillStyle = theme.pillBg;
        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(px, py, pw, ph, pr);
        } else {
          ctx.moveTo(px + pr, py);
          ctx.lineTo(px + pw - pr, py);     ctx.arcTo(px+pw, py,    px+pw, py+pr,    pr);
          ctx.lineTo(px + pw, py+ph-pr);    ctx.arcTo(px+pw, py+ph, px+pw-pr, py+ph, pr);
          ctx.lineTo(px + pr, py+ph);       ctx.arcTo(px,    py+ph, px,      py+ph-pr,pr);
          ctx.lineTo(px, py+pr);            ctx.arcTo(px,    py,    px+pr,   py,      pr);
          ctx.closePath();
        }
        ctx.fill();
        ctx.fillStyle = theme.ink((SCHICHT_COLOR[schicht] || SCHICHT_COLOR.andere).label);
        ctx.fillText(label, 12 * dpr, cY);
      }
      ctx.restore();
    });

    this._attachTooltip(container);
  },
};
