// Methoden für die Ideen-Karte (Sub-Komponente). Verwaltet User-Notizen und
// Pendenzen pro Seite ODER pro Kapitel — Scope-Switch via app.ideenScope.
// Ein Einabschnitts-Kapitel ist EIN Ort (ideen-shared.js#ideenPlace): die Karte
// zeigt dort die Ideen des Abschnitts UND des Kapitels, egal ob sie neben dem
// Editor oder neben der Kapitelbewertung offen ist, und legt neue am Abschnitt an.
// Offene Ideen werden im Seiten-Chat als Kontext eingespielt (Backend-seitig
// via getOpenIdeen: Page-Ideen + Chapter-Ideen des umliegenden Kapitels).
//
// Die Bearbeitungsstufe (`status`) ist dieselbe Achse wie im Ideen-Board; SSoT
// der Stufen ist ideen-shared.js. „Offen" heisst hier wie dort `offen` ODER
// `in_arbeit` — `verworfen` zaehlt NICHT als offen und setzt darum auch keine
// Sidebar-Plakette.

import { fetchJson, autosizeTextarea, mountAutosizeTextarea } from '../utils.js';
import { createIdee, patchIdee, deleteIdee as removeIdee, overlayPendingIdeen } from '../repo/ideen-queue.js';
import { IDEE_STATUSES, ideeStatus, isOpenIdee, normalizeIdeeStages, compareIdeeManual, IDEE_MAX_LEN, ideenPlace } from './ideen-shared.js';
import { isTempId as isTempPageId, resolveTempId } from '../repo/structure-queue.js';
import { loadToken } from '../cards/book-guard.js';

// Aktive Scope-IDs aus Root lesen. Liefert { kind, id } oder null.
function _activeScope(app) {
  if (!app) return null;
  if (app.ideenScope === 'chapter') {
    return app.ideenChapterId ? { kind: 'chapter', id: app.ideenChapterId } : null;
  }
  return app.currentPage?.id ? { kind: 'page', id: app.currentPage.id } : null;
}

// Ort der Karte: { pageId, chapterId } (ideenPlace) oder null.
function _activePlace(app) {
  return ideenPlace(Alpine.store('nav').tree, _activeScope(app));
}

// Hängt die Idee an diesem Ort?
function _inPlace(idee, place) {
  if (!idee || !place) return false;
  if (place.pageId != null && idee.page_id != null && String(idee.page_id) === String(place.pageId)) return true;
  return place.chapterId != null && idee.chapter_id != null && String(idee.chapter_id) === String(place.chapterId);
}

