// Viewer der Revisionsliste (natives <dialog>, Tabs «Inhalt | Vergleich»).
// Gespreadet in pageRevisionsCard (../page-revisions-card.js); `this` ist die
// Karte. Diff-Lib lazy.
//
// Vergleich in zwei Richtungen:
//   'prev'    — Vorgaengerin (links) gegen diese Version (rechts): was hat
//               dieser Save geaendert?
//   'current' — gespeicherter aktueller Stand (links) gegen diese Version
//               (rechts): was wuerde «Wiederherstellen» aendern?
//
// `pinned`/`label` kommen aus der Liste, nicht aus dem Detail: der Voll-Body ist
// im Service Worker SWR-gecacht und waere nach einem Anheften auf einem zweiten
// Geraet veraltet.

import { fetchJson } from '../../utils.js';
import { contentRepo } from '../../repo/content.js';
import { loadDiff } from '../../lazy-libs.js';
import { renderSideBySide } from '../../page-revision-diff.js';

export function viewerState() {
  return {
    viewerOpen: false,
    viewerRev: null,
    viewerBody: '',
    // Meta der Vorgaengerin laut Server (`prev` der Detail-Antwort) — greift,
    // wenn die Vorgaengerin nicht in der geladenen Liste steht.
    viewerPrevMeta: null,
    viewerMode: 'content',     // 'content' | 'diff'
    viewerCompare: 'prev',     // 'prev' | 'current'
    viewerLoading: false,
    viewerError: '',
    viewerDiffHtml: '',
    viewerDiffUnchanged: false,
    viewerDiffLoading: false,
    viewerLabelDraft: '',
    _viewerSeq: 0,
  };
}

