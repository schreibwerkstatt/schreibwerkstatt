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
//
// Zwei Sequenzen: `_viewerSeq` verwirft Antworten einer anderen Revision
// (Navigation, Schliessen), `_diffSeq` die eines ueberholten Vergleichs
// (Vergleichsziel umgeschaltet, Revision gewechselt). Ohne die zweite gewinnt
// bei schnellem Umschalten der zuletzt fertige Diff, nicht der zuletzt verlangte.
//
// Fehler: Inhalt (`viewerError`) und Vergleich (`viewerDiffError`) getrennt —
// ein gescheiterter Diff laesst den geladenen Inhalt lesbar. Beide tragen einen
// uebersetzten Satz, nie einen rohen Code.

import { fetchJson } from '../../utils.js';
import { tRaw } from '../../i18n.js';
import { trackUsageEvent } from '../../features-usage.js';
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
    viewerDiffError: '',
    // Vergleich «aktuell» lief gegen den lokalen Stand, weil der Server nicht
    // erreichbar war — die Vorlage zeigt dazu einen Hinweis.
    viewerDiffLocal: false,
    viewerLabelDraft: '',
    _viewerSeq: 0,
    _diffSeq: 0,
    // Voll-Bodies bereits geladener Revisionen (id → HTML) der aktuellen
    // Seite. Revisionen sind unveraenderlich; beim Blaettern im Vergleich ist
    // jede Revision einmal «diese» und einmal «Vorgaengerin» — ohne Cache
    // zwei Abrufe je Schritt. Geleert beim Seitenwechsel (_resetBodyCache).
    // Eingefroren: Alpines Reaktivitaet laesst nicht erweiterbare Objekte
    // unverpackt (nichts im Template haengt am Cache); `get`/`set` der Map
    // wirken trotzdem, weil Object.freeze die Eintraege nicht sperrt.
    _bodyCache: Object.freeze(new Map()),
    // Gespeicherter aktueller Stand fuer den Vergleich «aktuell», einmal je
    // Viewer-Sitzung vom Server; verworfen beim Schliessen und bei
    // `page-revisions:changed` (ein Save hat ihn ueberholt).
    _currentBody: null,
    // Name, der waehrend eines laufenden Anheften-Requests gespeichert werden
    // sollte — wird danach nachgeschickt statt still verworfen.
    _queuedLabel: null,
    // Nutzung der laufenden Viewer-Sitzung (Oeffnen bis Schliessen), gemeldet
    // als ein `revision.view` beim Schliessen (docs/usage-events.md). null =
    // Viewer zu. Nur Kategorien und eine Zahl, kein Inhalt.
    _viewerUsage: null,
  };
}

// Deckel des Body-Caches: aeltester Eintrag faellt (Map haelt Einfuegeordnung).
const BODY_CACHE_MAX = 40;

