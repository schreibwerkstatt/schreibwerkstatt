// Plot-Board-Tile: Snapshot des Beat-Boards (Akte/Stränge/Beats + Status-
// Verteilung + Drift-Warnung). Datenquelle: /plot?book_id → { acts, threads,
// beats }, jeder Beat mit status/verworfen/occ_count. Rein abgeleitet, kein
// KI-Job. Reader ohne Editor-Recht bekommen den Teil als `forbidden` → overviewPlot=null
// → Tile via x-if aus (siehe load.js).
import { classifyBeatAnchor, beatAnchorKnown } from '../book/plot/constants.js';

export const plotMethods = {
  // True, sobald das Buch ein Beat-Board mit Inhalt hat (Akte oder Beats).
  overviewHasPlot() {
    const p = this.overviewPlot;
    if (!p) return false;
    return (Array.isArray(p.acts) && p.acts.length > 0)
        || (Array.isArray(p.beats) && p.beats.length > 0);
  },

  // Snapshot-Aggregat: Zählungen + Status-Verteilung (aktive Beats) + Drift.
  // „Verworfen" ist die orthogonale Verwerfen-Achse (eigenes Segment); geplant/
  // im_buch zählen nur aktive Beats. Drift = als `im_buch` markiert, aber ohne
  // Fundstelle im Text (classifyBeatAnchor) — das Gesundheitssignal des Tiles.
  overviewPlotStats() {
    const p = this.overviewPlot;
    return this._memo('plotStats', [p], () => {
      const acts = Array.isArray(p?.acts) ? p.acts : [];
      const threads = Array.isArray(p?.threads) ? p.threads : [];
      const beats = Array.isArray(p?.beats) ? p.beats : [];
      const by = { geplant: 0, im_buch: 0, verworfen: 0 };
      let drift = 0, confirmed = 0;
      // Nie verankert → keine Drift-Warnung (0 Fundstellen hiesse „nie gesucht").
      const anchored = beatAnchorKnown(p?.beatAnchor, beats);
      for (const b of beats) {
        if (b.verworfen) { by.verworfen++; continue; }
        if (b.status === 'im_buch') by.im_buch++;
        else by.geplant++;
        const cls = classifyBeatAnchor(b.status, b.occ_count, b.verworfen, anchored);
        if (cls === 'drift') drift++;
        else if (cls === 'confirmed') confirmed++;
      }
      return {
        acts: acts.length,
        threads: threads.length,
        beats: by.geplant + by.im_buch, // aktive Beats (ohne verworfen)
        by,
        drift,
        confirmed,
      };
    });
  },
};
