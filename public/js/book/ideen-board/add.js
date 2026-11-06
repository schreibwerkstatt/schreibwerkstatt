// Anlegen im Ideen-Board: Ideen und Kapitel. `this` = die ideenBoardCard-Instanz.
//
// Das Board ist der Ort, an dem eine Gliederung entsteht: Kapitel anlegen und
// gleich die Stichworte darunter festhalten, ohne Umweg ueber den Buchorganizer
// und ohne jeden Abschnitt einzeln zu oeffnen. Eine eingefuegte Liste wird
// darum zu einer Idee je Zeile (splitIdeenLines), nach einer Rueckfrage.

import { createIdee } from '../../repo/ideen-queue.js';
import { LANE_BOOK, IDEE_MAX_LEN, splitIdeenLines } from '../ideen-shared.js';
import { buildLaneOrder } from './model.js';

export const ideenBoardAdd = {
  // Die Bahn waehlt den Anker. Vorgewaehlt ist das ganze Buch — ein Einfall,
  // der noch keinen Ort hat, wird so ohne Umweg festgehalten und spaeter per
  // „Zuordnen" eingeordnet.
  newLaneOptions() {
    return this._memo('newLaneOptionsWithBook', [this.laneOrder], () => [
      { value: LANE_BOOK, label: window.__app.t('ideenBoard.laneBook') },
      ...this.anchorLaneOptions(),
    ]);
  },

  // Eine Zeile = eine Idee. Mehrere Zeilen legen nach Rueckfrage je eine Idee
  // an, der Reihe nach ueber denselben Schreibweg (Offline-Queue je Idee).
  // Scheitert eine, bleiben die noch nicht angelegten Zeilen im Feld stehen —
  // nichts geht verloren, und ein zweiter Klick legt nichts doppelt an.
  async addIdee() {
    const app = window.__app;
    const lines = splitIdeenLines(this.newContent);
    const bookId = Alpine.store('nav').selectedBookId;
    if (!lines.length) { this.errorMessage = app.t('ideen.error.contentRequired'); return; }
    if (lines.some(l => l.length > IDEE_MAX_LEN)) { this.errorMessage = app.t('ideen.error.contentTooLong'); return; }
    if (!this.newLaneKey) { this.errorMessage = app.t('ideenBoard.error.laneRequired'); return; }
    if (!bookId || this.busy) return;
    const [kind, rawId] = String(this.newLaneKey).split(':');
    const anchorId = parseInt(rawId, 10);
    if (kind !== 'book' && !anchorId) return;
    if (lines.length > 1 && !await app.appConfirm({
      message: app.tn('ideenBoard.addManyConfirm', lines.length),
      confirmLabel: app.tn('ideenBoard.addManyAction', lines.length),
    })) return;

    this.busy = true;
    let done = 0;
    try {
      for (const content of lines) {
        const body = { book_id: bookId, content };
        if (kind !== 'book') body[kind === 'chapter' ? 'chapter_id' : 'page_id'] = anchorId;
        const row = await createIdee(body);
        this.ideen = [row, ...this.ideen];
        done++;
      }
      this.errorMessage = '';
    } catch {
      this.errorMessage = app.t('ideenBoard.error.save');
    } finally {
      this.newContent = lines.slice(done).join('\n');
      this._memos = {};
      this._publishCounts();
      this.busy = false;
      // Fallback ohne `field-sizing`: die Hoehe der eingefuegten Liste zuruecknehmen.
      this.$nextTick(() => this.autosizeEditInput?.(this.$refs.ideenBoardAddInput));
      await this._ensureBoardSortables();
    }
  },

  // «+ Kapitel»: legt das Kapitel ueber den Weg der Sidebar an (tree/load.js#
  // createChapter — Buchende, bei Einabschnitts-Buechern samt erstem Abschnitt),
  // oeffnet den Abschnitt aber NICHT zum Schreiben: wer hier gliedert, will
  // weiter gliedern. Danach steht das Kapitel als (noch leere) Bahn im Raster,
  // ist im Anlegen-Feld vorgewaehlt, und der Fokus liegt im Textfeld.
  async addChapterLane() {
    const app = window.__app;
    if (this.busy || !app.canEdit?.()) return;
    const name = await app.appPrompt({
      message: app.t('bookOrganizer.promptChapterName'),
      placeholder: app.t('bookOrganizer.placeholderChapterName'),
      confirmLabel: app.t('bookOrganizer.create'),
    });
    if (!name) return;
    this.busy = true;
    try {
      app.newChapterTitle = name;
      const item = await app.createChapter({ openFirstSection: false });
      if (!item?.id) { this.errorMessage = app.t('ideenBoard.error.chapterCreate'); return; }
      // Der Baum-Watch der Karte zieht die Bahnen nach — aber erst nach dem
      // naechsten Tick, und das Einhaengen des Abschnitts mutiert das
      // Kapitel-Item statt den Baum zu ersetzen. Hier sofort neu bauen, damit
      // Bahn und Vorwahl auf dem fertigen Stand stehen.
      this.laneOrder = buildLaneOrder(Alpine.store('nav').tree);
      this._memos = {};
      const id = String(item.id);
      const lane = this.laneOrder.find(l => (l.kind === 'chapter' && String(l.id) === id)
        || (l.merged && String(l.chapterId) === id));
      if (lane) {
        this.pinnedLaneKeys = [...(this.pinnedLaneKeys || []), lane.key];
        this.newLaneKey = lane.key;
      }
      this.errorMessage = '';
    } finally {
      this.busy = false;
    }
    await this._ensureBoardSortables();
    this.$nextTick(() => this.$refs.ideenBoardAddInput?.focus());
  },
};
