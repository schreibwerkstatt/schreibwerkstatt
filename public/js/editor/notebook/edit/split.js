// Teil von notebookEditMethods (siehe Facade edit.js): «Abschnitt hier teilen».
// Nur Notebook-Editor (Edit-Modus, nicht im Fokus-Modus). Schnittregel und
// Block-ID-Verhalten: ../split-html.js; Server: POST /content/pages/:id/split.
//
// Ablauf: Schnittpunkt sofort festhalten (der Namensdialog nimmt den Fokus und
// damit die Selection) und Kopf/Schwanz auf einer Kopie berechnen → Namen
// erfragen → Ausstehendes speichern (quickSave) → prüfen, dass der Editor seit
// dem Festhalten unverändert ist → Route mit dem Stempel der gespeicherten
// Fassung. Danach bleibt der Editor auf der Ausgangsseite (jetzt der Kopf) im
// Edit-Modus — wer ein langes Kapitel zerlegt, teilt meist gleich weiter; der
// neue Abschnitt steht direkt darunter im Baum.
import { contentRepo, editorHost, isNoChange, isPageConflict, stripLektoratMarks } from './_shared.js';
import { splitEditorAt } from '../split-html.js';

export const splitMethods = {
  // `block`: Schnitt vor diesem Block (Slash-Menü, der leere Trigger-Absatz).
  // Ohne `block` gilt der Caret der aktuellen Selection (Toolbar-Knopf).
  async splitSectionHere({ block = null } = {}) {
    const app = editorHost();
    if (!app?.editMode || !app.currentPage || app.focusActive) return;
    if (!app.canEdit?.()) return;
    const t = (k, p) => app.t(k, p);
    if (this._splitBusy || app.editSaving || app.editConflict || app.conflictResolution) {
      app.setStatus(t('editor.split.busy'), false, 4000);
      return;
    }
    const el = this._getEditEl();
    if (!el) return;

    let container = null;
    let offset = 0;
    if (block && el.contains(block)) {
      container = block;
    } else {
      const sel = document.getSelection();
      const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      if (range && (range.startContainer === el || el.contains(range.startContainer))) {
        container = range.startContainer;
        offset = range.startOffset;
      }
    }
    if (!container) { app.setStatus(t('editor.split.noCaret'), false, 5000); return; }
    const parts = splitEditorAt(el, container, offset);
    if (parts.error) {
      app.setStatus(t(parts.error === 'edge' ? 'editor.split.edge' : 'editor.split.noCaret'), false, 5000);
      return;
    }
    const pageId = app.currentPage.id;
    const snapshot = stripLektoratMarks(el.innerHTML);

    const raw = await app.appPrompt({
      message: t('editor.split.prompt'),
      placeholder: t('editor.split.placeholder'),
      defaultValue: t('editor.split.defaultName', { name: app.currentPage.name || '' }),
      confirmLabel: t('editor.split.confirm'),
    });
    const name = (raw || '').trim();
    if (!name || !this._stillEditing(pageId)) return;

    this._splitBusy = true;
    try {
      if (app.editDirty) await this.quickSave();
      if (!this._stillEditing(pageId)) return;
      if (app.editDirty || app.editConflict || app.conflictResolution || app.saveOffline) {
        app.setStatus(t('editor.split.saveFirst'), false, 6000);
        return;
      }
      if (!isNoChange(stripLektoratMarks(el.innerHTML), snapshot)) {
        app.setStatus(t('editor.split.changed'), false, 6000);
        return;
      }
      app.setStatus(t('editor.split.running'), true);
      const res = await contentRepo.splitPage(pageId, {
        head_html: stripLektoratMarks(parts.headHtml),
        tail_html: stripLektoratMarks(parts.tailHtml),
        new_name: name,
        expected_updated_at: app.currentPage.updated_at || null,
      }, { bookId: app.$store?.nav?.selectedBookId ?? null });
      if (!res?.head || !res?.tail) throw new Error('split: empty response');
      // Kopf in den Editor (Server-Fassung inkl. data-bid), Undo-Baseline neu:
      // ein Undo über die Teilung hinweg schriebe den Schwanz sonst doppelt.
      if (this._stillEditing(pageId)) {
        this._applySaveSuccess(res.head, res.head.html || '', { pageId, applyToEditor: true });
      }
      app._syncPageStatsAfterSave?.(res.tail, res.tail.html || '');
      await app.loadPages?.({ fresh: true });
      app.setStatus(t('editor.split.done', { name: res.tail.name || name }), false, 5000);
    } catch (e) {
      console.error('[splitSectionHere]', e);
      app.setStatus(t(isPageConflict(e) ? 'editor.split.conflict' : 'editor.split.failed'), false, 8000);
    } finally {
      this._splitBusy = false;
    }
  },
};
