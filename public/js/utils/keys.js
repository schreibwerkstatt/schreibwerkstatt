// Tastatur-Prädikate und -Handler für Edit-Formulare (public/CLAUDE.md «Edit-Formulare»).

// Cmd/Ctrl+S ohne Shift/Alt — das Speichern-Kürzel der Edit-Panels.
export function isSaveShortcut(event) {
  return (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey
    && (event.key === 's' || event.key === 'S');
}

// Panel-weite Kürzel eines Edit-Formulars (am Container, damit sie bei Fokus in
// jedem Feld greifen): Cmd/Ctrl+S → `save`, Escape → `cancel`. Ohne `cancel`
// (Einstellungsseite ohne Abbrechen-Knopf) bleibt Escape unberührt. Beide Tasten
// stoppen die Propagation: das Formular hat sie verbraucht, also feuern weder der
// globale Cmd+S-Griff (index.html → quickSave des Notebook-Editors) noch ein
// Esc-Handler der umgebenden Karte. Combobox/EntityPicker konsumieren Escape
// selbst, solange ihr Dropdown offen ist.
export function handleEditPanelKeydown(event, { save, cancel }) {
  if (isSaveShortcut(event)) {
    event.preventDefault();
    event.stopPropagation();
    save();
    return;
  }
  if (cancel && event.key === 'Escape' && !event.defaultPrevented) {
    event.preventDefault();
    event.stopPropagation();
    cancel();
  }
}
