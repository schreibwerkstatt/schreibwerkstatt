// Klick-Prädikate für aufklappbare Listenzeilen (Figuren, Schauplätze, Szenen,
// Welt-Fakten, Ereignisse, Recherche — DESIGN.md «Listen-Anriss + aufgeklappte Zeile»).
//
// `isRowBodyClick(ev)`: Klick auf den übrigen Zeilenkörper klappt die Zeile per Maus
// auf/zu. Ausgenommen sind interaktive Kinder (Titel-Knopf, Verweise, Menü-Knopf …)
// und eine aktive Textselektion (ein Markier-Drag endet ebenfalls mit `click`).
// Der Tastaturweg ist der Aufklapp-Knopf `.row-expand`, nicht die Fläche — darum trägt der
// Zeilenkörper kein `.internal-link`.
//
// `isFloatingLayerClick(ev)`: der Klick liegt in einer schwebenden Ebene, die NICHT
// im Formular-DOM hängt, aber zum Bearbeiten gehört — LanguageTool-Popover/-Badge
// (an <body> gehängt), Picker-Popover, Aktionsmenü, ein offener Dialog (appConfirm).
// Ein `@click.outside`-Commit eines Inline-Edits ignoriert solche Klicks; sonst
// speicherte schon die Übernahme einer Rechtschreib-Korrektur das Formular.

const INTERACTIVE_SEL = 'a, button, input, textarea, select, label, [contenteditable], .entity-ref, .combobox-wrap, .research-tag';
const FLOATING_SEL = '.lt-popover, .lt-badge, .picker-popover, .context-menu, dialog[open]';

export function isRowBodyClick(ev) {
  const t = ev?.target;
  if (t?.closest?.(INTERACTIVE_SEL)) return false;
  const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
  if (sel && !sel.isCollapsed && sel.toString().trim()) return false;
  return true;
}

export function isFloatingLayerClick(ev) {
  const t = ev?.target;
  if (!t) return false;
  if (t.isConnected === false) return true;
  return !!t.closest?.(FLOATING_SEL);
}
