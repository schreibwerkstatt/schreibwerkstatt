// «zusammenführen mit…» an einer Katalog-Zeile, die nicht mehr im Text steht
// (Figuren · Schauplätze · Szenen). Der Knopf sitzt in der Zeile und öffnet ein
// Picker-Popover (picker-popover.js) mit den aktiven Einträgen derselben Gattung;
// Markup: partials/entity-merge-picker.html, einmal je Karte eingebunden.
// Der Merge selbst läuft über den geteilten Client-Kern book/entity-merge.js.
//
//   ...entityMergePickerState(),        // Karten-State (inkl. Picker-Position)
//   ...entityMergePickerMethods,        // Karten-Methoden (inkl. Picker-Mechanik)
//
// Zielauswahl nur unter aktiven Einträgen: eine verwaiste Quelle in eine andere
// verwaiste aufgehen zu lassen, verschöbe die Verknüpfungen nur von einem
// Altlast-Eintrag zum nächsten.

import { pickerPopoverState, pickerPopoverMethods } from '../picker-popover.js';
import {
  MERGE_KIND_CFG, mergeEntryName, confirmEntityMerge, postEntityMerge,
  entityMergeMessage, reloadCatalogsAfterMerge,
} from './entity-merge.js';
import { compareText, tFetchError } from '../i18n.js';
import { isSelectedBook } from '../cards/book-guard.js';

const MESSAGE_MS = 8000;

const closedMergePick = () => ({ kind: null, sourceId: null, targetId: '', busy: false, error: '' });

export function entityMergePickerState() {
  return {
    ...pickerPopoverState(),
    mergePick: closedMergePick(),
    mergePickMessage: '',
    _mergePickMsgTimer: null,
  };
}

/** Teil des Karten-Resets (`resetState` von setupCardLifecycle): offener Picker
 *  und Meldung gehören zum alten Buch. Die Picker-Mechanik selbst bleibt — ihr
 *  Schliess-Listener räumt sich beim nächsten Klick daneben auf. */
export function entityMergePickerResetState() {
  return { mergePick: closedMergePick(), mergePickMessage: '' };
}

/** Ziel-Optionen (pur, für das Inline-`x-effect` der Combobox): aktive Einträge
 *  derselben Gattung ausser der Quelle, alphabetisch. Szenen tragen das Kapitel
 *  im Label — gleiche Titel kommen in verschiedenen Kapiteln vor. */
export function entityMergeTargetOptions(kind, sourceId, catalog) {
  const cfg = MERGE_KIND_CFG[kind];
  if (!cfg) return [];
  return (catalog?.[cfg.catalog] || [])
    .filter(e => !e.stale && String(e.id) !== String(sourceId))
    .map(e => {
      const name = mergeEntryName(kind, e);
      return { value: String(e.id), label: kind === 'szene' && e.kapitel ? `${name} · ${e.kapitel}` : name };
    })
    .sort((a, b) => compareText(a.label, b.label));
}

export const entityMergePickerMethods = {
  ...pickerPopoverMethods,

  entityMergeTargetOptions,

  openMergePick(ev, kind, entry) {
    this.mergePick = { ...closedMergePick(), kind, sourceId: String(entry.id) };
    this._openPickerPopover(ev, 'mergePickPopover', () => this.cancelMergePick());
  },

  cancelMergePick() {
    if (this.mergePick.busy) return;
    this.mergePick = closedMergePick();
    this._releasePickerPopover();
  },

  _mergePickEntry(id) {
    const cfg = MERGE_KIND_CFG[this.mergePick.kind];
    if (!cfg || id == null || id === '') return null;
    return (Alpine.store('catalog')[cfg.catalog] || []).find(e => String(e.id) === String(id)) || null;
  },

  mergePickSourceName() {
    return mergeEntryName(this.mergePick.kind, this._mergePickEntry(this.mergePick.sourceId));
  },

  async confirmMergePick() {
    const { kind, sourceId, targetId, busy } = this.mergePick;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!kind || !bookId || busy || !targetId) return;
    const srcEntry = this._mergePickEntry(sourceId);
    const tgtEntry = this._mergePickEntry(targetId);
    if (!srcEntry || !tgtEntry) return;
    const src = { name: mergeEntryName(kind, srcEntry) };
    const tgt = { name: mergeEntryName(kind, tgtEntry) };
    // Rückfrage vor dem Sperren: ein Abbruch lässt den Picker mit der Auswahl offen.
    if (!await confirmEntityMerge(src.name, tgt.name)) return;
    this.mergePick.busy = true;
    this.mergePick.error = '';
    try {
      const data = await postEntityMerge(kind, bookId, sourceId, targetId);
      if (!isSelectedBook(bookId)) return;
      this.mergePick.busy = false;
      this.cancelMergePick();
      this._showMergePickMessage(entityMergeMessage(kind, data, src, tgt));
      await reloadCatalogsAfterMerge(bookId);
    } catch (e) {
      console.error('[confirmMergePick]', e);
      this.mergePick.error = tFetchError(e);
    } finally {
      this.mergePick.busy = false;
    }
  },

  _showMergePickMessage(msg) {
    clearTimeout(this._mergePickMsgTimer);
    this.mergePickMessage = msg;
    this._mergePickMsgTimer = setTimeout(() => { this.mergePickMessage = ''; }, MESSAGE_MS);
  },

  // Buchwechsel/View-Reset: offener Picker und Meldung gehören zum alten Buch.
  _resetMergePick() {
    this.mergePick.busy = false;
    this.cancelMergePick();
    clearTimeout(this._mergePickMsgTimer);
    this.mergePickMessage = '';
  },
};
