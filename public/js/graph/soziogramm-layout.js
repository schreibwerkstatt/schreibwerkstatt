// Soziogramm-Layout — reine Berechnung, kein DOM, kein vis.
//
// Zwei Achsen, zwei Arten von Abstand:
//   Y = gesellschaftlicher Abstand. Jede Schicht ein Band (Reihenfolge
//       SCHICHT_LEVEL, «andere» als eigenes Band «ohne Angabe» darunter). Im Band
//       Zeilen nach Macht, die Mächtigsten oben; eine volle Schicht wächst in die
//       Höhe statt in die Breite (sonst wird das Bild ein schmaler Streifen, in dem
//       nach dem Einpassen kein Name mehr lesbar ist).
//   X = Nähe. Jede Beziehung ist eine Feder, deren Ruhelänge aus der emotionalen
//       Nähe kommt (book/beziehung-typen.js#naeheOf: eingeschätzter Wert, sonst
//       Typ-Standard). Begegnungen in Szenen ohne erfasste Beziehung ziehen schwach.
// Kapitel-Inseln: sind die Kapitel eigene Welten (die meisten Figuren kommen nur
// in einem Kapitel vor), bekommt jedes Kapitel eine Insel auf der X-Achse, zu der
// seine Figuren gezogen werden; wer in mehreren Kapiteln steht, liegt dazwischen.
// Bei durchgehenden Figuren (fortlaufender Roman, viele Kapitel) entfallen die
// Inseln — dort trägt der Kapitel-Filter.

import { SCHICHT_LEVEL } from './constants.js';
import { normalizeRelationTyp, canonicalRelation, naeheOf } from '../book/beziehung-typen.js';
import { relaxX } from './soziogramm-force.js';

export const LEVEL_Y_GAP = 190;                // Mittenabstand zweier Bänder
export const BAND_HALF   = LEVEL_Y_GAP * 0.45; // halbe Bandhöhe
export const ROW_GAP     = 62;                 // Abstand zweier Zeilen im Band (zweizeilige Knoten mit Geburtsjahr)
export const MAX_ROWS    = 6;
export const NODE_W      = 175;                // Mindestabstand zweier Knoten derselben Zeile
const ROW_DY             = 56;                 // darunter überdecken sich zwei Knoten
const ISLAND_GAP         = 320;                // Luft zwischen zwei Inseln
const PER_ROW_TARGET     = 3;                  // Figuren je Zeile, ab denen eine Gruppe eine weitere Zeile bekommt
const ROW_PAD            = 32;                 // Rand über/unter der obersten/untersten Zeile (Knotenhöhe)

// Ruhelänge je Nähe (−2 … +2): nah = kurz, feindselig = weit.
export const NAEHE_LEN = { 2: 110, 1: 170, 0: 250, [-1]: 360, [-2]: 480 };
const SPRING_K     = 0.06;
export const BEGEGNUNG_MIN = 2;                // gemeinsame Szenen, ab denen eine Begegnung zählt
const BEGEGNUNG_LEN = 220;
const BEGEGNUNG_K   = 0.015;

// Inseln nur, wenn sie etwas zeigen: 2–12 Kapitel, und die Mehrheit der Figuren
// mit Kapitelangabe steht in genau einem Kapitel.
export const ISLAND_MAX_CHAPTERS = 12;
const ISLAND_MIN_LOCAL_SHARE = 0.5;
const ANCHOR_K_ISLAND = 0.02;
const ANCHOR_K_CENTER = 0.002;

// Unbekannte Werte (Tippfehler, ältere Analysen) zählen als «andere» — sonst
// bekäme das Band einen rohen i18n-Key als Beschriftung.
export const schichtOf = (f) =>
  (f.sozialschicht && Object.hasOwn(SCHICHT_LEVEL, f.sozialschicht) ? f.sozialschicht : 'andere');