export const ideenMethods = {
  // ── Lifecycle ────────────────────────────────────────────────────────────
  async loadIdeen() {
    const app = window.__app;
    const scope = _activeScope(app);
    const place = _activePlace(app);
    if (!scope || !place) { this.ideen = []; return; }
    // Abschnitts-/Kapitelwechsel während des Fetch: die Ideen des alten Scopes
    // dürfen nicht in der Karte des neuen landen (auch nicht als Plaketten-Zahl).
    const fresh = loadToken(this, '_ideenLoadSeq');
    const isCurrent = () => {
      const now = _activeScope(window.__app);
      return fresh() && now?.kind === scope.kind && String(now.id) === String(scope.id);
    };
    this.loading = true;
    try {
      // Offline angelegter Abschnitt (negative, temporäre ID): auf dem Server
      // gibt es ihn noch nicht — nur die vorgemerkten Ideen zeigen. Ist er
      // inzwischen angelegt, gilt seine echte ID (repo/structure-queue.js).
      let pageId = place.pageId;
      if (pageId != null && isTempPageId(pageId)) pageId = resolveTempId(pageId);
      const [pageRows, chapterRows] = await Promise.all([
        pageId ? fetchJson(`/ideen?page_id=${pageId}`) : [],
        place.chapterId ? fetchJson(`/ideen?chapter_id=${place.chapterId}`) : [],
      ]);
      const rows = [...(Array.isArray(pageRows) ? pageRows : []), ...(Array.isArray(chapterRows) ? chapterRows : [])];
      // Offline vorgemerkte Writes darüberlegen (repo/ideen-queue.js).
      const merged = await overlayPendingIdeen(rows, (r) => _inPlace(r, place));
      if (!isCurrent()) return;
      this.ideen = this._sortIdeen(merged);
      this.errorMessage = '';
      this._publishIdeenCount();
      await this._loadStages();
    } catch (e) {
      if (!isCurrent()) return;
      this.errorMessage = app.t('ideen.error.load');
      this.ideen = [];
    } finally {
      if (fresh.latest()) this.loading = false;
    }
  },

  // Aktive Stufen des Buches (book_settings.ideen_stages) — einmal je Buch.
  // Non-fatal: ohne Antwort bleiben alle Stufen angeboten, der Server lehnt
  // eine abgeschaltete dann mit IDEE_STATUS_INACTIVE ab.
  async _loadStages() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this._stagesBookId === bookId) return;
    try {
      const data = await fetchJson(`/ideen/stages?book_id=${bookId}`);
      this.stages = normalizeIdeeStages(data?.stages);
      this._stagesBookId = bookId;
    } catch { /* alle Stufen bleiben angeboten */ }
  },

  // Das Board hat die Stufen umgeschaltet (Event aus ideen-board/actions.js).
  _onStagesChanged(e) {
    const { bookId, stages } = e?.detail || {};
    if (!bookId || bookId !== Alpine.store('nav').selectedBookId) return;
    this.stages = normalizeIdeeStages(stages);
    this._stagesBookId = bookId;
  },

  resetIdeen() {
    this.ideen = [];
    this.stages = [...IDEE_STATUSES];
    this._stagesBookId = null;
    this.newContent = '';
    this.editingId = null;
    this.editingDraft = '';
    this.movingId = null;
    this.moveTargetId = '';
    this.linkPickerIdeeId = null;
    this.linkPickerTargetId = '';
    this._releasePickerPopover?.();
    this.closeActionMenu();
    this.errorMessage = '';
    this.busy = false;
  },

  // ── Aktionsmenü (⋯-Knopf, Rechtsklick/Long-Press auf die Zeile) ──────────
  // Mechanik aus action-menu.js; Ziel = Ideen-ID. Picker, die aus dem Menü
  // öffnen (Verknüpfen, Verschieben), verankern an `actionMenuAnchor()` — dem
  // Knopf bzw. der Zeile, die stehen bleibt, wenn das Menü verschwindet.
  openMenu(ev, idee) {
    this.openActionMenu(ev, `idee:${idee.id}`, idee.id);
  },

  // Plain Methode statt Getter — siehe Hinweis bei offeneIdeen().
  menuOpenIdee() {
    if (this.actionMenuTarget == null) return null;
    return (this.ideen || []).find(i => i.id === this.actionMenuTarget) || null;
  },

  // ── CRUD ─────────────────────────────────────────────────────────────────
  async addIdee() {
    const app = window.__app;
    const content = (this.newContent || '').trim();
    if (!content) { this.errorMessage = app.t('ideen.error.contentRequired'); return; }
    if (content.length > IDEE_MAX_LEN) { this.errorMessage = app.t('ideen.error.contentTooLong'); return; }
    const place = _activePlace(app);
    const bookId = Alpine.store('nav').selectedBookId;
    if (!place || !bookId) return;

    this.busy = true;
    try {
      // Am Abschnitt, wo es einen gibt — beim Einabschnitts-Kapitel auch aus
      // der Kapitelbewertung heraus (ein Ort, ein Anker).
      const body = { book_id: bookId, content };
      if (place.pageId != null) body.page_id = place.pageId;
      else                      body.chapter_id = place.chapterId;
      const row = await createIdee(body);
      // Neueste offene Idee nach oben (Liste ist offen-zuerst, dann created_at DESC)
      this.ideen = [row, ...this.ideen];
      this.newContent = '';
      this.errorMessage = '';
      this._publishIdeenCount();
    } catch (e) {
      this.errorMessage = app.t('ideen.error.save');
    } finally {
      this.busy = false;
    }
  },

  startEditIdee(idee) {
    this.editingId = idee.id;
    this.editingDraft = idee.content || '';
  },

  mountIdeeEditInput: mountAutosizeTextarea,
  autosizeIdeeEditInput: autosizeTextarea,

  cancelEditIdee() {
    this.editingId = null;
    this.editingDraft = '';
  },

  // Speichern und schliessen — Enter, Cmd/Ctrl+S (`$editKeys`) und Klick ausserhalb.
  // Leerer Text wird verworfen; ein laufender Request wird nicht doppelt ausgelöst.
  commitEditIdee(idee) {
    if (this.busy || this.editingId !== idee.id) return;
    if (!(this.editingDraft || '').trim()) { this.cancelEditIdee(); return; }
    return this.saveEditIdee(idee);
  },

  async saveEditIdee(idee) {
    const app = window.__app;
    const content = (this.editingDraft || '').trim();
    if (!content) { this.errorMessage = app.t('ideen.error.contentRequired'); return; }
    if (content.length > IDEE_MAX_LEN) { this.errorMessage = app.t('ideen.error.contentTooLong'); return; }
    if (content === idee.content) { this.cancelEditIdee(); return; }

    this.busy = true;
    try {
      const row = await patchIdee(idee, { content });
      this._replaceIdee(row);
      this.editingId = null;
      this.editingDraft = '';
      this.errorMessage = '';
      this._publishIdeenCount();
    } catch (e) {
      this.errorMessage = app.t('ideen.error.save');
    } finally {
      this.busy = false;
    }
  },

  // Einziger Schreibpfad der Stufen-Achse auf dieser Karte — das Menue ruft ihn
  // je Ziel-Stufe auf (gleiche Bauart wie setIdeeStatus im Board).
  async setIdeeStatus(idee, status) {
    const app = window.__app;
    if (!this.statuses().includes(status) || ideeStatus(idee) === status) return;
    this.busy = true;
    try {
      const row = await patchIdee(idee, { status });
      this._replaceIdee(row);
      // Sort halten: offene oben, abgeschlossene unten — innerhalb nach created_at DESC
      this.ideen = this._sortIdeen(this.ideen);
      this.errorMessage = '';
      this._publishIdeenCount();
    } catch (e) {
      this.errorMessage = app.t('ideen.error.save');
    } finally {
      this.busy = false;
    }
  },

  // Nur die AKTIVEN Stufen des Buches stehen als Ziel im Menue; das Badge zeigt
  // weiter den echten Status, auch wenn dessen Stufe abgeschaltet ist.
  statuses() { return this.stages || IDEE_STATUSES; },
  statusLabel(s) { return window.__app.t(`ideen.status.${s}`); },
  ideeStatus(idee) { return ideeStatus(idee); },
  isOpenIdee(idee) { return isOpenIdee(idee); },

  // ── Move ─────────────────────────────────────────────────────────────────
  // Popover am Trigger (Picker-Popover: public/js/picker-popover.js).
  startMoveIdee(anchor, idee) {
    if (!idee) return;
    this._openPickerPopover(anchor, 'ideenMovePopover', () => this.cancelMoveIdee());
    this.movingId = idee.id;
    this.moveTargetId = '';
  },

  cancelMoveIdee() {
    this.movingId = null;
    this.moveTargetId = '';
    this._releasePickerPopover();
  },

  movingIdee() { return this._findIdee(this.movingId); },

  // Aus zentralem Picker — Idee wird aus this.movingId geholt.
  async confirmMoveCurrentIdee() {
    const idee = this.movingIdee();
    if (!idee) return;
    return this.confirmMoveIdee(idee);
  },

  // Ziel aus dem Picker: 'page:<id>' oder 'chapter:<id>' — der Umzug darf die
  // Ankerart wechseln (Kapitel → Abschnitt und umgekehrt), der Server leert
  // den alten Anker.
  async confirmMoveIdee(idee) {
    const app = window.__app;
    const [kind, rawId] = String(this.moveTargetId || '').split(':');
    const targetId = Number(rawId);
    if (!targetId || (kind !== 'page' && kind !== 'chapter')) return;

    this.busy = true;
    try {
      const row = await patchIdee(idee, kind === 'page' ? { page_id: targetId } : { chapter_id: targetId });
      // Kapitel-Idee an den eigenen Abschnitt (Einabschnitts-Kapitel): bleibt in
      // der Liste, die Plaketten rechnet _publishIdeenCount neu.
      const stays = _inPlace(row || { [kind === 'page' ? 'page_id' : 'chapter_id']: targetId }, _activePlace(app));
      this.ideen = stays && row ? this.ideen.map(i => (i.id === idee.id ? row : i)) : this.ideen.filter(i => i.id !== idee.id);
      this.cancelMoveIdee();
      this.errorMessage = '';
      this._publishIdeenCount();
      // Ziel-Counts bumpen (Backend lehnt Move bei abgeschlossener Idee ab → +1 sicher).
      if (!stays) this._bumpTreeCountForTarget(kind, targetId);
    } catch (e) {
      this.errorMessage = app.t('ideen.error.move');
    } finally {
      this.busy = false;
    }
  },

  async deleteIdee(idee) {
    const app = window.__app;
    if (!await app.appConfirm({
      message: app.t('ideen.confirmDelete'),
      confirmLabel: app.t('common.delete'),
      danger: true,
    })) return;
    this.busy = true;
    try {
      await removeIdee(idee);
      this.ideen = this.ideen.filter(i => i.id !== idee.id);
      this.errorMessage = '';
      this._publishIdeenCount();
    } catch (e) {
      this.errorMessage = app.t('ideen.error.delete');
    } finally {
      this.busy = false;
    }
  },

  // ── Helpers ──────────────────────────────────────────────────────────────
  // Knopf-Plakette = alle offenen Ideen der Karte (beim Einabschnitts-Kapitel
  // Abschnitt + Kapitel); die Baum-Plaketten bleiben je Anker, wie der Server
  // sie zählt.
  _publishIdeenCount() {
    const app = window.__app;
    const place = _activePlace(app);
    if (!place) return;
    const open = (this.ideen || []).filter(isOpenIdee);
    if (place.pageId != null && app.currentPage?.id === place.pageId) app.currentPageIdeenOpenCount = open.length;
    if (place.chapterId != null && app.ideenChapterId === place.chapterId) app.currentChapterIdeenOpenCount = open.length;
    if (place.pageId != null) {
      this._setTreeIdeenCount('page', place.pageId, open.filter(i => String(i.page_id) === String(place.pageId)).length);
    }
    if (place.chapterId != null) {
      this._setTreeIdeenCount('chapter', place.chapterId, open.filter(i => String(i.chapter_id) === String(place.chapterId)).length);
    }
  },

  // Patched ideenCounts/chapterIdeenCounts-Map im badges-Store für Sidebar-Indikator.
  // `count` null/0 entfernt den Eintrag.
  _setTreeIdeenCount(kind, id, count) {
    const badges = Alpine.store('badges');
    if (!badges || !id) return;
    const mapKey = kind === 'page' ? 'ideenCounts' : 'chapterIdeenCounts';
    const next = { ...(badges[mapKey] || {}) };
    if (count > 0) next[id] = count;
    else           delete next[id];
    badges[mapKey] = next;
  },

  _bumpTreeCountForTarget(kind, targetId) {
    const badges = Alpine.store('badges');
    if (!badges) return;
    const mapKey = kind === 'page' ? 'ideenCounts' : 'chapterIdeenCounts';
    const prev = (badges[mapKey] && badges[mapKey][targetId]) || 0;
    const next = { ...(badges[mapKey] || {}) };
    next[targetId] = prev + 1;
    badges[mapKey] = next;
  },

  _replaceIdee(row) {
    this.ideen = this.ideen.map(i => (i.id === row.id ? row : i));
  },

  // Offen zuerst, dann nach Stufe; innerhalb einer Stufe die Reihenfolge, die
  // der Autor im Ideen-Board von Hand gesetzt hat (`sort_order`, neue oben) —
  // sonst ordnete die Karte neben dem Editor dieselben Pendenzen anders als das
  // Board.
  _sortIdeen(arr) {
    return [...arr].sort((a, b) => {
      const ao = isOpenIdee(a) ? 0 : 1;
      const bo = isOpenIdee(b) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      const as = IDEE_STATUSES.indexOf(ideeStatus(a));
      const bs = IDEE_STATUSES.indexOf(ideeStatus(b));
      if (as !== bs) return as - bs;
      return compareIdeeManual(a, b);
    });
  },

  // Hinweis: Keine getter — `...ideenMethods`-Spread im Alpine.data-Factory ruft
  // getters sofort auf, mit `this === ideenMethods` (kein `ideen`-Feld) → Crash.
  // Plain Methoden funktionieren identisch im Template via `offeneIdeen()`.
  offeneIdeen() {
    return (this.ideen || []).filter(isOpenIdee);
  },
  // Abgeschlossen = erledigt ODER verworfen. Beide gehoeren unter denselben
  // Strich: erledigt ist getan, verworfen ist entschieden — offen ist keins von
  // beiden. Welches davon, sagt die Plakette an der Zeile.
  abgeschlosseneIdeen() {
    return (this.ideen || []).filter(i => !isOpenIdee(i));
  },
};
