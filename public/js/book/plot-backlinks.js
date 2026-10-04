// Gegenrichtung der Plot-Verknuepfung: die Beats AN einer Figur, einem Schauplatz
// oder einer Szene — fuer die Detailansichten von Figuren-, Orte- und Szenen-Karte.
//
// EIN Modul fuer alle drei Karten, Muster ideen-backlinks.js: dieselbe Frage
// („welche geplanten Handlungspunkte haengen hier?"), dieselbe Antwortform. Der
// Lesepfad ist `GET /plot/links?kind=…`, nicht ein Feld am Katalog-Eintrag: Beats
// sind pro (Buch, User) skopiert, der Figuren-/Orte-/Szenen-Katalog nicht.
//
// Kuratiert wird die Kante ausschliesslich im Beat-Edit der Plot-Werkstatt (Szene:
// abgeleitet aus der Beat-Verankerung); hier ist sie read-only mit Sprung aufs
// Board (x-entity-ref, Typ `beat`).
//
// Verwendung in einer Karte:
//   State:   plotBacklinks: {}
//   Init:    ...plotBacklinkMethods  (spread)
//   Laden:   this.loadPlotBacklinks('figure')   // im Lifecycle-load, non-fatal
//   Template: Fragment plot-backlinks mit `x-data="{ beatOwnerId: f.id }"` darueber

import { fetchJson } from '../utils.js';

export const plotBacklinkMethods = {
  /**
   * Map Ziel-ID → Beats fuer EINE Achse holen.
   *
   * NON-FATAL: Reader ohne Editor-Recht bekommen 403 (das Board ist Editor+), ein
   * Buch ohne Plot liefert {}. Beides laesst die Karte ohne Plot-Referenzen stehen.
   */
  async loadPlotBacklinks(kind) {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.plotBacklinks = {}; return; }
    try {
      const data = await fetchJson(`/plot/links?book_id=${bookId}&kind=${kind}`);
      if (Alpine.store('nav').selectedBookId !== bookId) return; // Buch inzwischen gewechselt
      this.plotBacklinks = data?.links || {};
    } catch {
      this.plotBacklinks = {};
    }
  },

  beatsFor(targetId) {
    return (this.plotBacklinks || {})[String(targetId)] || [];
  },

  beatChipTip(beat) {
    const app = window.__app;
    const status = app.t(`plot.status.${beat.status}`);
    return beat.inherited
      ? app.t('plot.backlinks.tipInherited', { status })
      : app.t('plot.backlinks.tip', { status });
  },
};
