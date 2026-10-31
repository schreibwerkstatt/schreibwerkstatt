// Lade-Skelett (selbst-rendernd) — der eine Baustein für „Inhalt kommt gleich".
//
// Graue, schimmernde Platzhalter an der Stelle einer Liste oder eines
// Kachel-Rasters, solange der erste Datensatz noch unterwegs ist. Das Markup
// rendert die Direktive selbst; das Element trägt nur Sichtbarkeit und Form:
//
//   <div x-show="cardLoading && items.length === 0" x-skeleton="6" x-cloak
//        class="entity-list--accented"></div>
//
//   <div x-show="cardLoading && !kdHeat" x-skeleton.tiles="3"></div>
//
// - Ausdruck = Anzahl Platzhalter (Default 6 Zeilen bzw. 3 Kacheln).
// - Ohne Modifier: Listen-Zeilen (`.entity-skeleton-row`, Anker/Titel/Meta).
//   `entity-list--accented` am Element gibt den Zeilen den Karten-Akzent.
// - `.tiles`: `.overview-tile`-Platzhalter. Der Wrapper ist `display: contents`,
//   die Kacheln werden direkte Kinder des umgebenden `.overview-grid`.
// - Bedingung „wann" bleibt am Element (`x-show`): wer lädt, weiss die Karte.
//   Für Karten mit `setupCardLifecycle` steht dafür `cardLoading` bereit.
//
// Gegated: tests/unit/skeleton-single-place.test.mjs — das Zeilen-/Kachel-
// Markup steht nur hier, nie handgeschrieben in einem Partial.
import { tRaw } from './i18n.js';

const ROW = '<div class="entity-skeleton-row">'
  + '<span class="entity-skeleton-cell entity-skeleton-cell--anchor"></span>'
  + '<span class="entity-skeleton-cell entity-skeleton-cell--title"></span>'
  + '<span class="entity-skeleton-cell entity-skeleton-cell--meta"></span>'
  + '</div>';

const TILE = '<div class="overview-tile skeleton-tile">'
  + '<span class="entity-skeleton-cell skeleton-tile__label"></span>'
  + '<span class="entity-skeleton-cell skeleton-tile__value"></span>'
  + '<span class="entity-skeleton-cell skeleton-tile__line"></span>'
  + '</div>';

export function skeletonMarkup(kind, count) {
  const n = Math.max(1, Math.min(20, Number(count) || (kind === 'tiles' ? 3 : 6)));
  return (kind === 'tiles' ? TILE : ROW).repeat(n);
}

export function registerSkeleton() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.directive('skeleton', (el, { expression, modifiers }) => {
    const kind = modifiers.includes('tiles') ? 'tiles' : 'rows';
    el.classList.add(kind === 'tiles' ? 'skeleton-tiles' : 'entity-skeleton');
    el.setAttribute('role', 'status');
    el.setAttribute('aria-label', tRaw('common.loading'));
    // Statisch: die Anzahl ist eine Literal-Zahl im Template, kein State.
    el.innerHTML = skeletonMarkup(kind, expression);
  });
}
