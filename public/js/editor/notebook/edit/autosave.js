// Teil von notebookEditMethods (siehe Facade edit.js).
//
// Timer liegen BEWUSST am Host (Root, deklariert im notebookState-Slice von
// app-state.js), nicht an der Karte: `_stopAutosave` wird auch aus Root-Kontext
// gerufen (app-view/page.js#resetPage via Trampoline) und muss dieselben Timer
// treffen.
//
// Die idle+max-Regel selbst liegt in editor/shared/autosave.js, geteilt mit dem
// Bucheditor: die beiden Editoren dürfen nicht mit unterschiedlichem Rhythmus
// speichern. Der Notebook-Editor bearbeitet immer nur EINE Seite, darum ein
// fester Key statt einer pageId — `_stopAutosave` läuft beim Seitenwechsel und
// kennt die alte Seite dann schon nicht mehr.
import { AUTOSAVE_KEY, DRAFT_DEBOUNCE_MS, clearDraft, createAutosaveTimers, createTimerBag, editorHost, isNoChange, stripLektoratMarks, writeDraft } from './_shared.js';

// Lazy, weil dieses Modul keinen eigenen init-Hook hat und der Host beim ersten
// Tastendruck sicher steht.
function autosaveTimers(app) {
  if (!app._autosaveTimers) app._autosaveTimers = createAutosaveTimers();
  return app._autosaveTimers;
}

function draftTimers(app) {
  if (!app._draftTimers) app._draftTimers = createTimerBag();
  return app._draftTimers;
}

