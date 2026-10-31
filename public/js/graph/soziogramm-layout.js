// Soziogramm-Layout — reine Berechnung, kein DOM, kein vis.
// Y = Sozialschicht-Band, innerhalb des Bands eine Treppe nach Macht (mächtigste
// oben links). Bänder mit vielen Figuren wachsen in der Höhe, statt die Treppe in
// das Nachbarband laufen zu lassen.

import { SCHICHT_LEVEL } from './constants.js';
import { normalizeRelationTyp, canonicalRelation } from '../book/beziehung-typen.js';

export const LEVEL_Y_GAP  = 190;                    // Mittenabstand zweier Standard-Bänder
export const NODE_X_GAP   = 210;
export const BAND_HALF    = LEVEL_Y_GAP * 0.45;     // halbe Standard-Bandhöhe
const BAND_GAP     = LEVEL_Y_GAP - 2 * BAND_HALF;   // Luft zwischen zwei Bändern
const STAIR_SPAN   = LEVEL_Y_GAP * 0.60;            // Treppenhöhe, die ein Standard-Band fasst
const NODE_PAD     = BAND_HALF - STAIR_SPAN / 2;    // Rand über/unter der Treppe (Knotenhöhe)
const MIN_STEP     = 12;
const MAX_STEP     = 34;

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

export function computeSoziogrammLayout(figuren) {
  const power = powerScores(figuren);
  const groups = new Map();   // level → Figuren
  for (const f of figuren) {
    const lev = SCHICHT_LEVEL[schichtOf(f)];
    if (!groups.has(lev)) groups.set(lev, []);
    groups.get(lev).push(f);
  }
  for (const g of groups.values()) g.sort((a, b) => power.get(b.id) - power.get(a.id));

  // Bandhälfte je Ebene: Standard, oder so viel, wie die Treppe braucht.
  const step = (cnt) => (cnt > 1 ? Math.max(MIN_STEP, Math.min(MAX_STEP, STAIR_SPAN / (cnt - 1))) : 0);
  const maxLev = Math.max(...groups.keys());
  const halfOf = (lev) => {
    const cnt = groups.get(lev)?.length || 0;
    return Math.max(BAND_HALF, ((cnt - 1) * step(cnt)) / 2 + NODE_PAD);
  };
  // Leere Ebenen behalten ihre Standardhöhe — die Lücke zeigt die fehlende Schicht.
  const centerY = new Map([[0, 0]]);
  for (let lev = 1; lev <= maxLev; lev++) {
    centerY.set(lev, centerY.get(lev - 1) + halfOf(lev - 1) + BAND_GAP + halfOf(lev));
  }

  const posById = new Map();
  const bands = [];
  for (const [lev, group] of [...groups].sort((a, b) => a[0] - b[0])) {
    const cnt = group.length, dy = step(cnt), y0 = centerY.get(lev);
    group.forEach((f, idx) => {
      const rank = idx - (cnt - 1) / 2;   // idx 0 = mächtigste → links oben
      posById.set(f.id, { x: rank * NODE_X_GAP, y: y0 + rank * dy });
    });
    // Teilen sich «andere» und eine echte Schicht die Ebene, trägt die echte das Band.
    const schicht = group.map(schichtOf).find(s => s !== 'andere') || 'andere';
    bands.push({ schicht, y: y0, half: halfOf(lev) });
  }
  return { posById, bands, power };
}
