// Bewertungs-Tile: 6 Sterne + Trend-Pfeil zur Vorbewertung.

/** Pure: `gesamtnote` einer Bewertung als Zahl 0..6 — `null`, wenn sie fehlt
 *  oder nicht numerisch ist. Eine fehlende Note ist keine 0: die Kachel zeigt
 *  dann weder Sterne noch Trend, statt sechs leere Sterne als Urteil. */
export function reviewScore(review) {
  const raw = review?.review_json?.gesamtnote;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(6, n)) : null;
}

/** Pure: Trend zwischen zwei Bewertungen in Sternen. `null` ohne zwei Noten
 *  oder bei Gleichstand. */
export function reviewTrend(cur, prev) {
  const a = reviewScore(cur);
  const b = reviewScore(prev);
  if (a == null || b == null) return null;
  const delta = a - b;
  if (Math.abs(delta) < 0.05) return null;
  return { dir: delta > 0 ? 'up' : 'down', delta: Math.round(delta * 10) / 10 };
}

export const reviewMethods = {
  // Note der letzten Bewertung (0..6) oder null (siehe reviewScore).
  overviewReviewScore() {
    return reviewScore(this.overviewLastReview);
  },

  // Sterne-Rendering: gesamtnote 0..6, Score in halbe Sterne aufgelöst.
  overviewStars(score) {
    const s = Math.max(0, Math.min(6, Number(score) || 0));
    const out = [];
    for (let i = 1; i <= 6; i++) {
      if (s >= i) out.push({ full: true });
      else if (s >= i - 0.5) out.push({ half: true });
      else out.push({ empty: true });
    }
    return out;
  },

  // Lokalisierte Note („4,5 / 6") — null ohne Note.
  overviewStarsAriaLabel() {
    const n = this.overviewReviewScore();
    return n == null ? null : `${this._numFmt({ maximumFractionDigits: 1 }).format(n)} / 6`;
  },

  // Zusammenfassung fürs aria-label der Kachel: Titel, Note, Datum, Trend.
  overviewReviewAria() {
    const app = window.__app;
    const parts = [app.t('overview.lastReview')];
    const score = this.overviewStarsAriaLabel();
    parts.push(score ?? app.t('overview.reviewNoScore'));
    const date = app.formatDate?.(this.overviewLastReview?.reviewed_at);
    if (date) parts.push(date);
    const trend = this.overviewReviewTrendDisplay();
    if (trend) parts.push(trend);
    return parts.join(', ');
  },

  // Trend zur Vorbewertung: Delta in Sternen (für Pfeil ↑/↓).
  // Null bei fehlender Note, keiner Vorbewertung ODER bei Gleichstand.
  overviewReviewTrend() {
    return reviewTrend(this.overviewLastReview, this.overviewPrevReview);
  },

  // Fertig formatierter Trend-String (statt Triple-Ternary im Template).
  // up: "↑ +0,5", down: "↓ 0,5" (Zahl lokalisiert). `null` wenn kein Trend → x-show greift.
  overviewReviewTrendDisplay() {
    const t = this.overviewReviewTrend();
    if (!t) return null;
    const arrow = t.dir === 'up' ? '↑ +' : '↓ ';
    return arrow + this._numFmt({ maximumFractionDigits: 1 }).format(Math.abs(t.delta));
  },
};
