// Teil von appViewMethods (siehe Facade app-view.js).
import { EVT, _withCardTransition, clearDraft, contentRepo, decorateMentions, escHtml, fetchJson, getDeviceId, htmlToText, readDraft, setLastPageId } from './_shared.js';
import { lsSet, lsRemove } from '../../safe-storage.js';

// Wie lange `selectPage` aus einer anderen Karte auf den Seiteninhalt wartet,
// bevor es trotzdem umschaltet (dann mit Lade-Skelett). Kurz genug, dass der
// Klick nicht hängt; lang genug für SW-Cache und lokales Netz.
const PREFETCH_WAIT_MS = 300;

export const pageMethods = {
  async selectPage(p) {
    if (this.currentPage && this.currentPage.id === p.id) {
      // Re-Klick auf bereits offene Seite: SW-Cache umgehen und frischen
      // Server-Stand laden. Aktive Edits nicht überschreiben.
      if (this.editMode || this.editDirty) return;
      this._scrollToEditorCard();
      await this._refetchCurrentPage();
      return;
    }
    if (this.editMode && this.editDirty) {
      // appConfirm statt native confirm(): gleicher Dialog wie cancelEdit /
      // discardDraft. Nicht `danger` — der Entwurf bleibt erhalten (resetPage
      // baut die Session mit `keepDraft` ab), es geht nichts verloren.
      const ok = await this.appConfirm({
        message: this.t('app.switchPageConfirm'),
        confirmLabel: this.t('app.switchPageConfirmBtn'),
      });
      if (!ok) return;
    }
    // Drei Wege in den Editor, alle ohne leeren Zwischen-Frame:
    // - `swap` (Abschnitt → Abschnitt aus der Leseansicht): Karte und gerenderter
    //   Text der alten Seite bleiben stehen, bis der neue Inhalt sie ersetzt
    //   (gedimmt, falls das dauert). Sonst blendete `showEditorCard` false → true
    //   die Karte aus und wieder ein (cardFadeIn neu, Skelett blitzt auf).
    // - `deferClose` (aus einer anderen Karte oder einer leeren Seite): die alte
    //   Ansicht bleibt stehen, während Partials und Seiteninhalt laden (Inhalt
    //   höchstens PREFETCH_WAIT_MS lang), dann schaltet ein Schritt im
    //   Karten-Cross-Fade um — der Editor erscheint mit Text statt leer.
    // - Edit-/Fokus-Modus: sofort abbauen wie bisher. Dort ist `renderedPageHtml`
    //   nicht der sichtbare Stand, und eine stehen gelassene Edit-Session nähme
    //   während des Wartens noch Eingaben an.
    const swap = !!(this.showEditorCard && this.currentPage && this.renderedPageHtml
      && !this.editMode && !this.focusActive);
    const deferClose = !swap && !this.editMode && !this.focusActive;
    const seq = this._selectPageSeq = (this._selectPageSeq || 0) + 1;
    if (!deferClose) {
      // Alle Buchkarten schliessen + Editor-State resetten – nur eine Ebene
      // (Buch oder Seite) aktiv. Helper deckt alle showXxxCard-Flags ab und
      // ruft resetPage().
      this._closeOtherMainCards(null, { keepView: swap });
      // Synchron setzen, damit kein Render-Tick mit offener Karte ohne Seite liegt.
      if (swap) this.currentPage = p;
    }
    const prefetch = deferClose ? this._prefetchPage(p.id) : null;
    // Editor + Sub-Partials parallel laden. Sub-Karten (toolbar, find, synonyme,
    // figur-lookup, focus) sind Geschwister-Partials, keine nested children —
    // werden vom Cascade-Helper deshalb nicht automatisch mitgezogen.
    await Promise.all([
      this._ensurePartial('editor-notebook'),
      this._ensurePartial('editor-toolbar'),
      this._ensurePartial('editor-find'),
      this._ensurePartial('editor-figur-lookup'),
      this._ensurePartial('editor-synonyme'),
      this._ensurePartial('editor-focus'),
      prefetch && Promise.race([prefetch.promise, new Promise(r => setTimeout(r, PREFETCH_WAIT_MS))]),
    ]);
    // Während der Awaits wurde ein anderer Abschnitt gewählt: dessen Aufruf
    // besitzt die Ansicht.
    if (seq !== this._selectPageSeq) return;
    // Exklusivität (bei `deferClose` die erste Runde, sonst die zweite): die
    // Awaits oben sind Netz-Fetches und können bei schlechter Verbindung hängen.
    // In dieser Zeit kann ein parallel laufender Landing-Pfad
    // (`_maybeOpenBookOverview`) eine Buchkarte geöffnet haben — ohne diesen
    // Re-Assert stünden Übersicht und Editor gleichzeitig offen. `resetPage`
    // nur, wenn er oben nicht schon lief: ein zweiter Lauf würde die gerade
    // aufgebaute Editor-Session wieder abräumen.
    // `_loadCurrentPageContent` wendet einen schon eingetroffenen Prefetch
    // synchron an — Umschalten und Inhalt landen im selben Render.
    let loaded;
    const flip = () => {
      this._closeOtherMainCards(null, { resetPage: deferClose });
      this.currentPage = p;
      this.showEditorCard = true;
      this.analysisOut = '';
      loaded = this._loadCurrentPageContent(p, { prefetch });
    };
    if (deferClose) await _withCardTransition(this, flip);
    else flip();
    this.$nextTick(() => this._scrollToEditorCard());

    if (typeof this._trackPageUsage === 'function' && this.$store.nav.selectedBookId) {
      this._trackPageUsage(p.id, this.$store.nav.selectedBookId);
    }
    setLastPageId(this.$store.session.currentUser?.email, this.$store.nav.selectedBookId, p.id);
    // Eine geoeffnete Seite ist das staerkste „ich arbeite in DIESEM Buch"-Signal
    // (gedrosselt im Helfer). Es entscheidet, welches Buch der naechste Aufruf
    // der Stamm-URL zeigt.
    this._touchBookOpened?.(this.$store.nav.selectedBookId);

    this._loadPageBadgeCounts(p.id);

    // Seiteninhalt (oben in `flip` angestossen) abwarten. Fehler landen nicht
    // still in einer leeren Seite, sondern in einem Retry-Block (pageLoadError)
    // — inkl. einmaligem stillem Auto-Retry mit Cache-Bypass.
    await loaded;
    // Die Leseansicht scrollt intern; beim Swap behielte sie die Position der
    // alten Seite.
    if (swap && this.currentPage?.id === p.id) {
      const view = document.querySelector('#editor-card .page-view-wrap > .page-content-view');
      if (view) view.scrollTop = 0;
    }
    // Während der Awaits eine andere Seite geöffnet: der Rest gehört deren
    // eigenem selectPage. Ein hier gestarteter Lektorat-Poll läse seine Seite aus
    // `currentPage` und hinge die Befunde von `p` an die neue.
    const stillHere = () => this.currentPage?.id === p.id;
    if (!stillHere()) return;

    // Prüfen ob ein Lektorat-Check-Job für diese Seite läuft (Server-seitig oder aus früherer Session)
    try {
      const { jobId: activeJobId } = await fetchJson(`/jobs/active?type=check&page_id=${p.id}`);
      if (!stillHere()) return;
      if (activeJobId) {
        lsSet('lektorat_check_job_' + p.id, activeJobId);
        this.checkLoading = true;
        this.checkProgress = 0;
        this.analysisOut = '';
        this.checkStatus = `<span class="spinner"></span>${escHtml(this.t('app.lektoratRunning'))}`;
        this.startCheckPoll(activeJobId);
      } else {
        // Kein aktiver Job → stale localStorage-Eintrag bereinigen
        lsRemove('lektorat_check_job_' + p.id);
      }
    } catch (e) { console.error('[selectPage active-job check]', e); }

    if (!stillHere()) return;
    // Figurenkontext für dieses Kapitel laden (parallel zur History)
    this.loadChapterFigures();
    await this.loadPageHistory(p.id);
  },


  // Lädt die aktuell offene Seite neu vom Server (SW-Cache umgangen). Wird
  // beim Re-Klick auf die offene Sidebar-Seite verwendet, damit nach einer
  // Änderung auf einem anderen Gerät kein veralteter Stand stehenbleibt.
  // Push-getriebenen „Zuletzt bearbeitet"-Hint aufbereiten. Zeigt nur, wenn das
  // letzte Save von einem ANDEREN eigenen Gerät kam: device_name ist serverseitig
  // schon user-scoped (kein Fremd-Leak), hier zusätzlich das AKTUELLE Gerät
  // ausfiltern (is_current_device → kein irritierender Selbst-Hinweis). Kein
  // Live-Signal: der Stand stammt aus dem letzten Save, refresht nur bei Reload.
  _resolvePageLastEditor(le) {
    if (!le || !le.device_name || !le.device_id) return null;
    if (le.device_id === getDeviceId()) return null;
    return { device_name: le.device_name, updated_at: le.updated_at || null };
  },


  // Page-Detail-Antwort in den Render-State übernehmen. Geteilt von
  // selectPage-Load und _refetchCurrentPage, damit beide Pfade exakt dieselben
  // Felder setzen (kein Drift). `p` ist die Page (currentPage).
  _applyPageData(p, pd) {
    const html = pd.html || '';
    this.originalHtml = html;
    this.renderedPageHtml = decorateMentions(html);
    this._updatePageViewHeight();
    // Listing-Cache kann stale sein (Page-Save aktualisiert ihn nicht).
    if (pd.updated_at) p.updated_at = pd.updated_at;
    // Wer zuletzt geschrieben hat — das Konflikt-Modal der Draft-Wiederaufnahme
    // nennt damit den Urheber der anderen Version (page-conflict.js#remoteAuthorFrom).
    p.last_editor_email = pd.last_editor_email || null;
    p.last_editor = pd.last_editor || null;
    p.updated_by_name = pd.updated_by_name || null;
    this.currentPageEmpty = !htmlToText(html).trim();
    this.pageLastEditor = this._resolvePageLastEditor(pd.last_editor);
    this._refreshPendingDraft(p.id, html);
    return html;
  },


  // Seiteninhalt für `p` laden und rendern. Bei Ladefehler einmaliger stiller
  // Auto-Retry mit Cache-Bypass (`fresh`) — deckt transiente Netz-/SW-Cache-
  // Zustände ab (typisch direkt nach Deploy). Schlägt auch der Retry fehl,
  // wird `pageLoadError` gesetzt → View zeigt Retry-Block statt leerer Seite.
  // `auto`=false unterdrückt den stillen Retry (manueller Retry-Button).
  // `prefetch` (aus `_prefetchPage`): ist er schon eingetroffen, wird ohne
  // await angewendet; sonst wird auf ihn gewartet, statt ein zweites Mal zu laden.
  async _loadCurrentPageContent(p, { auto = true, prefetch = null } = {}) {
    const pageId = p.id;
    this.pageLoadError = false;
    this.pageContentLoading = true;
    try {
      let pd = prefetch?.pd || (prefetch && await prefetch.promise) || await contentRepo.loadPage(pageId);
      // Während des await kann der User weggewechselt haben → nichts anwenden.
      if (this.currentPage?.id !== pageId) return true;
      // Stale-Check: Wenn der Tree-Eintrag (`p.updated_at`, kann selbst aus
      // SW-Cache stammen) jünger ist als die Detail-Antwort, hat der SW eine
      // veraltete Version geliefert → einmalig mit `fresh` nachziehen.
      if (p.updated_at && pd.updated_at && new Date(pd.updated_at) < new Date(p.updated_at)) {
        pd = await contentRepo.loadPage(pageId, { fresh: true });
        if (this.currentPage?.id !== pageId) return true;
      }
      this._applyPageData(p, pd);
      return true;
    } catch (e) {
      console.error('[selectPage load-page]', e);
      if (this.currentPage?.id !== pageId) return false;
      if (auto) {
        try {
          const pd = await contentRepo.loadPage(pageId, { fresh: true });
          if (this.currentPage?.id !== pageId) return false;
          this._applyPageData(p, pd);
          return true;
        } catch (e2) {
          console.error('[selectPage load-page retry]', e2);
          if (this.currentPage?.id !== pageId) return false;
        }
      }
      this.pageLoadError = true;
      // Beim Swap stünde sonst der Text der vorherigen Seite neben dem Retry-Block.
      this.renderedPageHtml = '';
      this.setStatus(this.t('chat.pageLoadFailed'));
      return false;
    } finally {
      // Skelett nur ausblenden, wenn dieser Load noch die aktuelle Seite betrifft —
      // bei schnellem Weiterwechsel besitzt der neuere Load das Flag.
      if (this.currentPage?.id === pageId) this.pageContentLoading = false;
    }
  },


  // Seiteninhalt vorab laden, solange noch die vorherige Ansicht steht.
  // `pd` ist gesetzt, sobald die Antwort da ist; ein Fehler endet als `null`
  // und `_loadCurrentPageContent` lädt dann selbst (inkl. Retry-Pfad).
  _prefetchPage(pageId) {
    const box = { pd: null, promise: null };
    box.promise = contentRepo.loadPage(pageId).then(pd => (box.pd = pd), () => null);
    return box;
  },


  // Aus dem Retry-Block im View-Modus: Seiteninhalt erneut laden (Cache-Bypass
  // via `fresh` greift im stillen Auto-Retry-Zweig von _loadCurrentPageContent).
  async retryLoadPage() {
    if (!this.currentPage || this._retryingPageLoad) return;
    this._retryingPageLoad = true;
    try {
      await this._loadCurrentPageContent(this.currentPage);
    } finally {
      this._retryingPageLoad = false;
    }
  },


  async _refetchCurrentPage() {
    if (!this.currentPage) return;
    const pageId = this.currentPage.id;
    try {
      const pd = await contentRepo.loadPage(pageId, { fresh: true });
      if (this.currentPage?.id !== pageId) return;
      const html = this._applyPageData(this.currentPage, pd);
      // Findings/Marks erhalten: ohne Refilter würden Marks beim Refetch
      // (Re-Klick, Collab-Remote-Edit, Revision-Restore) verschwinden, obwohl
      // `checkDone` + `lektoratFindings` noch gesetzt sind.
      if (this.lektoratFindings?.length > 0) {
        this._filterFindingsAfterSave?.(html);
        this.updatePageView();
      }
    } catch (e) {
      console.error('[refetchCurrentPage]', e);
      this.setStatus(this.t('chat.pageLoadFailed'));
    }
  },


  // Inline-Rename des Seitentitels aus dem Editor-Card-Header.
  async renameCurrentPage(ev) {
    const newName = (ev?.target?.value || '').trim();
    const page = this.currentPage;
    if (!page || !newName || page.name === newName) {
      if (page && ev?.target) ev.target.value = page?.name || '';
      return;
    }
    const ok = await this.renamePageById(page.id, newName);
    if (!ok && ev?.target) ev.target.value = page.name;
  },

  // Seite umbenennen — geteilt zwischen Editor-Kopf (renameCurrentPage) und
  // Sidebar-Kontextmenü. Spiegelt den neuen Namen in currentPage, nav.pages und
  // nav.tree (Seiten-Objekte und Solo-Wrapper; nav.tree ist flach, Sub-Kapitel
  // stehen als eigene Items darin), baut die namens-keyenden Sortier-Indexe neu
  // und invalidiert den Such-Memo. Der Buchorganizer pflegt seine eigene Spur
  // (book-organizer/crud.js#_doRenamePage) und hoert hier auf TREE_RENAMED.
  // Ist die Seite der einzige Abschnitt ihres Kapitels und hiess sie bisher wie
  // das Kapitel, wird das Kapitel mitbenannt (Gegenstueck zu
  // tree-context-menu.js#renameChapterById).
  // Liefert true bei Erfolg; der Fehler steht dann schon im Status.
  async renamePageById(pageId, newName) {
    const name = (newName || '').trim();
    if (!pageId || !name) return false;
    const before = this.$store.nav.pages.find(p => p.id === pageId);
    const oldName = before?.name;
    const chapterId = before?.chapter_id ?? null;
    try {
      await contentRepo.updatePage(pageId, { name });
    } catch (e) {
      this.setStatus(this.t('bookOrganizer.saveFailed', { detail: e.message }));
      return false;
    }
    const nav = this.$store.nav;
    if (this.currentPage?.id === pageId) this.currentPage.name = name;
    for (const p of nav.pages) if (p.id === pageId) p.name = name;
    for (const it of nav.tree) {
      if (it.type !== 'chapter') continue;
      if (it.solo && it.pages?.[0]?.id === pageId) it.name = name;
      for (const p of it.pages || []) if (p.id === pageId) p.name = name;
    }
    this._bumpTreeRev?.();
    this._rebuildTreeOrderMaps?.();
    // nav.pages-Identität neu setzen → invalidiert den identity-gateten
    // Diary-Kalender-Cache (er keyt auf den YYYY-MM-DD-Page-Namen).
    nav.pages = [...nav.pages];
    window.dispatchEvent(new CustomEvent(EVT.TREE_RENAMED, { detail: { kind: 'page', id: pageId } }));
    const ch = chapterId != null ? this._findTreeChapter?.(chapterId) : null;
    if (ch && ch.pages?.length === 1 && !ch.hasChildren
        && this.sameStructureTitle(ch.name, oldName) && !this.sameStructureTitle(ch.name, name)) {
      await this.renameChapterById(chapterId, name);
    }
    return true;
  },


  // EINZIGER Loeschweg einer Seite im Frontend — Sidebar-Kontextmenue, Editor
  // und Buchorganizer laufen alle hierher. Traegt Rueckfrage, Server-Call,
  // Entwurfs-Cleanup, Editor-Schliessung und das lokale Entfernen aus dem Store;
  // die Aufrufer behalten nur ihren eigenen Nachlauf (Editor: Kapitel-Rueckfall,
  // Organizer: History-Invalidierung).
  //
  // Kein `loadPages()`: entfernt wird in-place aus `nav.pages`/`nav.tree`
  // (`_removePageFromTree`, dieselbe SSoT wie der Remote-Delete des Collab-Feeds).
  // Ein Refetch wuerde den Sidebar-Tree leeren und neu aufbauen — sichtbares
  // Flackern fuer eine Information, die der Client schon hat.
  //
  // Liefert true, wenn die Seite wirklich weg ist (der Aufrufer haengt seinen
  // Nachlauf daran); false bei Abbruch in der Rueckfrage UND bei Serverfehler —
  // die Fehlermeldung steht dann schon im Status.
  //
  // `verify` laeuft NACH der Rueckfrage: der Dialog ist asynchron, waehrenddessen
  // kann eine andere Seite geoeffnet worden sein. Aufrufer, deren Ziel „die
  // aktuelle Seite" ist, pruefen darin, dass es noch dieselbe ist.
  async deletePageById(pageId, { name = '', confirm = true, verify = null } = {}) {
    if (!pageId || !this.canEdit()) return false;
    if (confirm) {
      const ok = await this.appConfirm({
        message: this.t('bookOrganizer.confirmDeletePage', { name }),
        confirmLabel: this.t('common.delete'),
        cancelLabel: this.t('common.cancel'),
        danger: true,
      });
      if (!ok) return false;
    }
    if (verify && !verify()) return false;
    try {
      await contentRepo.deletePage(pageId, { bookId: this.$store.nav.selectedBookId });
    } catch (e) {
      console.error('[deletePageById]', e);
      this.setStatus(this.t('bookOrganizer.deleteFailed', { detail: e.message }));
      return false;
    }
    try { clearDraft(pageId); } catch {}
    // Offene Seite: erst den Editor abbauen, dann die Zeile ziehen — gleiche
    // Reihenfolge wie der Remote-Delete-Pfad (app-collab.js), sonst rendert der
    // Editor kurz eine Seite, die es im Tree nicht mehr gibt.
    if (this.currentPage?.id === pageId) this.resetPage();
    this._removePageFromTree(pageId);
    // Loeschen aendert die Verfuegbarkeit von Querverweis-Zielen. Der Ziel-Picker
    // cacht seine Liste je Buch; ohne dieses Signal zeigte er die geloeschte
    // Seite bis zum Buchwechsel weiter an.
    window.dispatchEvent(new CustomEvent(EVT.XREFS_CHANGED,
      { detail: { bookId: this.$store.nav.selectedBookId ?? null } }));
    return true;
  },


  // Löscht die aktuell offene Seite. Zwei Aufrufer: der Knopf im Leer-Zustand
  // des Editors (nur bei `currentPageEmpty` gerendert) und das Sidebar-Kontext-
  // menü, wenn dessen Ziel die offene Seite ist. Eigener Nachlauf gegenüber
  // `deletePageById`: der Rückfall aufs Kapitel.
  async deleteCurrentPage() {
    const page = this.currentPage;
    if (!page || !this.canEdit()) return;
    // Kapitel der gelöschten Seite merken (deletePageById nullt currentPage) —
    // danach dorthin zurückfallen statt leere Ansicht zu zeigen.
    const chapterId = page.chapter_id;
    const ok = await this.deletePageById(page.id, {
      name: page.name,
      verify: () => this.currentPage?.id === page.id,
    });
    if (!ok) return;
    // Auf das Kapitel zurückfallen (wie ein Klick auf den Kapitel-Header):
    // leeres Kapitel → Kapitel-Review-Karte (neue Seite anlegbar), sonst
    // Review/Expand. Solo-Seiten (kein chapter_id) bleiben ohne Fallback.
    if (chapterId != null) {
      const item = this._findTreeChapter(chapterId);
      if (item) await this._onChapterHeaderActivate(item);
    }
  },


  // Draft-Recovery: nach Page-Load prüfen, ob lokaler Entwurf im localStorage
  // vom Server-HTML abweicht (z. B. nach Server-Crash mid-write + Tab-Reopen).
  // Wenn ja: `pendingDraft`-Banner zeigt User Wiederaufnahme-Option an. Im
  // editMode überspringen — `startEdit` hat den Draft bereits geladen.
  _refreshPendingDraft(pageId, originalHtml) {
    if (this.editMode) { this.pendingDraft = null; return; }
    const draft = readDraft(pageId);
    if (draft && draft.html && draft.html !== originalHtml) {
      this.pendingDraft = { savedAt: draft.savedAt || Date.now() };
    } else {
      // Stale-Draft (= identisch zu Server-HTML) räumen, damit alter Eintrag
      // bei nächster Visit nicht wieder triggert.
      if (draft) { try { clearDraft(pageId); } catch {} }
      this.pendingDraft = null;
    }
  },


  // Banner-Action „Weiterbearbeiten": Edit-Mode öffnen, startEdit lädt Draft
  // automatisch und setzt `editDirty=true`.
  resumeDraft() {
    if (!this.currentPage) return;
    this.pendingDraft = null;
    this.startEdit();
  },


  // Banner-Action „Verwerfen": lokalen Entwurf löschen, Banner schliessen.
  async discardDraft() {
    if (!this.currentPage) return;
    const ok = await this.appConfirm({
      message: this.t('edit.draftRecovery.discardConfirm'),
      confirmLabel: this.t('edit.draftRecovery.discard'),
      danger: true,
    });
    if (!ok) return;
    try { clearDraft(this.currentPage.id); } catch {}
    this.pendingDraft = null;
  },


  // Setzt allen Seiten-Level-State zurück (Editor, Lektorat, Chat, History).
  // `keepView`: nur für den Abschnittswechsel in `selectPage` — Karte bleibt
  // offen und der gerenderte Text sichtbar, bis der neue Inhalt ihn ersetzt.
  // `originalHtml` wird trotzdem genullt: daran hängen `startEdit` und die
  // Reload-Wiederaufnahme, die den alten Text nie der neuen Seite zuordnen dürfen.
  resetPage({ keepView = false } = {}) {
    // `_checkPollTimer_<pageId>` bewusst NICHT clearen: Poll der verlassenen
    // Seite muss weiterlaufen, damit `onDone` → `markPageChecked` den
    // Sidebar-Status aktualisiert (siehe lektorat.js startCheckPoll). Poll
    // räumt sich nach Job-Abschluss in job-helpers.js selbst auf.
    this.closeSynonymMenu?.();
    this.closeSynonymPicker?.();
    this.closeFigurLookup?.();
    if (this.focusActive) this.exitFocusMode();
    // Volles Edit-Session-Teardown über die SSoT im Notebook-Card (Pflicht-
    // Invariante #11): Autosave, Online-Retry, Steuerzeichen-Overlay, Counter,
    // Presence-Heartbeat, Edit-Lock, Undo-Stack, Konflikt-State. Ein
    // Teilabbau hier liesse Lock-Heartbeat und Presence-Ping der verlassenen
    // Seite weiterlaufen — andere User sähen sie dauerhaft als „in Bearbeitung".
    // `keepDraft`: der localStorage-Entwurf ist beim Seitenwechsel die einzige
    // Kopie ungespeicherter Arbeit; der pendingDraft-Banner bietet sie wieder an.
    this._teardownEditSession?.({ keepDraft: true });
    // Defensiver Rest-Reset: greift, wenn die Notebook-Card (noch) nicht
    // gemountet ist und der Teardown oben ins Leere lief.
    this._stopAutosave?.();
    this._uninstallOnlineRetry?.();
    this.resetChat();
    // Leiste schliessen — Chat, Ideen (beide Scopes: Chapter-Scope ist an die
    // Kapitelbewertung gekoppelt, die `_closeOtherMainCards` ebenfalls
    // schliesst) und Referenz. Ohne Editor stuende sie sonst auf voller Breite.
    // Direkt aufs Feld, nicht ueber `_setAside`: der Lektorat-Snapshot gilt der
    // verlassenen Seite und wird unten verworfen.
    this.asideSlot = null;
    this.ideenChapterId = null;
    this.ideenScope = 'page';
    this._checkDoneBeforeChat = false;
    this.currentPage = null;
    this.pageLastEditor = null;
    this.currentPageEmpty = false;
    this.pageLoadError = false;
    this.currentPageIdeenOpenCount = 0;
    this.currentPageRechercheCount = 0;
    this.currentPageShareCommentCount = 0;
    this.currentPageShareLinkCount = 0;
    this.currentPageChatSessionCount = 0;
    if (!keepView) this.renderedPageHtml = '';
    this.chapterFigures = [];
    this.showChapterFigures = false;
    this.originalHtml = null;
    this.correctedHtml = null;
    this.hasErrors = false;
    this.editMode = false;
    this.editDirty = false;
    this.editSaving = false;
    this.saveOffline = false;
    this.draftPersistFailed = false;
    // Konflikt-State ist seiten-gebunden: der Banner hängt nicht an editMode und
    // würde sonst mit den Daten der verlassenen Seite weiterstehen.
    this.editConflict = null;
    this.conflictResolution = null;
    this.pendingDraft = null;
    this.lastAutosaveAt = null;
    this.lastDraftSavedAt = null;
    if (!keepView) this.showEditorCard = false;
    this.analysisOut = '';
    this.status = '';
    this.statusSpinner = false;
    this.lastCheckId = null;
    this.pageHistory = [];
    this.activeHistoryEntryId = null;
    this.lektoratFindings = [];
    this.selectedFindings = [];
    this.appliedOriginals = [];
    this.appliedHistoricCorrections = [];
    this.lektoratProgress = null;
    this.checkDone = false;
    this.checkLoading = false;
    this.checkProgress = 0;
    this.checkStatus = '';
  },
};