export const viewerMethods = {
  async openViewer(rev, { keepMode = false } = {}) {
    if (!rev?.id) return;
    const pageId = this._pageId;
    if (!pageId) return;
    const seq = ++this._viewerSeq;

    const firstOpen = !this.viewerOpen;
    // Bei Prev/Next-Navigation den aktiven Tab beibehalten; beim Frischoeffnen
    // immer mit 'content' starten.
    const mode = keepMode && this.viewerMode === 'diff' ? 'diff' : 'content';
    this.viewerOpen = true;
    this.viewerRev = rev;
    this.viewerMode = mode;
    if (!keepMode) this.viewerCompare = 'prev';
    this.viewerBody = '';
    this.viewerPrevMeta = null;
    this.viewerError = '';
    this.viewerDiffHtml = '';
    this.viewerDiffUnchanged = false;
    this.viewerLabelDraft = rev.label || '';
    this.viewerLoading = true;

    if (firstOpen) {
      this.$nextTick(() => {
        const dlg = this.$refs?.viewerDialog;
        if (dlg && typeof dlg.showModal === 'function' && !dlg.open) dlg.showModal();
      });
    }

    try {
      const data = await fetchJson(`/content/pages/${pageId}/revisions/${rev.id}`);
      if (seq !== this._viewerSeq) return;
      const rev2 = data?.revision || null;
      if (!rev2) throw new Error('REVISION_NOT_FOUND');
      this.viewerBody = String(rev2.body_html || '');
      this.viewerPrevMeta = data?.prev || null;
    } catch (e) {
      if (seq !== this._viewerSeq) return;
      console.error('[pageRevisions:viewer:load]', e);
      this.viewerError = e.message || 'load failed';
    } finally {
      if (seq === this._viewerSeq) this.viewerLoading = false;
    }

    // Vergleichs-Tab beibehalten → Diff fuer die neu geladene Revision ziehen.
    if (seq === this._viewerSeq && this.viewerMode === 'diff' && !this.viewerError) await this._ensureDiff();
  },

  // Navigation laeuft ueber die ganze geladene Liste (ungefiltert, ungruppiert):
  // ‹/› soll Save fuer Save durch die Geschichte gehen. 'prev' = aelter.
  _siblingRev(direction) {
    if (!this.viewerRev?.id) return null;
    const idx = this.revisions.findIndex(r => r.id === this.viewerRev.id);
    if (idx < 0) return null;
    if (direction === 'prev') return this._prevRevFor(this.viewerRev);
    return this.revisions[idx - 1] || null;
  },
  hasPrevRev() { return !!this._siblingRev('prev'); },
  hasNextRev() { return !!this._siblingRev('next'); },
  // Am Fensterrand ist die aeltere Nachbarin `older` (nicht in der Liste):
  // erst nachladen, damit ‹/› von dort aus weiter funktioniert.
  async gotoRev(direction) {
    const target = this._siblingRev(direction);
    if (!target) return;
    if (direction === 'prev' && !this.revisions.some(r => r.id === target.id) && this.hasMore) {
      await this.loadMore();
    }
    const inList = this.revisions.find(r => r.id === target.id);
    this.openViewer(inList || target, { keepMode: true });
  },

  // Vorgaengerin der offenen Version: aus der Liste, sonst laut Server.
  _viewerPrev() {
    return this._prevRevFor(this.viewerRev) || this.viewerPrevMeta || null;
  },
  hasViewerPrev() { return !!this._viewerPrev(); },

  closeViewer() {
    this._viewerSeq++;
    this.viewerOpen = false;
    this.viewerRev = null;
    this.viewerBody = '';
    this.viewerPrevMeta = null;
    this.viewerMode = 'content';
    this.viewerCompare = 'prev';
    this.viewerError = '';
    this.viewerDiffHtml = '';
    this.viewerDiffUnchanged = false;
    this.viewerLabelDraft = '';
    const dlg = this.$refs?.viewerDialog;
    if (dlg && dlg.open) dlg.close();
  },

  async setViewerMode(mode) {
    if (mode !== 'content' && mode !== 'diff') return;
    this.viewerMode = mode;
    if (mode === 'diff' && !this.viewerDiffHtml && !this.viewerError) {
      await this._ensureDiff();
    }
  },

  async setViewerCompare(compare) {
    if (compare !== 'prev' && compare !== 'current') return;
    if (this.viewerCompare === compare) return;
    this.viewerCompare = compare;
    this.viewerDiffHtml = '';
    this.viewerDiffUnchanged = false;
    if (this.viewerMode === 'diff' && !this.viewerError) await this._ensureDiff();
  },

  // Rechte Spalte ist immer die offene Version. Links die Vorgaengerin bzw. der
  // gespeicherte aktuelle Stand. Aelteste Revision ohne Vorgaengerin: leerer
  // String, alles erscheint als "hinzugefuegt".
  async _ensureDiff() {
    const app = window.__app;
    if (!this.viewerRev?.id) return;
    const seq = this._viewerSeq;
    this.viewerDiffLoading = true;
    try {
      const diffLib = await loadDiff();
      const leftHtml = this.viewerCompare === 'current'
        ? await this._loadCurrentBody()
        : await this._loadPrevRevisionBody();
      if (seq !== this._viewerSeq) return;
      const t = (k, p) => app?.t?.(k, p);
      const out = renderSideBySide(leftHtml, this.viewerBody, diffLib, {
        skipLabel: (n) => t('editor.revisions.viewer.diffSkip', { n }) || `… ${n} …`,
        imageLabel: (name) => name
          ? t('editor.revisions.viewer.diffImage', { name })
          : t('editor.revisions.viewer.diffImageUnnamed'),
      });
      this.viewerDiffHtml = out.html;
      this.viewerDiffUnchanged = out.unchanged;
    } catch (e) {
      console.error('[pageRevisions:viewer:diff]', e);
      if (seq === this._viewerSeq) this.viewerError = e.message || 'diff failed';
    } finally {
      if (seq === this._viewerSeq) this.viewerDiffLoading = false;
    }
  },

  async _loadPrevRevisionBody() {
    const prev = this._viewerPrev();
    if (!prev?.id || !this._pageId) return '';
    try {
      const data = await fetchJson(`/content/pages/${this._pageId}/revisions/${prev.id}`);
      return String(data?.revision?.body_html || '');
    } catch (e) {
      console.error('[pageRevisions:viewer:prev]', e);
      return '';
    }
  },

  // Gespeicherter Stand, nicht der Editor-Puffer: «Wiederherstellen» ersetzt den
  // gespeicherten Stand. Frisch vom Server, weil ein zweites Geraet inzwischen
  // geschrieben haben kann.
  async _loadCurrentBody() {
    if (!this._pageId) return '';
    try {
      const page = await contentRepo.loadPage(this._pageId, { fresh: true });
      return String(page?.html || '');
    } catch (e) {
      console.error('[pageRevisions:viewer:current]', e);
      return String(window.__app?.originalHtml || '');
    }
  },

  async restoreFromViewer() {
    if (this.viewerRev) await this.restore(this.viewerRev);
  },

  async restorePreviousFromViewer() {
    const prev = this._viewerPrev();
    if (prev) await this.restore(prev);
  },

  // Cmd/Ctrl+Enter bei offener Ansicht: wiederherstellen und das Event hier
  // beenden. Window-Capture, damit der Body-Listener für Ctrl+Enter
  // (Lektorat starten) es nicht zusätzlich bekommt. Bei geschlossener
  // Ansicht bleibt das Event unberührt. Im Label-Feld ist Enter «Name
  // speichern», kein Restore.
  onViewerRestoreKey(event) {
    if (!this.viewerOpen || !(event.metaKey || event.ctrlKey)) return;
    if (event.target?.closest?.('.revision-viewer__label')) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.canRestore()) this.restoreFromViewer();
  },

  async saveViewerLabel() {
    const rev = this.viewerRev;
    if (!rev?.pinned) return;
    const label = this.viewerLabelDraft.trim();
    if (label === (rev.label || '')) return;
    await this.setPinned(rev, true, label);
  },
};
