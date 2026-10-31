// Drift-Check der Fassungen-Karte: „lohnt sich seit der letzten Fassung eine neue?"
// In snapshotsCard gespreadet (LOC-Split, analog snapshots-pdf-export.js /
// snapshots-compare.js). Kein Getter (Spread-Getter-Falle) — nur Methoden; der
// zugehoerige State (drift/driftLoading/driftDismissed) lebt im Karten-Initializer.
//
// Vergleicht den aktuellen Buchstand serverseitig (GET …/drift) mit der juengsten
// Fassung: Text-Wort-Diff + Publikations-/Einstellungs-Felder. Wegklickbar; der
// Hinweis kommt erst wieder, wenn sich die Drift-Signatur aendert.

import { fetchJson } from '../utils.js';
import { isSelectedBook } from './book-guard.js';

export const snapshotsDriftMethods = {
  // Best-effort: bei Fehler bleibt der Hinweis einfach aus.
  async loadDrift(bookId) {
    if (!bookId || !this.snapshots.length) { this.drift = null; return; }
    this.driftLoading = true;
    try {
      const drift = await fetchJson(`/snapshots/${bookId}/drift`);
      if (!isSelectedBook(bookId)) return;
      this.drift = drift;
    } catch (e) {
      console.error('[snapshots:drift]', e);
      if (!isSelectedBook(bookId)) return;
      this.drift = null;
    } finally {
      this.driftLoading = false;
    }
    // Weggeklickt-Zustand aus localStorage: nur verbergen, solange die gespeicherte
    // Signatur mit der aktuellen uebereinstimmt. Hat sich seit dem Wegklicken etwas
    // geaendert (mehr Text, neue/entfernte Seiten, Publikations-/Einstellungs-
    // Aenderung, neue Baseline), unterscheidet sich die Signatur → Hinweis kommt wieder.
    this.driftDismissed = this.hasDrift()
      && this._driftDismissKey() === this._readDriftDismiss(bookId);
  },

  // Kompakte Signatur des aktuellen Drift-Stands. Aendert sich, sobald sich am Buch
  // relativ zur juengsten Fassung etwas Messbares tut.
  _driftDismissKey() {
    if (!this.hasDrift()) return '';
    const d = this.drift.drift;
    const t = d.text;
    return [
      this.drift.baseline?.id ?? '',
      t.changePct, t.changedPages, t.addedPages, t.removedPages, this._driftStructureCount(),
      d.publicationChanged ? 1 : 0, d.settingsChanged ? 1 : 0, d.bookChanged ? 1 : 0,
    ].join(':');
  },

  _dismissStorageKey(bookId) {
    return `sw:snapshotDrift:dismissed:${bookId}`;
  },

  _readDriftDismiss(bookId) {
    try { return window.localStorage.getItem(this._dismissStorageKey(bookId)) || ''; }
    catch { return ''; }
  },

  // Hinweis wegklicken: aktuelle Signatur merken, bis sich etwas aendert.
  dismissDrift() {
    const bookId = Alpine.store('nav').selectedBookId;
    this.driftDismissed = true;
    try { window.localStorage.setItem(this._dismissStorageKey(bookId), this._driftDismissKey()); }
    catch { /* localStorage nicht verfuegbar → nur fuer diese Sitzung verborgen */ }
  },

  // Hat die Karte Drift-Daten? (Baseline vorhanden + Buch nicht leer.)
  hasDrift() {
    return !!(this.drift && this.drift.hasBaseline && this.drift.drift);
  },

  // Wird der Hinweis-Block angezeigt? (Daten vorhanden + nicht weggeklickt.)
  showDrift() {
    return this.hasDrift() && !this.driftDismissed;
  },

  // „Empfiehlt sich eine neue Fassung?"
  driftWorthwhile() {
    return !!this.drift?.drift?.worthwhile;
  },

  // Gliederungs-Aenderungen in Summe: umbenannte/verschobene/umsortierte
  // Abschnitte + Kapitel neu/entfernt/geaendert.
  _driftStructureCount() {
    const s = this.drift?.drift?.structure;
    if (!s) return 0;
    return s.renamedPages + s.movedPages + s.reorderedPages
      + s.chaptersAdded + s.chaptersRemoved + s.chaptersChanged;
  },

  // Kurz-Fazit fuer den Hinweis-Kopf. Nennt die Baseline-Fassung — nach einem
  // Restore ist das die wiederhergestellte, nicht die juengste.
  driftHeadline() {
    const app = window.__app;
    if (!this.hasDrift()) return '';
    const d = this.drift.drift;
    const n = this.drift.baseline?.seq ?? '';
    return this.driftWorthwhile()
      ? app.t('snapshots.drift.worthwhile', { n, pct: this.formatNum(d.text.changePct) })
      : app.t('snapshots.drift.notYet', { n, pct: this.formatNum(d.text.changePct), threshold: d.thresholdPct });
  },

  // Detail-Tags (nur zutreffende): Text-Anteil, Seiten neu/geaendert/entfernt,
  // Gliederung, Buchtitel/Publikation/Einstellungen geaendert.
  driftItems() {
    if (!this.hasDrift()) return [];
    const app = window.__app;
    const d = this.drift.drift;
    const out = [];
    out.push({ key: 'text', text: app.t('snapshots.drift.text', { pct: this.formatNum(d.text.changePct) }) });
    if (d.text.changedPages) out.push({ key: 'changed', text: app.t('snapshots.drift.changedPages', { n: this.formatNum(d.text.changedPages) }) });
    if (d.text.addedPages) out.push({ key: 'added', text: app.t('snapshots.drift.addedPages', { n: this.formatNum(d.text.addedPages) }) });
    if (d.text.removedPages) out.push({ key: 'removed', text: app.t('snapshots.drift.removedPages', { n: this.formatNum(d.text.removedPages) }) });
    const structure = this._driftStructureCount();
    if (structure) out.push({ key: 'structure', text: app.t('snapshots.drift.structure', { n: this.formatNum(structure) }) });
    if (d.bookChanged) out.push({ key: 'book', text: app.t('snapshots.drift.book') });
    if (d.publicationChanged) out.push({ key: 'pub', text: app.t('snapshots.drift.publication', { n: this.formatNum(d.publicationFields.length) }) });
    if (d.settingsChanged) out.push({ key: 'settings', text: app.t('snapshots.drift.settings', { n: this.formatNum(d.settingsFields.length) }) });
    return out;
  },
};
