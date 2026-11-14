// Bild-Dialog des Notebook-Editors: Ersatztext (alt) und Bildnachweis einer
// bereits eingefuegten Abbildung.
//
// WARUM EIN DIALOG UND KEIN INLINE-FELD: beide Angaben sind Felder mit fester
// Rolle, kein Fliesstext. Der Ersatztext hat im Satzspiegel ueberhaupt keine
// Darstellung (er lebt im `alt`-Attribut) — ohne Dialog gaebe es keinen Weg, ihn
// zu setzen. Der Bildnachweis ist zwar sichtbar, aber als atomarer Block
// (markFiguresAtomic) gegen das Verschmelzen an der Blockgrenze geschuetzt;
// bearbeitet wird er deshalb hier. Die Bildunterschrift dagegen wird NICHT hier
// gepflegt: sie ist Manuskripttext, wird direkt in der `<figcaption>` getippt
// und traegt Auszeichnung, Quellen-Chips und Querverweise, die ein Textfeld
// plattdruecken wuerde.
//
// Aufbau wie der Tabellen-Dialog: Karten-Scope (editorToolbarCard), also `x-ref`
// + showModal() statt des `modal()`-Primitivs, und `@close` ist der EINZIGE
// Aufraeumpunkt — ESC, Backdrop und Abbrechen laufen alle durch `dlg.close()`.
// Caret merken/zurueck, Backdrop- und Esc-Rueckfrage: panel-methods.js.
//
// Daneben der Einfuegeweg der Seiten-Toolbar (`insertImageAtCaret`): Datei
// waehlen, hochladen, `<figure>` am Caret. Das Slash-Menue hat seinen eigenen
// Weg in slash.js (ersetzt den leeren Trigger-Block); beide bauen das Markup
// aus derselben SSoT.
//
// EINGABE IST NOTEBOOK-ONLY (wie Tabelle und Diagramm). Focus-Editor und
// Bucheditor stellen Abbildungen nur dar.

import { getEditEl, placeCaretIn } from '../../utils.js';
import { ensureSlotAfter } from './_shared.js';
import { htmlToElement, placeBlockNode } from './caret-panel.js';
import {
  applyFigureMeta, buildFigureHtml, figureModel, markFiguresAtomic, FIGURE_CAPTION_SEL,
} from '../../../figure/figure-html.js';
import { contentRepo } from '../../../repo/content.js';

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

/** Datei-Dialog fuer ein Bild. Liefert die Datei oder null (abgebrochen).
 *  Ein abgebrochener Dialog feuert kein `change`, nur `cancel` — aeltere Safari
 *  nicht einmal das; dann raeumt der Fokus-Rueckkehr-Fallback das versteckte
 *  Feld ab. */
export function pickImageFile(doc = document) {
  return new Promise((resolve) => {
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = IMAGE_ACCEPT;
    input.hidden = true;
    doc.body.appendChild(input);
    const done = (file) => { input.remove(); resolve(file || null); };
    input.addEventListener('cancel', () => done(null), { once: true });
    window.addEventListener('focus', () => {
      setTimeout(() => { if (input.isConnected && !input.files?.length) done(null); }, 1000);
    }, { once: true });
    input.addEventListener('change', () => done(input.files && input.files[0]), { once: true });
    input.click();
  });
}

export const imageMethods = {
  /** Seiten-Toolbar: Bild am Caret. `target` aus caret-panel.js#blockInsertTarget
   *  (leerer Caret-Absatz → ersetzt, sonst dahinter). Eingefuegt wird nur, wenn
   *  nach dem Upload noch derselbe Abschnitt im Edit-Modus offen ist. */
  async insertImageAtCaret(target = {}) {
    const app = window.__app;
    const pageId = app?.currentPage?.id;
    if (!pageId) return;
    const file = await pickImageFile();
    if (!file) return;
    let result;
    try {
      result = await contentRepo.uploadPageImage(pageId, file);
    } catch {
      app?._showJobToast?.({
        message: app?.t?.('editor.image.uploadError'),
        severity: 'err', jobType: 'image', bookId: null,
      });
      return;
    }
    if (!app.editMode || app.focusActive || app.currentPage?.id !== pageId) return;
    const editEl = getEditEl();
    if (!editEl || !result?.url) return;
    const fig = htmlToElement(buildFigureHtml({ src: result.url }));
    if (!fig) return;
    // Getippt während des Uploads: placeBlockNode ersetzt dann nicht mehr.
    placeBlockNode(editEl, fig, target);
    ensureSlotAfter(fig);
    // Erster Handgriff nach dem Einfuegen ist die Legende (wie im Slash-Weg).
    const cap = fig.querySelector(FIGURE_CAPTION_SEL);
    editEl.focus({ preventScroll: true });
    if (cap) placeCaretIn(cap);
    app._markEditDirty?.();
  },

  /** `el` ist eine bestehende `<figure>` im Manuskript. Der Dialog beschreibt
   *  nur — die Abbildung entsteht beim Einfuegen (Datei-Dialog), und ohne Bild
   *  gaebe es nichts zu beschreiben. */
  openImageForEl(el) {
    const m = figureModel(el);
    if (!m) return;
    this._imageEl = el;
    this.imageSrc = m.src;
    this.imageAlt = m.alt;
    this.imageCredit = m.credit;
    const dlg = this.$refs?.imageDlg;
    if (!dlg) return;
    this._beginDialog('image');
    if (!dlg.open) dlg.showModal();
    queueMicrotask(() => this.$refs?.imageAltInput?.focus());
  },

  closeImageDialog() {
    this.$refs?.imageDlg?.close();
  },

  /** Einziger Aufraeumpunkt (siehe Modulkopf). */
  onImageDialogClose() {
    this._imageEl = null;
    this.imageSrc = '';
    this.imageAlt = '';
    this.imageCredit = '';
    this._endDialog();
  },

  /** Uebernehmen. `applyFigureMeta` meldet, ob sich etwas geaendert hat — ohne
   *  Aenderung bleibt die Seite sauber, statt allein vom Oeffnen des Dialogs
   *  dirty zu werden. */
  applyImageMeta() {
    const el = this._imageEl;
    if (el?.isConnected) {
      const changed = applyFigureMeta(el, { alt: this.imageAlt, credit: this.imageCredit });
      if (changed) {
        // Ein frisch angelegter Bildnachweis ist noch frei bearbeitbar — das
        // Laufzeit-Attribut setzt sonst erst der naechste Mount.
        markFiguresAtomic(el);
        window.__app?._markEditDirty?.();
      }
      // Caret beim Schliessen in den Absatz hinter der Abbildung.
      this._dialogInserted = el;
    }
    this.closeImageDialog();
  },

  /** Abbildung loeschen. Das `<img>` ist ein void-Element und damit kein
   *  Loeschziel fuer Backspace (harte Regel „Loeschen an Blockgrenzen") — ohne
   *  diesen Weg bliebe nur, die Legende zu leeren und die Abbildung stehen zu
   *  lassen. */
  removeImage() {
    const el = this._imageEl;
    if (el?.isConnected) {
      el.remove();
      window.__app?._markEditDirty?.();
    }
    this.closeImageDialog();
  },
};
