// Notebook-Card-Methoden (Normal-Editor Sub-Komponente).
//
// Pendant zu editor/focus/card.js für den Fokusmodus. Hostet bisher die
// Reload-Wiederaufnahme aus dem `normal.snapshot`-Session-Storage (Pendant zu
// _tryRestoreFocus). Wachstumsfläche für weitere Notebook-spezifische
// Lifecycle-Schritte (Lock, Listener-Cleanup, _notebookGen-Counter), wenn
// startEdit/saveEdit/cancelEdit von der Root in die Sub wandern.

import { readNormalSnapshot, clearNormalSnapshot } from './storage.js';
import { readDraft } from '../draft-storage.js';
import { isNoChange } from '../shared/save-pipeline.js';
import { DIAGRAMS_REDRAWN, renderDiagramsIn } from '../../diagram/mermaid-view.js';
import { stampCaptionNumbers } from '../../xrefs/caption-preview.js';

// Restore nur, wenn für die Seite ein lokaler Draft (ungespeicherter Inhalt)
// existiert. Ohne Draft hat der User keinen nennenswerten Edit-State —
// Snapshot-Reste aus exitFocusMode/_closeOtherMainCards würden den User sonst
// ungewollt aus „viewing" zurück in den Edit-Modus zwingen.
// Verglichen wird gegen die Server-Fassung (`originalHtml`) mit derselben
// Normalform wie der Dirty-Check — nicht gegen `renderedPageHtml`: die
// Leseansicht ist dekoriert (Figuren-/Befund-Marken, Legenden-Nummern) und
// wiche von jedem Draft ab, auch einem ohne echte Änderung.
function hasUnsavedDraft(pageId, serverHtml) {
  const draft = readDraft(pageId);
  if (!draft || !draft.html) return false;
  return !isNoChange(draft.html, serverHtml);
}