export const autosaveMethods = {

  _scheduleDraftSave() {
    const app = editorHost();
    if (!app) return;
    draftTimers(app).set(AUTOSAVE_KEY, () => this._flushDraftSaveNow(), DRAFT_DEBOUNCE_MS);
  },


  // Schreibt den aktuellen Editor-Inhalt sofort als Draft – unabhängig vom
  // Debounce-Timer. Aufruf vor jedem Zustandsübergang, der den Editor-Inhalt
  // nicht mehr einfängt (Focus-Mode-Entry) oder ihn riskieren könnte zu
  // verlieren.
  _flushDraftSaveNow() {
    const app = editorHost();
    if (!app) return;
    draftTimers(app).clear(AUTOSAVE_KEY);
    if (!app.editMode || !app.currentPage) return;
    const el = this._getEditEl();
    if (!el) return;
    // Der Draft ist Eingabe eines späteren Merges (startEdit →
    // _reconcileDraftWithServer, Outbox) — doppelte IDs darin verlören dort Text.
    this._ensureLiveBlockIds();
    const html = stripLektoratMarks(el.innerHTML);
    if (isNoChange(html, app.originalHtml)) {
      clearDraft(app.currentPage.id);
      app.lastDraftSavedAt = null;
      app.draftPersistFailed = false;
      return;
    }
    const ok = writeDraft(app.currentPage.id, html, app.originalHtml, app.currentPage.updated_at);
    app.draftPersistFailed = !ok;
    if (ok) app.lastDraftSavedAt = Date.now();
  },


  _startAutosave() {
    const app = editorHost();
    if (!app) return;
    this._clearAutosaveTimers();
    if (app.editDirty) this._scheduleAutosave();
  },


  _stopAutosave() {
    const app = editorHost();
    if (!app) return;
    this._clearAutosaveTimers();
    draftTimers(app).clear(AUTOSAVE_KEY);
  },


  _clearAutosaveTimers() {
    const app = editorHost();
    if (!app) return;
    autosaveTimers(app).clear(AUTOSAVE_KEY);
  },


  // Idle-Timer wird bei jedem Edit zurückgesetzt → speichert erst nach
  // AUTOSAVE_IDLE_MS Tipp-Pause. Max-Timer läuft ab erstem Dirty-Mark
  // weiter und greift bei Dauer-Tippen, sodass spätestens AUTOSAVE_MAX_MS
  // nach der ersten Änderung ein Save ausgelöst wird.
  //
  // Auslöser wird pro Aufruf übergeben statt beim Bau des Bags eingefangen: der
  // Bag lebt am Host und überlebt ein Neu-Mounten der Karte, ein eingefangenes
  // `this` zeigte danach auf eine tote Instanz.
  //
  // Die Seite wird beim Planen festgehalten: feuert der Timer, nachdem die
  // Session auf eine andere Seite gewechselt hat, speichert er nicht dort.
  _scheduleAutosave() {
    const app = editorHost();
    if (!app) return;
    const pageId = app.currentPage?.id ?? null;
    autosaveTimers(app).schedule(AUTOSAVE_KEY, () => this._fireAutosave(pageId));
  },


  _fireAutosave(pageId = null) {
    const app = editorHost();
    if (!app) return;
    this._clearAutosaveTimers();
    if (app.editDirty && this._canBackgroundSave(pageId)) this.quickSave();
  },


  // Fenster-Listener der Edit-Session: Retry-Anlässe für einen
  // hängengebliebenen Save und der Draft-Flush beim Verstecken des Tabs. Beide
  // leben genau so lange wie die Session — Abbau in `_uninstallOnlineRetry`
  // (Teardown, Pflicht-Invariante #11).
  _installOnlineRetry() {
    const app = editorHost();
    if (!app || app._onlineHandler) return;
    // Retry-Trigger fuer einen haengengebliebenen Offline-Save. Das `online`-Event
    // allein genuegt nicht: es feuert nur bei einem echten Offline→Online-Wechsel,
    // nicht bei einem transienten Server-Blip oder einem faelschlichen
    // navigator.onLine-`false`. Tab-Refokus (visibilitychange/focus) ist der
    // zuverlaessige zweite Anlass, den Netzwerkversuch erneut zu wagen.
    // Gegated über `_canBackgroundSave`: kein Retry unter offenem Konflikt-
    // Modal und keiner nach einem Fehler, den Wiederholen nicht behebt.
    const retry = () => {
      if (app.editDirty && app.saveOffline && this._canBackgroundSave()) {
        this.quickSave();
      }
    };
    app._onlineHandler = retry;
    app._onlineVisHandler = () => { if (document.visibilityState === 'visible') retry(); };
    window.addEventListener('online', app._onlineHandler);
    window.addEventListener('focus', app._onlineHandler);
    document.addEventListener('visibilitychange', app._onlineVisHandler);
    // Draft sofort sichern, wenn der Tab verschwindet (Tab-/Fensterwechsel,
    // Schliessen, Mobile-App in den Hintergrund): der 500-ms-Debounce kann
    // dort nicht mehr feuern, das zuletzt Getippte wäre sonst nirgends.
    // `pagehide` deckt das Entladen ab, `visibilitychange` den Fall, dass der
    // Browser den versteckten Tab später ohne weiteres Event verwirft.
    app._hideFlushHandler = () => this._flushDraftSaveNow();
    app._hideFlushVisHandler = () => { if (document.visibilityState === 'hidden') this._flushDraftSaveNow(); };
    window.addEventListener('pagehide', app._hideFlushHandler);
    document.addEventListener('visibilitychange', app._hideFlushVisHandler);
  },


  _uninstallOnlineRetry() {
    const app = editorHost();
    if (!app || !app._onlineHandler) return;
    window.removeEventListener('online', app._onlineHandler);
    window.removeEventListener('focus', app._onlineHandler);
    if (app._onlineVisHandler) {
      document.removeEventListener('visibilitychange', app._onlineVisHandler);
      app._onlineVisHandler = null;
    }
    if (app._hideFlushHandler) {
      window.removeEventListener('pagehide', app._hideFlushHandler);
      app._hideFlushHandler = null;
    }
    if (app._hideFlushVisHandler) {
      document.removeEventListener('visibilitychange', app._hideFlushVisHandler);
      app._hideFlushVisHandler = null;
    }
    app._onlineHandler = null;
  },
};
