// Soziogramm: Relaxation entlang X bei fester Y-Lage — rein, kein DOM, kein vis.
// Y trägt die Schicht (und darin die Macht), also bewegt sich jede Figur nur
// waagrecht. Drei Kräfte:
//   - Federn je Beziehung: Ruhelänge aus der Nähe (nah = kurz). Die Länge gilt im
//     Raum, nicht nur waagrecht — zwei Figuren in weit getrennten Schichten
//     erreichen eine kurze Ruhelänge nie und werden darum übereinander gezogen.
//   - Abstossung nur zwischen Knoten, die sich sonst überdecken (gleiche Zeile,
//     näher als `minDx`). Sortiert nach X, also nahezu linear statt O(n²).
//   - Anker: Zug zur Kapitel-Insel (bzw. schwach zur Mitte), damit Figuren ohne
//     Beziehung nicht wegtreiben.
// Deterministisch: gleiche Eingabe, gleiches Bild (kein Zufall, feste Schrittzahl).

/**
 * @param {Array<{ x: number, y: number, anchor: number, anchorK: number }>} nodes — x wird verändert
 * @param {Array<{ a: number, b: number, len: number, k: number }>} springs — Indizes in `nodes`
 * @param {{ iterations?: number, minDx?: number, rowDy?: number, repulse?: number, maxStep?: number }} [opts]
 */
export function relaxX(nodes, springs, {
  iterations = 300, minDx = 175, rowDy = 44, repulse = 0.5, maxStep = 60,
} = {}) {
  const n = nodes.length;
  if (!n) return nodes;
  const fx = new Float64Array(n);
  const order = nodes.map((_, i) => i);

  const pushApart = (strength) => {
    order.sort((i, j) => (nodes[i].x - nodes[j].x) || (i - j));
    for (let p = 0; p < n; p++) {
      const i = order[p];
      for (let q = p + 1; q < n; q++) {
        const j = order[q];
        const dx = nodes[j].x - nodes[i].x;
        if (dx >= minDx) break;
        if (Math.abs(nodes[j].y - nodes[i].y) >= rowDy) continue;
        const push = strength * (minDx - dx) / 2;
        fx[i] -= push;
        fx[j] += push;
      }
    }
  };

  for (let t = 0; t < iterations; t++) {
    fx.fill(0);
    for (const s of springs) {
      const A = nodes[s.a], B = nodes[s.b];
      const dx = B.x - A.x, dy = B.y - A.y;
      const d = Math.hypot(dx, dy) || 1e-6;
      const f = s.k * (d - s.len) * (dx / d);
      fx[s.a] += f;
      fx[s.b] -= f;
    }
    pushApart(repulse);
    const cool = 1 - (t / iterations) * 0.85;
    for (let i = 0; i < n; i++) {
      const nd = nodes[i];
      fx[i] += nd.anchorK * (nd.anchor - nd.x);
      const step = Math.max(-maxStep, Math.min(maxStep, fx[i])) * cool;
      nd.x += step;
    }
  }

  // Abschluss: nur noch Überdeckungen auflösen, damit kein Label auf einem anderen liegt.
  for (let t = 0; t < 400; t++) {
    fx.fill(0);
    pushApart(1);
    let moved = false;
    for (let i = 0; i < n; i++) {
      if (fx[i]) { nodes[i].x += fx[i]; moved = true; }
    }
    if (!moved) break;
  }
  return nodes;
}
