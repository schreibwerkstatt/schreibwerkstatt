// Vergleich zweier Fassungen — Methods-Modul, eingespreadet in snapshotsCard
// (Geschwister zu snapshots-pdf-export.js). Buch-Level-Diff via
// book-snapshot-diff.js, pro geänderter Seite lazy ein Wort-Diff via
// page-revision-diff.js#renderSideBySide, dazu der Publikations-Metadaten-Diff.
// State (compareFrom/compareTo/diff/pubDiff/expanded/…) + der geteilte
// _fetchSnapshot-Cache leben im Haupt-Objekt (snapshots-card.js).

import { loadDiff } from '../lazy-libs.js';
import { renderSideBySide } from '../page-revision-diff.js';
import { diffSnapshots, diffPublication } from '../book-snapshot-diff.js';

export const snapshotsCompareMethods = {
  canCompare() {
    return this.compareFrom && this.compareTo && this.compareFrom !== this.compareTo;
  },

  sameSelection() {
    return !!this.compareFrom && this.compareFrom === this.compareTo;
  },

  // Combobox-Wechsel: den frisch gewaehlten Wert EXPLIZIT aus dem Event-Detail
  // uebernehmen, statt auf die (asynchrone) x-modelable-Propagation zu warten.
  // Sonst rechnet runCompare() im selben Tick noch mit dem alten Wert (Race) →
  // Diff passt nicht zur angezeigten Auswahl.
  onCompareChange(which, val) {
    const v = val == null ? '' : String(val);
    if (which === 'from') this.compareFrom = v;
    else this.compareTo = v;
    this.runCompare();
  },

  async runCompare() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !this.canCompare()) { this.diff = null; this.pubDiff = []; this.diffError = ''; return; }
    this.diffLoading = true;
    this.diffError = '';
    this.diff = null;
    this.pubDiff = [];
    this.expanded = {};
    this.expandLoading = {};
    try {
      const [a, b] = await Promise.all([
        this._fetchSnapshot(bookId, this.compareFrom),
        this._fetchSnapshot(bookId, this.compareTo),
      ]);
      const fromContent = a?.content;
      const toContent = b?.content;
      if (!fromContent || !toContent) throw new Error('SNAPSHOT_NOT_FOUND');
      this.diff = diffSnapshots(fromContent, toContent);
      // Publikations-Metadaten-Diff (Titelei/ISBN/Cover …) — die Felder, die der
      // Inhalts-Diff nicht sieht.
      this.pubDiff = diffPublication(a?.publication, b?.publication);
    } catch (e) {
      console.error('[snapshots:compare]', e);
      this.diffError = e.message || 'compare failed';
    } finally {
      this.diffLoading = false;
    }
  },

  // ── Publikations-Metadaten-Diff (Anzeige) ──────────────────────────────────────
  pubFieldLabel(key) {
    return window.__app.t('snapshots.pub.' + key);
  },

  // Anzeigewert einer Diff-Zelle: Bool → Vorhanden/—, ausgetauschtes Bild →
  // Vorhanden/Ersetzt, Text → Wert oder „—".
  pubValueDisplay(entry, side) {
    const app = window.__app;
    const v = side === 'from' ? entry.from : entry.to;
    if (entry.kind === 'replaced') return app.t(side === 'from' ? 'snapshots.pub.present' : 'snapshots.pub.replaced');
    if (entry.kind === 'bool') return v ? app.t('snapshots.pub.present') : app.t('snapshots.pub.absent');
    const s = (v == null ? '' : String(v)).trim();
    return s || '—';
  },

  // Sichtbare Diff-Eintraege (unveraenderte standardmaessig ausgeblendet).
  visibleEntries() {
    if (!this.diff) return [];
    if (this.showUnchanged) return this.diff.entries;
    return this.diff.entries.filter(e => e.status !== 'unchanged' || e.renamed || e.moved || e.reordered);
  },

  // Kapitel-Aenderungen (neu/entfernt/umbenannt/verschoben/umsortiert/Export-
  // Ausschluss) — eigene Liste ueber den Abschnitten.
  chapterEntries() {
    return this.diff?.chapters || [];
  },

  chapterTags(c) {
    const app = window.__app;
    const out = [];
    if (c.renamed) out.push(app.t('snapshots.renamedTag', { old: c.oldName }));
    if (c.moved) out.push(app.t('snapshots.movedTag', { from: this.chapterPathLabel(c.oldPath) }));
    if (c.reordered) out.push(app.t('snapshots.reorderedTag'));
    if (c.excludedChanged) out.push(app.t(c.excluded ? 'snapshots.chapters.excludedOn' : 'snapshots.chapters.excludedOff'));
    return out;
  },

  entryKey(entry, idx) {
    return entry.srcId != null ? `s${entry.srcId}` : `i${idx}`;
  },

  statusLabel(entry) {
    const app = window.__app;
    return app.t(`snapshots.status.${entry.status}`);
  },

  chapterPathLabel(path) {
    if (!Array.isArray(path) || !path.length) return window.__app.t('snapshots.topLevel');
    return path.filter(Boolean).join(' › ');
  },

  // Lazy Word-Level-Diff fuer eine Seite (Inhalt-Aenderung).
  async toggleEntry(entry, idx) {
    const key = this.entryKey(entry, idx);
    if (this.expanded[key]) { delete this.expanded[key]; return; }
    // Reine Umbenennung/Verschiebung ohne Inhaltsaenderung: nichts zu rendern.
    if (entry.status === 'unchanged') { this.expanded[key] = ''; return; }
    this.expandLoading[key] = true;
    try {
      const app = window.__app;
      const diffLib = await loadDiff();
      const skipLabel = (n) => app?.t?.('editor.revisions.viewer.diffSkip', { n }) || `… ${n} …`;
      const out = renderSideBySide(entry.fromHtml || '', entry.toHtml || '', diffLib, { skipLabel });
      this.expanded[key] = out.unchanged ? '' : out.html;
    } catch (e) {
      console.error('[snapshots:entryDiff]', e);
      this.expanded[key] = '';
    } finally {
      this.expandLoading[key] = false;
    }
  },
};
