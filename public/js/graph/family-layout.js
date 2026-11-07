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
  // Widersprüchliche Daten (A Kind von B und B Kind von A, auch über Umwege):
  // Rückkanten einer Tiefensuche verwerfen, sonst schaukelt der längste Pfad
  // die Ebenen bis zum Iterationsdeckel hoch und Eltern stehen Dutzende Ebenen
  // über ihren Kindern.
  const outPc = new Map();
  for (const [p, c] of pc) { if (!outPc.has(p)) outPc.set(p, []); outPc.get(p).push(c); }
  const state = new Map(), back = new Set();
  const dfs = (g) => {
    state.set(g, 1);
    for (const c of outPc.get(g) || []) {
      if (state.get(c) === 1) back.add(`${g}|${c}`);
      else if (!state.has(c)) dfs(c);
    }
    state.set(g, 2);
  };
  for (const g of groups) if (!state.has(g)) dfs(g);
  for (let i = pc.length - 1; i >= 0; i--) if (back.has(`${pc[i][0]}|${pc[i][1]}`)) pc.splice(i, 1);
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

// Pool-Adjacent-Violators: Zentren in fester Reihenfolge so nah wie möglich an
// `want` (gewichtete Fehlerquadrate), mit Mindestabstand `gaps[i]` zwischen
// Einheit i und i+1. Über die kumulierten Abstände wird daraus eine reine
// Monotonie-Bedingung.
function placeInOrder(want, weight, gaps) {
  const off = [0];
  for (let i = 0; i < gaps.length; i++) off.push(off[i] + gaps[i]);
  const blocks = [];
  for (let i = 0; i < want.length; i++) {
    let b = { sum: (want[i] - off[i]) * weight[i], w: weight[i], n: 1 };
    while (blocks.length && blocks[blocks.length - 1].sum / blocks[blocks.length - 1].w >= b.sum / b.w) {
      const p = blocks.pop();
      b = { sum: p.sum + b.sum, w: p.w + b.w, n: p.n + b.n };
    }
    blocks.push(b);
  }
  const out = [];
  for (const b of blocks) for (let k = 0; k < b.n; k++) out.push(b.sum / b.w + off[out.length]);
  return out;
}

// Positionen je Figur, jede Familie für sich ab x = 0 (danach `packFamilies`).
// Ehepaare (auch Ketten bei mehreren Ehen) bilden eine Einheit und stehen
// nebeneinander. Reihenfolge je Ebene per Barycenter (Mittel der Lage von Eltern
// bzw. Kindern), dann x so, dass jede Einheit möglichst mittig über ihren Kindern
// und unter ihren Eltern steht — ohne Überlappung, Reihenfolge bleibt.
export function familyPositions(ids, edges, levels, opts = {}) {
  const comp = familyComponents(ids, edges);
  const groups = new Map();
  for (const id of ids) {
    const c = comp.get(id);
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(id);
  }
  const out = {};
  for (const members of groups.values()) Object.assign(out, layoutFamily(members, edges, levels, opts));
  return out;
}

