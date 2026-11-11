// Ansicht der Mindmap: Einpassen, Zoom, Auf-/Zuklappen, Touch-Pan, Knoten-
// Markierung für den Karten-Look.
//
// jsMind kennt kein „Einpassen". Zwei Eigenheiten stehen dem im Weg und werden
// hier an der Instanz (nicht im Vendor-File) geradegezogen:
//   1. `expand_size` setzt die Zeichenfläche auf mindestens Panel-Grösse in
//      UNGEZOOMTEN Pixeln. Unter 100 % ist die gezoomte Fläche dann kleiner als
//      das Panel, die Map klebt oben links. `_patchExpandSize` rechnet die
//      Mindestgrösse durch den Zoom, so bleibt sie mittig.
//   2. `set_zoom` verweigert jedes Herauszoomen, sobald die Map ins Panel passt
//      — auch den einen Schritt, der sie gerade erst passend macht.
//      `_applyZoom` setzt den Zoom darum selbst (dieselben drei Schritte wie
//      jsMind: Kinder-`zoom`, `_show`, Scroll).
// Die Knöpfe und Strg/Cmd+Mausrad gehen weiter über jsMinds eigenes zoom_in/
// zoom_out; dessen Sperre ist dann richtig: unter „alles sichtbar" lohnt kein
// weiterer Schritt.

const FIT_MAX = 1;          // Einpassen vergrössert nie über 100 %
const ZOOM_MIN = 0.25;
const START_DEPTH = 2;      // Startansicht: Wurzel + zwei Ebenen offen

// Ebene als Attribut: '0' Wurzel, '1' Hauptzweig, 'n' alles darunter. Setzt der
// Render-Hook (mindmap.js#_buildJmConfig) VOR jsMinds Grössenmessung — die
// Ebene darf darum auch Schrift/Abstand ändern. Ein Umhängen rendert nur den
// bewegten Knoten neu; seine Kinder bleiben dabei immer in 'n'.
export function depthAttr(node) {
  let d = 0;
  for (let p = node?.parent; p; p = p.parent) d++;
  return d > 1 ? 'n' : String(d);
}

export function patchJmView(jm) {
  const view = jm?.view;
  if (!view || view._swPatched) return;
  view._swPatched = true;
  view.expand_size = function expandSizeZoomAware() {
    const min = this.layout.get_min_size();
    const z = this.zoom_current || 1;
    const w = min.w + 2 * this.opts.hmargin;
    const h = min.h + 2 * this.opts.vmargin;
    this.size.w = Math.max(w, this.e_panel.clientWidth / z);
    this.size.h = Math.max(h, this.e_panel.clientHeight / z);
  };
}

// Zielzoom, bei dem die ganze sichtbare Map ins Panel passt (max. 100 %).
function _fitZoom(view) {
  const min = view.layout.get_min_size();
  const w = min.w + 2 * view.opts.hmargin;
  const h = min.h + 2 * view.opts.vmargin;
  const pw = view.e_panel.clientWidth;
  const ph = view.e_panel.clientHeight;
  if (!w || !h || !pw || !ph) return 1;
  return Math.max(ZOOM_MIN, Math.min(FIT_MAX, pw / w, ph / h));
}

function _applyZoom(view, z) {
  view.zoom_current = z;
  for (const child of view.e_panel.children) child.style.zoom = z;
  view.expand_size();
  view._show();
}

// Scrollt so, dass die Mitte der Map in der Panel-Mitte liegt.
function _centerContent(view) {
  const z = view.zoom_current || 1;
  const p = view.e_panel;
  p.scrollLeft = Math.max(0, (view.size.w * z - p.clientWidth) / 2);
  p.scrollTop = Math.max(0, (view.size.h * z - p.clientHeight) / 2);
}

// Rohe jsMind-Instanz: über den Alpine-Proxy kämen Knoten als Proxys zurück,
// jsMinds Identitätsvergleiche (Auswahl, Edit, Layout) schlügen fehl.
function _raw(jm) {
  return jm && window.Alpine?.raw ? window.Alpine.raw(jm) : jm;
}