// Macht je Figur. `machtverhaltnis > 0` an einer Beziehung von A zu B heisst: B
// dominiert. Beide Seiten zählen (A verliert, B gewinnt), damit eine nur bei
// einer Figur erfasste Beziehung auch die andere einordnet; eine von beiden
// Seiten erfasste Beziehung zählt einmal (Paar + kanonischer Typ).
export function powerScores(figuren) {
  const byId = new Map(figuren.map(f => [String(f.id), f]));
  const score = new Map(figuren.map(f => [f.id, 0]));
  const seen = new Set();
  for (const f of figuren) {
    for (const bz of (f.beziehungen || [])) {
      const target = byId.get(String(bz.figur_id));
      const m = Number(bz.machtverhaltnis) || 0;
      if (!target || !m) continue;
      const { typ } = canonicalRelation(f.id, target.id, normalizeRelationTyp(bz.typ).typ);
      const key = [String(f.id), String(target.id)].sort().join('|') + '|' + typ;
      if (seen.has(key)) continue;
      seen.add(key);
      score.set(f.id, score.get(f.id) - m);
      score.set(target.id, score.get(target.id) + m);
    }
  }
  return score;
}

/** Nähe je ungeordnetem Figurenpaar (Mittel über alle Beziehungen des Paars). */
export function pairNaehe(figuren) {
  const ids = new Set(figuren.map(f => String(f.id)));
  const acc = new Map();   // key → { a, b, sum, n }
  for (const f of figuren) {
    for (const bz of (f.beziehungen || [])) {
      const to = String(bz.figur_id);
      const from = String(f.id);
      if (!ids.has(to) || to === from) continue;
      const [a, b] = from < to ? [from, to] : [to, from];
      const key = a + '|' + b;
      const e = acc.get(key) || { a, b, sum: 0, n: 0 };
      e.sum += naeheOf(bz).wert;
      e.n++;
      acc.set(key, e);
    }
  }
  return new Map([...acc].map(([k, e]) => [k, { a: e.a, b: e.b, naehe: Math.round(e.sum / e.n) }]));
}

/** Paare, die sich in mindestens `min` Szenen begegnen, ohne eine erfasste Beziehung.
 *  `szenen`: [{ fig_ids: [...] }] aus dem Szenen-Katalog. */
export function begegnungenOf(figuren, szenen, relationPairs, min = BEGEGNUNG_MIN) {
  const ids = new Set(figuren.map(f => String(f.id)));
  const count = new Map();
  for (const s of (szenen || [])) {
    const fs = [...new Set((s.fig_ids || []).map(String))].filter(id => ids.has(id)).sort();
    for (let i = 0; i < fs.length; i++) {
      for (let j = i + 1; j < fs.length; j++) {
        const key = fs[i] + '|' + fs[j];
        count.set(key, (count.get(key) || 0) + 1);
      }
    }
  }
  const out = [];
  for (const [key, n] of count) {
    if (n < min || relationPairs.has(key)) continue;
    const [a, b] = key.split('|');
    out.push({ a, b, n });
  }
  return out.sort((x, y) => (y.n - x.n) || _cmpId(x.a, y.a) || _cmpId(x.b, y.b));
}

// IDs sind keine Anzeige-Texte: roher Vergleich, deterministisch.
const _cmpId = (a, b) => { const x = String(a), y = String(b); return x < y ? -1 : x > y ? 1 : 0; };

// Kapitel einer Figur auf der Kapitelachse: [{ ix, w }], Gewicht wie im Figurengraph
// (häufige Auftritte ziehen stärker).
function _chaptersOf(f, ixById) {
  const out = [];
  for (const k of (f.kapitel || [])) {
    const ix = ixById.get(String(k.chapter_id));
    if (ix == null || out.some(o => o.ix === ix)) continue;
    out.push({ ix, w: Math.pow(Math.max(1, Number(k.haeufigkeit) || 1), 1.5) });
  }
  return out;
}

/**
 * @param {Array} figuren — wie `window.__app.figuren` (id, sozialschicht, kapitel, beziehungen)
 * @param {object} [opts]
 * @param {Array}  [opts.kapitelOrder] — chapter_ids in Buchreihenfolge
 * @param {boolean}[opts.inseln=true]  — Kapitel-Inseln, wenn die Kapitel eigene Welten sind
 * @param {Array}  [opts.szenen]       — Szenen-Katalog; nur mit `begegnungen: true` wirksam
 * @param {boolean}[opts.begegnungen=false]
 */
