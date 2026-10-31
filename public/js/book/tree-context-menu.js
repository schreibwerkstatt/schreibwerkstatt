import { EVT } from '../events.js';
import { contentRepo } from '../repo/content.js';
import { localIsoDate } from '../utils.js';
import { MAX_CHAPTER_DEPTH } from '../book-organizer/constants.js';
// Pagetree-Rechtsklick-Menü. Aktionen pro Node-Typ:
//   page    → Öffnen, Editieren (Notebook), Teilen, Exportieren, Neues Kapitel,
//             Löschen (danger)
//   chapter → Öffnen (Header-Activate = Toggle + ggf. Kapitel-Review), Kapitel
//             lektorieren, Kapitel bewerten, Teilen, Exportieren, Neues Kapitel, Neue Seite,
//             Neues Unterkapitel (bis Tiefe 3), Aus-/Einschliessen
//   beide   → Bearbeitungsstand (Abschnitt: eigene Stufe; Kapitel: alle darunter)
//   page mit `single` (Ein-Abschnitt-Kapitel, eine Sidebar-Zeile) → die
//             Seiten-Eintraege PLUS die Kapitel-Eintraege; Umbenennen, Teilen
//             und Exportieren wirken auf das Kapitel (`chapterId`), Umbenennen
//             zieht den gleichnamigen Abschnitt mit (renameChapterById).
//   Neues Kapitel wird hinter dem Ziel-Kapitel (bzw. dem Kapitel der Ziel-Seite)
//   als dessen Geschwister eingefügt, sonst ans Ende.
//
// SCHREIBENDE EINTRAEGE SIND `canEdit()`-GEGATET — Neue Seite, Neues Kapitel,
// Aus-/Einschliessen und Loeschen. Die Sichtbarkeit im Partial und der Guard in
// der Methode gehoeren zusammen: ohne den Guard bliebe der Pfad ueber Tastatur
// oder einen veralteten Rollen-Stand erreichbar, ohne die Sichtbarkeit saehe ein
// viewer/lektor Eintraege, die serverseitig mit 403 enden. Lesende Eintraege
// (Oeffnen, Teilen, Exportieren) bleiben ungegated — sie brauchen nur `viewer`.
//
// State + Mechanik aus action-menu.js (`actionMenuState`/`actionMenuMethods`,
// in den Root gespreadet); Ziel steht als `actionMenuTarget` im Menue. Render-
// HTML in public/partials/sidebar-pagetree-menu.html.
// Methoden hier werden über `treeContextMenuMethods` in den Root gespreadet —
// `this` ist die Alpine-Root-Komponente.

const MENU_CLOSE_EVENTS = [EVT.BOOK_CHANGED, EVT.PAGES_LOADED, EVT.VIEW_RESET];

