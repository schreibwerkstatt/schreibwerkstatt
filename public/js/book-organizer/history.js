// Undo/Redo für Buchorganizer.
//
// Record-Typen:
//   { kind: 'reorder', before, after }              — workstate-Snapshots
//   { kind: 'rename-chapter', id, oldName, newName }
//   { kind: 'rename-page',    id, oldName, newName }
//   { kind: 'create-chapter', id, name }
//   { kind: 'create-page',    id, chapterId, name }
//   { kind: 'delete-page',    pageId, name, chapterId, index }
//
// Stack, Deckel, Flight-Schutz und Requeue: Kern [cards/board-history.js];
// hier stehen nur die Records, ihre Applier und die Hooks.
//
// Sonderfall create: Undo löscht das frisch erstellte Kapitel/Seite. Nach
// einem solchen Undo wird der gesamte Redo-Stack invalidiert — beim erneuten
// Anlegen würde der Server eine NEUE ID vergeben, andere Records im Redo-Stack
// referenzieren aber die alten IDs (z.B. Reorder-Snapshots). Saubere Lösung:
// User legt das Kapitel manuell neu an. Hat die Seite inzwischen Inhalt bzw.
// das Kapitel Seiten/Sub-Kapitel, verweigert der Undo (`_historyStaleReason`): der
// Verlauf überlebt das Schliessen der Karte, und ein Strg+Z Stunden später
// löschte sonst kommentarlos geschriebenen Text.
//
// Delete-Seite ist umkehrbar: der Server legt gelöschte Seiten in den
// Papierkorb (page_deletions). Undo stellt sie wieder her — mit NEUER page_id,
// darum zieht `_remapPageId` die alte ID in beiden Stacks nach — und setzt sie
// an ihre alte Stelle. Delete-Kapitel (nur leere) und Cross-Book-Move bleiben
// irreversibel und rufen `_clearHistory()`.
//
// Fremd-Änderungen (Sidebar-Kontextmenü, Collab-Feed, Catch-up) verändern den
// Bestand an Kapiteln/Seiten, ohne durch diese History zu laufen. Ein Record,
// der danach nicht mehr zum Bestand passt, wird vor dem Einspielen erkannt
// (`_historyStaleReason`) und leert die History — sonst schickte ein Reorder-Undo
// einen Tree mit fehlenden/toten IDs, der Server lehnte ihn ab
// (MISSING_PAGE/-CHAPTER) und der Fehlerpfad lüde das ganze Buch neu.

import { contentRepo } from '../repo/content.js';
import { eachChapter } from './tree-walk.js';
import { boardHistoryMethods } from '../cards/board-history.js';

// Sortierter ID-Schlüssel eines Workstates ({ workTree, soloPages }) — gleich,
// wenn beide Stände dieselben Kapitel und Seiten enthalten.
function _workstateIdKey({ workTree, soloPages }) {
  const ids = [];
  eachChapter(workTree, (c) => {
    ids.push('c' + c.id);
    for (const p of c.pages || []) ids.push('p' + p.id);
  });
  for (const p of soloPages || []) ids.push('p' + p.id);
  return ids.sort().join(',');
}