export function computeSoziogrammLayout(figuren, {
  kapitelOrder = [], inseln = true, szenen = [], begegnungen = false,
} = {}) {
  const power = powerScores(figuren);
  const levelOf = (f) => SCHICHT_LEVEL[schichtOf(f)];

  // ── Kapitel ────────────────────────────────────────────────────────────────
  const ixById = new Map(kapitelOrder.map((id, i) => [String(id), i]));
  const chOf = new Map(figuren.map(f => [f.id, _chaptersOf(f, ixById)]));
  const withCh = figuren.filter(f => chOf.get(f.id).length);
  const usedIx = [...new Set(withCh.flatMap(f => chOf.get(f.id).map(c => c.ix)))].sort((a, b) => a - b);
  const localShare = withCh.length ? withCh.filter(f => chOf.get(f.id).length === 1).length / withCh.length : 0;
  const inselnAktiv = inseln && usedIx.length >= 2 && usedIx.length <= ISLAND_MAX_CHAPTERS
    && localShare >= ISLAND_MIN_LOCAL_SHARE;
  const primaryOf = (f) => {
    const cs = chOf.get(f.id);
    if (!cs.length) return null;
    return cs.reduce((best, c) => (c.w > best.w || (c.w === best.w && c.ix < best.ix) ? c : best)).ix;
  };

  // ── Gruppen: (Insel, Ebene) → Figuren nach Macht ───────────────────────────
  // Ohne Inseln gibt es eine Gruppe je Ebene; Figuren ohne Kapitel bilden mit
  // Inseln eine eigene Gruppe in der Mitte.
  const groupKey = (f) => `${inselnAktiv ? (chOf.get(f.id).length === 1 ? primaryOf(f) : 'x') : 'all'}|${levelOf(f)}`;
  const groups = new Map();
  for (const f of figuren) {
    const k = groupKey(f);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => (power.get(b.id) - power.get(a.id)) || _cmpId(a.id, b.id));
  }

  // Zeilen je Gruppe: mit wachsender Gruppe bis MAX_ROWS.
  const rowsOf = (cnt) => Math.max(1, Math.min(MAX_ROWS, Math.ceil(cnt / PER_ROW_TARGET)));
  const colsOf = (cnt) => Math.ceil(cnt / rowsOf(cnt));

  // ── Bänder (Y) ─────────────────────────────────────────────────────────────
  const levels = [...new Set(figuren.map(levelOf))].sort((a, b) => a - b);
  const realLevels = levels.filter(l => l !== SCHICHT_LEVEL.andere);
  const maxReal = realLevels.length ? Math.max(...realLevels) : -1;
  // Bandhälfte je Ebene: Standard, oder so viel, wie ihre höchste Gruppe Zeilen braucht.
  const halfOf = new Map();
  for (const [k, g] of groups) {
    const lev = Number(k.slice(k.lastIndexOf('|') + 1));
    const need = ((rowsOf(g.length) - 1) * ROW_GAP) / 2 + ROW_PAD;
    halfOf.set(lev, Math.max(halfOf.get(lev) || BAND_HALF, need));
  }
  // Leere echte Ebenen behalten ihre Standardhöhe (die Lücke zeigt die fehlende
  // Schicht); «ohne Angabe» schliesst direkt an die unterste belegte Schicht an.
  const order = [...Array(maxReal + 1).keys()];
  if (levels.includes(SCHICHT_LEVEL.andere)) order.push(SCHICHT_LEVEL.andere);
  const centerOf = new Map();
  let prevBottom = null;
  for (const lev of order) {
    const half = halfOf.get(lev) || BAND_HALF;
    const y = prevBottom == null ? 0 : prevBottom + (LEVEL_Y_GAP - 2 * BAND_HALF) + half;
    centerOf.set(lev, y);
    prevBottom = y + half;
  }
  const centerY = (lev) => centerOf.get(lev);
  const bands = levels.map(lev => {
    const schicht = Object.keys(SCHICHT_LEVEL).find(s => SCHICHT_LEVEL[s] === lev && s !== 'andere') || 'andere';
    return { schicht, y: centerY(lev), half: halfOf.get(lev) || BAND_HALF };
  });

  // ── Inseln (X-Anker) ───────────────────────────────────────────────────────
  // Breite einer Insel = breiteste ihrer Schicht-Gruppen.
  const islandCenter = new Map();
  if (inselnAktiv) {
    let cursor = 0;
    for (const ix of usedIx) {
      let cols = 1;
      for (const [k, g] of groups) if (k.startsWith(ix + '|')) cols = Math.max(cols, colsOf(g.length));
      const w = cols * NODE_W;
      islandCenter.set(ix, cursor + w / 2);
      cursor += w + ISLAND_GAP;
    }
    const mid = (cursor - ISLAND_GAP) / 2;
    for (const [ix, x] of islandCenter) islandCenter.set(ix, x - mid);
  }
  const anchorOf = (f) => {
    if (!inselnAktiv) return 0;
    const cs = chOf.get(f.id);
    if (!cs.length) return 0;
    const sw = cs.reduce((n, c) => n + c.w, 0);
    return cs.reduce((n, c) => n + c.w * islandCenter.get(c.ix), 0) / sw;
  };

  // ── Startlage: Gruppe als Raster um ihren Anker, Mächtigste oben links ─────
  const idx = new Map();
  const nodes = [];
  for (const g of groups.values()) {
    const cnt = g.length, rows = rowsOf(cnt), cols = colsOf(cnt);
    g.forEach((f, rank) => {
      const row = Math.floor(rank / cols);
      const col = rank % cols;
      const inRow = Math.min(cols, cnt - row * cols);
      const anchor = anchorOf(f);
      idx.set(f.id, nodes.length);
      nodes.push({
        id: f.id,
        x: anchor + (col - (inRow - 1) / 2) * NODE_W,
        y: centerY(levelOf(f)) + (row - (rows - 1) / 2) * ROW_GAP,
        anchor,
        anchorK: inselnAktiv && chOf.get(f.id).length ? ANCHOR_K_ISLAND : ANCHOR_K_CENTER,
      });
    });
  }

  // ── Federn ─────────────────────────────────────────────────────────────────
  // Paar-Schlüssel tragen String-IDs; die Figur-ID selbst kann (Alt-Daten) eine Zahl sein.
  const idxOf = (sid) => idx.get(origId.get(sid));
  const origId = new Map(figuren.map(f => [String(f.id), f.id]));
  const naehe = pairNaehe(figuren);
  const springs = [];
  for (const { a, b, naehe: n } of naehe.values()) {
    const ia = idxOf(a), ib = idxOf(b);
    if (ia == null || ib == null) continue;
    springs.push({ a: ia, b: ib, len: NAEHE_LEN[n] ?? NAEHE_LEN[0], k: SPRING_K });
  }
  const meets = begegnungen ? begegnungenOf(figuren, szenen, new Set(naehe.keys())) : [];
  for (const m of meets) {
    const ia = idxOf(m.a), ib = idxOf(m.b);
    if (ia == null || ib == null) continue;
    springs.push({ a: ia, b: ib, len: BEGEGNUNG_LEN, k: BEGEGNUNG_K * Math.min(m.n, 4) / 2 });
  }

  relaxX(nodes, springs, { minDx: NODE_W, rowDy: ROW_DY, iterations: nodes.length > 400 ? 150 : 300 });

  const posById = new Map(nodes.map(nd => [nd.id, { x: Math.round(nd.x), y: nd.y }]));

  // ── Inseln + Brücken für den Renderer ──────────────────────────────────────
  const islands = [];
  const bridges = new Map();
  if (inselnAktiv) {
    for (const ix of usedIx) {
      const members = figuren.filter(f => chOf.get(f.id).length === 1 && primaryOf(f) === ix).map(f => f.id);
      islands.push({ chapter_id: kapitelOrder[ix], index: ix, members });
    }
    for (const f of figuren) {
      const cs = chOf.get(f.id);
      if (cs.length > 1) bridges.set(f.id, cs.map(c => c.ix).sort((a, b) => a - b).map(i => kapitelOrder[i]));
    }
  }

  return { posById, bands, power, islands, bridges, begegnungen: meets, inseln: inselnAktiv };
}
