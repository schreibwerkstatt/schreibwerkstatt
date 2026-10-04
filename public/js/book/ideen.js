// Methoden für die Ideen-Karte (Sub-Komponente). Verwaltet User-Notizen und
// Pendenzen pro Seite ODER pro Kapitel — Scope-Switch via app.ideenScope.
// Offene Ideen werden im Seiten-Chat als Kontext eingespielt (Backend-seitig
// via getOpenIdeen: Page-Ideen + Chapter-Ideen des umliegenden Kapitels).
//
// Die Bearbeitungsstufe (`status`) ist dieselbe Achse wie im Ideen-Board; SSoT
// der Stufen ist ideen-shared.js. „Offen" heisst hier wie dort `offen` ODER
// `in_arbeit` — `verworfen` zaehlt NICHT als offen und setzt darum auch keine
// Sidebar-Plakette.

import { fetchJson } from '../utils.js';
import { EVT } from '../events.js';
import { IDEE_STATUSES, ideeStatus, isOpenIdee, normalizeIdeeStages } from './ideen-shared.js';
import { computePopoverPos, refinePopoverPos } from '../popover-anchor.js';
import { attachDismiss, detachDismiss } from '../cards/dismiss.js';

// Aktive Scope-IDs aus Root lesen. Liefert { kind, id } oder null.
function _activeScope(app) {
  if (!app) return null;
  if (app.ideenScope === 'chapter') {
    return app.ideenChapterId ? { kind: 'chapter', id: app.ideenChapterId } : null;
  }
  return app.currentPage?.id ? { kind: 'page', id: app.currentPage.id } : null;
}

