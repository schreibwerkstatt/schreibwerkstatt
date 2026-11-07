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

import { localDayDiff, relativeDay, fetchJson } from '../../utils.js';
import { tFetchError } from '../../i18n.js';
import { deleteIdee as removeIdee } from '../../repo/ideen-queue.js';
import { ideeStatus, isOpenIdee } from '../ideen-shared.js';
import { buildIdeenList, IDEE_STALE_DAYS } from './model.js';

/**
 * Welche der markierten Ideen beim Zusammenführen bleibt: eine offene vor einer
 * abgeschlossenen (eine offene Pendenz geht nie in einer erledigten auf — der
 * Server lehnt das ab), dann die älteste. Pure.
 */
export function mergeTargetOf(ideen) {
  return [...(ideen || [])].sort((a, b) => {
    const ao = isOpenIdee(a) ? 0 : 1, bo = isOpenIdee(b) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    // ISO-Zeitstempel: lexikografisch = zeitlich (kein Anzeige-Text, kein compareText).
    const ac = String(a.created_at || ''), bc = String(b.created_at || '');
    return ac < bc ? -1 : ac > bc ? 1 : a.id - b.id;
  })[0] || null;
}

/** Vorschlag für den gemeinsamen Text: jede Fassung einmal, bleibende zuerst. Pure. */
export function mergedContentOf(target, sources) {
  const seen = new Set();
  const out = [];
  for (const i of [target, ...(sources || [])]) {
    const t = String(i?.content || '').replace(/\s+/g, ' ').trim();
    const k = t.toLowerCase();
    if (t && !seen.has(k)) { seen.add(k); out.push(t); }
  }
  return out.join(' · ');
}

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

  // ── Mehrfachauswahl (Mechanik: selection-bar.js) ─────────────────────────
  // „Alle" meint die SICHTBAREN Zeilen: was der Filter ausblendet, faellt nicht
  // unbemerkt unter eine Sammelaktion.
  selectionVisibleIds() { return this.listRows().map(r => r.id); },
  selectedIdeen() {
    const sel = new Set(this.selectedVisibleIds());
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

  // Dubletten zusammenführen (POST /ideen/:id/merge, derselbe Weg wie der
  // Vorschlag des Ideen-Chats): eine bleibt (mergeTargetOf), die anderen gehen
  // in ihr auf — Verknüpfungen wandern mit, sie selbst fallen. Der Text wird
  // vorher in der Rückfrage bestätigt bzw. gekürzt. Online-only: der Merge ist
  // eine Transaktion über mehrere Ideen, die Offline-Warteschlange kennt nur
  // Einzel-Schreibwege.
  async bulkMerge() {
    const app = window.__app;
    const todo = this.selectedIdeen();
    if (todo.length < 2 || this.busy) return;
    const target = mergeTargetOf(todo);
    const sources = todo.filter(i => i.id !== target.id);
    const content = await app.appPrompt({
      message: app.t('ideenBoard.bulk.mergePrompt'),
      defaultValue: mergedContentOf(target, sources),
      confirmLabel: app.t('ideenBoard.bulk.merge'),
    });
    if (content == null || !String(content).trim()) return;
    this.busy = true;
    try {
      const r = await fetchJson(`/ideen/${target.id}/merge`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_ids: sources.map(i => i.id), content: String(content).trim() }),
      });
      const removed = new Set(r.removed_ids || []);
      this.ideen = this.ideen.filter(i => !removed.has(i.id));
      this._replaceIdee(r.idee);
      this._publishCounts();
      this.errorMessage = '';
      this.clearSelection();
    } catch (e) {
      this.errorMessage = tFetchError(e);
    } finally {
      this.busy = false;
    }
  },

  _afterBulk(failed) {
    if (failed) this.errorMessage = window.__app.t('ideenBoard.bulk.failed', { n: failed });
    else this.errorMessage = '';
    // Gelungenes faellt aus der Auswahl, Gescheitertes bleibt zum Wiederholen.
    this._pruneSelection();
    if (!failed) this.clearSelection();
  },
};
