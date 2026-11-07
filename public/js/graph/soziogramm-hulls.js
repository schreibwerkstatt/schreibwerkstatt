// Soziogramm: Hüllen der Kapitel-Inseln — rein, kein DOM, kein vis.
// Die Hülle umschliesst die Knoten einer Insel mit Abstand: jeder Knoten wird als
// Kreis mit Radius `pad` abgetastet, darum die konvexe Hülle. Der Renderer rechnet
// sie bei jedem Zeichnen aus den aktuellen Positionen, damit sie gezogenen Knoten folgt.

/** Konvexe Hülle (Andrew's monotone chain), gegen den Uhrzeigersinn, ohne Wiederholung des Starts. */
export function convexHull(points) {
  const pts = [...points].sort((p, q) => (p.x - q.x) || (p.y - q.y));
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Hülle um Punkte mit Abstand `pad` (Knotenbreite ist breiter als hoch: `padX`). */
export function paddedHull(points, pad = 40, { padX = pad, steps = 12 } = {}) {
  const ring = [];
  for (const p of points) {
    for (let s = 0; s < steps; s++) {
      const a = (s / steps) * Math.PI * 2;
      ring.push({ x: p.x + Math.cos(a) * padX, y: p.y + Math.sin(a) * pad });
    }
  }
  return convexHull(ring);
}
