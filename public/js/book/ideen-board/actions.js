// Laden, Filtern, Schreiben und Drag&Drop des Ideen-Boards.
// `this` = die ideenBoardCard-Instanz.

import { fetchJson } from '../../utils.js';
import { loadSortable } from '../../lazy-libs.js';
import {
  patchSortableOnce, revertSortable, markDragIgnore, unmarkDragIgnore, BASE_SORTABLE_OPTS,
} from '../../sortable-dnd.js';
import {
  IDEE_STATUSES, IDEE_OPTIONAL_STATUSES, IDEE_OPEN_STATUSES, ideeStatus, ideeLaneKey, isOpenIdee, isBookIdee, LANE_BOOK,
  normalizeIdeeStages,
} from '../ideen-shared.js';
import {
  buildLaneOrder, buildBoard, chapterFilterOptions, statusTotals, boardColumns, IDEE_SORT_MANUAL,
  columnSortOf, nextColumnSort, compareIdeeManual, cellOrderAfterDrop,
} from './model.js';
import { memoMethods } from '../../cards/card-memo.js';
import { ideenBoardTreeDrop } from './tree-drop.js';
import { EVT } from '../../events.js';

// Key in einer Klapp-Liste umschalten — immer als neue Liste (siehe
// toggleLaneFold).
function toggleKey(list, key) {
  const arr = Array.isArray(list) ? list : [];
  return arr.includes(key) ? arr.filter(k => k !== key) : [...arr, key];
}