export const notebookCardMethods = {
  // Reload-Wiederaufnahme: liest den `normal.snapshot` aus sessionStorage und
  // ruft `startEdit()` an der Root, sobald `currentPage`/`renderedPageHtml`/
  // `showEditorCard` für die richtige Seite stehen. Snapshot wird einmalig
  // konsumiert (auch bei späterem Misserfolg kein Retry, sonst Loop bei
  // kaputter Seite).
  _setupNotebookRestore() {
    const snap = readNormalSnapshot();
    if (!snap) return;
    this._notebookRestoreSnapshot = snap;
    const tryRestore = () => this._tryRestoreNotebook();
    this.$watch(() => window.__app?.currentPage?.id, tryRestore);
    this.$watch(() => window.__app?.renderedPageHtml, tryRestore);
    this.$watch(() => window.__app?.showEditorCard, tryRestore);
    queueMicrotask(tryRestore);
  },

  _tryRestoreNotebook() {
    const snap = this._notebookRestoreSnapshot;
    if (!snap) return;
    const app = window.__app;
    if (!app) return;
    if (app.editMode || app.focusActive) return;
    if (!app.showEditorCard) return;
    if (!app.currentPage || app.currentPage.id !== snap.pageId) return;
    if (!app.renderedPageHtml || app.originalHtml == null) return;
    this._notebookRestoreSnapshot = null;
    clearNormalSnapshot();
    if (!hasUnsavedDraft(snap.pageId, app.originalHtml)) return;
    app.startEdit?.();
  },

  // Diagramme in der Leseansicht rendern. `renderedPageHtml` hängt per x-html
  // am Root-Scope, das DOM steht also erst nach dem Alpine-Effekt — darum
  // `$nextTick` statt eines direkten Aufrufs im Watcher.
  //
  // NUR die Leseansicht (`.page-content-view` ohne `--editing`): im Edit-Modus
  // bleibt der Quelltext sichtbar, weil er dort bearbeitet wird. Ein SVG neben
  // dem `<pre>` im contenteditable wäre ausserdem ein Fremdknoten im
  // Save-Pfad.
  _setupNotebookDiagrams() {
    const draw = () => this.$nextTick(() => {
      const app = window.__app;
      if (!app || app.editMode || app.focusActive) return;
      const view = document.querySelector('.page-content-view:not(.page-content-view--editing)');
      if (!view) return;
      // Fehler bleiben lokal: ein ungültiges Diagramm zeigt seinen Quelltext.
      renderDiagramsIn(view, { errorLabel: app.t?.('editor.diagram.invalid') })
        // Die Kastenhöhe (`--pcv-max-h`) wird aus dem Seiten-HTML geschätzt und
        // kennt bis hierher nur eine Pauschale pro Diagramm. Jetzt steht das SVG
        // im DOM und ist messbar — sonst deckelt der Kasten das Diagramm weg.
        .then(() => app._updatePageViewHeight?.())
        .catch(() => {});
    });
    this.$watch(() => window.__app?.renderedPageHtml, draw);
    this.$watch(() => window.__app?.editMode, draw);
    // Nach einem Theme-Wechsel steht ein neuer Render-Knoten im DOM: das
    // Rendern selbst ist dann schon erledigt (der Lauf ist idempotent), aber
    // die Kastenhoehe muss neu gemessen werden.
    document.addEventListener(DIAGRAMS_REDRAWN, draw, { signal: this._notebookAbort?.signal });
    queueMicrotask(draw);
  },

  // Kastenhöhe der Leseansicht (`--pcv-max-h`) nachmessen, sobald sie steht.
  // Bilder und Diagramme kennt die Schätzung aus dem Seiten-HTML nur als
  // Pauschale; gemessen wird in book/page-view.js#`_measuredPageViewPx`, und
  // zwar erst, wenn alle Bilder geladen sind. Auslöser: Seitenwechsel/
  // Re-Render, Rückkehr aus dem Edit-Modus (die Leseansicht war
  // `display:none`, `scrollHeight` 0) und jedes `load`/`error` eines Bildes.
  // `load` bubbelt nicht, darum capture am Dokument; ein rAF bündelt die
  // Events einer Seite mit vielen Bildern. Der Editor deckelt fest (siehe
  // `_measuredPageViewPx`) und braucht keine Nachmessung.
  _setupNotebookPageHeight() {
    let raf = 0;
    const remeasure = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const app = window.__app;
        if (!app || app.editMode || app.focusActive) return;
        app._updatePageViewHeight?.();
      });
    };
    const afterRender = () => this.$nextTick(remeasure);
    this.$watch(() => window.__app?.renderedPageHtml, afterRender);
    this.$watch(() => window.__app?.editMode, afterRender);
    const onImage = (e) => {
      const t = e.target;
      if (t?.tagName !== 'IMG') return;
      if (!t.closest('.page-content-view:not(.page-content-view--editing)') || t.closest('.revision-viewer__content')) return;
      remeasure();
    };
    const signal = this._notebookAbort?.signal;
    document.addEventListener('load', onImage, { capture: true, signal });
    document.addEventListener('error', onImage, { capture: true, signal });
    signal?.addEventListener('abort', () => { if (raf) cancelAnimationFrame(raf); });
  },

  // Nummern in Abbildungslegenden und Tabellenbeschriftungen der Leseansicht
  // („Abb. 3.2: Der Käfer"). Ohne sie steht die Legende am Bildschirm nackt da,
  // und wer prüfen will, ob „vgl. Abb. 3.2" im Text auf die richtige Abbildung
  // zeigt, muss erst ein PDF bauen.
  //
  // NUR die Leseansicht (`.page-content-view` ohne `--editing`) — dieselbe
  // Grenze wie beim Diagramm, aber hier mit schärferer Begründung: das Badge ist
  // ein Fremdknoten, und im Edit-Modus liefe es durch den Save-Pfad. Dass es
  // dort nichts anrichten KANN, sichern zwei Bereinigungsschichten
  // (editor/shared/html-clean.js und lib/html-clean.js) — der Editier-Container
  // bleibt trotzdem frei davon, statt sich auf sie zu verlassen.
  //
  // Die Nummer ist eine VORSCHAU nach nested-arabischer Vorgabe. Was im
  // fertigen Dokument steht, entscheidet das Exportprofil (lib/xref-render.js).
  _setupNotebookCaptionNumbers() {
    const stamp = () => this.$nextTick(() => {
      const app = window.__app;
      if (!app || app.editMode || app.focusActive) return;
      const view = document.querySelector('.page-content-view:not(.page-content-view--editing)');
      if (!view) return;
      const bookId = window.Alpine?.store('nav')?.selectedBookId;
      // Fehler bleiben lokal: ohne Nummern ist die Leseansicht vollständig,
      // nur ohne diese Zusatzinformation.
      stampCaptionNumbers(view, bookId).catch(() => {});
    });
    this.$watch(() => window.__app?.renderedPageHtml, stamp);
    this.$watch(() => window.__app?.editMode, stamp);
    queueMicrotask(stamp);
  },
};
