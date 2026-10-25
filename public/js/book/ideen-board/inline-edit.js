// Text einer Pendenz direkt auf der Board-Karte bearbeiten. Tastatur wie im
// Plot-Beat-Edit (public/CLAUDE.md «Edit-Formulare», Tasten via `$editKeys` im
// Template): Enter/Cmd+S speichert und schliesst, Esc verwirft, Klick daneben speichert.
// `this` = die ideenBoardCard-Instanz.

import { autosizeTextarea, mountAutosizeTextarea } from '../../utils.js';
import { IDEE_MAX_LEN } from '../ideen-shared.js';

export const ideenBoardInlineEdit = {
  startEdit(idee) { this.editingId = idee.id; this.editingDraft = idee.content || ''; },
  mountEditInput: mountAutosizeTextarea,
  autosizeEditInput: autosizeTextarea,
  cancelEdit() { this.editingId = null; this.editingDraft = ''; },
  // Speichern und schliessen — auch beim Klick ausserhalb. Leerer Text wird
  // verworfen; ein laufender Request wird nicht doppelt ausgelöst.
  commitEdit(idee) {
    if (this.busy || this.editingId !== idee.id) return;
    if (!(this.editingDraft || '').trim()) { this.cancelEdit(); return; }
    return this.saveEdit(idee);
  },
  async saveEdit(idee) {
    const content = (this.editingDraft || '').trim();
    if (!content) { this.errorMessage = window.__app.t('ideen.error.contentRequired'); return; }
    if (content.length > IDEE_MAX_LEN) { this.errorMessage = window.__app.t('ideen.error.contentTooLong'); return; }
    if (content === idee.content) { this.cancelEdit(); return; }
    if (await this._patchIdee(idee, { content })) this.cancelEdit();
  },
};
