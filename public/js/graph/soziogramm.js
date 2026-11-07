import { SCHICHT_COLOR, DEFAULT_FONT } from './constants.js';
import { computeSoziogrammLayout, schichtOf } from './soziogramm-layout.js';
import { paddedHull } from './soziogramm-hulls.js';
import { graphPlaceholder, parseColor, rgba, toCss } from '../graph-kit.js';
import { seriesColor } from '../cards/chart-style.js';

const BAND_EXTENT = 9000;
const HULL_PAD = 34;        // Abstand der Insel-Hülle zum Knoten (vertikal)
const HULL_PAD_X = 92;      // … waagrecht (Knoten sind breiter als hoch)
const BRIDGE_W = 54;        // Breite der Kapitel-Marke unter einer Brückenfigur

// Soziogramm: Y = Schicht (darin Macht), X = Nähe, Kapitel als Inseln.
// Positionen rechnet soziogramm-layout.js; hier wird nur gezeichnet.
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

    const kapitel = this.figurenKapitelOptionen();
    const kapitelLabel = new Map(kapitel.map(o => [String(o.value), o.label]));
    const kapitelIx = new Map(kapitel.map((o, i) => [String(o.value), i]));
    const { posById, bands, islands, bridges, begegnungen } = computeSoziogrammLayout(figuren, {
      kapitelOrder: kapitel.map(o => o.value),
      inseln: this.soziogrammInseln,
      begegnungen: this.soziogrammBegegnungen,
      szenen: Alpine.store('catalog').szenen,
    });

    const nodes = new vis.DataSet(figuren.map(f => {
      const { x, y } = posById.get(f.id);
      return {
        ...this._baseNode(f),
        color: this._schichtNodeColor(schichtOf(f)),
        font: this._schichtNodeFont(schichtOf(f)),
        x, y,
        fixed: { x: false, y: true }, // Schicht-Zeile fixieren; waagrecht darf der User ziehen
      };
    }));

    const { edgeList } = this._buildEdges(/* soziogrammModus */ true);
    const meetColor = theme.muted;
    for (const m of begegnungen) {
      const color = { color: rgba(parseColor(meetColor) || [128, 128, 128], 0.55), highlight: meetColor };
      edgeList.push({
        id: `meet:${m.a}|${m.b}`, from: m.a, to: m.b, label: '',
        begegnung: m.n,
        color, restoreColor: color,
        dashes: [3, 4], width: 1, arrows: '',
      });
    }
    const edges = new vis.DataSet(edgeList);
    this._figurenNodes = nodes;
    this._figurenEdges = edges;

    const options = {
      physics: false,
      layout: { randomSeed: 7 },
      interaction: { hover: true, tooltipDelay: 100 },
      edges: { smooth: { type: 'curvedCW', roundness: 0.15 } },
    };

    const network = new vis.Network(container, { nodes, edges }, options);
    this._figurenNetwork = network;

    // Band-Streifen: die Palette hält den hellen Wasch für hellen Grund. Auf dunklem
    // Grund wäre er ein Leuchtbalken — dort stattdessen die gesättigte Schicht-Border
    // schwach eingeblendet (gleiche Farbfamilie, passende Richtung).
    const bandFill = (schicht) => {
      const style = SCHICHT_COLOR[schicht] || SCHICHT_COLOR.andere;
      if (!theme.dark) return style.band;
      const rgb = parseColor(style.border);
      return rgb ? rgba(rgb, 0.18) : style.band;
    };
    const bandLabel = (schicht) => window.__app.t(schicht === 'andere'
      ? 'graph.sozio.ohneSchicht' : 'figuren.schicht.' + schicht);
    const islandRgb = (ix) => parseColor(theme.ink(seriesColor(ix))) || [128, 128, 128];
    const dpr = () => window.devicePixelRatio || 1;

    // Pill mit Text in Bildschirm-Koordinaten (Canvas-Pixel, × dpr).
    const pill = (ctx, text, x, cY, fs, color) => {
      const padY = (fs * 0.9) * dpr(), pillH = (fs * 1.6) * dpr();
      const tw = ctx.measureText(text).width;
      const px = x, py = cY - padY, pw = tw + 12 * dpr(), ph = pillH, pr = 4 * dpr();
      ctx.fillStyle = theme.pillBg;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(px, py, pw, ph, pr);
      else ctx.rect(px, py, pw, ph);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.fillText(text, px + 6 * dpr(), cY);
    };

    network.on('beforeDrawing', (ctx) => {
      // 1) Schicht-Bänder + Trennlinien in Netzwerk-Koordinaten
      ctx.save();
      for (const { schicht, y, half } of bands) {
        ctx.fillStyle = bandFill(schicht);
        ctx.fillRect(-BAND_EXTENT, y - half, BAND_EXTENT * 2, half * 2);
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

      // 2) Kapitel-Inseln: Hülle aus den AKTUELLEN Positionen (folgt gezogenen Knoten)
      const hullTops = [];
      if (islands.length) {
        ctx.save();
        for (const isl of islands) {
          if (!isl.members.length) continue;
          const pts = Object.values(network.getPositions(isl.members));
          const hull = paddedHull(pts, HULL_PAD, { padX: HULL_PAD_X });
          if (hull.length < 3) continue;
          const rgb = islandRgb(isl.index);
          ctx.beginPath();
          hull.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          ctx.closePath();
          ctx.fillStyle = rgba(rgb, theme.dark ? 0.10 : 0.07);
          ctx.fill();
          ctx.strokeStyle = rgba(rgb, 0.55);
          ctx.lineWidth = 2;
          ctx.setLineDash([8, 6]);
          ctx.stroke();
          ctx.setLineDash([]);
          const top = hull.reduce((a, p) => (p.y < a.y ? p : a));
          const minX = Math.min(...hull.map(p => p.x)), maxX = Math.max(...hull.map(p => p.x));
          hullTops.push({ x: (minX + maxX) / 2, y: top.y, rgb, label: kapitelLabel.get(String(isl.chapter_id)) || '' });
        }
        ctx.restore();
      }

      // 3) Labels in Bildschirm-Koordinaten: Schicht links, Kapitel über der Insel
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const cHeightCss = ctx.canvas.height / dpr();
      const fs = Math.max(10, Math.min(15, cHeightCss / 65));
      ctx.font = `bold ${fs * dpr()}px ${DEFAULT_FONT.face}`;
      ctx.textBaseline = 'middle';
      for (const { schicht, y } of bands) {
        const domY = network.canvasToDOM({ x: 0, y }).y;
        if (domY < -16 || domY > cHeightCss + 16) continue;
        pill(ctx, bandLabel(schicht), 6 * dpr(), domY * dpr(),
          fs, theme.ink((SCHICHT_COLOR[schicht] || SCHICHT_COLOR.andere).label));
      }
      for (const h of hullTops) {
        if (!h.label) continue;
        const dom = network.canvasToDOM({ x: h.x, y: h.y });
        const tw = ctx.measureText(h.label).width;
        pill(ctx, h.label, dom.x * dpr() - tw / 2 - 6 * dpr(), (dom.y - fs) * dpr(), fs, toCss(h.rgb));
      }
      ctx.restore();
    });

    // 4) Brückenfiguren (mehrere Kapitel): Farbmarke je Kapitel unter dem Knoten.
    if (bridges.size) {
      network.on('afterDrawing', (ctx) => {
        ctx.save();
        const pos = network.getPositions([...bridges.keys()]);
        for (const [id, chapterIds] of bridges) {
          const p = pos[id];
          if (!p) continue;
          const box = network.getBoundingBox(id);
          const y = (box ? box.bottom : p.y + 18) + 4;
          const seg = BRIDGE_W / chapterIds.length;
          chapterIds.forEach((cid, i) => {
            ctx.fillStyle = toCss(islandRgb(kapitelIx.get(String(cid)) ?? 0));
            ctx.fillRect(p.x - BRIDGE_W / 2 + i * seg, y, seg - 1, 5);
          });
        }
        ctx.restore();
      });
    }

    network.once('afterDrawing', () => network.fit({ nodes: figuren.map(f => f.id) }));
    this._attachTooltip(container);
  },
};

const toCssRgb = (rgb) => `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
