// Cmd/Ctrl+Z · Cmd/Ctrl+Shift+Z · Ctrl+Y für Karten mit eigener Aktions-
// Historie (Buchorganizer, Plot-Board). EIN Listener-Muster statt zweier
// handgeschriebener Kopien; die Griffe selbst kommen aus `matchHistoryCommand`
// (editor/shared/shortcuts.js), derselben Quelle wie in den Editoren — so
// zählt z.B. AltGr+Z (Ctrl+Alt) auch hier nicht als Undo.
//
// Greift NICHT:
//   - bei unsichtbarer Karte,
//   - wenn der Fokus in INPUT/TEXTAREA/contenteditable steht (dort gilt das
//     native Edit-Undo der Felder),
//   - solange ein modaler <dialog> offen ist (Bestätigungsdialog): ein Undo
//     dahinter dreht womöglich genau das Objekt zurück, über dessen Löschung
//     gerade entschieden wird,
//   - wenn `isBlocked(event)` true liefert (kartenspezifisch, z.B. Fokus in
//     einem offenen Bearbeiten-Panel mit ungespeichertem Entwurf).

import { matchHistoryCommand } from '../editor/shared/shortcuts.js';

export function bindBoardHistoryKeys({ isVisible, isBlocked = null, onUndo, onRedo, signal }) {
  const handler = (e) => {
    if (!isVisible()) return;
    const cmd = matchHistoryCommand(e);
    if (!cmd) return;
    const t = e.target;
    const tag = t?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return;
    if (document.querySelector('dialog[open]')) return;
    if (typeof isBlocked === 'function' && isBlocked(e)) return;
    e.preventDefault();
    if (cmd === 'undo') onUndo(); else onRedo();
  };
  window.addEventListener('keydown', handler, signal ? { signal } : undefined);
  return handler;
}
