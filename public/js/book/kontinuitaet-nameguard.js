// Namens-/Konsistenz-Waechter der Kontinuitäts-Karte (in kontinuitaetMethods
// gespreadet, book/kontinuitaet.js). Regelbasierte Erkennung buchweiter
// Schreibvarianten/Tippfehler von Eigennamen (Figuren + Orte); synchroner Endpunkt,
// kein KI-Job.

import { fetchJson } from '../utils.js';
import { isSelectedBook } from '../cards/book-guard.js';

export const nameGuardMethods = {
  // ── Namens-/Konsistenz-Waechter ────────────────────────────────────────────
  // Regelbasierte Erkennung buchweiter Schreibvarianten/Tippfehler von Eigennamen
  // (Figuren + Orte). Synchroner Endpunkt, kein KI-Job. Auf Knopfdruck.
  // Das Ergebnis trägt seine bookId mit: nameGuardIgnore schreibt die Ignore-Liste
  // des Buchs, zu dem der Cluster gehört, nicht des gerade gewählten.
  async nameGuardRun() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.nameGuardLoading) return;
    this.nameGuardLoading = true;
    try {
      const data = await fetchJson('/name-guard/' + bookId + '/check', { method: 'POST' });
      if (!isSelectedBook(bookId)) return;
      this.nameGuardResult = { ...data, bookId };
      this.selectedNameGuardKey = null;
    } catch (e) {
      if (!isSelectedBook(bookId)) return;
      console.error('[nameGuardRun]', e);
      this.nameGuardResult = { clusters: [], error: true, bookId };
    } finally {
      // Nach Buchwechsel hat der Reset nameGuardLoading schon zurückgesetzt.
      if (isSelectedBook(bookId)) this.nameGuardLoading = false;
    }
  },

  nameGuardKey(cluster) {
    return 'ng:' + (cluster?.canonical || '');
  },

  // Cluster-Zeile auf-/zuklappen (Klick + Enter/Space).
  nameGuardToggle(cluster) {
    const key = this.nameGuardKey(cluster);
    this.selectedNameGuardKey = this.selectedNameGuardKey === key ? null : key;
  },

  nameGuardConfidenceSeverity(conf) {
    // Auf die bestehende severity-tag-Farbskala mappen (Farbe = Aufmerksamkeit):
    // hohe Konfidenz = stark hervorgehoben.
    return conf === 'hoch' ? 'kritisch' : (conf === 'mittel' ? 'mittel' : 'niedrig');
  },

  // Eine Variante als gewollt akzeptieren → serverseitige Ignore-Liste + lokal entfernen.
  async nameGuardIgnore(cluster, variant) {
    const result = this.nameGuardResult;
    const bookId = result?.bookId;
    if (!bookId || !cluster || !variant || !isSelectedBook(bookId)) return;
    try {
      await fetchJson('/name-guard/' + bookId + '/ignore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canonical: cluster.canonical, variant: variant.form }),
      });
      // Gespeichert ist es; die lokale Liste nur anfassen, wenn sie noch dieses Ergebnis zeigt.
      if (!isSelectedBook(bookId) || this.nameGuardResult !== result) return;
      cluster.variants = (cluster.variants || []).filter(v => v.form !== variant.form);
      if (!cluster.variants.length && this.nameGuardResult?.clusters) {
        this.nameGuardResult.clusters = this.nameGuardResult.clusters.filter(c => c !== cluster);
      }
    } catch (e) {
      console.error('[nameGuardIgnore]', e);
    }
  },
};
