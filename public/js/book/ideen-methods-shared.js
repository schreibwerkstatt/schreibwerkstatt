// Methoden, die Ideen-Karte (book/ideen.js) und Ideen-Board (ideen-board/*)
// wortgleich brauchen — EINE Definition, beide spreaden sie. Was je Oberflaeche
// verschieden ist (welche Plaketten nachgezogen werden, welcher Fehlertext),
// liefert die Karte ueber zwei Hooks:
//
//   _afterIdeenRemoved(rows)   — nach dem Loeschen (Zaehler, Memo, Historie)
//   _ideenErrorKey(kind)       — i18n-Key des Fehlers ('delete')
//
// `this` = die jeweilige Karten-Instanz (ideenCard bzw. ideenBoardCard).

import { deleteIdee as removeIdee } from '../repo/ideen-queue.js';
import { ideeStatus } from './ideen-shared.js';

export const ideenSharedMethods = {
  statusLabel(s) { return window.__app.t(`ideen.status.${s}`); },
  ideeStatus(idee) { return ideeStatus(idee); },

  // Nach Rueckfrage loeschen (Offline-Warteschlange in repo/ideen-queue.js).
  // true = geloescht.
  async deleteIdee(idee) {
    const app = window.__app;
    if (!idee) return false;
    if (!await app.appConfirm({
      message: app.t('ideen.confirmDelete'),
      confirmLabel: app.t('common.delete'),
      danger: true,
    })) return false;
    this.busy = true;
    try {
      await removeIdee(idee);
      this.ideen = this.ideen.filter(i => i.id !== idee.id);
      this.errorMessage = '';
      this._afterIdeenRemoved?.([idee]);
      return true;
    } catch {
      this.errorMessage = app.t(this._ideenErrorKey?.('delete') || 'ideen.error.delete');
      return false;
    } finally {
      this.busy = false;
    }
  },
};
