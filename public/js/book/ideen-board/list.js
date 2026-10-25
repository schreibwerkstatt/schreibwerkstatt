// Listenansicht, Alter und Mehrfachauswahl des Ideen-Boards.
// `this` = die ideenBoardCard-Instanz.
//
// Die Liste ist die zweite Sicht auf DENSELBEN Bestand: gleicher Filter
// (model.js#makeIdeeFilter), gleiche Schreibpfade (_patchIdee, repo/ideen-queue.js).
// Das Raster beantwortet „wie weit ist welche Stelle", die Liste „was ist
// insgesamt offen und was liegt am laengsten" — bei siebzig Pendenzen ist das
// horizontal scrollende Raster dafuer keine Uebersicht mehr.
//
// Die Mehrfachauswahl lebt nur in der Liste: im Raster laege ein Haken neben
// dem Drag-Griff und konkurrierte mit ihm um dieselbe Geste.

import { localDayDiff, relativeDay } from '../../utils.js';
import { deleteIdee as removeIdee } from '../../repo/ideen-queue.js';
import { ideeStatus, isOpenIdee } from '../ideen-shared.js';
import { buildIdeenList, IDEE_STALE_DAYS } from './model.js';

export const ideenBoardList = {
  isListView() { return this.view === 'list'; },
  setView(v) {
    this.view = v === 'list' ? 'list' : 'board';
    this.clearSelection();
  },

  // Zeilen der Liste, nach demselben Filter wie das Raster (memoisiert wie board()).
  listRows() {
    return this._memo('listRows',
      [this.ideen, this.laneOrder, this.filterChapterId, this.showErledigt, this.showVerworfen, this.query],
      () => buildIdeenList({
        ideen: this.ideen,
        laneOrder: this.laneOrder,
        filterChapterId: this.filterChapterId,
        showErledigt: this.showErledigt,
        showVerworfen: this.showVerworfen,
        query: this.query,
      }).map(r => ({
        ...r,
        id: r.idee.id,
        text: r.idee.content || '',
        status: ideeStatus(r.idee),
        statusRank: this.statuses().indexOf(ideeStatus(r.idee)),
        place: this.ideePlaceLabel(r.idee, r.lane),
        created: r.idee.created_at || '',
        statusAt: r.idee.status_at || r.idee.created_at || '',
      })));
  },

  // Ort einer Idee als Text (Sortierschluessel und Fallback, wenn der Baum die
  // Bahn noch nicht kennt). Angezeigt wird der Ort als x-entity-ref.
  ideePlaceLabel(idee, lane) {
    const t = window.__app.t.bind(window.__app);
    if (idee.page_id == null && idee.chapter_id == null) return t('ideenBoard.laneBook');
    if (idee.page_id != null) {
      const chapter = lane?.chapterLabel || idee.lane_chapter_name || '';
      const page = lane?.label || idee.page_name || t('ideenBoard.lanePageFallback');
      return chapter ? `${chapter} · ${page}` : page;
    }
    return lane?.label || idee.chapter_name || t('ideenBoard.laneChapterFallback');
  },

  // ── Alter ────────────────────────────────────────────────────────────────
  // Tage seit dem Anlegen, Tag-genau in der App-Zeitzone (localDayDiff), damit
  // „heute" um Mitternacht kippt und nicht 24 Stunden nach dem Anlegen.
  ideeAgeDays(idee) {
    const d = localDayDiff(idee?.created_at);
    return Number.isFinite(d) ? Math.max(d, 0) : null;
  },
  ideeAgeLabel(idee) {
    const d = this.ideeAgeDays(idee);
    if (d == null) return '';
    return window.__app.t('ideenBoard.age', { rel: relativeDay(d, Alpine.store('shell').uiLocale) });
  },
  isOpenIdeeRow(idee) { return isOpenIdee(idee); },
  // Liegengeblieben: offen und aelter als IDEE_STALE_DAYS. Nur offene — eine
  // erledigte Pendenz von vor einem Jahr ist Geschichte, kein Versaeumnis.
  isStaleIdee(idee) {
    const d = this.ideeAgeDays(idee);
    return isOpenIdee(idee) && d != null && d >= IDEE_STALE_DAYS;
  },
  staleTip() { return window.__app.t('ideenBoard.staleTip', { n: IDEE_STALE_DAYS }); },
  statusSinceLabel(idee) {
    const iso = idee?.status_at || idee?.created_at;
    const d = localDayDiff(iso);
    return Number.isFinite(d) ? relativeDay(Math.max(d, 0), Alpine.store('shell').uiLocale) : '';
  },

  // ── Mehrfachauswahl ──────────────────────────────────────────────────────
  // Immer eine NEUE Liste schreiben (Alpine-Reaktivitaet ueber Identitaet,
  // wie collapsedLanes).
  isSelected(id) { return (this.selectedIds || []).includes(id); },
  toggleSelect(id) {
    const cur = this.selectedIds || [];
    this.selectedIds = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
  },
  clearSelection() { this.selectedIds = []; },
  // „Alle" meint die SICHTBAREN Zeilen: was der Filter ausblendet, faellt nicht
  // unbemerkt unter eine Sammelaktion.
  allVisibleSelected() {
    const rows = this.listRows();
    return rows.length > 0 && rows.every(r => this.isSelected(r.id));
  },
  toggleSelectAllVisible() {
    this.selectedIds = this.allVisibleSelected() ? [] : this.listRows().map(r => r.id);
  },
  // Auswahl auf den aktuellen Bestand kuerzen (nach Neuladen/Filterwechsel
  // zeigte sie sonst auf Ideen, die es nicht mehr gibt oder die man nicht sieht).
  _pruneSelection() {
    const visible = new Set(this.listRows().map(r => r.id));
    const next = (this.selectedIds || []).filter(id => visible.has(id));
    if (next.length !== (this.selectedIds || []).length) this.selectedIds = next;
  },
  selectedIdeen() {
    const sel = new Set(this.selectedIds || []);
    return (this.ideen || []).filter(i => sel.has(i.id));
  },

  // Stufe fuer alle Ausgewaehlten — derselbe Schreibpfad wie Knopf und Drag
  // (`_patchIdee`), eine Idee nach der anderen: so greifen Offline-Warteschlange
  // und Stufen-Pruefung je Idee, und ein Fehler bricht nicht die schon
  // gespeicherten zurueck. Was schon in der Stufe steht, bleibt unberuehrt.
  async bulkSetStatus(status) {
    if (!this.isStageActive(status)) return;
    const todo = this.selectedIdeen().filter(i => ideeStatus(i) !== status);
    let failed = 0;
    for (const idee of todo) {
      if (!await this._patchIdee(idee, { status })) failed++;
    }
    this._afterBulk(failed);
  },

  async bulkDelete() {
    const app = window.__app;
    const todo = this.selectedIdeen();
    if (!todo.length) return;
    if (!await app.appConfirm({
      message: app.t('ideenBoard.bulk.confirmDelete', { n: todo.length }),
      confirmLabel: app.t('common.delete'),
      danger: true,
    })) return;
    this.busy = true;
    let failed = 0;
    try {
      for (const idee of todo) {
        try {
          await removeIdee(idee);
          this.ideen = this.ideen.filter(i => i.id !== idee.id);
        } catch { failed++; }
      }
    } finally {
      this.busy = false;
      this._memos = {};
      this._publishCounts();
    }
    this._afterBulk(failed);
  },

  _afterBulk(failed) {
    if (failed) this.errorMessage = window.__app.t('ideenBoard.bulk.failed', { n: failed });
    else this.errorMessage = '';
    // Gelungenes faellt aus der Auswahl, Gescheitertes bleibt zum Wiederholen.
    this._pruneSelection();
    if (!failed) this.clearSelection();
  },
};