export const treeContextMenuMethods = {
  // Rechtsklick bzw. Long-Press auf eine Baum-Zeile. Mechanik (Position,
  // Tastatur, Schliessen, Fokus zurueck) aus action-menu.js. Ein Buchwechsel
  // oder Tree-Reload macht das Ziel ungueltig: die ID zeigte danach auf eine
  // Seite, die es in diesem Buch nicht gibt.
  _openPagetreeContextMenu(ev, target) {
    if (!target || !target.kind || target.id == null) return;
    this.openActionMenu(ev, `pagetree:${target.kind}:${target.id}`, target, { closeOn: MENU_CLOSE_EVENTS });
  },

  // Sucht das Chapter-Item im Tree. `nav.tree` ist FLACH + depth-annotiert
  // (Invariante in tree/load.js) — Sub-Kapitel stehen als eigene Items darin,
  // nicht in einem `subchapters`-Array. Ein `find` trifft daher alle Ebenen.
  _findTreeChapter(id) {
    return (this.$store.nav.tree || []).find(
      it => it.type === 'chapter' && String(it.id) === String(id)) || null;
  },

  _findTreePage(id) {
    return (this.$store.nav.pages || []).find(p => String(p.id) === String(id)) || null;
  },

  // Kapitel, auf das ein Menue-Ziel wirkt: der Kapitelkopf selbst oder das
  // Kapitel hinter einer Ein-Abschnitt-Zeile. Sonst null (normaler Abschnitt).
  _pagetreeCtxChapterId(target = this.actionMenuTarget) {
    if (!target) return null;
    if (target.kind === 'chapter') return target.id;
    return target.single ? target.chapterId : null;
  },

  // Plaketten der Zeile als Menue-Eintraege (Tastatur-Zugang: die Plaketten
  // selbst liegen ausserhalb der Tab-Folge). Abschnitt: seine Zaehler; Kapitel-
  // kopf: die des Kapitels; Ein-Abschnitt-Zeile: Abschnitt, sonst Kapitel.
  _pagetreeCtxBadges(target = this.actionMenuTarget) {
    if (!target) return [];
    const b = this.$store.badges;
    const chapterId = this._pagetreeCtxChapterId(target);
    const out = [];
    const add = (kind, scope, id, n) => {
      if (n > 0 && !out.some(o => o.kind === kind)) out.push({
        kind, scope, id, n,
        icon: kind === 'ideen' ? 'lightbulb' : 'compass',
        label: kind === 'ideen' ? 'pagetreeCtx.openIdeen' : 'pagetreeCtx.openRecherche',
      });
    };
    if (target.kind === 'page') {
      add('ideen', 'page', target.id, b.ideenCounts[target.id] || 0);
      add('recherche', 'page', target.id, b.rechercheCounts[target.id] || 0);
    }
    if (chapterId != null) {
      add('ideen', 'chapter', chapterId, b.chapterIdeenCounts[chapterId] || 0);
      add('recherche', 'chapter', chapterId, b.chapterRechercheCounts[chapterId] || 0);
    }
    return out;
  },

  pagetreeCtxOpenBadge(badge) {
    this.closeActionMenu();
    if (!badge) return;
    if (badge.kind === 'ideen') {
      if (badge.scope === 'page') this.openIdeenForPage(badge.id);
      else this.openIdeenForChapter(badge.id);
    } else if (badge.scope === 'page') this.openRechercheForPage(badge.id);
    else this.openRechercheForChapter(badge.id);
  },

  pagetreeCtxReviewChapter() {
    const chapterId = this._pagetreeCtxChapterId();
    this.closeActionMenu();
    if (chapterId != null) this.openKapitelReviewForChapter(chapterId);
  },

  pagetreeCtxOpen() {
    const target = this.actionMenuTarget;
    this.closeActionMenu();
    if (!target) return;
    if (target.kind === 'page') {
      const page = this._findTreePage(target.id);
      if (page) this.selectPage(page);
    } else {
      const item = this._findTreeChapter(target.id);
      if (item) this._onChapterHeaderActivate(item);
    }
  },

  async pagetreeCtxEdit() {
    const target = this.actionMenuTarget;
    this.closeActionMenu();
    if (!target || target.kind !== 'page') return;
    const page = this._findTreePage(target.id);
    if (!page) return;
    await this.selectPage(page);
    // selectPage kann ohne Wechsel zurueckkehren (Dirty-Rueckfrage abgelehnt)
    // — dann gehoert die Folgeaktion nicht der weiterhin offenen Seite.
    if (this.currentPage?.id !== page.id) return;
    // selectPage öffnet die Editor-Karte im View-Mode; Notebook-Edit-Trampoline
    // setzt editMode=true und installiert Autosave.
    this.startEdit?.();
  },

  async pagetreeCtxLektorieren() {
    const target = this.actionMenuTarget;
    this.closeActionMenu();
    if (!target || target.kind !== 'page') return;
    const page = this._findTreePage(target.id);
    if (!page) return;
    await this.selectPage(page);
    if (this.currentPage?.id !== page.id) return; // siehe pagetreeCtxEdit
    this.runCheck?.();
  },

  // Alle Abschnitte des Kapitels (inkl. Unterkapitel) als Serien-Lektorat.
  pagetreeCtxLektorierenChapter() {
    const target = this.actionMenuTarget;
    this.closeActionMenu();
    if (!target || target.kind !== 'chapter') return;
    this.batchCheck?.(target.id);
  },

  // Markierte Stufe im Bearbeitungsstand-Block: am Abschnitt seine eigene, am
  // Kapitelkopf die schwaechste darunter (tree/edit-status.js).
  _pagetreeCtxStatus(target = this.actionMenuTarget) {
    if (!target) return null;
    if (target.kind === 'page') return this.pageEditStatus(target.id)?.status || null;
    return this.chapterEditStatus(this._findTreeChapter(target.id))?.status || null;
  },

  // Abschnitt: Klick auf die aktive Stufe nimmt sie zurueck. Kapitel: setzt
  // alle Abschnitte darunter (Rueckfrage bei abweichenden Einzelstaenden).
  async pagetreeCtxSetStatus(status) {
    const target = this.actionMenuTarget;
    const current = this._pagetreeCtxStatus(target);
    this.closeActionMenu();
    if (!target) return;
    if (target.kind === 'page') {
      await this.setPageEditStatus(target.id, current === status ? null : status);
    } else {
      await this.setChapterEditStatus(target.id, status);
    }
  },

  // Seite oder Kapitel umbenennen (Titel per appPrompt, vorbelegt).
  async pagetreeCtxRename() {
    const target = this.actionMenuTarget;
    this.closeActionMenu();
    if (!target || !this.canEdit()) return;
    const chapterId = this._pagetreeCtxChapterId(target);
    const current = chapterId == null
      ? this._findTreePage(target.id)?.name
      : this._findTreeChapter(chapterId)?.name;
    if (current == null) return;
    const name = (await this.appPrompt({
      message: this.t(chapterId == null ? 'pagetreeCtx.renamePagePrompt' : 'pagetreeCtx.renameChapterPrompt'),
      defaultValue: current,
      confirmLabel: this.t('pagetreeCtx.renameConfirm'),
    }))?.trim();
    if (!name || name === current) return;
    if (chapterId == null) await this.renamePageById(Number(target.id), name);
    else await this.renameChapterById(chapterId, name);
  },

  // Ein-Abschnitt-Zeile, deren Abschnitt anders heisst als das Kapitel (die
  // Sidebar zeigt den Abschnittsnamen dann grau daneben). Exporte und
  // Bucheditor drucken nur den Kapitelnamen; der abweichende Name lebt nur im
  // Editorkopf weiter und haengt das Mitbenennen ab.
  _pagetreeCtxTitlesDiffer(target = this.actionMenuTarget) {
    if (!target?.single) return false;
    const page = this._findTreePage(target.id);
    const ch = this._findTreeChapter(target.chapterId);
    return !!page && !!ch && !this.sameStructureTitle(page.name, ch.name);
  },

  // Abschnitt bekommt den Kapitelnamen — ab dann benennen sich beide
  // gegenseitig mit (renameChapterById / renamePageById).
  async pagetreeCtxAlignTitles() {
    const target = this.actionMenuTarget;
    this.closeActionMenu();
    if (!this.canEdit() || !this._pagetreeCtxTitlesDiffer(target)) return;
    const ch = this._findTreeChapter(target.chapterId);
    await this.renamePageById(Number(target.id), ch.name);
  },

  // Kapitel umbenennen: Server, dann In-Place-Mirror auf nav.tree, die
  // `chapterName`-Aliase der Seiten und die namens-keyenden Sortier-Indexe.
  // Gegenstueck zu app-view/page.js#renamePageById. Hat das Kapitel genau einen
  // Abschnitt, der bisher gleich hiess, wird er mitbenannt (_renameTwinTitle) —
  // sonst liefen die Namen auseinander, und Export/Bucheditor zeigten ab dann
  // zwei Ueberschriften.
  async renameChapterById(chapterId, newName) {
    const name = (newName || '').trim();
    if (chapterId == null || !name) return false;
    const oldName = this._findTreeChapter(chapterId)?.name;
    try {
      await contentRepo.updateChapter(chapterId, { name }, { bookId: this.$store.nav.selectedBookId });
    } catch (e) {
      this.setStatus?.(this.t('bookOrganizer.saveFailed', { detail: e.message }));
      return false;
    }
    const item = this._mirrorChapterRename(chapterId, name); // tree/structure.js
    window.dispatchEvent(new CustomEvent(EVT.TREE_RENAMED, { detail: { kind: 'chapter', id: chapterId } }));
    const twin = item && item.pages?.length === 1 && !item.hasChildren ? item.pages[0] : null;
    if (twin && this.sameStructureTitle(twin.name, oldName) && !this.sameStructureTitle(twin.name, name)) {
      await this.renamePageById(twin.id, name);
    }
    return true;
  },

  pagetreeCtxShare() {
    const target = this.actionMenuTarget;
    this.closeActionMenu();
    if (!target) return;
    const chapterId = this._pagetreeCtxChapterId(target);
    if (chapterId == null) this.openShareLinksForPage(target.id);
    else this.openShareLinksForChapter(chapterId);
  },

  // Kapitel aus Export/Bewertung/Komplettanalyse aus- bzw. wieder einschliessen.
  // Lektorat + Fassungen bleiben unberuehrt. In-Place-Mirror auf nav.tree (flach,
  // inkl. Sub-Kapitel) fuer sofortiges Greying. Geteilt zwischen Sidebar-Kontext-
  // menue und Kapitelbewertungs-Meatball.
  async setChapterExcluded(chapterId, next) {
    if (chapterId == null) return;
    try {
      await contentRepo.updateChapter(chapterId, { excluded: !!next }, { bookId: this.$store.nav.selectedBookId });
      for (const it of (this.$store.nav.tree || [])) {
        if (it.type === 'chapter' && !it.solo && String(it.id) === String(chapterId)) it.excluded = !!next;
      }
      // Suchtreffer sind Kopien der Items (app.js#filteredTree) — ohne Reset
      // zeigte eine laufende Suche den alten Ausschluss weiter.
      this._bumpTreeRev();
    } catch (e) {
      this.setStatus?.(this.t('bookOrganizer.saveFailed', { detail: e.message }));
    }
  },

  pagetreeCtxToggleExclude() {
    const target = this.actionMenuTarget;
    this.closeActionMenu();
    const chapterId = this._pagetreeCtxChapterId(target);
    if (chapterId == null || !this.canEdit()) return;
    // Ueber einen Vorfahren ausgeschlossen: das eigene Flag zu setzen aenderte
    // nichts (Kaskade in lib/load-contents.js) — der Eintrag ist dort gesperrt.
    if (target.excludedByParent && !target.excluded) return;
    this.setChapterExcluded(chapterId, !target.excluded);
  },

  // Seite aus dem Kontextmenü löschen (danger, bestätigungspflichtig).
  async pagetreeCtxDeletePage() {
    const target = this.actionMenuTarget;
    this.closeActionMenu();
    if (!target || target.kind !== 'page' || !this.canEdit()) return;
    const page = this._findTreePage(target.id);
    if (!page) return;
    // Offene Seite: ueber `deleteCurrentPage`, damit der Kapitel-Rueckfall
    // greift (sonst stuende der User nach dem Loeschen vor einer leeren
    // Ansicht). Der eigentliche Loeschvorgang liegt in beiden Faellen in
    // `deletePageById` — Rueckfrage, Server-Call und Tree-Pflege inklusive.
    if (this.currentPage && this.currentPage.id === page.id) {
      await this.deleteCurrentPage();
      return;
    }
    await this.deletePageById(page.id, { name: page.name });
  },

  // Kapitel loeschen: am Kapitelkopf nur ein LEERES (wie im Buchorganizer,
  // book-organizer/crud.js#deleteChapter), an einer Ein-Abschnitt-Zeile samt dem
  // einen Abschnitt. Der Abschnitt geht wie jedes Loeschen in den Papierkorb,
  // das dann leere Kapitel wird entfernt. Scheitert der zweite Schritt, bleibt
  // ein leeres Kapitel stehen — derselbe Zustand wie nach „Abschnitt loeschen".
  async pagetreeCtxDeleteChapter() {
    const target = this.actionMenuTarget;
    this.closeActionMenu();
    const chapterId = this._pagetreeCtxChapterId(target);
    if (chapterId == null || !this.canEdit()) return;
    const item = this._findTreeChapter(chapterId);
    if (!item || item.solo || item.hasChildren) return;
    if (target.single) {
      if (item.pages.length !== 1) return;
      const ok = await this.appConfirm({
        message: this.t('pagetreeCtx.confirmDeleteSingleChapter', { name: item.name }),
        confirmLabel: this.t('common.delete'),
        cancelLabel: this.t('common.cancel'),
        danger: true,
      });
      if (!ok) return;
      const page = item.pages[0];
      if (!await this.deletePageById(page.id, { name: page.name, confirm: false })) return;
    } else {
      if (item.pages.length > 0) return;
      const ok = await this.appConfirm({
        message: this.t('bookOrganizer.confirmDeleteChapter', { name: item.name }),
        confirmLabel: this.t('common.delete'),
        cancelLabel: this.t('common.cancel'),
        danger: true,
      });
      if (!ok) return;
    }
    await this.deleteChapterById(chapterId);
  },

  // Neue Seite direkt im angeklickten Kapitel anlegen: Titel per appPrompt,
  // dann Baum + Flat-Liste lokal einhängen und zur neuen Seite springen.
  async pagetreeCtxNewPage() {
    const target = this.actionMenuTarget;
    this.closeActionMenu();
    const chapterId = this._pagetreeCtxChapterId(target);
    if (chapterId == null || !this.canEdit()) return;
    const item = this._findTreeChapter(chapterId);
    if (!item || item.solo) return;
    const isDiary = this.isTagebuch();
    const name = await this.appPrompt({
      message: this.t('pagetreeCtx.newPagePrompt'),
      placeholder: this.t('pagetreeCtx.newPagePlaceholder'),
      defaultValue: isDiary ? localIsoDate() : '',
      confirmLabel: this.t('pagetreeCtx.newPageConfirm'),
    });
    if (!name) return;
    try {
      const created = await contentRepo.createPage({
        chapter_id: parseInt(chapterId, 10),
        name,
        html: '<p></p>',
      });
      if (!created?.id) return;
      const newPage = this._insertCreatedPageIntoTree(item, created);
      await this.openNewSectionForWriting(newPage);
    } catch (e) {
      this.setStatus?.(this.t('bookOrganizer.saveFailed', { detail: e.message }));
    }
  },

  // Neues Kapitel direkt aus dem Kontextmenü. Position: hinter dem
  // angeklickten Kapitel bzw. hinter dem Kapitel der angeklickten Seite, auf
  // derselben Ebene (kein Match → ans Ende). createChapter liest `newChapterTitle`.
  async pagetreeCtxNewChapter() {
    const target = this.actionMenuTarget;
    this.closeActionMenu();
    if (!target || !this.canEdit()) return;
    let afterChapterId = null;
    if (target.kind === 'chapter') {
      afterChapterId = target.id;
    } else if (target.kind === 'page') {
      afterChapterId = this._findTreePage(target.id)?.chapter_id ?? null;
    }
    const name = await this.appPrompt({
      message: this.t('bookOrganizer.promptChapterName'),
      placeholder: this.t('bookOrganizer.placeholderChapterName'),
      confirmLabel: this.t('bookOrganizer.create'),
    });
    if (!name) return;
    this.newChapterTitle = name;
    // createChapter hängt das Kapitel (open:true) lokal in den Tree — es
    // erscheint sofort in der Sidebar; keine Karte aufreissen.
    await this.createChapter({ afterChapterId });
  },

  // Unterkapitel im angeklickten Kapitel (bzw. dem Kapitel hinter einer
  // Ein-Abschnitt-Zeile) anlegen — als letztes Kind, nur bis zur dritten Ebene
  // (MAX_CHAPTER_DEPTH, Server antwortet sonst CHAPTER_MAX_DEPTH).
  _pagetreeCtxCanAddSubchapter(target = this.actionMenuTarget) {
    const chapterId = this._pagetreeCtxChapterId(target);
    if (chapterId == null) return false;
    const item = this._findTreeChapter(chapterId);
    return !!item && !item.solo && (item.depth || 1) < MAX_CHAPTER_DEPTH;
  },

  async pagetreeCtxNewSubchapter() {
    const target = this.actionMenuTarget;
    const ok = this._pagetreeCtxCanAddSubchapter(target);
    const parentId = this._pagetreeCtxChapterId(target);
    this.closeActionMenu();
    if (!ok || !this.canEdit()) return;
    const name = await this.appPrompt({
      message: this.t('pagetreeCtx.newSubchapterPrompt'),
      placeholder: this.t('bookOrganizer.placeholderChapterName'),
      confirmLabel: this.t('bookOrganizer.create'),
    });
    if (!name) return;
    this.newChapterTitle = name;
    await this.createChapter({ parentChapterId: parentId });
  },

  async pagetreeCtxExport() {
    const target = this.actionMenuTarget;
    this.closeActionMenu();
    const chapterId = this._pagetreeCtxChapterId(target);
    if (chapterId != null) {
      await this.openExportFor('chapter', chapterId);
    } else if (target?.kind === 'page') {
      await this.openExportFor(target.kind, target.id);
    } else {
      await this.openExportFor();
    }
  },

  // Export-Karte öffnen, optional mit Seiten-/Kapitel-Preset. Geteilt zwischen
  // Sidebar-Kontextmenue und den Meatball-Menues (Notebook-Seitenaktionen +
  // Kapitelbewertung).
  async openExportFor(kind, id) {
    const preset = (kind === 'page' || kind === 'chapter') && id != null
      ? { kind, id }
      : null;
    if (preset) {
      this.__exportPreset = preset;
      window.dispatchEvent(new CustomEvent(EVT.EXPORT_PRESET, { detail: preset }));
    }
    if (!this.showExportCard) await this.toggleExportCard();
    else this._scrollToCardByKey('export');
  },
};
