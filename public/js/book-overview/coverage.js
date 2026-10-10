// Lektorat-Coverage-Donut + Top-Fehler-Bars.
export const coverageMethods = {
  // Geprüfte / gesamte Abschnitte, geklemmt: `checked_pages` zählt Prüfungen aus
  // page_checks, `total_pages` die Abschnitte mit Stats — hinkt page_stats nach
  // (neue Abschnitte ohne Abgleich), stünde sonst „12 / 10 geprüft" da.
  overviewCoverageCounts() {
    const cov = this.overviewCoverage;
    const total = Math.max(0, Number(cov?.total_pages) || 0);
    const checked = Math.min(total, Math.max(0, Number(cov?.checked_pages) || 0));
    return { checked, total };
  },

  // Donut-Math für Coverage-Ring. Stroke-Dasharray-Approach: kein <path>-Arc nötig.
  // CIRC = 2π·r — 100% = vollständig sichtbarer Stroke.
  overviewCoverageRing() {
    const cov = this.overviewCoverage;
    return this._memo('coverageRing', [cov], () => {
      const pct = Math.max(0, Math.min(100, cov?.pct ?? 0));
      const r = 28;
      const c = 2 * Math.PI * r;
      return { r, c, dash: (pct / 100) * c, gap: c - (pct / 100) * c, pct };
    });
  },

  overviewCoverageMeta() {
    const { checked, total } = this.overviewCoverageCounts();
    return window.__app.t('overview.coverageMeta', { checked: this._fmtNum(checked), total: this._fmtNum(total) });
  },

  overviewTopFehler() {
    const heat = this.overviewHeat;
    return this._memo('topFehler', [heat], () => {
      const totals = heat?.totals || {};
      const arr = Object.entries(totals)
        .map(([typ, count]) => ({ typ, count }))
        .filter(e => e.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 3);
      if (arr.length === 0) return arr;
      const max = arr[0].count;
      return arr.map(e => ({ ...e, pct: Math.max(8, Math.round((e.count / max) * 100)) }));
    });
  },

  // aria-label der Top-Fehler-Kachel: Titel + die Typen mit Anzahl — das
  // aria-label ersetzt den Inhalt der role=button-Kachel für Screenreader.
  overviewTopFehlerAria() {
    const parts = this.overviewTopFehler().map(e => `${this.tileFehlerLabel(e.typ)} ${this._fmtNum(e.count)}`);
    return window.__app.t('overview.topErrors') + (parts.length ? ': ' + parts.join(', ') : '');
  },
};