export const ideenMethods = {
  // ── Lifecycle ────────────────────────────────────────────────────────────
  async loadIdeen() {
    const app = window.__app;
    const scope = _activeScope(app);
    if (!scope) { this.ideen = []; return; }
    this.loading = true;
    try {
      const qs = scope.kind === 'chapter' ? `chapter_id=${scope.id}` : `page_id=${scope.id}`;
      const rows = await fetchJson(`/ideen?${qs}`);
      this.ideen = Array.isArray(rows) ? rows : [];
      this.errorMessage = '';
      this._publishIdeenCount();
      await this._loadStages();
    } catch (e) {
      this.errorMessage = app.t('ideen.error.load');
      this.ideen = [];
    } finally {
      this.loading = false;
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
    this.menuOpenId = null;
    this._detachMenuListeners?.();
    this.errorMessage = '';
    this.busy = false;
  },

  // ── Meatball-Menu (Popover) ───────────────────────────────────────────────
  openMenu(ev, idee) {
    if (this.menuOpenId === idee.id) { this.closeMenu(); return; }
    // Hover-Tooltip des Triggers wegblenden — er hinge sonst über dem Menü.
    window.dispatchEvent(new CustomEvent(EVT.TOOLTIP_HIDE));
    this._triggerRect = ev.currentTarget.getBoundingClientRect();
    // Schätzung vor dem Render; danach mit der echten Popover-Grösse nachjustieren.
    // Das Menü ist je nach Stufe unterschiedlich lang (die aktuelle Stufe steht
    // nicht als Ziel drin) — eine feste Höhe würde es beim Hochklappen zu weit
    // über den Button schieben.
    this.menuPos = computePopoverPos(this._triggerRect, 220, 200);
    this.menuOpenId = idee.id;
    this._attachMenuListeners();
    this.$nextTick(() => {
      const pos = refinePopoverPos(this.$refs.ideenMenu, this._triggerRect);
      if (pos) this.menuPos = pos;
    });
  },

  closeMenu() {
    this.menuOpenId = null;
    this._detachMenuListeners();
  },

  // Plain Methode statt Getter — siehe Hinweis bei offeneIdeen().
  menuOpenIdee() {
    if (this.menuOpenId == null) return null;
    return (this.ideen || []).find(i => i.id === this.menuOpenId) || null;
  },

  _attachMenuListeners() {
    this._menuCloseHandler ??= attachDismiss(() => this.closeMenu());
  },

  _detachMenuListeners() {
    detachDismiss(this, '_menuCloseHandler');
  },

  // ── CRUD ─────────────────────────────────────────────────────────────────
  async addIdee() {
    const app = window.__app;
    const content = (this.newContent || '').trim();
    if (!content) { this.errorMessage = app.t('ideen.error.contentRequired'); return; }
    if (content.length > 4000) { this.errorMessage = app.t('ideen.error.contentTooLong'); return; }
    const scope = _activeScope(app);
    const bookId = Alpine.store('nav').selectedBookId;
    if (!scope || !bookId) return;

    this.busy = true;
    try {
      const body = { book_id: bookId, content };
      if (scope.kind === 'page') body.page_id = scope.id;
      else                       body.chapter_id = scope.id;
      const row = await fetchJson('/ideen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
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

  cancelEditIdee() {
    this.editingId = null;
    this.editingDraft = '';
  },

  async saveEditIdee(idee) {
    const app = window.__app;
    const content = (this.editingDraft || '').trim();
    if (!content) { this.errorMessage = app.t('ideen.error.contentRequired'); return; }
    if (content.length > 4000) { this.errorMessage = app.t('ideen.error.contentTooLong'); return; }
    if (content === idee.content) { this.cancelEditIdee(); return; }

    this.busy = true;
    try {
      const row = await fetchJson(`/ideen/${idee.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
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
      const row = await fetchJson(`/ideen/${idee.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
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
  startMoveIdee(idee) {
    this.movingId = idee.id;
    this.moveTargetId = '';
  },

  cancelMoveIdee() {
    this.movingId = null;
    this.moveTargetId = '';
  },

  // Aus zentralem Picker — Idee wird aus this.movingId geholt.
  async confirmMoveCurrentIdee() {
    const idee = (this.ideen || []).find(i => i.id === this.movingId);
    if (!idee) return;
    return this.confirmMoveIdee(idee);
  },

  async confirmMoveIdee(idee) {
    const app = window.__app;
    const targetId = parseInt(this.moveTargetId, 10);
    if (!targetId) return;

    this.busy = true;
    try {
      // Body je nach Idee-Scope (within-kind move): Page-Idee → page_id,
      // Chapter-Idee → chapter_id. Backend lehnt Cross-Kind ab.
      const body = idee.page_id != null ? { page_id: targetId } : { chapter_id: targetId };
      await fetchJson(`/ideen/${idee.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      this.ideen = this.ideen.filter(i => i.id !== idee.id);
      this.movingId = null;
      this.moveTargetId = '';
      this.errorMessage = '';
      this._publishIdeenCount();
      // Ziel-Counts bumpen (Backend lehnt Move bei abgeschlossener Idee ab → +1 sicher).
      this._bumpTreeCountForTarget(idee, targetId);
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
      await fetchJson(`/ideen/${idee.id}`, { method: 'DELETE' });
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
  _publishIdeenCount() {
    const app = window.__app;
    const scope = _activeScope(app);
    if (!scope) return;
    const count = (this.ideen || []).filter(isOpenIdee).length;
    if (scope.kind === 'page') {
      if (app.currentPage?.id === scope.id) app.currentPageIdeenOpenCount = count;
    } else {
      if (app.ideenChapterId === scope.id) app.currentChapterIdeenOpenCount = count;
    }
    this._setTreeIdeenCount(scope, count);
  },

  // Patched ideenCounts/chapterIdeenCounts-Map im badges-Store für Sidebar-Indikator.
  _setTreeIdeenCount(scope, count) {
    const badges = Alpine.store('badges');
    if (!badges || !scope?.id) return;
    if (scope.kind === 'page') {
      const next = { ...(badges.ideenCounts || {}) };
      if (count > 0) next[scope.id] = count;
      else           delete next[scope.id];
      badges.ideenCounts = next;
    } else {
      const next = { ...(badges.chapterIdeenCounts || {}) };
      if (count > 0) next[scope.id] = count;
      else           delete next[scope.id];
      badges.chapterIdeenCounts = next;
    }
  },

  _bumpTreeCountForTarget(idee, targetId) {
    const badges = Alpine.store('badges');
    if (!badges) return;
    const isPage = idee.page_id != null;
    const mapKey = isPage ? 'ideenCounts' : 'chapterIdeenCounts';
    const prev = (badges[mapKey] && badges[mapKey][targetId]) || 0;
    const next = { ...(badges[mapKey] || {}) };
    next[targetId] = prev + 1;
    badges[mapKey] = next;
  },

  _replaceIdee(row) {
    this.ideen = this.ideen.map(i => (i.id === row.id ? row : i));
  },

  _sortIdeen(arr) {
    return [...arr].sort((a, b) => {
      const ao = isOpenIdee(a) ? 0 : 1;
      const bo = isOpenIdee(b) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      // created_at DESC
      return (b.created_at || '').localeCompare(a.created_at || '');
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
