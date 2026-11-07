import { graphPlaceholder } from '../graph-kit.js';
import { BZ } from './constants.js';
import { familyEdges, familyLevels, familyComponents, familyPositions, packFamilies } from './family-layout.js';

// Familienbaum: Generationen und x-Lage aus den Daten (Eltern oben, Geschwister und
// Ehepartner auf einer Ebene, Paare nebeneinander über ihren Kindern, siehe
// ./family-layout.js); vis zeichnet nur. Danach werden die einzelnen Familien als
// Raster gepackt — nebeneinander in einer Reihe wären sie bei vielen kleinen
// Familien nach `fit()` winzig und weit auseinander.
export const familiengraphMethods = {
  _renderFamiliengraph(container) {
    const figuren = this._graphFiguren();
    const { edgeList } = this._buildEdges(/* soziogrammModus */ false);
    const theme = this._theme();
    const kindStyle = {
      color: { color: theme.ink(BZ.kind.color), highlight: theme.ink(BZ.kind.highlight) },
      // Pfeil zum Kind: im Baum von oben nach unten liest er sich als Abstammung.
      arrows: 'to', dashes: BZ.kind.dashes,
    };
    const famEdges = familyEdges(edgeList, kindStyle);
    if (!famEdges.length) {
      graphPlaceholder(container, window.__app.t('graph.empty.familie'));
      return;
    }
    const familyIds = new Set();
    for (const e of famEdges) { familyIds.add(e.from); familyIds.add(e.to); }
    const famFiguren = figuren.filter(f => familyIds.has(f.id));
    const ids = famFiguren.map(f => f.id);
    const levels = familyLevels(ids, famEdges);

    const packed = packFamilies(familyPositions(ids, famEdges, levels), familyComponents(ids, famEdges), {
      aspect: Math.max(0.8, (container.offsetWidth || 800) / (container.offsetHeight || 500)),
      nodeW: 180,
    });

    const nodes = new vis.DataSet(famFiguren.map(f => ({ ...this._baseNode(f), ...packed[f.id] })));
    const edges = new vis.DataSet(famEdges);
    this._figurenNodes = nodes;
    this._figurenEdges = edges;

    this._figurenNetwork = new vis.Network(container, { nodes, edges }, {
      physics: false,
      layout: { improvedLayout: false },
      interaction: { hover: true, tooltipDelay: 100 },
      edges: { smooth: { type: 'cubicBezier', forceDirection: 'vertical', roundness: 0.4 } },
    });
    // Erst nach dem ersten Zeichnen einpassen: vorher hat der Canvas noch nicht
    // seine endgültige Grösse, und die äussere Spalte würde angeschnitten.
    const network = this._figurenNetwork;
    network.once('afterDrawing', () => network.fit());
    this._attachTooltip(container);
  },
};
