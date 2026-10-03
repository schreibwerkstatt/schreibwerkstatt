// Create/Rename/Delete-Slice. Server-Calls via contentRepo + In-Place-Mirror
// in nav.tree/nav.pages. History-Push pro erfolgreichem Schritt.
import { contentRepo } from '../repo/content.js';
import { localIsoDate } from '../utils.js';
import { MAX_CHAPTER_DEPTH } from './constants.js';

export const crudMethods = {
  onRenameChapter(id, ev) {
    const newName = (ev?.target?.value || '').trim();
    const ch = this._findChapter(id)?.node;
    if (!ch || !newName || ch.name === newName) {
      if (ch && ev?.target) ev.target.value = ch.name;
      return;
    }
    const oldName = ch.name;
    this._trackRename(this._doRenameChapter(id, newName, ev.target).then(ok => {
      if (ok) this._recordRenameChapter(id, oldName, newName);
    }));
  },

  // Umbenennen laeuft ohne `organizerSaving` — der Flag disabled alle Name-
  // Inputs, und ein Blur durch Klick ins NAECHSTE Feld verloere sonst sofort den
  // Fokus. Stattdessen merkt sich die Karte die laufenden Renames; Undo/Redo
  // warten darauf (history.js), damit der Record der Umbenennung im Stack liegt,
  // bevor einer herausgenommen wird. Ohne das nahm ein Klick auf „Rueckgaengig"
  // (Blur → Rename startet) den VORHERIGEN Record, und der spaeter gepushte
  // Rename-Record leerte den Redo-Stack.
  _trackRename(promise) {
    const all = Promise.all([this._renamesInFlight, promise]);
    this._renamesInFlight = all;
    all.finally(() => { if (this._renamesInFlight === all) this._renamesInFlight = null; });
    return promise;
  },

  async _doRenameChapter(id, newName, inputEl) {
    const root = window.__app;
    try {
      await contentRepo.updateChapter(id, { name: newName });
      const ch = this._findChapter(id)?.node;
      if (ch) ch.name = newName;
      // In-place mirror: Kapitel-Eintrag in nav.tree (enthaelt alle Tiefen)
      // + _chapterOrderMap (keyt auf den Namen).
      for (const it of Alpine.store('nav').tree) {
        if (it.type === 'chapter' && !it.solo && it.id === id) it.name = newName;
      }
      this._rebuildOrderMaps();
      this._signalXrefsChanged();
      return true;
    } catch (e) {
      root.setStatus(root.t('bookOrganizer.saveFailed', { detail: e.message }));
      const ch = this._findChapter(id)?.node;
      if (ch && inputEl) inputEl.value = ch.name;
      return false;
    }
  },

  onRenamePage(id, ev) {
    const newName = (ev?.target?.value || '').trim();
    const page = this._findPage(id);
    if (!page || !newName || page.name === newName) {
      if (page && ev?.target) ev.target.value = page.name;
      return;
    }
    const oldName = page.name;
    this._trackRename(this._doRenamePage(id, newName, ev.target).then(ok => {
      if (ok) this._recordRenamePage(id, oldName, newName);
    }));
  },

  async _doRenamePage(id, newName, inputEl) {
    const root = window.__app;
    const nav = Alpine.store('nav');
    try {
      await contentRepo.updatePage(id, { name: newName });
      const page = this._findPage(id);
      if (page) page.name = newName;
      // In-place mirror: Page in nav.pages + ggf. solo-Tree-Entry.
      const rp = nav.pages.find(p => p.id === id);
      if (rp) rp.name = newName;
      for (const it of nav.tree) {
        if (it.type === 'chapter' && it.solo && it.pages?.[0]?.id === id) it.name = newName;
      }
      // Order-Maps neu aufbauen (Reihenfolge unverändert, aber Name-Index drin).
      this._rebuildOrderMaps();
      this._invalidateDiaryCache();
      this._signalXrefsChanged();
      return true;
    } catch (e) {
      root.setStatus(root.t('bookOrganizer.saveFailed', { detail: e.message }));
      const page = this._findPage(id);
      if (page && inputEl) inputEl.value = page.name;
      return false;
    }
  },

  async createChapter() {
    const root = window.__app;
    const name = await root.appPrompt({
      message: root.t('bookOrganizer.promptChapterName'),
      placeholder: root.t('bookOrganizer.placeholderChapterName'),
      confirmLabel: root.t('bookOrganizer.create'),
    });
    if (!name) return;
    let createdId = null;
    const ok = await this._runMutation(async () => {
      const created = await contentRepo.createChapter({
        book_id: parseInt(Alpine.store('nav').selectedBookId, 10),
        name,
      });
      if (!created?.id) return;
      createdId = created.id;
      this._mirrorCreatedChapter(created, name);
      // Aufgeklappt anlegen (wie createSubchapter): ein zugeklapptes leeres
      // Kapitel hat keine Seitenliste im DOM, also auch kein Drop-Ziel.
      this.chapterOpen = { ...this.chapterOpen, [created.id]: true };
      await this._rerender();
    }, 'bookOrganizer.createFailed');
    if (ok && createdId != null) this._recordCreateChapter(createdId, name);
  },

  async createPage(chapterId) {
    const root = window.__app;
    const isDiary = typeof root.isTagebuch === 'function' && root.isTagebuch();
    const name = await root.appPrompt({
      message: root.t('bookOrganizer.promptPageName'),
      placeholder: root.t('bookOrganizer.placeholderPageName'),
      defaultValue: isDiary ? localIsoDate() : '',
      confirmLabel: root.t('bookOrganizer.create'),
    });
    if (!name) return;
    let createdId = null;
    const ok = await this._runMutation(async () => {
      const created = await this._createPageRaw({ name, chapterId });
      if (!created?.id) return;
      createdId = created.id;
    }, 'bookOrganizer.createFailed');
    if (ok && createdId != null) this._recordCreatePage(createdId, chapterId || 0, name);
  },

  // Reine Create-Operation ohne Prompt — auch von History-Redo nutzbar.
  async _createPageRaw({ name, chapterId }) {
    const body = {
      book_id: parseInt(Alpine.store('nav').selectedBookId, 10),
      name,
      // Server (routes/content.js) defaultet HTML auf '<p></p>' wenn leer —
      // notwendig, weil sonst ein Draft angelegt wird, der nicht in GET /pages
      // auftaucht. Explizit hier setzen schadet nicht.
      html: '<p></p>',
    };
    if (chapterId) body.chapter_id = chapterId;
    const created = await contentRepo.createPage(body);
    if (!created?.id) return null;
    this._mirrorCreatedPage(created, chapterId);
    // Kapitel aufklappen, damit die neue Seite sichtbar ist (frisch erstellte
    // Kapitel sind im Organizer per Default zu). Vor _rerender setzen:
    // _recomputeInitialOpenState behält bekannte Keys, danach bindet
    // _initSortables die jetzt sichtbare Pages-UL.
    if (chapterId) this.chapterOpen = { ...this.chapterOpen, [chapterId]: true };
    await this._rerender();
    return created;
  },

  _mirrorCreatedChapter(created, name) {
    const nav = Alpine.store('nav');
    // Neues Top-Level-Kapitel steht in Depth-First-Reihenfolge am Ende — push
    // trifft die richtige Position, kein Re-Sort (der wuerde Sub-Kapitel aus
    // ihrem Parent reissen, siehe mirror.js Ordnungs-Invariante).
    nav.tree.push(this._buildChapterEntry(created, name, { depth: 1, parentId: null }));
    this._rebuildOrderMaps();
    this._refreshChapterStats();
  },

  // Tree-Item eines neuen Kapitels. Shape muss zu tree/build.js passen.
  _buildChapterEntry(created, name, { depth, parentId }) {
    return {
      type: 'chapter',
      id: created.id,
      name: created.name || name,
      priority: created.priority ?? Number.MAX_SAFE_INTEGER,
      depth,
      parent_id: parentId,
      excluded: false,
      hasChildren: false,
      open: true,
      solo: false,
      pages: [],
    };
  },

  _mirrorCreatedPage(created, chapterId) {
    const nav = Alpine.store('nav');
    const findChapterEntry = (id) => nav.tree.find(
      it => it.type === 'chapter' && !it.solo && String(it.id) === String(id));
    const newPage = { ...created, chapterName: chapterId ? (findChapterEntry(chapterId)?.name || null) : null };
    nav.pages.push(newPage);
    if (chapterId) {
      const treeCh = findChapterEntry(chapterId);
      if (treeCh) {
        // Reassignment statt push: Alpine-Reaktivität greift bei nested
        // Arrays nicht immer zuverlässig, wenn das Parent-Item kürzlich
        // selbst gepusht wurde (neu erstelltes Kapitel). Property-Set
        // auf `.pages` triggert die Watcher in jedem Fall.
        treeCh.pages = [...treeCh.pages, newPage];
        treeCh.open = true;
      }
      // nav.pages haengt die neue Seite hinten an, obwohl sie hinter die Seiten
      // ihres Kapitels gehoert → nach Kapitel-Rang neu sortieren.
      this._resortRootPages();
    } else {
      // Solo-Entry direkt hinter den bestehenden Solo-Items einsetzen (die
      // stehen per Invariante vor allen Kapiteln).
      let lastSolo = -1;
      for (let i = 0; i < nav.tree.length; i++) {
        if (nav.tree[i].type === 'chapter' && nav.tree[i].solo) lastSolo = i;
      }
      nav.tree.splice(lastSolo + 1, 0, this._buildSoloEntry(newPage));
    }
    // Reassignment statt Index-Assign: der `tokTotals`-Memo haengt an der
    // Identitaet von `tokEsts` (app/app-root-getters.js).
    window.__app.tokEsts = { ...window.__app.tokEsts, [newPage.id]: { tok: 0, words: 0, chars: 0 } };
    this._rebuildOrderMaps();
    this._invalidateDiaryCache();
    this._refreshChapterStats();
  },

  async deleteChapter(id) {
    const root = window.__app;
    const ch = this._findChapter(id)?.node;
    if (!ch) return;
    if (ch.pages.length > 0) {
      root.setStatus(root.t('bookOrganizer.chapterNotEmpty', { name: ch.name, n: ch.pages.length }));
      return;
    }
    if ((ch.subchapters?.length || 0) > 0) {
      root.setStatus(root.t('bookOrganizer.chapterHasSubchapters', { name: ch.name }));
      return;
    }
    const ok = await root.appConfirm({
      message: root.t('bookOrganizer.confirmDeleteChapter', { name: ch.name }),
      confirmLabel: root.t('common.delete'),
      cancelLabel: root.t('common.cancel'),
      danger: true,
    });
    if (!ok) return;
    await this._deleteChapterRaw(id);
    this._clearHistory();
  },

  // Loescht ein LEERES Kapitel (Vorbedingung beider Aufrufer: deleteChapter
  // prueft pages/subchapters, Create-Undo betrifft ein frisch erstelltes).
  async _deleteChapterRaw(id) {
    const nav = Alpine.store('nav');
    const found = this._findChapter(id);
    if (!found) return false;
    return await this._runMutation(async () => {
      await contentRepo.deleteChapter(id);
      for (let i = nav.tree.length - 1; i >= 0; i--) {
        const it = nav.tree[i];
        if (it.type === 'chapter' && !it.solo && it.id === id) nav.tree.splice(i, 1);
      }
      found.parentList.splice(found.index, 1);
      // Struktur-Mirror zieht priority/depth/parent_id/hasChildren der
      // verbleibenden Kapitel nach (der Parent verliert ggf. sein letztes Kind).
      this._mirrorChapterOrderInRoot();
      this._invalidateDiaryCache();
      await this._reattachSortables();
    }, 'bookOrganizer.deleteFailed');
  },

  // Neues Sub-Kapitel unter einem bestehenden Kapitel anlegen.
  async createSubchapter(parentChapterId) {
    const root = window.__app;
    const parent = this._findChapter(parentChapterId)?.node;
    if (!parent) return;
    if (parent.depth >= MAX_CHAPTER_DEPTH) {
      root.setStatus(root.t('bookOrganizer.maxDepthReached'));
      return;
    }
    const name = await root.appPrompt({
      message: root.t('bookOrganizer.promptChapterName'),
      placeholder: root.t('bookOrganizer.placeholderChapterName'),
      confirmLabel: root.t('bookOrganizer.create'),
    });
    if (!name) return;
    let createdId = null;
    const ok = await this._runMutation(async () => {
      const created = await contentRepo.createChapter({
        book_id: parseInt(Alpine.store('nav').selectedBookId, 10),
        name,
        parent_chapter_id: parentChapterId,
      });
      if (!created?.id) return;
      createdId = created.id;
      this.chapterOpen = { ...this.chapterOpen, [parentChapterId]: true, [created.id]: true };
      // Parent NACH dem Prompt neu suchen: waehrend des Dialogs kann ein
      // `pages:loaded` den Workstate ersetzt haben. Fehlt er, bleibt nur der
      // volle Resync.
      const parentNow = this._findChapter(parentChapterId)?.node;
      if (!parentNow) { await this._applyMirror('reload'); return; }
      // Server haengt das Kapitel ans Ende der Geschwister (localdb#createChapter)
      // — dieselbe Stelle im Workstate. Den Platz im flachen nav.tree bestimmt
      // anschliessend `_reorderNavTree` ueber den Depth-First-Rang.
      parentNow.subchapters = [...(parentNow.subchapters || []), {
        id: created.id,
        name: created.name || name,
        depth: parentNow.depth + 1,
        parent_id: parentNow.id,
        pages: [],
        subchapters: [],
      }];
      Alpine.store('nav').tree.push(this._buildChapterEntry(created, name,
        { depth: parentNow.depth + 1, parentId: parentNow.id }));
      this._mirrorChapterOrderInRoot();
      await this._reattachSortables();
    }, 'bookOrganizer.createFailed');
    if (ok && createdId != null) this._recordCreateChapter(createdId, name);
  },

  // Gelöschte Seiten landen im Papierkorb (page_deletions) — darum ist das
  // Loeschen ueber die History umkehrbar: Undo stellt sie wieder her und setzt
  // sie an ihre alte Stelle (history.js#_restoreDeletedPage). Position VOR dem
  // Loeschen merken, danach ist die Seite aus dem Workstate verschwunden.
  async deletePage(id) {
    const root = window.__app;
    const page = this._findPage(id);
    if (!page) return;
    const pos = this._pagePosition(id);
    const name = page.name;
    const ok = await this._deletePageRaw(id, { name, confirm: true });
    if (!ok) return;
    this._recordDeletePage(id, name, pos.chapterId, pos.index);
    root.setStatus(root.t('bookOrganizer.deletedUndoHint', { name }), false, 5000);
  },

  // Kapitel + Index einer Seite im Workstate (0 = ohne Kapitel).
  _pagePosition(id) {
    const page = this._findPage(id);
    const chapterId = page?.chapter_id || 0;
    const bucket = this._pagesBucket(chapterId) || [];
    return { chapterId, index: Math.max(0, bucket.findIndex(p => p.id === id)) };
  },

  // Ohne Rueckfrage per Default — der History-Undo eines `create-page` loescht
  // die Seite wieder und darf dafuer keinen Dialog zeigen.
  //
  // Der Loeschvorgang selbst liegt beim Root (`deletePageById`): EINE Methode
  // fuer alle drei Loeschorte (Sidebar-Kontextmenue, Editor, diese Karte), inkl.
  // Server-Call, Entwurfs-Cleanup, Fehlermeldung und Store-Pflege. Hier bleibt
  // nur der Saving-Flag der Karte; ihr Workstate zieht ueber den
  // `page:removed`-Listener nach — derselbe Weg wie beim Remote-Delete.
  async _deletePageRaw(id, opts = {}) {
    this.organizerSaving = true;
    try {
      return await window.__app.deletePageById(id, { confirm: false, ...opts });
    } finally {
      this.organizerSaving = false;
      this.organizerStatus = '';
    }
  },

  // Entfernt eine Seite aus Store + Tree, OHNE Server-Call. Die Mutation liegt
  // beim Root (`_removePageFromTree`, SSoT): sie dispatcht `page:removed`, und
  // der Card-Listener zieht Workstate, Order-Maps und Diary-Cache nach.
  // Bleibt als eigene Methode fuer movePageToBook — dort verlaesst die Seite
  // dieses Buch, ohne geloescht zu werden.
  _forgetPageLocally(id) {
    window.__app._removePageFromTree(id);
  },

  // Seite in ein anderes Buch verschieben. Bestaetigung mit Warnung (Buchwelt-
  // Analyse der Seite wird gekappt), dann Server-Move + lokale Entfernung aus
  // diesem Buch. Die Seite landet im Zielbuch top-level — Einsortierung in ein
  // Kapitel erfolgt dort im Organizer. Nicht via History rueckgaengig.
  async movePageToBook(pageId, targetBookIdRaw) {
    const root = window.__app;
    const nav = Alpine.store('nav');
    if (this.organizerSaving) return;
    const targetBookId = parseInt(targetBookIdRaw, 10);
    if (!targetBookId) return;
    const page = this._findPage(pageId);
    if (!page) return;
    const book = (nav.books || []).find(b => String(b.id) === String(targetBookId));
    const bookName = book?.name || ('#' + targetBookId);
    const ok = await root.appConfirm({
      message: root.t('bookOrganizer.moveToBookConfirm', { page: page.name, book: bookName }),
      confirmLabel: root.t('bookOrganizer.moveToBookConfirmLabel'),
      cancelLabel: root.t('common.cancel'),
      danger: true,
    });
    if (!ok) return;
    const sourceBookId = parseInt(nav.selectedBookId, 10);
    const pageName = page.name;
    const done = await this._runMutation(async () => {
      await contentRepo.movePage(pageId, { target_book_id: targetBookId }, { sourceBookId });
      this._forgetPageLocally(pageId);
      await this._reattachSortables();
    }, 'bookOrganizer.moveToBookFailed');
    if (done) {
      // Cross-Book-Move ist nicht reversibel → History invalidieren.
      this._clearHistory();
      root.setStatus(root.t('bookOrganizer.moveToBookSuccess', { page: pageName, book: bookName }));
    }
  },
};
