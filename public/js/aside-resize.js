// Breite der Leiste eines `.aside-split` per Griff (layout/aside-split.css).
//
//   <div class="aside-split" x-aside-resize :class="{ 'aside-split--on': offen }">
//
// Die Direktive hängt den Griff an das Split-Element; die CSS setzt ihn an die
// Spaltengrenze und zeigt ihn nur, solange die Leiste daneben steht. Eine
// Breite für alle Leisten: der Griff schreibt `--aside-w-user` auf <html>,
// gespeichert in localStorage('aside-width'). Ohne Eintrag gilt die `--aside-w`
// des Splits (Default bzw. `-wide`). Grenzen nur in tokens/spacing.css
// (`--aside-w-min/-max`); die CSS deckelt zusätzlich auf 50vw. Wie beim
// Seitenbaum wird nach jedem Setzen die gerenderte Breite zurückgeschrieben,
// sonst hätte der Rückweg über den vw-Deckel hinaus eine tote Zone.
import { bindColumnResize } from './column-resize.js';
import { lsGet, lsSet, lsRemove } from './safe-storage.js';

const KEY = 'aside-width';
const VAR = '--aside-w-user';

const root = () => document.documentElement;
const token = (name) => parseFloat(getComputedStyle(root()).getPropertyValue(name));

// Gerenderte Breite der Leistenspalte: letzte Spur des Rasters.
function measure(split) {
  const cols = getComputedStyle(split).gridTemplateColumns.split(' ');
  const w = parseFloat(cols[cols.length - 1]);
  return cols.length > 1 && Number.isFinite(w) ? Math.round(w) : 0;
}

export function registerAsideResize() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  const saved = parseInt(lsGet(KEY), 10);
  if (Number.isFinite(saved)) root().style.setProperty(VAR, saved + 'px');

  window.Alpine.directive('aside-resize', (split, _dir, { evaluateLater, effect }) => {
    if (split.querySelector(':scope > .aside-split-handle')) return;
    const MIN = token('--aside-w-min');
    const MAX = token('--aside-w-max');
    const set = (w) => root().style.setProperty(VAR, Math.max(MIN, Math.min(MAX, Math.round(w))) + 'px');

    const handle = document.createElement('div');
    handle.className = 'aside-split-handle';
    // Reaktiv: index.html initialisiert die Direktive vor dem Laden der Locale.
    const label = evaluateLater("$app.t('aside.resizeHandle')");
    effect(() => label(v => handle.setAttribute('aria-label', v)));
    split.appendChild(handle);

    bindColumnResize(handle, {
      min: MIN,
      max: MAX,
      grow: -1,
      measure: () => measure(split),
      apply: (w) => {
        set(w);
        const actual = measure(split);
        if (actual > 0) root().style.setProperty(VAR, actual + 'px');
      },
      persist: () => {
        const cur = parseInt(root().style.getPropertyValue(VAR), 10);
        if (Number.isFinite(cur)) lsSet(KEY, String(cur));
      },
      reset: () => {
        root().style.removeProperty(VAR);
        lsRemove(KEY);
      },
    });
  });
}