// Uebersetzter Satz zu einem Ladefehler: bekannter `error_code` → `error.<code>`,
// sonst der Fallback-Key. Nie die rohe Fehlermeldung (`HTTP 500: …`).
export function revisionErrorText(e, fallbackKey) {
  const code = e?.code;
  if (code) {
    const key = 'error.' + code;
    const msg = tRaw(key);
    if (msg && msg !== key) return msg;
  }
  return tRaw(fallbackKey);
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
    this.viewerDiffError = '';
    this.viewerDiffLocal = false;
    this._diffSeq++;
    this.viewerLabelDraft = rev.label || '';
    this.viewerLoading = true;

    if (firstOpen) {
      this._viewerUsage = { diff: false, current: false, steps: 0 };
      this.$nextTick(() => {
        const dlg = this.$refs?.viewerDialog;
        if (dlg && typeof dlg.showModal === 'function' && !dlg.open) dlg.showModal();
      });
    }

    try {
      const data = await this._fetchRevision(pageId, rev.id);
      if (seq !== this._viewerSeq) return;
      this.viewerBody = data.body;
      this.viewerPrevMeta = data.prev;
    } catch (e) {
      if (seq !== this._viewerSeq) return;
      console.error('[pageRevisions:viewer:load]', e);
      this.viewerError = revisionErrorText(e, 'editor.revisions.viewer.loadFailed');
    } finally {
      if (seq === this._viewerSeq) this.viewerLoading = false;
    }

    // Vergleichs-Tab beibehalten → Diff fuer die neu geladene Revision ziehen.
    if (seq === this._viewerSeq && this.viewerMode === 'diff' && !this.viewerError) await this._ensureDiff();
  },

  // Detail einer Revision: Body + Meta der Vorgaengerin laut Server. Der Cache
  // haelt beides, damit ein Treffer auch `prev` liefert.
  async _fetchRevision(pageId, revId) {
    const hit = this._bodyCache.get(revId);
    if (hit && hit.pageId === pageId) return hit;
    const data = await fetchJson(`/content/pages/${pageId}/revisions/${revId}`);
    if (!data?.revision) throw Object.assign(new Error('REVISION_NOT_FOUND'), { code: 'REVISION_NOT_FOUND' });
    const entry = { pageId, body: String(data.revision.body_html || ''), prev: data.prev || null };
    if (this._pageId === pageId) {
      this._bodyCache.set(revId, entry);
      if (this._bodyCache.size > BODY_CACHE_MAX) this._bodyCache.delete(this._bodyCache.keys().next().value);
    }
    return entry;
  },

  _resetBodyCache() {
    this._bodyCache = Object.freeze(new Map());
    this._currentBody = null;
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
  // erst nachladen, damit ‹/› von dort aus weiter funktioniert. Wurde der
  // Viewer waehrenddessen geschlossen, gewechselt oder die Seite verlassen,
  // bleibt er zu — sonst oeffnete ihn die spaete Antwort wieder.
  async gotoRev(direction) {
    const target = this._siblingRev(direction);
    if (!target) return;
    if (this._viewerUsage) this._viewerUsage.steps += 1;
    if (direction === 'prev' && !this.revisions.some(r => r.id === target.id) && this.hasMore) {
      const seq = this._viewerSeq;
      await this.loadMore();
      if (seq !== this._viewerSeq || !this.viewerOpen) return;
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
    this._reportViewerUsage();
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
    this.viewerDiffError = '';
    this.viewerDiffLocal = false;
    this.viewerDiffLoading = false;
    this._diffSeq++;
    this._currentBody = null;
    this.viewerLabelDraft = '';
    const dlg = this.$refs?.viewerDialog;
    if (dlg && dlg.open) dlg.close();
  },

  _reportViewerUsage() {
    const u = this._viewerUsage;
    this._viewerUsage = null;
    if (!u) return;
    trackUsageEvent('revision.view', {
      diff: u.diff ? 'yes' : 'no',
      current: u.current ? 'yes' : 'no',
      steps: u.steps,
    });
  },

  // Schliessen durch den User (Esc, ×, «Schliessen»): ein getippter, noch
  // nicht gespeicherter Name wird vorher gespeichert — wie beim Klick daneben.
  // `closeViewer` allein (Seitenwechsel, Restore) speichert nicht: dort gehoert
  // `_pageId` evtl. schon zur naechsten Seite.
  dismissViewer() {
    if (this.viewerOpen) this.saveViewerLabel();
    this.closeViewer();
  },

  // ←/→ blaettern durch die Revisionen — aber nicht mit Zusatztaste
  // (Umschalt+Pfeil erweitert eine Textauswahl), nicht im Namensfeld und nicht
  // auf der Tab-Leiste (dort wechseln die Pfeile den Tab, Alpine.data('tabs')).
  onViewerArrow(event, direction) {
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    const tgt = event.target;
    if (tgt?.closest?.('input, textarea, [role="tab"]')) return;
    event.preventDefault();
    if (direction === 'prev' ? this.hasPrevRev() : this.hasNextRev()) this.gotoRev(direction);
  },

  async setViewerMode(mode) {
    if (mode !== 'content' && mode !== 'diff') return;
    this.viewerMode = mode;
    if (mode === 'diff' && this._viewerUsage) this._viewerUsage.diff = true;
    // Waehrend der Body noch laedt kein Diff: er liefe gegen einen leeren
    // Body. openViewer zieht ihn nach dem Laden selbst nach.
    if (mode === 'diff' && !this.viewerLoading && !this.viewerDiffHtml && !this.viewerDiffUnchanged && !this.viewerError) {
      await this._ensureDiff();
    }
  },

  async setViewerCompare(compare) {
    if (compare !== 'prev' && compare !== 'current') return;
    if (this.viewerCompare === compare) return;
    this.viewerCompare = compare;
    if (compare === 'current' && this._viewerUsage) this._viewerUsage.current = true;
    this.viewerDiffHtml = '';
    this.viewerDiffUnchanged = false;
    this.viewerDiffError = '';
    this.viewerDiffLocal = false;
    if (this.viewerMode === 'diff' && !this.viewerLoading && !this.viewerError) await this._ensureDiff();
  },

  // Rechte Spalte ist immer die offene Version. Links die Vorgaengerin bzw. der
  // gespeicherte aktuelle Stand. Aelteste Revision ohne Vorgaengerin: leerer
  // String, alles erscheint als "hinzugefuegt".
  async _ensureDiff() {
    const app = window.__app;
    if (!this.viewerRev?.id) return;
    const seq = this._viewerSeq;
    const dseq = ++this._diffSeq;
    const current = () => seq === this._viewerSeq && dseq === this._diffSeq;
    this.viewerDiffLoading = true;
    this.viewerDiffError = '';
    try {
      const diffLib = await loadDiff();
      let leftHtml;
      let local = false;
      if (this.viewerCompare === 'current') {
        const cur = await this._loadCurrentBody();
        leftHtml = cur.html;
        local = cur.local;
      } else {
        leftHtml = await this._loadPrevRevisionBody();
      }
      if (!current()) return;
      const t = (k, p) => app?.t?.(k, p);
      const out = renderSideBySide(leftHtml, this.viewerBody, diffLib, {
        skipLabel: (n) => t('editor.revisions.viewer.diffSkip', { n }) || `… ${n} …`,
        imageLabel: (name) => name
          ? t('editor.revisions.viewer.diffImage', { name })
          : t('editor.revisions.viewer.diffImageUnnamed'),
      });
      this.viewerDiffHtml = out.html;
      this.viewerDiffUnchanged = out.unchanged;
      this.viewerDiffLocal = local;
    } catch (e) {
      console.error('[pageRevisions:viewer:diff]', e);
      if (current()) this.viewerDiffError = revisionErrorText(e, 'editor.revisions.viewer.diffFailed');
    } finally {
      if (current()) this.viewerDiffLoading = false;
    }
  },

  // Leerer String nur, wenn es wirklich keine Vorgaengerin gibt (allererste
  // Revision: alles erscheint als hinzugefuegt). Ein Ladefehler wirft — sonst
  // zeigte der Vergleich still den ganzen Text als neu.
  async _loadPrevRevisionBody() {
    const prev = this._viewerPrev();
    if (!prev?.id || !this._pageId) return '';
    const data = await this._fetchRevision(this._pageId, prev.id);
    return data.body;
  },

  // Gespeicherter Stand, nicht der Editor-Puffer: «Wiederherstellen» ersetzt den
  // gespeicherten Stand. Frisch vom Server, weil ein zweites Geraet inzwischen
  // geschrieben haben kann — einmal je Viewer-Sitzung (`_currentBody`), nicht
  // bei jedem ‹/›. Ist der Server nicht erreichbar, vergleicht der Viewer gegen
  // den lokal geladenen Stand und sagt das (`local: true` → Hinweis); dieser
  // Ersatz wird nicht gemerkt, der naechste Vergleich fragt den Server neu.
  async _loadCurrentBody() {
    const pageId = this._pageId;
    if (!pageId) return { html: '', local: false };
    if (this._currentBody?.pageId === pageId) return this._currentBody;
    try {
      const page = await contentRepo.loadPage(pageId, { fresh: true });
      const entry = { pageId, html: String(page?.html || ''), local: false };
      if (this._pageId === pageId) this._currentBody = entry;
      return entry;
    } catch (e) {
      console.error('[pageRevisions:viewer:current]', e);
      const app = window.__app;
      if (app?.currentPage?.id !== pageId) throw e;
      return { pageId, html: String(app.originalHtml || ''), local: true };
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

  // Laeuft gerade ein Anheften-Request, wird der Name danach nachgeschickt
  // (setPinned → `_queuedLabel`) — sonst ginge ein schnell nachgetippter Name
  // still verloren.
  async saveViewerLabel() {
    const rev = this.viewerRev;
    if (!rev?.pinned) return;
    const label = this.viewerLabelDraft.trim();
    if (label === (rev.label || '')) return;
    if (this.pinningId) {
      this._queuedLabel = { rev, label, pageId: this._pageId };
      return;
    }
    await this.setPinned(rev, true, label);
  },
};
