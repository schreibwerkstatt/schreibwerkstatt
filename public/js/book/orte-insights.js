// Schauplatz-Auswertung (deterministisch, kein KI-Call): Präsenz-Streifen pro Ort
// über die Kapitel, Spannen-Hinweis («ab Kapitel X nicht mehr Schauplatz») und
// Begegnungen (welche Figuren sich hier in derselben Szene treffen).
//
// Quellen sind der geladene Katalog: o.kapitel [{ name, haeufigkeit }] und die
// Szenen (s.ort_ids, s.fig_ids). Methoden werden in Alpine.data('orteCard')
// gespreadet; die reinen Compute-Funktionen sind exportiert → ohne Alpine testbar.

// Spannen-Schwellen bewusst gleich wie die Schauplatz-Nutzung im Erzählprofil
// (lib/narrative-report.js#NARRATIVE_REPORT_THRESHOLDS), damit Karte und Befund
// denselben Ort als «aufgegeben» melden.
const MIN_CHAPTERS_FOR_SPAN = 6;
const FIRST_FRACTION = 1 / 3;
const LAST_FRACTION = 1 / 2;

// Präsenz eines Orts auf der Kapitelachse `chapterOrder` (Namen in Lesereihenfolge).
export function computeOrtPresence(ort, chapterOrder) {
  const chapters = chapterOrder || [];
  const n = chapters.length;
  const col = new Map(chapters.map((name, i) => [name, i]));
  const haeByCol = new Array(n).fill(0);
  for (const k of (ort?.kapitel || [])) {
    const c = col.get(k.name);
    if (c != null) haeByCol[c] += (k.haeufigkeit || 1);
  }
  let firstIdx = -1, lastIdx = -1, maxCell = 0, count = 0;
  for (let i = 0; i < n; i++) {
    if (haeByCol[i] > 0) {
      if (firstIdx < 0) firstIdx = i;
      lastIdx = i;
      count++;
      if (haeByCol[i] > maxCell) maxCell = haeByCol[i];
    }
  }
  if (count === 0) return null;
  const abandoned = n >= MIN_CHAPTERS_FOR_SPAN && count >= 2
    && firstIdx < Math.ceil(n * FIRST_FRACTION) && lastIdx < Math.ceil(n * LAST_FRACTION);
  return {
    chapters, haeByCol, firstIdx, lastIdx, maxCell, count,
    abandoned, lastChapter: chapters[lastIdx],
  };
}

// Figuren am Ort mit Szenenzahl + Paare, die sich hier in derselben Szene treffen.
// Nur aktive (nicht verwaiste) Szenen zählen.
export function computeOrtEncounters(ortId, szenen) {
  const figCount = new Map();
  const pairCount = new Map();
  let sceneCount = 0;
  for (const s of (szenen || [])) {
    if (s.stale || !(s.ort_ids || []).includes(ortId)) continue;
    sceneCount++;
    const figs = [...new Set(s.fig_ids || [])].sort();
    for (const f of figs) figCount.set(f, (figCount.get(f) || 0) + 1);
    for (let i = 0; i < figs.length; i++) {
      for (let j = i + 1; j < figs.length; j++) {
        const key = figs[i] + '\u0000' + figs[j];
        pairCount.set(key, (pairCount.get(key) || 0) + 1);
      }
    }
  }
  const figures = [...figCount].map(([id, scenes]) => ({ id, scenes }))
    .sort((a, b) => b.scenes - a.scenes || String(a.id).localeCompare(String(b.id)));
  const pairs = [...pairCount].map(([key, scenes]) => {
    const [a, b] = key.split('\u0000');
    return { a, b, scenes };
  }).sort((x, y) => y.scenes - x.scenes).slice(0, 5);
  return { sceneCount, figures, pairs };
}

export const orteInsightMethods = {
  ortPresence(o) {
    const order = window.__app.orteKapitelListe();
    return this._memo('ortPresence:' + o.id, [o, order], () => computeOrtPresence(o, order));
  },

  ortEncounters(o) {
    const szenen = Alpine.store('catalog').szenen;
    return this._memo('ortEnc:' + o.id, [o.id, szenen], () => computeOrtEncounters(o.id, szenen));
  },

  // Zellfarbe wie der Figuren-Präsenz-Streifen (figuren-presence.js): Sockel 12 %,
  // Skala relativ zum stärksten Kapitel dieses Orts.
  ortPresenceCellVars(hae, maxCell) {
    if (!hae || !maxCell) return {};
    const t = Math.min(1, 0.12 + 0.6 * (hae / maxCell));
    return { '--heatmap-t': Math.round(t * 100) + '%' };
  },
};
