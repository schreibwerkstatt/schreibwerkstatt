// Ansichts-Menü der Filterleiste — Verhalten + Zählung für das einzige Markup
// in public/partials/view-menu.html (DESIGN.md „Ansichts-Menü"). Gegated durch
// tests/unit/view-menu-single-place.test.mjs.
//
// Die Filterleiste trägt die häufig benutzten Filter (Suche, Kapitel, Figur …).
// Schalter des Arbeitsmodus — Archiv einblenden, Erledigtes ausblenden, Dichte —
// stellt man selten um; als einzelne Haken füllten sie die Leiste. Sie stehen
// darum gesammelt hinter einem Knopf «Ansicht», dessen Zahl sagt, wie viele
// davon von der Grundansicht abweichen: ein ausgeblendeter Zustand wäre im
// geschlossenen Menü sonst unsichtbar.
//
// Die Karte liefert nur Daten — `viewMenuSpec()` im Karten-Scope:
//
//   viewMenuSpec() {
//     return {
//       tip: this.$app.t('…'),           // Tooltip am Knopf: was drin steckt
//       items: [
//         { kind: 'toggle', key: 'archived', label: '…', on: this.showArchived,
//           toggle: () => { this.showArchived = !this.showArchived; } },
//         { kind: 'sep', key: 'sep1' },
//         { kind: 'header', key: 'h1', label: '…' },
//         { kind: 'hint', key: 'hint1', text: '…' },
//       ],
//     };
//   }
//
// Schalter-Felder: `on` (Haken gesetzt), `toggle()`, optional `base` (Zustand
// der Grundansicht, Standard `false` — ein Schalter, der von Haus aus an ist,
// z.B. «Erledigte ausblenden», trägt `base: true`), optional `disabled`,
// optional `tip`, optional `counts: false` für Einstellungen,
// die keine persönliche Ansicht sind (z.B. die Stufen, die ein Buch verwendet).
// Was gerade nicht angeboten wird, lässt die Karte aus der Liste weg — ein
// Archiv-Haken ohne archivierte Einträge zählt so auch nicht mit.
// Schalter halten den Klick an (`.stop` im Partial): das Menü bleibt für den
// nächsten offen.

import { menuData } from './menu.js';

// Zahl am Knopf: zählende Schalter, die nicht im Zustand der Grundansicht stehen.
export function viewMenuChangeCount(items) {
  if (!Array.isArray(items)) return 0;
  return items.filter(it => it?.kind === 'toggle' && it.counts !== false
    && !!it.on !== !!it.base).length;
}

// Kein `{ ...menuData() }`: der Spread werte die Getter `trigger`/`panel` sofort
// mit dem Rohobjekt als `this` aus — der Klick toggelte dann ein nicht-reaktives
// `open`, das Panel ginge nie auf. Darum ans unveränderte Objekt anhängen.
export function viewMenuData() {
  return Object.assign(menuData(), {
    changeCount(spec) { return viewMenuChangeCount(spec?.items); },
  });
}

export function registerViewMenu() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('viewMenu', () => viewMenuData());
}
