// Verlauf über die Monate (Tagebuch-Rückblick, Ansicht «Verlauf»): Personen,
// Orte oder Themen als Zeilen, die Monate mit gespeichertem Rückblick als
// Spalten, je Zelle die Zahl der Belegtage. Daten fertig zusammengeführt vom
// Server (GET /history/rueckblick-verlauf, routes/jobs/rueckblick-facets.js
// #buildRueckblickVerlauf) — kein KI-Call. Klick auf eine Zelle öffnet den
// Monat und zeigt die Belege des Eintrags.

import { fetchJson, localeTag, tzOpts } from '../utils.js';
import { isSelectedBook } from '../cards/book-guard.js';
import { quartileLevelFor } from './ymheatmap.js';

// Mehr Zeilen zeigt die Ansicht nicht auf einmal — die Suche grenzt ein.
export const VERLAUF_MAX_ROWS = 30;
export const VERLAUF_FACETS = Object.freeze(['personen', 'orte', 'themen']);

// Pure: Zeilen der Matrix für eine Facette. Stufe je Zelle = Anteil der
// Belegtage an den Einträgen des Monats (Quartile über alle Zellen der Facette),
// damit ein schreibstarker Monat nicht alles überstrahlt.
export function computeVerlaufRows(verlauf, facet, query = '', maxRows = VERLAUF_MAX_ROWS) {
  const months = verlauf?.months || [];
  const items = verlauf?.[facet] || [];
  const q = String(query || '').trim().toLowerCase();
  const hit = (it) => !q || [it.name, ...(it.aliase || [])].some(n => String(n || '').toLowerCase().includes(q));
  const filtered = items.filter(hit);
  const share = (it, m) => {
    const n = it.perMonth?.[m.zeitraum] || 0;
    return n && m.entries ? n / m.entries : n;
  };
  const levelFor = quartileLevelFor(filtered.flatMap(it => months.map(m => share(it, m))));
  const rows = filtered.slice(0, maxRows).map(it => ({
    name: it.name,
    aliase: it.aliase || [],
    total: it.total,
    cells: months.map(m => {
      const n = it.perMonth?.[m.zeitraum] || 0;
      return { zeitraum: m.zeitraum, n, level: n ? Math.max(1, levelFor(share(it, m))) : 0 };
    }),
  }));
  return { months, rows, more: Math.max(0, filtered.length - rows.length) };
}

export const rueckblickVerlaufMethods = {
  async loadRueckblickVerlauf() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.rbVerlauf = null; return; }
    try {
      const data = await fetchJson('/history/rueckblick-verlauf/' + bookId);
      if (!isSelectedBook(bookId)) return;
      this.rbVerlauf = data;
    } catch (e) {
      if (!isSelectedBook(bookId)) return;
      console.error('[loadRueckblickVerlauf]', e);
      this.rbVerlauf = null;
    }
  },

  // Verlauf lohnt erst ab zwei Monaten mit Rückblick (Coverage zählt sie).
  rbHasVerlauf() {
    const months = this.rbCoverage?.months || {};
    let n = 0;
    for (const k of Object.keys(months)) if (months[k]?.rueckblick && ++n >= 2) return true;
    return false;
  },

  rbVerlaufRows() {
    return this._memo('verlaufRows', [this.rbVerlauf, this.rbVerlaufFacet, this.rbVerlaufSearch],
      () => computeVerlaufRows(this.rbVerlauf, this.rbVerlaufFacet, this.rbVerlaufSearch));
  },

  // Spaltenkopf: «Aug 16» — Monat kurz + zweistelliges Jahr.
  rbVerlaufMonthLabel(z) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(z || ''));
    if (!m) return String(z || '');
    const d = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, 15, 12));
    try {
      return d.toLocaleDateString(localeTag(Alpine.store('shell').uiLocale),
        tzOpts({ month: 'short', year: '2-digit', timeZone: 'UTC' }));
    } catch { return String(z); }
  },

  rbVerlaufCellTip(row, cell) {
    const app = window.__app;
    return `${row.name} · ${this.zeitraumLabel(cell.zeitraum)}: ${app.tn('rueckblick.verlauf.days', cell.n)}`;
  },

  rbVerlaufMoreLabel(n) {
    return window.__app.tn('rueckblick.verlauf.moreRows', n);
  },

  // Zelle → Monat öffnen und das Stichwort mit seinen Belegen aufklappen.
  async openVerlaufCell(row, cell) {
    if (!cell?.n || this.rueckblickLoading) return;
    const entry = this._latestEntryFor(cell.zeitraum);
    if (!entry) return;
    await this.openRueckblickHistory(entry);
    if (this.selectedRueckblickId !== entry.id) return;
    const facet = this.rbVerlaufFacet;
    const nameKey = facet === 'themen' ? 'label' : 'name';
    const keys = new Set([row.name, ...row.aliase].map(n => String(n || '').trim().toLowerCase()));
    const item = (this.rueckblickResult?.[facet] || []).find(it =>
      [it[nameKey], ...(it.aliase || [])].some(n => keys.has(String(n || '').trim().toLowerCase())));
    if (!item) return;
    if (facet !== 'themen' && (item.haeufigkeit || 0) <= 1) this.rbFacetMore = { ...this.rbFacetMore, [facet]: true };
    this.toggleBeleg(`${facet}:${item[nameKey]}`, item[nameKey], item.belege, item.aliase);
  },
};