export const ideenBoardActions = {
  // ── Ansicht ──────────────────────────────────────────────────────────────
  // Spalten = aktive Stufen + abgeschaltete, in denen noch Ideen stehen
  // (model.js#boardColumns). Stufen-Knoepfe und Drop-Ziele bieten dagegen nur
  // die AKTIVEN an (`isStageActive`).
  statuses() {
    return this._memo('columns', [this.stages, this.ideen], () => boardColumns(this.stages, this.ideen));
  },
  isStageActive(s) { return (this.stages || IDEE_STATUSES).includes(s); },
  statusLabel(s) { return window.__app.t(`ideen.status.${s}`); },
  inactiveStageTip(s) { return window.__app.t('ideenBoard.stageInactive', { status: this.statusLabel(s) }); },

  // ── Stufen pro Buch ──────────────────────────────────────────────────────
  // `offen`/`erledigt` sind fest, die uebrigen schaltet das Buch zu
  // (book_settings.ideen_stages, buchweit). Der Server normalisiert und
  // antwortet mit dem gespeicherten Stand — der wird uebernommen, nicht der
  // eigene Wunsch.
  optionalStages() { return IDEE_OPTIONAL_STATUSES; },
  async toggleStage(s) {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !IDEE_OPTIONAL_STATUSES.includes(s)) return;
    const cur = this.stages || IDEE_STATUSES;
    const next = cur.includes(s) ? cur.filter(x => x !== s) : [...cur, s];
    this.busy = true;
    try {
      const data = await fetchJson('/ideen/stages', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, stages: next }),
      });
      this.stages = normalizeIdeeStages(data?.stages);
      this.errorMessage = '';
      this._memos = {};
      window.dispatchEvent(new CustomEvent(EVT.IDEEN_STAGES_CHANGED, { detail: { bookId, stages: this.stages } }));
      await this._ensureBoardSortables();
    } catch {
      this.errorMessage = app.t('ideenBoard.error.save');
    } finally {
      this.busy = false;
    }
  },
  ideeStatus(idee) { return ideeStatus(idee); },

  // Ein Pass ueber den Bestand fuer alle Bahnen und Spalten (Memo-Pattern:
  // das Template fragt das Board mehrfach pro Render — Bahnen, Karten, Zaehler).
  board() {
    return this._memo('board',
      [this.ideen, this.laneOrder, this.filterChapterId, this.showErledigt, this.showVerworfen, this.query,
        this.collapsedLanes, this.collapsedChapters, this.columnSort],
      () => buildBoard({
        ideen: this.ideen,
        laneOrder: this.laneOrder,
        filterChapterId: this.filterChapterId,
        showErledigt: this.showErledigt,
        showVerworfen: this.showVerworfen,
        query: this.query,
        collapsedLanes: this.collapsedLanes,
        collapsedChapters: this.collapsedChapters,
        columnSort: this.columnSort,
      }));
  },
  lanes() { return this.board().lanes; },
  hiddenCount() { return this.board().hiddenByFilter; },
  visibleCount() { return this.board().visible; },
  totalCount() { return this.board().total; },
  statusTotal(s) {
    return this._memo('statusTotals', [this.ideen], () => statusTotals(this.ideen))[s] || 0;
  },
  // Trefferzaehler der Filterleiste. Nennt das Ausgeblendete ausdruecklich —
  // ein blosses „12" liesse offen, ob die uebrigen erledigt, gefiltert oder weg
  // sind.
  countLabel() {
    const app = window.__app;
    const hidden = this.hiddenCount();
    return hidden > 0
      ? app.t('ideenBoard.countFiltered', { n: this.visibleCount(), total: this.totalCount(), hidden })
      : app.t('ideenBoard.countAll', { n: this.totalCount() });
  },
  // ── Sortierung pro Spalte ────────────────────────────────────────────────
  // Jede Stufe sortiert fuer sich (`columnSort`, Filter-Scope `ideenBoard`);
  // ohne Eintrag steht die Spalte in ihrer urspruenglichen, per Drag gesetzten
  // Position (`sort_order`). Nur dort zieht man innerhalb der Spalte.
  colSort(s) { return columnSortOf(this.columnSort, s); },
  isColumnManual(s) { return this.colSort(s).by === IDEE_SORT_MANUAL; },
  setColumnSort(s, by) { this.columnSort = nextColumnSort(this.columnSort, s, by); },
  resetColumnSort(s) { this.columnSort = nextColumnSort(this.columnSort, s, null); },
  sortDirIcon(s) { return this.colSort(s).dir === 'desc' ? '/icons.svg#arrow-down' : '/icons.svg#arrow-up'; },
  sortKeyLabel(k) { return window.__app.t(`ideenBoard.sort.${k}`); },
  sortKeyTip(s, k) {
    const app = window.__app;
    const cur = this.colSort(s);
    if (cur.by !== k) return app.t('ideenBoard.sort.by', { key: this.sortKeyLabel(k) });
    return app.t(cur.dir === 'desc' ? 'ideenBoard.sort.desc' : 'ideenBoard.sort.asc', { key: this.sortKeyLabel(k) });
  },
  chapterOptions() {
    return this._memo('chapterOptions', [this.ideen, this.laneOrder],
      () => chapterFilterOptions(this.ideen, this.laneOrder));
  },
  laneLabel(lane) {
    if (lane.kind === 'unknown') return window.__app.t('ideenBoard.laneUnknown');
    if (lane.kind === 'book') return window.__app.t('ideenBoard.laneBook');
    return lane.label || window.__app.t(lane.kind === 'chapter' ? 'ideenBoard.laneChapterFallback' : 'ideenBoard.lanePageFallback');
  },
  // ── Klappen ──────────────────────────────────────────────────────────────
  // Zwei unabhaengige Achsen, beide als Liste von Bahn-Keys im Filter-Scope
  // `ideenBoard` (per Buch im localStorage, siehe cards/ideen-board-card.js):
  //   collapsedLanes    — die KARTEN dieser Bahn sind eingeklappt.
  //   collapsedChapters — die SEITEN-BAHNEN dieses Kapitels sind in die
  //                       Kapitelzeile gefaltet.
  // Sie sind getrennt, weil sie Verschiedenes beantworten: „zeig mir die
  // Gliederung des Kapitels ohne seine Seiten" und „zeig mir die Bahn, aber
  // nicht ihre Notizen".
  //
  // Immer eine NEUE Liste schreiben, nie die bestehende mutieren: der
  // Board-Memo vergleicht seine Deps per Identitaet, und die Default-Liste des
  // Filter-Scopes ist ein geteiltes Objekt (filter-persist.js legt sie beim
  // Restore direkt auf die Karte).
  toggleLaneFold(lane) {
    if (!lane?.key) return;
    this.collapsedLanes = toggleKey(this.collapsedLanes, lane.key);
  },
  toggleChapterFold(lane) {
    if (lane?.kind !== 'chapter') return;
    this.collapsedChapters = toggleKey(this.collapsedChapters, lane.key);
  },
  // Beschriftung des Kapitel-Griffs: wie viele BELEGTE Seiten-Bahnen darunter
  // haengen (leere erscheinen ohnehin nicht, und eine Zahl, die sie mitzaehlte,
  // liesse beim Aufklappen weniger Zeilen erscheinen als angekuendigt).
  foldChapterTip(row) {
    const app = window.__app;
    return row.childCollapsed
      ? app.t('ideenBoard.chapterExpand', { n: row.childLanes, ideen: row.foldedCount })
      : app.t('ideenBoard.chapterCollapse', { n: row.childLanes });
  },
  foldLaneTip(row) {
    const app = window.__app;
    return app.t(row.collapsed ? 'ideenBoard.laneExpand' : 'ideenBoard.laneCollapse', { n: row.count });
  },

  // Sprung an die Stelle im Buch, an der die Pendenz haengt. Der Hash-Router ist
  // SSoT der Navigation — hier wird nur das Ziel gebaut.
  openLane(lane) {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !lane || lane.kind === 'unknown' || lane.kind === 'book') return;
    location.hash = lane.kind === 'chapter'
      ? `#book/${bookId}/kapitel/${lane.id}`
      : `#book/${bookId}/page/${lane.id}`;
  },

  // Drop einer Buch-Idee aufs Inhaltsverzeichnis (tree-drop.js).
  ...ideenBoardTreeDrop,

  // Memo-Helper (cards/card-memo.js); `this._memos` wird in loadBoard/resetBoard geleert.
  ...memoMethods,

  // ── Laden ────────────────────────────────────────────────────────────────
  async loadBoard() {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.resetBoard(); return; }
    this.loading = true;
    this._memos = {};
    try {
      const data = await fetchJson(`/ideen/board?book_id=${bookId}`);
      this.ideen = Array.isArray(data?.ideen) ? data.ideen : [];
      this.stages = normalizeIdeeStages(data?.stages);
      this.laneOrder = buildLaneOrder(Alpine.store('nav').tree);
      this.errorMessage = '';
      this._publishCounts();
    } catch {
      this.errorMessage = app.t('ideenBoard.error.load');
      this.ideen = [];
    } finally {
      this.loading = false;
      this._memos = {};
      await this._ensureBoardSortables();
    }
  },

  resetBoard() {
    this.ideen = [];
    this.stages = [...IDEE_STATUSES];
    this.laneOrder = [];
    this.newContent = '';
    this.newLaneKey = LANE_BOOK;
    this.assigningId = null;
    this.assignLaneKey = '';
    this.editingId = null;
    this.editingDraft = '';
    this.linkPickerIdeeId = null;
    this.linkPickerKind = 'research';
    this.linkPickerTargetId = '';
    // Filterfelder bleiben unangetastet: sie gehoeren dem Filter-Scope
    // (filter-persist.js) und werden im Lifecycle VOR dem Nachladen restauriert.
    // Wuerde der Reset sie mitnehmen, holte der Buchwechsel das ungefilterte
    // Board und der restaurierte Filter zeigte auf nichts.
    this.errorMessage = '';
    this.busy = false;
    this._memos = {};
    this._destroyBoardSortables();
  },

  // Die Sidebar-Plaketten haengen an denselben Zahlen wie das Board. Wer hier
  // eine Pendenz abhakt, soll die Plakette der Seite nicht erst nach einem
  // Neuladen fallen sehen — die Maps werden darum aus dem Bestand neu gebildet
  // (nicht inkrementell gepatcht: das Board kennt ohnehin alle Ideen des Buchs).
  _publishCounts() {
    const badges = Alpine.store('badges');
    if (!badges) return;
    const pages = {};
    const chapters = {};
    for (const idee of (this.ideen || [])) {
      if (!isOpenIdee(idee)) continue;
      if (idee.page_id != null) pages[idee.page_id] = (pages[idee.page_id] || 0) + 1;
      else if (idee.chapter_id != null) chapters[idee.chapter_id] = (chapters[idee.chapter_id] || 0) + 1;
    }
    badges.ideenCounts = pages;
    badges.chapterIdeenCounts = chapters;
  },

  // ── Schreiben ────────────────────────────────────────────────────────────
  async setIdeeStatus(idee, status) {
    if (!idee || !this.isStageActive(status)) return;
    if (ideeStatus(idee) === status) return;
    await this._patchIdee(idee, { status });
  },

  async _patchIdee(idee, body) {
    const app = window.__app;
    this.busy = true;
    try {
      const row = await fetchJson(`/ideen/${idee.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      this._replaceIdee(row);
      this.errorMessage = '';
      this._publishCounts();
      return row;
    } catch {
      this.errorMessage = app.t('ideenBoard.error.save');
      return null;
    } finally {
      this.busy = false;
    }
  },

  _replaceIdee(row) {
    if (!row) return;
    this.ideen = this.ideen.map(i => (i.id === row.id ? row : i));
    this._memos = {};
  },

  startEdit(idee) { this.editingId = idee.id; this.editingDraft = idee.content || ''; },
  cancelEdit() { this.editingId = null; this.editingDraft = ''; },
  async saveEdit(idee) {
    const content = (this.editingDraft || '').trim();
    if (!content) { this.errorMessage = window.__app.t('ideen.error.contentRequired'); return; }
    if (content === idee.content) { this.cancelEdit(); return; }
    if (await this._patchIdee(idee, { content })) this.cancelEdit();
  },

  // Neue Pendenz direkt am Board: die Bahn waehlt den Anker. Vorgewaehlt ist
  // das ganze Buch — ein Einfall, der noch keinen Ort hat, wird so ohne Umweg
  // festgehalten und spaeter per „Zuordnen" eingeordnet.
  newLaneOptions() {
    return this._memo('newLaneOptionsWithBook', [this.laneOrder], () => [
      { value: LANE_BOOK, label: window.__app.t('ideenBoard.laneBook') },
      ...this.anchorLaneOptions(),
    ]);
  },

  // Nur echte Anker (Kapitel, Seiten) — die Ziele beim Zuordnen einer Buch-Idee.
  anchorLaneOptions() {
    // Erst alle Kapitel-Bahnen, dann alle Seiten-Bahnen — INNERHALB jeder Gruppe
    // bleibt die Buch-Reihenfolge aus `laneOrder`. Die Gruppen muessen
    // zusammenhaengen: die Combobox setzt ihre Kopfzeile beim Gruppenwechsel,
    // und in der reinen Buch-Reihenfolge wechselt die Art bei fast jeder Zeile —
    // dann stuenden „Kapitel" und „Seiten" abwechselnd zwischen den Eintraegen
    // statt als die zwei Bloecke, die die beiden Labels versprechen.
    return this._memo('anchorLaneOptions', [this.laneOrder], () => {
      const t = window.__app.t.bind(window.__app);
      const opt = (l) => ({
        value: l.key,
        label: l.kind === 'chapter' ? l.label : `${l.chapterLabel ? l.chapterLabel + ' · ' : ''}${l.label}`,
        group: t(l.kind === 'chapter' ? 'ideenBoard.groupChapters' : 'ideenBoard.groupPages'),
      });
      const lanes = this.laneOrder || [];
      return [
        ...lanes.filter(l => l.kind === 'chapter').map(opt),
        ...lanes.filter(l => l.kind !== 'chapter').map(opt),
      ];
    });
  },

  async addIdee() {
    const app = window.__app;
    const content = (this.newContent || '').trim();
    const bookId = Alpine.store('nav').selectedBookId;
    if (!content) { this.errorMessage = app.t('ideen.error.contentRequired'); return; }
    if (!this.newLaneKey) { this.errorMessage = app.t('ideenBoard.error.laneRequired'); return; }
    if (!bookId) return;
    const [kind, rawId] = String(this.newLaneKey).split(':');
    const anchorId = parseInt(rawId, 10);
    if (kind !== 'book' && !anchorId) return;

    this.busy = true;
    try {
      const body = { book_id: bookId, content };
      if (kind !== 'book') body[kind === 'chapter' ? 'chapter_id' : 'page_id'] = anchorId;
      const row = await fetchJson('/ideen', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      this.ideen = [row, ...this.ideen];
      this.newContent = '';
      this.errorMessage = '';
      this._memos = {};
      this._publishCounts();
      await this._ensureBoardSortables();
    } catch {
      this.errorMessage = app.t('ideenBoard.error.save');
    } finally {
      this.busy = false;
    }
  },

  // ── Zuordnen (Buch-Idee → Kapitel/Seite) ─────────────────────────────────
  // Nur fuer Ideen ohne Anker und nur solange offen (der Server lehnt den Move
  // einer abgeschlossenen Idee ab, IDEE_CLOSED). Danach steht die Idee in der
  // Bahn ihres neuen Ankers; weiter verschoben wird sie auf der Ideen-Karte.
  // Drei Wege, ein Schreibpfad (`_assignIdee`): der Picker hier, der Drag in
  // eine Kapitel-/Abschnitts-Bahn des Boards und der Drop auf einen Eintrag im
  // Inhaltsverzeichnis der Sidebar (dort stehen auch die Anker, die noch keine
  // Bahn haben, weil an ihnen keine Idee haengt).
  canAssign(idee) { return isBookIdee(idee) && isOpenIdee(idee); },
  dragTip(idee) {
    return window.__app.t(this.canAssign(idee) ? 'ideenBoard.dragBook' : 'ideenBoard.drag');
  },
  startAssign(idee) { this.assigningId = idee.id; this.assignLaneKey = ''; },
  cancelAssign() { this.assigningId = null; this.assignLaneKey = ''; },
  assigningIdee() { return (this.ideen || []).find(i => i.id === this.assigningId) || null; },
  async confirmAssign() {
    const idee = this.assigningIdee();
    if (!idee) return;
    if (await this._assignIdee(idee, this.assignLaneKey)) this.cancelAssign();
  },

  // Buch-Idee an den Anker hinter `laneKey` (`chapter:<id>` / `page:<id>`)
  // haengen, optional zugleich die Stufe setzen (Drop in eine andere Spalte) —
  // ein PATCH, damit die Idee nie halb umgezogen dasteht.
  async _assignIdee(idee, laneKey, status = null) {
    const [kind, rawId] = String(laneKey || '').split(':');
    const anchorId = parseInt(rawId, 10);
    if (!this.canAssign(idee) || !anchorId || (kind !== 'chapter' && kind !== 'page')) return null;
    const body = { [kind === 'chapter' ? 'chapter_id' : 'page_id']: anchorId };
    if (status && status !== ideeStatus(idee) && this.isStageActive(status)) body.status = status;
    const row = await this._patchIdee(idee, body);
    if (row) await this._ensureBoardSortables();
    return row;
  },

  // Darf die gezogene Karte aus `fromLane` in die Zelle `toLane` × `toStatus`?
  // Quer zur Bahn nur die Buch-Idee, nur in eine Kapitel-/Abschnitts-Bahn und
  // nur in eine offene Stufe — eine Idee, die beim Zuordnen gleich
  // abgeschlossen wuerde, haette an ihrem Anker nie offen gestanden.
  _canDropAssign(fromLane, toLane, toStatus, dragEl) {
    if (fromLane !== LANE_BOOK || !/^(chapter|page):\d+$/.test(toLane || '')) return false;
    if (!IDEE_OPEN_STATUSES.includes(toStatus)) return false;
    const id = parseInt(dragEl?.dataset?.ideeCardId, 10);
    return this.canAssign((this.ideen || []).find(i => i.id === id));
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
      this._memos = {};
      this._publishCounts();
    } catch {
      this.errorMessage = app.t('ideenBoard.error.delete');
    } finally {
      this.busy = false;
    }
  },

  // ── Drag & Drop ──────────────────────────────────────────────────────────
  // Angebunden werden die Status-Zellen JEDER Bahn. Anders als im Recherche-
  // Board sind sie nicht stabil (Bahnen kommen und gehen mit dem Filter), darum
  // wird nach jedem Board-Wechsel neu angebunden.
  //
  // Ein Drag einer verankerten Idee traegt genau EINE Aussage: den neuen
  // Status. Ihre Bahn bleibt, wie sie ist — sie IST der Anker im Buch, und den
  // verschiebt man nicht per Kanban-Zug quer durchs Manuskript (dafuer gibt es
  // „Verschieben" auf der Ideen-Karte, das within-kind bleibt). Darum `put` nur
  // aus derselben Bahn. Einzige Ausnahme ist die offene Buch-Idee: sie hat noch
  // keinen Anker, und ihn zu bekommen ist ihr Zweck (`_canDropAssign`, dazu der
  // Drop aufs Inhaltsverzeichnis, `_trackTreeDrop`).
  async _ensureBoardSortables() {
    if (!window.__app?.showIdeenBoardCard) { this._destroyBoardSortables(); return; }
    try { await loadSortable(); } catch { return; }
    await this.$nextTick();
    this._initBoardSortables();
  },

  _destroyBoardSortables() {
    for (const s of (this._boardSortables || [])) { try { s.destroy(); } catch { /* schon weg */ } }
    this._boardSortables = [];
    document.body.classList.remove('ideen-dnd-active');
    this._stopTreeDrop();
  },

  _initBoardSortables() {
    const Sortable = window.Sortable;
    if (!Sortable) return;
    patchSortableOnce(Sortable);
    this._destroyBoardSortables();
    const cells = this.$root?.querySelectorAll('[data-idee-status-cell]') || [];
    for (const el of cells) {
      const laneKey = el.dataset.ideeLane || '';
      this._boardSortables.push(new Sortable(el, {
        ...BASE_SORTABLE_OPTS,
        // Flache Zellen, keine verschachtelten Listen: der invertierte Swap-
        // Bereich des Kerns liesse die obere von zwei Karten nicht unter die
        // untere ziehen — bei zwei Karten der einzige moegliche Zug.
        invertSwap: false,
        emptyInsertThreshold: 24,
        scroll: true,
        draggable: '.idee-board-card',
        handle: '.idee-board-grip',
        sort: this.isColumnManual(el.dataset.ideeStatusCell || ''),
        // Gruppenname pro Bahn: eine Karte bleibt in ihrer Zeile. Eine
        // abgeschaltete Stufe nimmt nichts auf — gelesen wird beim Drag, weil
        // das Umschalten die Zellen nicht neu anbindet.
        group: {
          name: `idee-lane-${laneKey}`,
          pull: true,
          put: (to, from, dragEl) => {
            const toStatus = to?.el?.dataset?.ideeStatusCell || '';
            if (!this.isStageActive(toStatus)) return false;
            const fromLane = from?.el?.dataset?.ideeLane || '';
            return fromLane === laneKey || this._canDropAssign(fromLane, laneKey, toStatus, dragEl);
          },
        },
        chosenClass: 'idee-board-card--chosen',
        ghostClass: 'idee-board-card--ghost',
        dragClass: 'idee-board-card--dragging',
        onChoose: markDragIgnore,
        onUnchoose: unmarkDragIgnore,
        onStart: (evt) => {
          document.body.classList.add('ideen-dnd-active');
          const dragged = (this.ideen || []).find(i => i.id === parseInt(evt.item?.dataset?.ideeCardId, 10));
          if (this.canAssign(dragged)) this._trackTreeDrop();
          const fsEl = document.fullscreenElement;
          const ghost = Sortable.ghost;
          if (fsEl && ghost && !fsEl.contains(ghost)) fsEl.appendChild(ghost);
        },
        onEnd: (evt) => {
          document.body.classList.remove('ideen-dnd-active');
          const treeLane = this._treeDropLane;
          this._stopTreeDrop();
          unmarkDragIgnore(evt);
          this.onBoardSortEnd(evt, treeLane);
        },
      }));
    }
  },

  // Innerhalb einer Spalte zieht man nur, solange sie in ihrer urspruenglichen
  // Position steht — sonst ordnete ihre Sortierung die Karte gleich wieder um.
  // Umgeschaltet wird an den bestehenden Instanzen, je Zelle nach IHRER Spalte
  // (Watcher in ideen-board-card.js).
  _applyManualSortOption() {
    for (const s of (this._boardSortables || [])) {
      try { s.option('sort', this.isColumnManual(s.el?.dataset?.ideeStatusCell || '')); } catch { /* schon weg */ }
    }
  },

  // Immer zuerst reverten: Alpine x-for ist alleiniger DOM-Besitzer. Vorher wird
  // aus dem DOM nur abgelesen, wohin die Karte fiel. Ein Zug in eine andere
  // Spalte setzt den Status; steht die ZIELSPALTE in ihrer urspruenglichen
  // Position, wird danach die Zielzelle neu durchnummeriert (scheitert der Status, bleibt die Reihenfolge
  // unangetastet). Ein Zug einer Buch-Idee in eine andere Bahn — oder auf
  // einen Eintrag im Inhaltsverzeichnis (`treeLane`) — ordnet sie zu.
  async onBoardSortEnd(evt, treeLane = '') {
    const ideeId = parseInt(evt.item?.dataset?.ideeCardId, 10);
    const target = evt.to?.dataset?.ideeStatusCell || '';
    const domIds = [...(evt.to?.querySelectorAll('[data-idee-card-id]') || [])]
      .map(el => parseInt(el.dataset.ideeCardId, 10));
    const sameCell = evt.from === evt.to;
    const fromLane = evt.from?.dataset?.ideeLane || '';
    const toLane = evt.to?.dataset?.ideeLane || '';
    const manual = this.isColumnManual(target);
    revertSortable(evt);
    if (this.busy || !Number.isFinite(ideeId)) return;
    const idee = (this.ideen || []).find(i => i.id === ideeId);
    if (!idee) return;
    if (sameCell && treeLane) { await this._assignIdee(idee, treeLane); return; }
    if (fromLane !== toLane) {
      if (!this._canDropAssign(fromLane, toLane, target, evt.item)) return;
      const row = await this._assignIdee(idee, toLane, target);
      if (row && manual) await this._saveCellOrder(ideeId, domIds);
      return;
    }
    if (sameCell && (!manual || evt.oldIndex === evt.newIndex)) return;
    if (!sameCell) {
      await this.setIdeeStatus(idee, target);
      const moved = (this.ideen || []).find(i => i.id === ideeId);
      if (!moved || ideeStatus(moved) !== target) return;
    }
    if (manual) await this._saveCellOrder(ideeId, domIds);
  },

  // Zelle = gleiche Bahn (Anker) + gleiche Stufe, ueber den GANZEN Bestand —
  // auch was der Textfilter gerade ausblendet (cellOrderAfterDrop).
  async _saveCellOrder(ideeId, domIds) {
    const idee = (this.ideen || []).find(i => i.id === ideeId);
    if (!idee) return;
    const lane = ideeLaneKey(idee);
    const status = ideeStatus(idee);
    const cellIds = this.ideen
      .filter(i => ideeLaneKey(i) === lane && ideeStatus(i) === status)
      .sort(compareIdeeManual)
      .map(i => i.id);
    const ids = cellOrderAfterDrop(cellIds, domIds, ideeId);
    const prev = new Map(this.ideen.map(i => [i.id, i.sort_order || 0]));
    const rank = new Map(ids.map((id, i) => [id, i + 1]));
    // Optimistisch: sofort umsortiert anzeigen, bei Fehler zurueck.
    const apply = (orderOf) => {
      this.ideen = this.ideen.map(i => (rank.has(i.id) ? { ...i, sort_order: orderOf(i.id) } : i));
      this._memos = {};
    };
    apply(id => rank.get(id));
    this.busy = true;
    try {
      await fetchJson('/ideen/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: Alpine.store('nav').selectedBookId, ids }),
      });
      this.errorMessage = '';
    } catch {
      apply(id => prev.get(id));
      this.errorMessage = window.__app.t('ideenBoard.error.save');
    } finally {
      this.busy = false;
    }
  },
};
