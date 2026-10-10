// Teil von notebookEditMethods (siehe Facade edit.js).
import { clearDraft, clearNormalSnapshot, editorHost, findInHtml, getActiveEditorContainer, htmlToText, installEditCounter, isNoChange, isPageConflict, mountEditorHtml, readConflictBody, readDraft, readEditorPrefs, savePage, sortByPosition, stripLektoratMarks, writeDraft, writeNormalSnapshot } from './_shared.js';
import { startLiveEdit, stopLiveEdit } from '../../live-edit.js';
import { noteEditStartDuringOutage, noteSaveRecovered } from '../save-outage.js';

export const lifecycleMethods = {
  // Container-Lookup: einziger Eintrittspunkt für beide Modi.
  _getEditEl() {
    return getActiveEditorContainer();
  },


  // Speicherziel beim Save-Start festhalten: Seite, Name und die Basis für
  // einen Draft (originalHtml + updated_at der Seite, auf der editiert wurde).
  _pinSaveTarget(html) {
    const app = editorHost();
    return {
      pageId: app.currentPage.id,
      pageName: app.currentPage.name,
      baseHtml: app.originalHtml,
      baseUpdatedAt: app.currentPage.updated_at,
      html,
    };
  },

  // Was ein gescheiterter Save als Draft sichert: der Live-Stand, solange die
  // Session noch auf der gepinnten Seite steht, sonst das HTML vom Save-Start.
  // Der Editor bleibt während des PUT beschreibbar, und der Draft-Debounce hat
  // das dort Getippte womöglich schon gesichert — `pin.html` darüber zu
  // schreiben, ersetzte den neueren Draft durch den älteren. Die Basis bleibt
  // `pin.baseHtml`: ohne erfolgreichen Save rückt `originalHtml` nicht vor.
  _liveHtmlFor(pin) {
    if (!this._stillEditing(pin.pageId)) return pin.html;
    const el = this._getEditEl();
    return el ? stripLektoratMarks(el.innerHTML) : pin.html;
  },

  // Save über einen Seitenwechsel abgebrochen, bevor der PUT lief: die Arbeit
  // als Draft der gepinnten Seite sichern — der pendingDraft-Banner bietet sie
  // beim nächsten Besuch wieder an.
  _keepPinnedDraft(pin) {
    this._keepAsDraft({
      pageId: pin.pageId, html: pin.html, statusKey: null,
      base: pin.baseHtml, baseUpdatedAt: pin.baseUpdatedAt,
    });
  },


  // Gemeinsame Nachbereitung nach jedem erfolgreichen Page-Save. Aufrufer:
  // saveEdit + quickSave + submitConflictResolution, jeweils im Haupt- und im
  // 409-Re-Merge-Pfad. Übernimmt den frischen Server-Stand, spiegelt Findings/
  // Stats, räumt Draft + Dirty-/Offline-/Conflict-Flags. Kein Teardown (Editor
  // bleibt offen) und kein setStatus — Wortlaut/Übergang entscheidet der
  // Aufrufer je nach Pfad. `applyToEditor` spiegelt das gespeicherte HTML in
  // den Live-Editor (Konflikt-Auflösungs-Pfade, damit Folge-Edits auf dem
  // gemergten Stand aufbauen).
  //
  // Der Editor bleibt waehrend des PUT beschreibbar. Was in dieser Zeit
  // getippt wurde, liegt weder auf dem Server noch (nach dem clearDraft unten)
  // im Draft — darum wird der Live-Stand gegen das Gespeicherte geprueft: weicht
  // er ab, bleibt die Session dirty, der Draft wird auf der neuen Basis neu
  // geschrieben und der Autosave neu geplant. Rueckgabe `true` = es gibt noch
  // Ungespeichertes (saveEdit baut die Session dann nicht ab).
  //
  // Neue Basis ist die Antwort des Servers (`saved.html`), nicht das gesendete
  // HTML: der Server vergibt beim Write Block-IDs (lib/html-clean.js#
  // ensureBlockIds), und der nächste Block-Merge braucht als gemeinsamen
  // Vorfahren genau die Fassung, die ein anderes Gerät jetzt lädt. Die IDs
  // wandern per Attribut auch ins Live-DOM (kein Remount: Caret, IME und
  // Undo-Stack bleiben unberührt).
  _applySaveSuccess(saved, html, { pageId = null, applyToEditor = false } = {}) {
    const app = editorHost();
    if (!app) return false;
    const serverHtml = typeof saved?.html === 'string' ? saved.html : html;
    if (applyToEditor) this._applyMergedToEditor(html);
    const liveEl = !applyToEditor && app.editMode ? this._getEditEl?.() : null;
    const typedDuringSave = !!liveEl && !isNoChange(stripLektoratMarks(liveEl.innerHTML), html);
    if (saved?.updated_at && app.currentPage) app.currentPage.updated_at = saved.updated_at;
    app.originalHtml = serverHtml;
    this._ensureLiveBlockIds(serverHtml);
    app.currentPageEmpty = !htmlToText(serverHtml).trim();
    this._filterFindingsAfterSave(serverHtml);
    app._syncPageStatsAfterSave?.(app.currentPage, serverHtml);
    // Sidebar-Lektorat-Status flippt auf 'warn' (updated_at > checkedAt) — Server-Map nachladen.
    app.refreshPageAges?.();
    clearDraft(pageId ?? app.currentPage?.id);
    // Lief davor ein Save-Ausfall, jetzt als eine Zeile melden (save-outage.js).
    noteSaveRecovered(pageId ?? app.currentPage?.id);
    // Autosave-Zyklus schliessen: der Max-Timer läuft ab dem ERSTEN Dirty-Mark
    // und wird von `_scheduleAutosave` nur neu gesetzt, wenn er null ist. Ohne
    // Reset hier würde der 120-s-Cap der nächsten Tipp-Serie noch von der
    // Baseline vor diesem Save gemessen.
    this._clearAutosaveTimers();
    app.lastAutosaveAt = Date.now();
    app.lastDraftSavedAt = null;
    app.draftPersistFailed = false;
    app.editDirty = false;
    app.saveOffline = false;
    app.saveFailKind = null;
    app.editConflict = null;
    if (typedDuringSave) {
      app.editDirty = true;
      this._flushDraftSaveNow();
      this._scheduleAutosave();
    }
    app.updatePageView?.();
    return typedDuringSave;
  },


  // Vollständiges Teardown einer Edit-Session: stoppt Autosave/Draft/Retry/
  // Marks/Counter/Presence/Lock, verwirft Snapshot (+ optional Draft) und setzt
  // die Session-Flags zurück. Reihenfolge = Pflicht-Invariante #11 (Draft →
  // Snapshot → Autosave → OnlineRetry → Marks → Counter → Presence → Lock →
  // History → editMode=false); frühes editMode=false liesse Teardowns auf
  // bereits genullten Refs laufen.
  //
  // SSoT für den Session-Abbau — Aufrufer: cancelEdit, saveEdit (Non-Focus-Pfad)
  // und `resetPage` (Seitenwechsel/Karten-Schliessen, via Trampoline). Ohne den
  // resetPage-Aufruf blieben Edit-Lock-Heartbeat und Presence-Ping der
  // verlassenen Seite laufen — andere User sähen dort dauerhaft „wird bearbeitet".
  //
  // `keepDraft: true` behält den localStorage-Entwurf: beim Seitenwechsel mit
  // ungespeicherten Änderungen ist der Draft die einzige Kopie der Arbeit, und
  // der `pendingDraft`-Banner bietet sie beim nächsten Besuch wieder an.
  // cancelEdit verwirft ihn dagegen bewusst (User hat „verwerfen" bestätigt).
  _teardownEditSession({ keepDraft = false } = {}) {
    const app = editorHost();
    if (!app) return;
    if (keepDraft) {
      // Offenen 500-ms-Debounce einlösen, bevor `_stopAutosave` ihn verwirft:
      // sonst fehlte dem behaltenen Draft das zuletzt Getippte.
      this._flushDraftSaveNow();
    } else {
      if (app.currentPage) clearDraft(app.currentPage.id);
      app.pendingDraft = null;
    }
    clearNormalSnapshot();
    this._stopAutosave();
    this._uninstallOnlineRetry();
    this._uninstallFormatMarks();
    app._editCounterCtx?.teardown?.();
    app._stopPresenceHeartbeat?.();
    stopLiveEdit();
    app._releaseEditLock?.(app.currentPage?.id);
    this._historyClear?.();
    app.editMode = false;
    app.editDirty = false;
    app.editSaving = false;
    app.saveOffline = false;
    app.saveFailKind = null;
    app.draftPersistFailed = false;
    app.lastDraftSavedAt = null;
    // Konflikt-State gehört zur Session: der Banner (`x-show="editConflict"` in
    // editor-notebook.html) ist nicht an editMode gekoppelt und würde sonst im
    // Lesemodus stehen bleiben — mit einem Button, der `saveEdit()` auf dem noch
    // im DOM hängenden (nur display:none) contenteditable auslöst und damit
    // gerade verworfenen Text zurückschreibt.
    app.editConflict = null;
    app.conflictResolution = null;
    app.pageEditorFullscreen = false;
    app.pageEditorFitWidth = false;
    app.closeSynonymMenu?.();
    app.closeSynonymPicker?.();
    app.closeFigurLookup?.();
  },


  // Nach jedem erfolgreichen Save: Findings, deren `original`-Text nicht mehr
  // im neuen HTML vorkommt, gelten als behoben und fliegen raus. Gilt sowohl
  // für saveEdit (expliziter Save) als auch quickSave (Ctrl+S/Autosave) –
  // damit das Prüf-Panel auch nach Fokus-Editor-Edits aktuell bleibt.
  // Überlebens-Check via `findInHtml` (tolerant gegen Tag-/Entity-/Whitespace-
  // Differenzen), identisch zu `sortByPosition` — reines indexOf auf rohem HTML
  // würde ein noch gültiges Finding verwerfen, sobald sich Markup (z.B.
  // data-bid) um den Textausschnitt herum ändert.
  _filterFindingsAfterSave(newHtml) {
    const app = editorHost();
    if (!app?.lektoratFindings || app.lektoratFindings.length === 0) return;
    const survivors = [];
    const prevSelected = new Map();
    for (let i = 0; i < app.lektoratFindings.length; i++) {
      const f = app.lektoratFindings[i];
      if (f.original && findInHtml(newHtml, f.original)) {
        survivors.push(f);
        prevSelected.set(f, !!app.selectedFindings[i]);
      }
    }
    app.lektoratFindings = sortByPosition(newHtml, survivors);
    app.selectedFindings = app.lektoratFindings.map(f => prevSelected.get(f) ?? false);
    app.appliedOriginals = app.appliedOriginals.filter(o => findInHtml(newHtml, o));
    if (app.lektoratFindings.length === 0) {
      app.checkDone = false;
      app.correctedHtml = null;
      app.hasErrors = false;
    } else {
      app._recomputeCorrectedHtml?.();
    }
  },


  startEdit() {
    const app = editorHost();
    if (!app || !app.currentPage || app.originalHtml === null) return;
    // Re-Entry würde `el.innerHTML` überschreiben und die Undo-Baseline neu
    // setzen. Aktuell hält kein Aufrufer den Button im Edit-Modus sichtbar
    // (`<template x-if="!editMode">`), aber ein zweiter Aufruf darf niemals
    // laufende Arbeit anfassen.
    if (app.editMode) return;
    if (app.checkLoading || app.saveApplying != null) return;
    // Prüfmodus blockt Edit (Invariante: editMode + checkDone forbidden).
    // Findings-Apply-Pfad bleibt via saveCorrections, ohne contenteditable.
    if (app.checkDone) return;
    // viewer/lektor duerfen Page-HTML nicht direkt mutieren.
    // Defense-in-depth zum verstecken Button-Hide in editor.html.
    if (!app.canEdit?.()) return;
    app.editMode = true;
    app.editDirty = false;
    app.editSaving = false;
    app.saveOffline = false;
    app.saveFailKind = null;
    app.pendingDraft = null;
    // Auto-Fokus-Caret (setTimeout focus() weiter unten) ist KEIN bewusster
    // Anker — erst ein Klick ins Feld setzt sttCaretUserSet (STT haengt sonst
    // ans Editorende an).
    app.$store.stt.caretUserSet = false;

    // Chromium/Safari-Default ist 'div' → Enter an bare Text oder am
    // Editor-Root erzeugt <div> statt <p>, damit fehlt der Absatz-Abstand
    // und der Fokus-Mode erkennt den Block nicht (BLOCK_TAGS ohne DIV).
    // Einmal pro Edit-Session genügt, der Flag ist dokumentweit.
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch {}

    let initialHtml = app.originalHtml;

    // Draft-Wiederherstellung: lokalen Entwurf immer übernehmen, wenn vorhanden
    // und abweichend. Kein Dialog – der User hat den Entwurf bewusst getippt,
    // ihn beim Wiedereintritt zu verwerfen wäre destruktiv.
    // Ist die Seite seit dem Draft weitergeschrieben worden, wird er gegen den
    // Server-Stand gemergt (edit/conflict.js#_reconcileDraftWithServer) — sonst
    // stünde alter Text unter frischem Stempel, und der nächste Save nähme die
    // Remote-Änderung still zurück.
    const draft = readDraft(app.currentPage.id);
    let draftConflict = null;
    if (draft && draft.html && !isNoChange(draft.html, app.originalHtml)) {
      const restored = this._reconcileDraftWithServer(draft);
      initialHtml = restored.html;
      draftConflict = restored.conflict || null;
      app.editDirty = true;
      app.lastDraftSavedAt = draft.savedAt || Date.now();
    }

    const el = this._getEditEl();
    if (el) {
      // Einhängen inkl. Block-Normalisierung + Caret-Slot über die geteilte
      // Pipeline (shared/mount-html.js) — dieselbe, die Undo/Redo-Restore und
      // das Spiegeln eines gemergten Stands nutzen.
      //
      // `repaired` heisst: der Normalizer hat Legacy-HTML reparieren müssen
      // (orphan Text-/Inline-Nodes direkt unter dem Editor-Root). Ohne
      // Persistenz kehrt der Defekt nach jedem Reload zurück und bricht die
      // Focus-Mode-Absatz-Hervorhebung erneut — `editDirty=true` sorgt dafür,
      // dass der nächste Auto- oder Manual-Save die bereinigte Fassung schreibt.
      const { repaired } = mountEditorHtml(el, initialHtml);
      if (repaired) {
        app.editDirty = true;
        this._scheduleDraftSave();
      }
      // Platzhalter der leeren Bildunterschrift. Als CSS-Custom-Property am
      // Editier-Container, nicht als Attribut im Inhalt: die Attribute dieses
      // Elements sind nicht Teil des gespeicherten `innerHTML`, es kann also
      // nichts davon in die Persistenz laufen. Den Text zieht die Regel in
      // page-view.css über `content: var(--figcaption-ph)`; CSS kann die
      // i18n-Registry nicht selbst lesen.
      el.style.setProperty('--figcaption-ph', JSON.stringify(app.t('editor.image.captionPlaceholder')));
    }
    setTimeout(() => this._getEditEl()?.focus(), 0);

    this._startAutosave();
    this._installOnlineRetry();
    // Presence-Heartbeat: anderen Usern signalisieren „hier editiert wer".
    // Stopp im cancelEdit/saveEdit (Non-Focus-Pfad).
    app._startPresenceHeartbeat?.(app.currentPage.id);
    // Live-Edit-Marker: die Outbox anderer Tabs lässt den Draft dieses
    // Abschnitts in Ruhe, solange dieser Tab ihn bearbeitet (../../live-edit.js).
    startLiveEdit(app.currentPage.id);
    // Offener Save-Ausfall dieses Tabs (z.B. Reload mitten im Ausfall).
    noteEditStartDuringOutage(app.currentPage.id);
    // Soft-Edit-Lock: zusaetzliches UI-Signal mit Ablaufzeit; OCC-Pfad bleibt
    // das echte Safety-Net. Fremder Lock → foreignEditLock-Banner.
    app._acquireEditLock?.(app.currentPage.id);
    // Live-Counter rechnet in beiden Modi (für korrektes Tagesdelta beim
    // Wiedereintritt in den Focus), sichtbar aber nur im Focus-Header
    // (x-show=focusActive in editor.html). Setup nach Alpine-x-show-Flush —
    // contenteditable existiert vorher nicht im DOM.
    setTimeout(() => { if (app.editMode) installEditCounter(app); }, 0);
    // Snapshot für Reload-Wiederaufnahme. Pendant zu focus/storage.js —
    // beim regulären Exit (cancelEdit/saveEdit) wird er wieder gelöscht.
    writeNormalSnapshot(app.currentPage.id);

    // Undo/Redo: Session-Baseline mit dem initialen Edit-Stand. Stack
    // wird bei cancel/save (non-focus) wieder geclear't.
    if (el) this._historyReset?.(el.innerHTML);

    // Draft kollidiert blockweise mit dem Server-Stand: Auflösung sofort statt
    // erst beim ersten Save. Der Draft bleibt bis zur Entscheidung liegen.
    if (draftConflict) {
      this._openConflictResolution({ ...draftConflict, source: app.focusActive ? 'focus' : 'main' });
    }

    // Layout-Prefs (Fullscreen, Seitenbreite, Steuerzeichen, Zoom) aus
    // localStorage restoren. Fit-Width skaliert die Schrift per CSS
    // Container-Query (cqi); der Zoom-Faktor multipliziert sich orthogonal dazu.
    const prefs = readEditorPrefs();
    app.pageEditorFullscreen = prefs.fullscreen;
    app.pageEditorFitWidth = prefs.fitWidth;
    app.pageEditorShowMarks = prefs.showMarks;
    app.pageEditorShowHead = prefs.showHead;
    app.pageEditorZoom = prefs.zoom;
    // Marks-Layer erst nach dem Alpine-x-show-Flush vermessen: der
    // Editor-Wrapper ist in diesem Tick noch display:none, alle Rects wären 0.
    if (app.pageEditorShowMarks) setTimeout(() => { if (app.editMode) this._installFormatMarks(); }, 0);
  },


  async cancelEdit() {
    const app = editorHost();
    if (!app) return;
    if (app.editDirty) {
      const ok = await app.appConfirm({
        message: app.t('edit.cancelConfirm'),
        confirmLabel: app.t('edit.discardEdit'),
        danger: true,
      });
      if (!ok) return;
    }
    this._teardownEditSession();
    app.updatePageView?.();
    if (app.focusActive) app.exitFocusMode?.();
  },


  async saveEdit() {
    const app = editorHost();
    if (!app || !app.currentPage) return;
    // Ohne offene Edit-Session gibt es nichts zu speichern. Das contenteditable
    // hängt nach dem Teardown weiter im DOM (nur `display:none`) und trägt noch
    // den letzten Stand — ein Aufruf von aussen (z. B. der Konflikt-Banner)
    // würde sonst verworfenen Text zurückschreiben. Spiegelt den quickSave-Guard.
    if (!app.editMode) return;
    // Offenes Konflikt-Modal entscheidet, welche Fassung gilt — ein Save daneben
    // liefe in denselben Merge und setzte die Auflösung zurück.
    if (app.conflictResolution) return;
    if (!app.canEdit?.()) return;
    const el = this._getEditEl();
    if (!el) return;
    this._ensureLiveBlockIds();
    const newHtml = stripLektoratMarks(el.innerHTML);
    if (isNoChange(newHtml, app.originalHtml)) {
      // Im Fokusmodus nicht aus Edit-/Fokusmodus herausfallen, wenn
      // der User ein zweites Mal Speichern klickt (nichts geändert).
      if (app.focusActive) {
        app.setStatus(app.t('edit.changesSaved'), false, 2000);
        return;
      }
      // editDirty kann durch startEdit-Normalize gesetzt sein, obwohl der
      // tatsächliche Inhalt sich nicht von normalizeForCompare(original)
      // unterscheidet. cancelEdit darf hier NICHT den Verwerfen-Dialog
      // zeigen — wir sind im Save-Flow, nicht im Cancel-Flow.
      app.editDirty = false;
      await this.cancelEdit();
      return;
    }

    const newText = htmlToText(newHtml).trim();
    if (!newText) {
      app.setStatus(app.t('edit.emptyTextAbort'), false, 5000);
      return;
    }

    // Pflicht-Invariante #6: `editSaving` VOR dem ersten `await` setzen. Der
    // Kürzungs-Dialog und der Pre-Save-Conflict-Read sind Wartezeiten, in denen
    // sonst der Autosave-Tick (`_fireAutosave` prüft nur `!editSaving`) einen
    // parallelen PUT absetzt — dessen Save verschiebt `updated_at`, und der
    // hier schon gefangene Stempel läuft garantiert in einen 409 gegen den
    // eigenen Schreibvorgang.
    app.editSaving = true;
    const source = app.focusActive ? 'focus' : 'main';
    // Seite beim Save-Start pinnen (siehe _stillEditing): nach jedem `await`
    // kann ein Seitenwechsel `app.currentPage` bereits auf die nächste Seite
    // gesetzt haben.
    const pin = this._pinSaveTarget(newHtml);
    try {
      const origText = htmlToText(app.originalHtml || '').trim();
      if (origText.length > 50 && newText.length < origText.length * 0.2) {
        const okShort = await app.appConfirm({
          message: app.t('edit.shorterConfirm', { newLen: newText.length, oldLen: origText.length }),
        });
        if (!this._stillEditing(pin.pageId)) { this._keepPinnedDraft(pin); return; }
        if (!okShort) return;
      }

      const pre = await this._resolveConflictBeforeSave({
        localHtml: newHtml, source, silent: false, pageId: pin.pageId, expectedAt: pin.baseUpdatedAt,
      });
      if (pre.stale) { this._keepPinnedDraft(pin); return; }
      if (!pre.proceed) return;

      app.setStatus(app.t('edit.saving'), true);
      try {
        const saved = await savePage(pin.pageId, {
          html: pre.saveHtml,
          pageName: pin.pageName,
          source,
          expectedUpdatedAt: pre.expectedAt,
          reason: 'save',
        });
        if (!this._stillEditing(pin.pageId)) { this._releaseDraftAfterSave(pin.pageId, pre.saveHtml, saved); return; }
        const typedDuringSave = this._applySaveSuccess(saved, pre.saveHtml);
        // Kein extra setStatus vor dem Teardown — Save-Indicator in der Subline
        // zeigt schon "gespeichert HH:MM"; doppelte Notification wäre redundant.
        // Im Fokus bleibt die Session offen (User schreibt weiter), ebenso wenn
        // während des PUT weitergetippt wurde — der Teardown verwürfe das.
        if (!typedDuringSave) {
          if (!app.focusActive) this._teardownEditSession();
        }
        // Auto-Merge-Hinweis NACH dem Save melden (wie im 409-Pfad): vor dem PUT
        // gesetzt, überschreibt ihn die „speichere…"-Zeile sofort wieder.
        if (pre.merged) app.setStatus(app.t('edit.conflict.merged.silent'), false, 3000);
        else app.setStatus('');
      } catch (e) {
        if (isPageConflict(e)) {
          // Race: zwischen Pre-Check und PUT hat anderer User geschrieben.
          if (!this._stillEditing(pin.pageId)) { this._keepPinnedDraft(pin); return; }
          const retry = await this._retryAfterConflict({
            localHtml: newHtml, source, pageId: pin.pageId,
            pageName: pin.pageName, tag: 'saveEdit', liveLocal: true,
          });
          if (retry?.stale) { this._keepPinnedDraft(pin); return; }
          if (retry?.conflict) return;
          if (retry) {
            if (!this._stillEditing(pin.pageId)) { this._releaseDraftAfterSave(pin.pageId, retry.html, retry.saved); return; }
            this._applySaveSuccess(retry.saved, retry.html);
            app.setStatus(app.t('edit.conflict.merged.silent'), false, 3000);
            return;
          }
          this._keepAsDraft({
            pageId: pin.pageId, html: this._liveHtmlFor(pin), banner: readConflictBody(e),
            base: pin.baseHtml, baseUpdatedAt: pin.baseUpdatedAt,
          });
          return;
        }
        console.error('[saveEdit]', e);
        // Draft behalten, Fehlerklasse merken (Netz/5xx → Auto-Retry; 423/403/
        // 404 → kein Retry, Hinweis bleibt stehen).
        this._keepAsDraft({
          pageId: pin.pageId, html: this._liveHtmlFor(pin), statusKey: null,
          base: pin.baseHtml, baseUpdatedAt: pin.baseUpdatedAt,
        });
        if (!this._stillEditing(pin.pageId)) return;
        app.setStatus(this._noteSaveFailure(e, { offlineKey: 'edit.offlineSaved' }), false, 8000);
      }
    } finally {
      app.editSaving = false;
    }
  },


  // Stilles Speichern (Ctrl+S / Auto-Save): bleibt im Editor. `reason` nennt
  // den Auslöser nur fürs PAGE_CONFLICT-Log (autosave, retry; sonst 'quick').
  async quickSave(reason = 'quick') {
    const app = editorHost();
    if (!app || !app.editMode || !app.currentPage || app.editSaving) return;
    // Offenes Konflikt-Modal: es entscheidet. Ein stiller Save liefe in den
    // Merge, öffnete das Modal neu und setzte die Entscheidungen zurück
    // (Ctrl+S, Fokus-Exit, Abschnitts-Chat — die Timer-/Retry-Wege sperrt
    // schon `_canBackgroundSave`). Der Draft liegt seit dem Konflikt.
    if (app.conflictResolution) return;
    // Ohne Edit-Recht kein Auto-Save (Defense; startEdit blockt
    // ohnehin den Eintritt — aber Race mit Role-Refresh waehrend Edit-Session).
    if (!app.canEdit?.()) return;
    const el = this._getEditEl();
    if (!el) return;
    this._ensureLiveBlockIds();
    const newHtml = stripLektoratMarks(el.innerHTML);
    if (isNoChange(newHtml, app.originalHtml)) {
      app.editDirty = false;
      clearDraft(app.currentPage.id);
      app.lastDraftSavedAt = null;
      app.draftPersistFailed = false;
      return;
    }
    const newText = htmlToText(newHtml).trim();
    if (!newText) return;

    // Immer zuerst lokal sichern, dann erst Netzwerkversuch. Schlägt die lokale
    // Sicherung fehl (localStorage voll), sichtbar machen — der Offline-Fall
    // hätte sonst stillen Datenverlust (Save-Indicator zeigt `unsaved`).
    const draftOk = writeDraft(app.currentPage.id, newHtml, app.originalHtml, app.currentPage.updated_at);
    app.draftPersistFailed = !draftOk;
    if (draftOk) app.lastDraftSavedAt = Date.now();

    // Bewusst KEIN navigator.onLine-Gate vor dem PUT: der Flag meldet (Sleep/Wake,
    // VPN-Wechsel, Netzwerk-Interface-Flap) faelschlich `false` und feuert danach
    // kein `online`-Event — ein Vorab-Abbruch wuerde den Editor dauerhaft auf
    // "offline" nageln (Recovery haengt am `online`-Event). Stattdessen den Fetch
    // immer wagen; sein echter Ausgang entscheidet ueber saveOffline (Catch unten).

    // editSaving früh setzen — verhindert, dass parallele Auto-Save-Tick + Ctrl+S
    // (oder exitFocusMode-quickSave + Auto-Save-Timer) den gleichen PUT zweimal
    // absetzen.
    app.editSaving = true;
    const source = app.focusActive ? 'focus' : 'main';
    // Seite pinnen (siehe saveEdit). Der Draft oben ist schon geschrieben —
    // ein Abbruch nach Seitenwechsel lässt ihn einfach stehen.
    const pin = this._pinSaveTarget(newHtml);
    try {
      // Silent-Path: Auto-Save darf keinen Modal triggern (Pflicht-Invariante #9).
      // Bei Cross-User-Konflikt versucht der Block-Merge still zusammenzuführen;
      // nur echte Block-Kollisionen öffnen das Auflösungs-Banner (auch im
      // Fokusmodus sichtbar). Ohne Merge bleibt der editConflict-Hinweis.
      const pre = await this._resolveConflictBeforeSave({
        localHtml: newHtml, source, silent: true, pageId: pin.pageId, expectedAt: pin.baseUpdatedAt,
      });
      if (!pre.proceed) return;
      const saved = await savePage(pin.pageId, {
        html: pre.saveHtml,
        pageName: pin.pageName,
        source,
        expectedUpdatedAt: pre.expectedAt,
        reason,
      });
      if (!this._stillEditing(pin.pageId)) { this._releaseDraftAfterSave(pin.pageId, pre.saveHtml, saved); return; }
      this._applySaveSuccess(saved, pre.saveHtml);
      // Kein setStatus — Save-Indicator in der Subline zeigt schon
      // "gespeichert HH:MM"; doppelte Notification wäre redundant.
      app.setStatus('');
    } catch (e) {
      if (isPageConflict(e)) {
        // Race nach Pre-Check: anderer User war im selben Tick schneller.
        // Block-Merge gegen den frischen Remote-Stand; nur Block-Kollisionen
        // öffnen das Banner. Quiet-Pfad, kein Modal.
        if (!this._stillEditing(pin.pageId)) return;
        const retry = await this._retryAfterConflict({
          localHtml: newHtml, source, pageId: pin.pageId,
          pageName: pin.pageName, tag: 'quickSave', liveLocal: true,
        });
        if (retry?.stale || retry?.conflict) return;
        if (retry) {
          if (!this._stillEditing(pin.pageId)) { this._releaseDraftAfterSave(pin.pageId, retry.html, retry.saved); return; }
          this._applySaveSuccess(retry.saved, retry.html);
          return;
        }
        const banner = readConflictBody(e);
        this._keepAsDraft({
          pageId: pin.pageId, html: this._liveHtmlFor(pin), banner, statusKey: null,
          base: pin.baseHtml, baseUpdatedAt: pin.baseUpdatedAt,
        });
        if (this._stillEditing(pin.pageId)) app.setStatus(this._conflictHintText(banner), false, 8000);
        return;
      }
      console.error('[quickSave]', e);
      // Draft liegt seit dem Save-Start; Offline-Flag/Status nur für die Seite,
      // die noch offen ist.
      if (!this._stillEditing(pin.pageId)) return;
      // Fehlerklasse entscheidet über Retry und Wortlaut: Netz/5xx wartet auf
      // den nächsten Anlass (online/Fokus), 423/403/404 nicht — sonst liefe bei
      // jedem Fokus derselbe abgewiesene PUT. navigator.onLine ist nur Hinweis
      // für die Wortwahl, kein Gate.
      const msg = this._noteSaveFailure(e);
      app.setStatus(msg, false, app.saveFailKind === 'network' && !navigator.onLine ? 3000 : 8000);
    } finally {
      app.editSaving = false;
    }
  },
};
