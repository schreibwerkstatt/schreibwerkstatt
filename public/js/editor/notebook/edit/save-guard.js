// Teil von notebookEditMethods (siehe Facade edit.js).
//
// Querschnitt der Save-Pfade: ob ein Hintergrund-Save überhaupt laufen darf,
// Block-IDs vor Merge/Save, der Draft nach einem Save, der über einen
// Seitenwechsel lief, und die Fehlerklassen eines gescheiterten PUT.
import { clearDraft, editorHost, isNoChange, localeTag, readDraft, tzOpts, writeDraft } from './_shared.js';
import { syncLiveBlockIds } from '../block-ids.js';
import { classifySaveError, isRetryableSaveError } from '../save-errors.js';
import { noteSaveOutage } from '../save-outage.js';

export const saveGuardMethods = {
  // Riegel für jeden Save, den der User nicht selbst ausgelöst hat (Autosave-
  // Timer, Online-/Fokus-Retry). Kein Hintergrund-Save
  //  - ohne offene Session oder während ein Save läuft,
  //  - solange das Konflikt-Modal offen ist: es entscheidet, welche Fassung
  //    gilt — ein stiller Save darunter liefe in den Merge, öffnete das Modal
  //    neu und setzte die getroffenen Entscheidungen zurück,
  //  - auf einer anderen Seite als der, für die er geplant wurde (`pageId`),
  //  - nach einem Fehler, den Wiederholen nicht behebt (423/403/404/4xx) — nur
  //    der ausdrückliche Save versucht es dann erneut.
  _canBackgroundSave(pageId = null) {
    const app = editorHost();
    if (!app?.editMode || app.editSaving || app.conflictResolution || !app.currentPage) return false;
    if (pageId != null && app.currentPage.id !== pageId) return false;
    return isRetryableSaveError(app.saveFailKind);
  },


  // Block-IDs im Live-Editor vor jedem Merge/Save/Draft in Ordnung bringen
  // (doppelte nach Enter, fehlende bei neuen Blöcken) — siehe ../block-ids.js.
  // `referenceHtml` ist die zuletzt bekannte Server-Fassung.
  _ensureLiveBlockIds(referenceHtml) {
    const app = editorHost();
    if (!app?.editMode) return 0;
    return syncLiveBlockIds(this._getEditEl(), referenceHtml ?? app.originalHtml);
  },


  // Save ist durch, die Session steht aber nicht mehr auf der Seite (Wechsel
  // während des PUT). Der Draft wurde beim Verlassen womöglich NACH dem
  // Save-Start geschrieben und trägt dann mehr als das Gespeicherte — ihn zu
  // löschen, verlöre genau diese Arbeit. Gelöscht wird nur, was dem
  // gespeicherten Stand entspricht; ein neuerer Draft rückt auf die
  // gespeicherte Fassung als Basis vor (sonst liefe er beim nächsten Öffnen
  // gegen den eigenen Save in einen Merge).
  _releaseDraftAfterSave(pageId, html, saved) {
    const draft = readDraft(pageId);
    if (!draft?.html || isNoChange(draft.html, html)) { clearDraft(pageId); return; }
    const base = typeof saved?.html === 'string' ? saved.html : html;
    writeDraft(pageId, draft.html, base, saved?.updated_at || draft.originalUpdatedAt);
  },


  // Gescheiterter PUT ohne Konflikt: Fehlerklasse merken (steuert Retry und
  // Statuszeile) und Text für die Statuszeile liefern. Der Draft liegt zu
  // diesem Zeitpunkt schon (Pflicht-Invariante #5). `offlineKey` ist der
  // Wortlaut für „wirklich offline" — saveEdit meldet ausführlich, quickSave
  // knapp mit Uhrzeit.
  _noteSaveFailure(e, { offlineKey = 'edit.offlineSavedAt' } = {}) {
    const app = editorHost();
    const kind = classifySaveError(e);
    app.saveOffline = true;
    app.saveFailKind = kind;
    noteSaveOutage(app.currentPage?.id, { kind, status: e?.status });
    return this._saveFailureText(kind, e, { offlineKey });
  },


  _saveFailureText(kind, e, { offlineKey = 'edit.offlineSavedAt' } = {}) {
    const app = editorHost();
    if (kind === 'network') {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        const tag = localeTag(app.$store?.shell?.uiLocale);
        return app.t(offlineKey, { time: new Date().toLocaleTimeString(tag, tzOpts()) });
      }
      return app.t('edit.saveFailedRetry');
    }
    if (kind === 'locked') {
      const email = e?.body?.locked_by_email || null;
      const user = email ? (app.userDisplayName?.(email) || email) : null;
      return user ? app.t('edit.saveError.lockedBy', { user }) : app.t('edit.saveError.locked');
    }
    if (kind === 'rejected') return app.t('edit.saveError.rejected', { status: e?.status ?? '' });
    return app.t(`edit.saveError.${kind}`);
  },
};