export const historyMethods = {
  ...boardHistoryMethods,

  _recordReorder(before) {
    const after = this._snapshotWorkstate();
    this._pushUndo({ kind: 'reorder', before, after });
  },

  _recordRenameChapter(id, oldName, newName) {
    this._pushUndo({ kind: 'rename-chapter', id, oldName, newName });
  },

  _recordRenamePage(id, oldName, newName) {
    this._pushUndo({ kind: 'rename-page', id, oldName, newName });
  },

  // `pageId`: der gleichnamige erste Abschnitt, der im Ein-Abschnitt-Buch
  // mitentsteht (crud.js#createChapter) — ein Undo nimmt beides zurueck.
  _recordCreateChapter(id, name, pageId = null) {
    this._pushUndo({ kind: 'create-chapter', id, name, pageId });
  },

  _recordCreatePage(id, chapterId, name) {
    this._pushUndo({ kind: 'create-page', id, chapterId, name });
  },

  _recordDeletePage(pageId, name, chapterId, index) {
    this._pushUndo({ kind: 'delete-page', pageId, name, chapterId, index });
  },

  // Passt der Record noch zum aktuellen Workstate? Liefert null oder die
  // Meldung `{ key, params }`, mit der die History verworfen wird.
  // Reorder: der einzuspielende Snapshot muss exakt dieselben Kapitel- und
  // Seiten-IDs enthalten (nur die Anordnung darf abweichen). Rename/Create: das
  // Ziel muss noch existieren. Create-Undo zusaetzlich: nur solange leer.
  // Delete-Redo: die (wiederhergestellte) Seite muss existieren.
  _historyStaleReason(rec, dir) {
    const STALE = { key: 'bookOrganizer.historyStale' };
    if (rec.kind === 'reorder') {
      const snap = dir === 'undo' ? rec.before : rec.after;
      return _workstateIdKey(snap) !== _workstateIdKey(this) ? STALE : null;
    }
    if (rec.kind === 'rename-chapter') return this._findChapter(rec.id) ? null : STALE;
    if (rec.kind === 'rename-page') return this._findPage(rec.id) ? null : STALE;
    if (rec.kind === 'create-chapter') {
      const ch = this._findChapter(rec.id)?.node;
      if (!ch) return STALE;
      const ownPages = (ch.pages || []).filter(p => p.id !== rec.pageId);
      const written = rec.pageId != null && (window.__app?.tokEsts?.[rec.pageId]?.chars || 0) > 0;
      const filled = ownPages.length > 0 || (ch.subchapters?.length || 0) > 0 || written;
      return filled ? { key: 'bookOrganizer.historyHasContent', params: { name: ch.name } } : null;
    }
    if (rec.kind === 'create-page') {
      const page = this._findPage(rec.id);
      if (!page) return STALE;
      // tokEsts traegt die Zeichenzahl jeder Seite (Server-Stats + Frontend-
      // Nachzug nach jedem Save, tree/stats.js#_syncPageStatsAfterSave).
      const chars = window.__app?.tokEsts?.[rec.id]?.chars || 0;
      return chars > 0 ? { key: 'bookOrganizer.historyHasContent', params: { name: page.name } } : null;
    }
    if (rec.kind === 'delete-page') {
      if (dir === 'redo') return this._findPage(rec.pageId) ? null : STALE;
      return this._findPage(rec.pageId) ? STALE : null;
    }
    return null;
  },

  // Hooks des Kerns (cards/board-history.js).
  _historyOnDropped(reason = { key: 'bookOrganizer.historyStale' }) {
    const root = window.__app;
    root?.setStatus?.(root.t(reason.key, reason.params));
  },

  // Blur-Umbenennungen laufen asynchron; ein Undo davor drehte einen Stand
  // zurück, dessen Rename-Record noch gar nicht im Stack liegt.
  _historyBeforeStep() {
    return this._renamesInFlight || null;
  },

  _historyBusy() {
    return this.organizerSaving;
  },

  async _applyInverse(rec) {
    if (rec.kind === 'reorder') return this._applyReorderSnapshot(rec.before);
    if (rec.kind === 'rename-chapter') return this._doRenameChapter(rec.id, rec.oldName, null);
    if (rec.kind === 'rename-page') return this._doRenamePage(rec.id, rec.oldName, null);
    if (rec.kind === 'create-chapter') {
      if (rec.pageId != null && this._findPage(rec.pageId) && !await this._deletePageRaw(rec.pageId)) return false;
      return this._deleteChapterRaw(rec.id);
    }
    if (rec.kind === 'create-page') return this._deletePageRaw(rec.id);
    if (rec.kind === 'delete-page') return this._restoreDeletedPage(rec);
    return false;
  },

  async _applyForward(rec) {
    if (rec.kind === 'reorder') return this._applyReorderSnapshot(rec.after);
    if (rec.kind === 'rename-chapter') return this._doRenameChapter(rec.id, rec.newName, null);
    if (rec.kind === 'rename-page') return this._doRenamePage(rec.id, rec.newName, null);
    if (rec.kind === 'delete-page') return this._redoDeletePage(rec);
    return false;
  },

  // Snapshot einspielen: Workstate ersetzen, Sortables neu binden, dann derselbe
  // Single-Tree-PUT wie jede andere Reorder-Mutation. `mirror: 'both'`, weil ein
  // Snapshot sowohl Kapitel-Struktur als auch Seiten-Zugehoerigkeit enthalten
  // kann (Chapter-Prio/Tiefe zuerst, danach Page-Membership mit neuen Prios).
  //
  // Namen kommen aus dem AKTUELLEN Workstate, nicht aus dem Snapshot: der traegt
  // die Namen von damals, und eine Umbenennung anderswo (Sidebar, Editor,
  // Collab) laeuft nicht durch diese History — sonst zeigte der Undo lokal
  // wieder den alten Namen, waehrend der Server den neuen hat.
  async _applyReorderSnapshot(snap) {
    const names = this._currentNames();
    const workTree = JSON.parse(JSON.stringify(snap.workTree));
    const soloPages = JSON.parse(JSON.stringify(snap.soloPages));
    const rename = (item, prefix) => {
      const n = names.get(prefix + item.id);
      if (n != null) item.name = n;
    };
    eachChapter(workTree, (c) => {
      rename(c, 'c');
      for (const p of c.pages || []) rename(p, 'p');
    });
    for (const p of soloPages) rename(p, 'p');
    this.workTree = workTree;
    this.soloPages = soloPages;
    await this._reattachSortables();
    return await this._persistOrder({ mirror: 'both' });
  },

  // 'c<id>'/'p<id>' → Name im aktuellen Workstate.
  _currentNames() {
    const names = new Map();
    eachChapter(this.workTree, (c) => {
      names.set('c' + c.id, c.name);
      for (const p of c.pages || []) names.set('p' + p.id, p.name);
    });
    for (const p of this.soloPages || []) names.set('p' + p.id, p.name);
    return names;
  },

  // Undo eines Seiten-Loeschens: Papierkorb-Eintrag suchen, wiederherstellen
  // (neue page_id), an die alte Stelle setzen, Reihenfolge speichern. Der Store
  // wird danach voll neu geladen — wie in der Papierkorb-Sektion der Fassungen-
  // Karte (snapshots-trash.js): die wiederhergestellte Seite bringt Inhalt und
  // Stats mit, die nur der Server-Tree kennt.
  async _restoreDeletedPage(rec) {
    const root = window.__app;
    const bookId = parseInt(Alpine.store('nav').selectedBookId, 10);
    if (!bookId) return false;
    let newId = null;
    const ok = await this._runMutation(async () => {
      const trash = await contentRepo.listTrash(bookId);
      const entry = (trash?.items || []).find(it => it.page_id === rec.pageId);
      if (!entry) throw new Error(root.t('bookOrganizer.trashEntryMissing'));
      const res = await contentRepo.restoreFromTrash(bookId, entry.id);
      newId = res?.page?.id ?? null;
      if (!newId) throw new Error(root.t('bookOrganizer.trashEntryMissing'));
      const target = rec.chapterId ? this._pagesBucket(rec.chapterId) : null;
      const bucket = target || this.soloPages;
      bucket.splice(Math.min(rec.index ?? bucket.length, bucket.length), 0, {
        id: newId,
        name: res.page.name ?? rec.name,
        chapter_id: target ? rec.chapterId : 0,
      });
      await this._saveOrder(bookId, this._buildTreeFromWorkstate());
      await this._applyMirror('reload');
    }, 'bookOrganizer.restoreFailed');
    if (newId != null) this._remapPageId(rec.pageId, newId, rec);
    return ok;
  },

  // Redo eines Seiten-Loeschens: wieder in den Papierkorb, ohne Rueckfrage. Die
  // Position wird neu gemerkt — sie kann sich seit dem Undo verschoben haben.
  async _redoDeletePage(rec) {
    const pos = this._pagePosition(rec.pageId);
    const ok = await this._deletePageRaw(rec.pageId);
    if (ok) { rec.chapterId = pos.chapterId; rec.index = pos.index; }
    return ok;
  },

  // Eine wiederhergestellte Seite hat eine neue ID. Alle Records, die die alte
  // tragen (Reorder-Snapshots, Rename/Create, weitere Deletes), auf die neue
  // umschreiben — sonst wuerden sie beim Einspielen als veraltet verworfen.
  _remapPageId(oldId, newId, ...extra) {
    const fixPages = (list) => { for (const p of list || []) if (p.id === oldId) p.id = newId; };
    const fixSnap = (snap) => { if (snap) { eachChapter(snap.workTree, (c) => fixPages(c.pages)); fixPages(snap.soloPages); } };
    for (const rec of [...this._undoStack, ...this._redoStack, ...extra]) {
      if (rec.kind === 'reorder') { fixSnap(rec.before); fixSnap(rec.after); }
      if ((rec.kind === 'rename-page' || rec.kind === 'create-page') && rec.id === oldId) rec.id = newId;
      if (rec.kind === 'delete-page' && rec.pageId === oldId) rec.pageId = newId;
    }
  },
};