export const mindmapViewMethods = {
  // Zoom so, dass alles Sichtbare ins Panel passt, dann zentrieren.
  fitMindmap() {
    const view = _raw(this._jm)?.view;
    if (!view?.e_panel) return;
    try {
      _applyZoom(view, _fitZoom(view));
      _centerContent(view);
    } catch {}
  },

  zoomMindmap(dir) {
    const view = _raw(this._jm)?.view;
    if (!view) return;
    try { dir > 0 ? view.zoom_in() : view.zoom_out(); } catch {}
  },

  expandAllMindmap() {
    const jm = _raw(this._jm);
    if (!jm) return;
    try { jm.expand_all(); this.fitMindmap(); } catch {}
  },

  // Wurzel + erste Ebene bleiben sichtbar (collapse_all klappt alles ausser
  // der Wurzel zu — die Hauptzweige stehen dann noch da).
  collapseAllMindmap() {
    const jm = _raw(this._jm);
    if (!jm) return;
    try {
      jm.collapse_all();
      const sel = jm.get_selected_node?.();
      if (sel && !jm.layout.is_visible(sel)) this._selectNodeQuiet(jm.get_root().id);
      this.fitMindmap();
    } catch {}
  },

  // Startansicht nach dem Mount: Ebene 1–2 offen, tiefer zu. Auf-/Zuklappen
  // feuert in jsMind kein Edit-Event — die Figur wird dadurch nicht dirty.
  _applyStartView() {
    const jm = _raw(this._jm);
    if (!jm) return;
    try { jm.expand_to_depth(START_DEPTH); } catch {}
    this._tagMindmapNodes();
    this.fitMindmap();
  },

  // Macht einen (evtl. eingeklappten) Knoten sichtbar: alle Vorfahren auf.
  _revealNode(id) {
    const jm = _raw(this._jm);
    const n = id && jm?.get_node?.(id);
    if (!n) return;
    const chain = [];
    for (let p = n.parent; p; p = p.parent) chain.unshift(p);
    for (const p of chain) if (!p.expanded) { try { jm.expand_node(p); } catch {} }
  },

  // Karten-Look: Seite (links/rechts der Wurzel) als Attribut, für die
  // Akzentleiste zur Wurzel hin. Die Seite steht erst nach dem Layout fest,
  // darum hier statt im Render-Hook; der Akzent ist ein Inset-Schatten und
  // ändert die schon gemessene Knotengrösse nicht.
  _tagMindmapNodes() {
    const nodes = _raw(this._jm)?.mind?.nodes;
    if (!nodes) return;
    for (const id in nodes) {
      const n = nodes[id];
      const el = n._data?.view?.element;
      if (el) el.dataset.side = n.direction === -1 ? 'left' : 'right';
    }
  },

  // Ein-Finger-Pan auf der leeren Fläche (jsMinds eigenes Ziehen kennt nur die
  // Maus; das Panel hat overflow:hidden, damit das Mausrad die Seite scrollt).
  // Auf einem Knoten startet stattdessen das Umhängen (Drag-Plugin) bzw. der
  // Long-Press des Knoten-Menüs.
  _attachTouchPan(container, signal) {
    let last = null;
    const panel = () => _raw(this._jm)?.view?.e_panel;
    container.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1 || e.target.closest?.('jmnode, jmexpander')) { last = null; return; }
      last = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }, { passive: true, signal });
    container.addEventListener('touchmove', (e) => {
      const p = panel();
      if (!last || !p || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = last.x - t.clientX;
      const dy = last.y - t.clientY;
      const canX = p.scrollWidth > p.clientWidth;
      const canY = p.scrollHeight > p.clientHeight;
      if (!canX && !canY) return;     // nichts zu schieben: Seite scrollt
      e.preventDefault();
      p.scrollBy(dx, dy);
      last = { x: t.clientX, y: t.clientY };
    }, { passive: false, signal });
    const end = () => { last = null; };
    container.addEventListener('touchend', end, { passive: true, signal });
    container.addEventListener('touchcancel', end, { passive: true, signal });
  },
};
