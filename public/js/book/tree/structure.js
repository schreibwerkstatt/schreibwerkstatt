import { EVT } from '../../events.js';
import { contentRepo } from '../../repo/content.js';

// Struktur-Pflege des Seitenbaums ohne Reload: frisch angelegte Abschnitte
// einhaengen, den ersten Abschnitt eines neuen Kapitels anlegen, ein geloeschtes
// Kapitel entfernen. Konsumenten: Sidebar-Kontextmenue (tree-context-menu.js)
// und Kapitel-Anlage (tree/load.js#createChapter). `this` = die Alpine-Komponente.

export const treeStructureMethods = {
  // Frisch angelegten Abschnitt lokal in Baum + Flat-Liste einhaengen (ohne
  // Reload), Kapitel samt Vorfahren aufklappen, leere Stats setzen. Geteilt
  // zwischen „Neuer Abschnitt" und „Neues Kapitel" mit erstem Abschnitt
  // (tree/load.js#createChapter). Liefert den dekorierten Abschnitt.
  _insertCreatedPageIntoTree(item, created) {
    const newPage = {
      ...created,
      priority: created.position, // Sort-Alias wie decoratePage
      chapterName: item.name,
    };
    // nav.pages folgt der Lese-Reihenfolge (Sortier-Indexe in
    // tree/build.js#_rebuildTreeOrderMaps): die neue Seite gehoert hinter die
    // letzte Seite ihres Kapitels, nicht ans Buchende.
    // Ist das Kapitel leer, zaehlt die letzte Seite des naechsten Vorgaengers
    // mit Seiten (nav.tree ist depth-first, Invariante in tree/load.js).
    const tree = this.$store.nav.tree;
    let anchorId = null;
    for (let i = tree.indexOf(item); i >= 0 && anchorId == null; i--) {
      const prev = tree[i].pages;
      if (prev?.length) anchorId = prev[prev.length - 1].id;
    }
    const pages = [...this.$store.nav.pages];
    const at = anchorId != null ? pages.findIndex(p => p.id === anchorId) : -1;
    pages.splice(at + 1, 0, newPage);
    this.$store.nav.pages = pages;
    // Reassignment statt push: Property-Set auf `.pages` triggert die
    // Alpine-Watcher zuverlässig — nested-Array-push tut das nicht immer.
    item.pages = [...(item.pages || []), newPage];
    this._bumpTreeRev();
    this._rebuildTreeOrderMaps();
    // Kapitel (und alle Vorfahren) aufklappen, sonst springt der Editor auf
    // eine Seite, die in der Sidebar unsichtbar unter einem zugeklappten
    // Parent haengt.
    for (let cur = item; cur; cur = cur.parent_id ? this._findTreeChapter(cur.parent_id) : null) {
      cur.open = true;
    }
    this._persistTreeOpenState();
    // Ebenfalls Reassignment: der `tokTotals`-Memo haengt an der Identitaet
    // von `tokEsts` (app/app-root-getters.js).
    this.tokEsts = { ...this.tokEsts, [newPage.id]: { tok: 0, words: 0, chars: 0 } };
    // Organizer mit eigenem Workstate zieht nach (sonst MISSING_PAGE beim naechsten Order-PUT).
    window.dispatchEvent(new CustomEvent(EVT.PAGE_ADDED, { detail: { pageId: newPage.id } }));
    return newPage;
  },

  // Frisch angelegter, leerer Abschnitt: öffnen und gleich in den Edit-Modus
  // des Notebook-Editors — wer einen Abschnitt anlegt, will darin schreiben.
  // `startEdit` prüft selbst Rechte, Prüfmodus und geladenen Stand; greift
  // einer der Guards, bleibt die Leseansicht mit ihrem «Jetzt schreiben».
  // Konsumenten: _createFirstSection, Baum-Kontextmenü, Kapitel-Übersicht,
  // Tagebuch-Kalender.
  async openNewSectionForWriting(page) {
    await this.selectPage(page);
    if (String(this.currentPage?.id) !== String(page.id) || !this.currentPageEmpty) return;
    this.startEdit?.();
    // startEdit fokussiert per setTimeout 0 — direkt nach dem Seitenwechsel ist
    // der Editor da noch per x-show verborgen, `focus()` verpufft, und der
    // Fokus bliebe auf der Baumzeile, an die der Namensdialog ihn zurückgab.
    for (let i = 0; i < 30 && this.editMode; i++) {
      await new Promise(r => requestAnimationFrame(r));
      const el = this._getEditEl?.();
      if (el && el.offsetParent !== null) {
        if (!el.contains(document.activeElement)) el.focus();
        break;
      }
    }
  },

  // Buch aus lauter Ein-Abschnitt-Kapiteln (tree/stats.js#
  // _bookUsesSingleSectionChapters): zum neuen Kapitel entsteht der erste
  // Abschnitt gleich mit — gleichnamig, also eine Sidebar-Zeile ohne Doppel-
  // Ueberschrift — und oeffnet sich. Sonst kostete jedes Kapitel einen zweiten
  // Schritt mit zweiter Namensabfrage. Scheitert nur dieser Teil, bleibt das
  // leere Kapitel stehen; ein Klick darauf fuehrt wie immer zum Anlegen.
  async _createFirstSection(chapter) {
    if (!chapter?.id || !this.canEdit()) return;
    try {
      const page = await contentRepo.createPage({ chapter_id: chapter.id, name: chapter.name, html: '<p></p>' });
      const item = this._findTreeChapter(chapter.id);
      if (page?.id && item) await this.openNewSectionForWriting(this._insertCreatedPageIntoTree(item, page));
    } catch (e) {
      this.setStatus?.(this.t('bookOrganizer.saveFailed', { detail: e.message }));
    }
  },

  // Umbenanntes Kapitel in den Store spiegeln: Name am Baum-Item, die
  // `chapterName`-Aliase seiner Abschnitte (Palette, Editorkopf, Filter) und die
  // namens-keyenden Sortier-Indexe. SSoT fuer beide Umbenenn-Wege — Sidebar
  // (tree-context-menu.js#renameChapterById) und Buchorganizer
  // (book-organizer/crud.js#_doRenameChapter). Kein Event: das setzt der Aufrufer
  // (der Organizer darf sich nicht selbst neu rendern, das kostete den Fokus).
  _mirrorChapterRename(chapterId, name) {
    const item = this._findTreeChapter(chapterId);
    if (item) item.name = name;
    for (const p of this.$store.nav.pages) {
      if (String(p.chapter_id) === String(chapterId)) p.chapterName = name;
    }
    this._bumpTreeRev();
    this._rebuildTreeOrderMaps();
    return item;
  },

  // Leeres Kapitel serverseitig loeschen und lokal aus nav.tree nehmen. Der
  // Parent verliert ggf. sein letztes Unterkapitel (`hasChildren`).
  async deleteChapterById(chapterId) {
    const bookId = this.$store.nav.selectedBookId;
    try {
      await contentRepo.deleteChapter(chapterId, { bookId });
    } catch (e) {
      this.setStatus?.(this.t('bookOrganizer.deleteFailed', { detail: e.message }));
      return false;
    }
    const nav = this.$store.nav;
    const item = this._findTreeChapter(chapterId);
    const parentId = item?.parent_id ?? null;
    nav.tree = nav.tree.filter(it => !(it.type === 'chapter' && !it.solo && String(it.id) === String(chapterId)));
    if (parentId != null) {
      const parent = this._findTreeChapter(parentId);
      if (parent) parent.hasChildren = nav.tree.some(it => it.type === 'chapter' && !it.solo && it.parent_id === parentId);
    }
    if (String(this.kapitelReviewChapterId) === String(chapterId)) this.kapitelReviewChapterId = '';
    this._bumpTreeRev();
    this._rebuildTreeOrderMaps();
    this._refreshChapterStats();
    this._persistTreeOpenState();
    window.dispatchEvent(new CustomEvent(EVT.CHAPTER_REMOVED, { detail: { chapterId } }));
    return true;
  },
};