function layoutFamily(ids, edges, levels, { nodeSep = 180, levelSep = 120, rounds = 24 } = {}) {
  const key = (id) => String(id);
  const byKey = new Map(ids.map(id => [key(id), id]));
  const lv = (k) => levels.get(byKey.get(k)) ?? 0;
  const spouse = new Map(), kin = new Map(), sib = new Map();
  const add = (m, a, b) => { if (!m.has(a)) m.set(a, []); m.get(a).push(b); };
  for (const e of edges) {
    const a = key(e.from), b = key(e.to);
    if (!byKey.has(a) || !byKey.has(b) || a === b) continue;
    if (e.typ === 'ehepartner' && lv(a) === lv(b)) { add(spouse, a, b); add(spouse, b, a); }
    else if (e.typ === 'geschwister') { add(sib, a, b); add(sib, b, a); }
    else if (e.typ === 'kind') { add(kin, a, b); add(kin, b, a); }
  }
  // Gemeinsame Eltern eines Kindes gehören nebeneinander, auch ohne erfasste Ehe.
  for (const [k, nb] of kin) {
    const parents = nb.filter(p => lv(p) < lv(k));
    for (let i = 1; i < parents.length; i++) {
      const a = parents[i - 1], b = parents[i];
      if (lv(a) !== lv(b) || (spouse.get(a) || []).includes(b)) continue;
      add(spouse, a, b); add(spouse, b, a);
    }
  }

  // Einheiten: Ehe-Ketten, Mitglieder als Pfad (Ende mit Grad 1 zuerst).
  const unitOf = new Map();
  const units = [];
  for (const k of byKey.keys()) {
    if (unitOf.has(k)) continue;
    const comp = [], stack = [k], seen = new Set([k]);
    while (stack.length) {
      const x = stack.pop(); comp.push(x);
      for (const y of spouse.get(x) || []) if (!seen.has(y)) { seen.add(y); stack.push(y); }
    }
    const start = comp.find(x => (spouse.get(x) || []).length <= 1) ?? comp[0];
    const members = [], done = new Set();
    const walk = (x) => {
      if (done.has(x)) return;
      done.add(x); members.push(x);
      for (const y of spouse.get(x) || []) walk(y);
    };
    walk(start);
    const u = { members, level: lv(k), x: 0 };
    for (const m of members) unitOf.set(m, u);
    units.push(u);
  }
  const width = (u) => u.members.length * nodeSep;
  const memberX = (u, m) => u.x + (u.members.indexOf(m) - (u.members.length - 1) / 2) * nodeSep;
  const nodeX = (k) => memberX(unitOf.get(k), k);
  const rel = (u, pick) => u.members.flatMap(m => (kin.get(m) || []).filter(n => pick(unitOf.get(n).level, u.level)));

  // Startreihenfolge: Tiefensuche über alle Kanten, Familienzweige bleiben beisammen.
  const order = new Map();
  let n = 0;
  const visit = (u) => {
    if (order.has(u)) return;
    order.set(u, n++);
    const next = u.members.flatMap(m => [...(sib.get(m) || []), ...(kin.get(m) || [])]);
    for (const k of next) visit(unitOf.get(k));
  };
  [...units].sort((a, b) => a.level - b.level).forEach(visit);

  const maxLevel = Math.max(0, ...units.map(u => u.level));
  const rows = Array.from({ length: maxLevel + 1 }, () => []);
  for (const u of units) rows[u.level].push(u);
  const sortRow = (row) => row.sort((a, b) => order.get(a) - order.get(b));
  const layoutRow = (row) => {
    let x = 0;
    row.forEach((u, i) => { if (i) x += (width(row[i - 1]) + width(u)) / 2; u.x = x; });
  };
  rows.forEach(r => { sortRow(r); layoutRow(r); });

  // Barycenter-Sweeps für die Reihenfolge.
  for (let s = 0; s < 6; s++) {
    const down = s % 2 === 0;
    const seq = down ? rows.slice(1) : rows.slice(0, -1).reverse();
    for (const row of seq) {
      const bc = new Map(row.map(u => {
        const nb = rel(u, down ? (l, ul) => l < ul : (l, ul) => l > ul);
        return [u, nb.length ? nb.reduce((sum, k) => sum + nodeX(k), 0) / nb.length : u.x];
      }));
      row.sort((a, b) => bc.get(a) - bc.get(b) || order.get(a) - order.get(b));
      row.forEach((u, i) => order.set(u, i));
      layoutRow(row);
    }
  }

  // x-Feinlage: jede Einheit zum Mittel ihrer Eltern und Kinder ziehen.
  for (let s = 0; s < rounds; s++) {
    const seq = s % 2 === 0 ? rows : [...rows].reverse();
    for (const row of seq) {
      if (!row.length) continue;
      const want = [], weight = [];
      for (const u of row) {
        const nb = rel(u, (l, ul) => l !== ul);
        // Mitglied-Offset herausrechnen: der Elternteil links im Paar zieht die
        // Paarmitte, nicht sich selbst, zum Kind.
        const pulls = u.members.flatMap(m => (kin.get(m) || [])
          .filter(k => unitOf.get(k).level !== u.level)
          .map(k => nodeX(k) - (memberX(u, m) - u.x)));
        want.push(pulls.length ? pulls.reduce((a, b) => a + b, 0) / pulls.length : u.x);
        weight.push(nb.length ? nb.length : 0.1);
      }
      const gaps = row.slice(1).map((u, i) => (width(row[i]) + width(u)) / 2);
      placeInOrder(want, weight, gaps).forEach((x, i) => { row[i].x = x; });
    }
  }

  const out = {};
  for (const [k, id] of byKey) out[id] = { x: nodeX(k), y: lv(k) * levelSep };
  return out;
}
