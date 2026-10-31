// Liste schrittweise rendern — der eine Baustein für Karten-Listen, die bei
// grossen Büchern tausend Zeilen tragen (Ereignisse, Schauplätze).
//
// Eine Zeile mit Entitäts-Referenzen, Badges und Bindings kostet Alpine einige
// Millisekunden; tausend davon blockieren beim Öffnen der Karte Sekunden lang den
// Main-Thread. Darum rendert die Liste nur ein Fenster vom Anfang her und wächst
// beim Scrollen nach: am Listenende steht ein «Weitere anzeigen»-Knopf, den
// `x-list-more` automatisch auslöst, sobald er in die Nähe des Sichtfelds kommt.
// Der Knopf bleibt sichtbar und klickbar — Tastatur und Rückfall, falls der
// Observer nicht greift.
//
//   <template x-for="o in listWindowed(orteFiltered)" :key="o.id">…</template>
//   <button type="button" class="btn-compact list-window-more"
//           x-show="listWindowRest(orteFiltered) > 0" x-cloak
//           x-list-more="listWindowMore()" @click="listWindowMore()"
//           x-text="$app.t('common.showMore', { n: listWindowRest(orteFiltered) })"></button>
//
// Gruppierte Listen (Weltfakten nach Kategorie) bekommen ein Fenster je Gruppe:
// alle Methoden nehmen optional einen Schlüssel (`listWindowed(g.fakten, g.kategorie)`),
// der Knopf steht dann am Ende jeder Gruppe. Ohne Schlüssel gilt das eine
// Fenster der Karte.
//
// Pflicht für jeden Sprung in eine Zeile (Deep-Link, Auswahl, Band-Klick):
// vorher `listWindowReveal(index)` — eine Zeile hinter dem Fenster steht nicht im
// DOM, ein Scroll dorthin liefe ins Leere. Die Karte spreadet `listWindowState()`
// (optional mit eigener Schrittweite) in ihren Initial-State und
// `listWindowMethods` in ihre Methoden; Buchwechsel setzt die Fenster über
// `resetState` zurück (`listWindowState()` erneut).

export const LIST_WINDOW_STEP = 150;

// Fenstergrösse, damit `index` enthalten ist — auf ganze Schritte gerundet.
export function listWindowSizeFor(index, current, step = LIST_WINDOW_STEP) {
  if (!(index >= 0) || index < current) return current;
  return (Math.floor(index / step) + 1) * step;
}

export function listWindowState(step = LIST_WINDOW_STEP) {
  return { listWindowStep: step, listWindowSizes: {} };
}

// `listWindowSizes` wird nur neu zugewiesen, nie in place geändert: ein
// `resetState`-Literal der Karte teilt sonst sein Objekt mit dem Live-State und
// brächte beim nächsten Reset die alten Fenster zurück.
export const listWindowMethods = {
  listWindowSize(key = '') {
    return this.listWindowSizes[key] ?? this.listWindowStep;
  },
  listWindowed(list, key = '') {
    const l = list || [];
    const n = this.listWindowSize(key);
    return l.length > n ? l.slice(0, n) : l;
  },
  listWindowRest(list, key = '') {
    return Math.max(0, (list?.length || 0) - this.listWindowSize(key));
  },
  listWindowMore(key = '') {
    this.listWindowSizes = { ...this.listWindowSizes, [key]: this.listWindowSize(key) + this.listWindowStep };
  },
  listWindowReveal(index, key = '') {
    const cur = this.listWindowSize(key);
    const next = listWindowSizeFor(index, cur, this.listWindowStep);
    if (next !== cur) this.listWindowSizes = { ...this.listWindowSizes, [key]: next };
  },
};

// Vorlauf, ab dem nachgeladen wird: rund eine Bildschirmhöhe vor dem Listenende,
// damit beim zügigen Scrollen keine Lücke aufgeht.
const ROOT_MARGIN = '0px 0px 800px 0px';

export function registerListWindow() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.directive('list-more', (el, { expression }, { evaluateLater, cleanup }) => {
    if (typeof IntersectionObserver === 'undefined') return;
    const more = evaluateLater(expression);
    let frame = 0;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some(e => e.isIntersecting)) return;
      more();
      // Steht der Knopf nach dem Nachladen noch im Vorlauf (kurze Zeilen), meldet
      // der Observer keinen neuen Wechsel — neu beobachten erzwingt eine Meldung.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { io.unobserve(el); io.observe(el); });
    }, { rootMargin: ROOT_MARGIN });
    io.observe(el);
    cleanup(() => { cancelAnimationFrame(frame); io.disconnect(); });
  });
}
