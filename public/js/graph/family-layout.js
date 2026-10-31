// Familienbaum-Layout (rein, ohne vis): Kanten normalisieren, Generationen
// zuweisen, die einzelnen Familien als Raster packen.
//
// Die Beziehungsdaten tragen Eltern-Kind-Kanten in beiden Richtungen
// (`typ` = Rolle von `to`: X –elternteil→ Y heisst «Y ist Elternteil von X»,
// X –kind→ Y heisst «Y ist Kind von X»). Gezeichnet wird einheitlich
// Elternteil → Kind; Geschwister und Ehepartner stehen auf derselben Ebene.

import { canonicalRelation } from '../book/beziehung-typen.js';

export const BLOOD_TYPES = ['elternteil', 'kind', 'geschwister'];
const SAME_LEVEL_TYPES = new Set(['geschwister', 'ehepartner']);

// Familienkanten aus der Graph-Kantenliste: Eltern-Kind als `kind` von Eltern
// zu Kind gedreht (Pfeil/Tooltip bleiben stimmig, `typ` beschreibt weiter die
// Rolle von `to`), Doppelungen aus beiden Perspektiven entfernt. Ehepartner
// kommen nur mit, wenn eine Seite schon über Blutsverwandtschaft im Baum steht —
// ein Paar ohne Familie bleibt draussen.
export function familyEdges(edgeList, kindStyle) {
  const out = [];
  const seen = new Set();
  const blood = new Set();
  for (const e of edgeList) {
    if (!BLOOD_TYPES.includes(e.typ)) continue;
    // Drehung aus der gemeinsamen Regel (beziehung-typen.js); _buildEdges liefert
    // schon kanonisch, rohe Listen (Tests) laufen hier noch einmal durch.
    const { from, to, typ } = canonicalRelation(e.from, e.to, e.typ);
    const edge = typ === 'kind' ? { ...e, ...kindStyle, from, to, typ } : e;
    const key = edge.typ === 'kind'
      ? `k|${edge.from}|${edge.to}`
      : `g|${[String(edge.from), String(edge.to)].sort().join('|')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    blood.add(edge.from); blood.add(edge.to);
    out.push(edge);
  }
  for (const e of edgeList) {
    if (e.typ !== 'ehepartner' || !(blood.has(e.from) || blood.has(e.to))) continue;
    const key = `e|${[String(e.from), String(e.to)].sort().join('|')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function unionFind(ids) {
  const parent = new Map(ids.map(id => [id, id]));
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  return { find, union };
}

// Zusammenhängende Familien: Map id → Komponenten-Schlüssel.
export function familyComponents(ids, edges) {
  const uf = unionFind(ids);
  for (const e of edges) uf.union(e.from, e.to);
  return new Map(ids.map(id => [id, uf.find(id)]));
}

// Generation je Figur (0 = oberste Ebene der jeweiligen Familie).
// Geschwister/Ehepartner werden zu einer Gruppe verschmolzen; zwischen Gruppen
// gilt Kind = Elternteil + 1 (längster Pfad). Wurzeln ohne eigene Eltern
// rutschen danach an ihre Kinder heran — eingeheiratete Grosseltern sollen
// nicht ganz oben über einer fremden Linie schweben. Zyklen in widersprüchlichen
// Daten deckelt die Iterationszahl.
export function familyLevels(ids, edges) {
  const uf = unionFind(ids);
  for (const e of edges) if (SAME_LEVEL_TYPES.has(e.typ)) uf.union(e.from, e.to);
  const groups = [...new Set(ids.map(id => uf.find(id)))];
  const pc = [];
  for (const e of edges) {
    if (e.typ !== 'kind') continue;
    const p = uf.find(e.from), c = uf.find(e.to);
    if (p !== c) pc.push([p, c]);
  }
  const level = new Map(groups.map(g => [g, 0]));
  const cap = groups.length + 1;
  for (let i = 0, changed = true; changed && i < cap; i++) {
    changed = false;
    for (const [p, c] of pc) {
      if (level.get(c) < level.get(p) + 1) { level.set(c, level.get(p) + 1); changed = true; }
    }
  }
  const hasParent = new Set(pc.map(([, c]) => c));
  for (let i = 0, changed = true; changed && i < cap; i++) {
    changed = false;
    for (const g of groups) {
      if (hasParent.has(g)) continue;
      const kids = pc.filter(([p]) => p === g).map(([, c]) => level.get(c));
      if (!kids.length) continue;
      const want = Math.min(...kids) - 1;
      if (want > level.get(g)) { level.set(g, want); changed = true; }
    }
  }
  // Je Familie bei 0 beginnen.
  const comp = familyComponents(ids, edges);
  const minByComp = new Map();
  for (const id of ids) {
    const c = comp.get(id), l = level.get(uf.find(id));
    if (!minByComp.has(c) || l < minByComp.get(c)) minByComp.set(c, l);
  }
  return new Map(ids.map(id => [id, level.get(uf.find(id)) - minByComp.get(comp.get(id))]));
}

// Familien (Komponenten) als Zeilen-Raster packen statt einer langen Reihe.
// `positions`: { id: {x, y} } aus dem Hierarchie-Layout; Rückgabe gleiche Form.
// Zeilenbreite zielt auf das Seitenverhältnis des Containers; grösste Familie
// zuerst, damit die Zeilen gleichmässig füllen.
export function packFamilies(positions, comp, { aspect = 1.6, gap = 80, nodeW = 120, nodeH = 60 } = {}) {
  const boxes = new Map();
  for (const [id, p] of Object.entries(positions)) {
    const c = comp.get(id) ?? comp.get(Number(id)) ?? id;
    const b = boxes.get(c) || { ids: [], x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
    b.ids.push(id);
    b.x0 = Math.min(b.x0, p.x); b.x1 = Math.max(b.x1, p.x);
    b.y0 = Math.min(b.y0, p.y); b.y1 = Math.max(b.y1, p.y);
    boxes.set(c, b);
  }
  const list = [...boxes.values()].map(b => ({ ...b, w: b.x1 - b.x0 + nodeW, h: b.y1 - b.y0 + nodeH }));
  list.sort((a, b) => (b.w * b.h) - (a.w * a.h) || b.ids.length - a.ids.length);
  const area = list.reduce((s, b) => s + (b.w + gap) * (b.h + gap), 0);
  const rowMax = Math.max(Math.sqrt(area * aspect), ...list.map(b => b.w));

  const out = {};
  let x = 0, y = 0, rowH = 0;
  for (const b of list) {
    if (x > 0 && x + b.w > rowMax) { x = 0; y += rowH + gap; rowH = 0; }
    const dx = x + nodeW / 2 - b.x0, dy = y + nodeH / 2 - b.y0;
    for (const id of b.ids) out[id] = { x: positions[id].x + dx, y: positions[id].y + dy };
    x += b.w + gap;
    rowH = Math.max(rowH, b.h);
  }
  return out;
}
