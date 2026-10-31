// Computed-Getter der `lektorat`-Alpine-Root-Komponente.
//
// Export als Property-Descriptor-Map: Alpine-Proxy wrappt das Objekt nach
// `Alpine.data(...)`-Return; Getter-Aufrufe gehen durch den Proxy → Reaktivität
// + Dependency-Tracking funktionieren wie bei inline definierten Gettern.
// Object-Spread (`...getters`) würde Getter zur Spread-Zeit einmalig ausführen
// und als statische Werte kopieren — darum descriptor-basiertes
// `Object.defineProperties`.

import { aggregateLiveBookStats } from '../utils.js';

// Sichtbarkeit einer Leistenkarte als Sicht auf `asideSlot` (app-state.js).
// Lesend wie ein gewoehnliches Flag (Templates, `setupCardLifecycle({ showFlag })`,
// Hash-Router); schreibend belegt `true` die Leiste, `false` raeumt sie nur,
// wenn sie gerade diese Karte zeigt — ein verspaetetes `showChatCard = false`
// schliesst also nie die Referenz, die inzwischen dort steht.
function asideFlag(slot) {
  return {
    enumerable: true,
    configurable: true,
    get() { return this.asideSlot === slot; },
    set(v) {
      if (v) this.asideSlot = slot;
      else if (this.asideSlot === slot) this.asideSlot = null;
    },
  };
}

export const asideFlagDescriptors = {
  showChatCard: asideFlag('chat'),
  showIdeenCard: asideFlag('ideen'),
  showReferenceCard: asideFlag('reference'),
};

export const rootGetterDescriptors = {
  ...asideFlagDescriptors,

  // Splits mit Leiste der Hauptebene (index.html, layout/aside-split.css).
  // Ideen stehen je nach Scope neben dem Editor ('page') oder neben der
  // Kapitelbewertung ('chapter') — ideen-card.js haengt die Karte dafuer um.
  editorAsideOpen: {
    enumerable: true,
    configurable: true,
    get() {
      const slot = this.asideSlot;
      return !!(this.showEditorCard && slot && (slot !== 'ideen' || this.ideenScope === 'page'));
    },
  },
  kapitelAsideOpen: {
    enumerable: true,
    configurable: true,
    get() {
      return !!(this.showKapitelReviewCard && this.asideSlot === 'ideen' && this.ideenScope === 'chapter');
    },
  },

  // Seitenbaum-Spalte: nur angemeldet, nicht fuer das Admin-Konto und nicht
  // ohne ein einziges Buch (der Baum haette nichts zu zeigen). Eine Bedingung
  // fuer Spalte (`.layout--no-sidebar`) und Inhalt (`x-show`), sonst bliebe
  // bei Abweichung eine leere Grid-Spalte stehen.
  hasSidebar: {
    enumerable: true,
    configurable: true,
    get() {
      return !!this.$store.session.currentUser && !this.isAdminOnly
        && !(this.booksLoaded && this.$store.nav.books.length === 0);
    },
  },

  // Sidebar-Σ: identisch zu Hero-Snapshot (overviewLatest) und Server-Total
  // (routes/sync.js#syncBook). Σ per-Seite-Stats — Titel zählen nicht.
  tokTotals: {
    enumerable: true,
    configurable: true,
    get() {
      const ts = this.tokEsts;
      // Cache-Schluessel ist Identitaet UND Eintragszahl. Die Identitaet allein
      // reicht nicht: Pfade, die eine frisch angelegte Seite eintragen, setzen
      // per Index-Assign (`tokEsts[id] = …`) und lassen die Identitaet stehen —
      // ein reiner Ref-Vergleich liefert dort dauerhaft den alten Wert zurueck,
      // im Erstfall inklusive `any: false`, sodass die Σ-Zeile der Sidebar gar
      // nicht erst erscheint. Die Zahl der Eintraege deckt Hinzufuegen und
      // Entfernen ab; geaenderte WERTE kommen ausschliesslich ueber eine
      // Reassignment (Save-Sync, Backfill, Buch-Sync) und damit ueber die
      // Identitaet. Der Zaehler kostet nichts Zusaetzliches — die Aggregation
      // darunter laeuft ohnehin ueber dieselben Keys.
      const size = ts ? Object.keys(ts).length : 0;
      const cache = this._tokTotalsCache;
      if (cache && cache.tokRef === ts && cache.size === size) return cache.value;
      const { chars, words, tok } = aggregateLiveBookStats(ts);
      const value = {
        chars, words, tok,
        normseiten: Math.round((chars / 1500) * 10) / 10,
        any: size > 0,
      };
      this._tokTotalsCache = { tokRef: ts, size, value };
      return value;
    },
  },

  // Der „Zuletzt bearbeitet auf <Gerät>"-Hint, gefiltert gegen den aktuellen
  // Seitenstand. `pageLastEditor` ist der Schnappschuss der letzten loadPage-
  // Antwort; jeder Save dieser Seite — egal welcher Pfad (Editor-Save, Autosave,
  // Konflikt-Auflösung, Lektorat-/Beleg-/Chat-Apply, Todo-Haken, Outbox-Flush) —
  // rückt `currentPage.updated_at` vor und macht den Schnappschuss damit zur
  // Vergangenheit: neuester Schreiber ist dann DIESES Gerät, und dafür sieht
  // `_resolvePageLastEditor` bewusst keinen Hinweis vor.
  //
  // Why abgeleitet statt als Reset in den Save-Pfaden: die Aussage des Banners
  // ist „der neueste Stand dieser Seite kam von Gerät X" — eine Funktion aus
  // (Schnappschuss, aktueller Stand). Als Regel fällt sie an EINER Stelle,
  // während acht Schreibpfade das Feld von Hand nullen müssten und der nächste
  // neue Schreibweg es vergisst. `pageLastEditor` bleibt dadurch die
  // unverfälschte Server-Antwort; nur die Anzeige urteilt über ihre Aktualität.
  pageLastEditorHint: {
    enumerable: true,
    configurable: true,
    get() {
      const le = this.pageLastEditor;
      if (!le) return null;
      const cur = this.currentPage?.updated_at;
      if (cur && le.updated_at && new Date(cur) > new Date(le.updated_at)) return null;
      return le;
    },
  },
};
