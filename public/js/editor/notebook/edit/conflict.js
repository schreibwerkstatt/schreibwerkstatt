// Teil von notebookEditMethods (siehe Facade edit.js).
import { FEATURE_BLOCK_MERGE, buildResolvedHtml, captureBlockCaret, checkPageConflict, clearDraft, conflictBannerFrom, conflictText, contentRepo, editorHost, isOwnSentSave, isPageConflict, mergeBlocks, mergedToHtml, mountEditorHtml, isNoChange, readConflictBody, readDraft, restoreBlockCaret, savePage, stripLektoratMarks, trackMerge, writeDraft } from './_shared.js';
import { classifySaveError } from '../save-errors.js';
import { conflictDiffView } from '../../shared/conflict-diff.js';
import { noteSaveOutage } from '../save-outage.js';

// Läuft die Abbrechen-Rückfrage schon? Esc (window-Listener im Partial) und
// der Knopf dürfen keinen zweiten Dialog über den ersten legen.
let _cancelAsking = false;

export const conflictMethods = {

  // Text des Konflikt-Banners. Die Gerät-vs-User-Verzweigung liegt in
  // shared/conflict-text.js (geteilt mit dem Bucheditor); hier nur die Variante
  // und der Zeitstempel als zusätzlicher Platzhalter.
  editConflictBannerText() {
    const app = editorHost();
    const c = app?.editConflict;
    if (!c) return '';
    const time = c.remoteUpdatedAt ? app.formatDate(c.remoteUpdatedAt) : '';
    return conflictText(app.t.bind(app), c, 'banner', { time });
  },


  // Banner-State (`editConflict`) aus einem Konflikt-Objekt — Feldsatz-SSoT in
  // shared/page-conflict.js, weil ihn beide Editoren gleich befüllen.
  _conflictBannerFrom(conflict) {
    return conflictBannerFrom(conflict);
  },


  // Statuszeile für den stillen Pfad (quickSave/Autosave).
  _conflictHintText(banner) {
    const app = editorHost();
    return conflictText(app.t.bind(app), banner, 'hint');
  },


  // Gemeinsamer Fallback aller Save-Pfade, wenn ein Konflikt nicht automatisch
  // aufzulösen ist: lokale Fassung als Draft sichern, Offline-/Konflikt-Banner
  // setzen, Status melden. Draft zuerst (Pflicht-Invariante #5) — die Arbeit
  // darf nicht am Banner hängen.
  //
  // Ist die Seite inzwischen gewechselt (Save lief über einen Seitenwechsel),
  // gehört nur der Draft noch zu `pageId`: Basis kommt dann aus `base`/
  // `baseUpdatedAt` des Aufrufers, und Banner/Status/Offline-Flag der jetzt
  // offenen Seite bleiben unberührt.
  _keepAsDraft({ pageId, html, banner = null, statusKey = 'edit.conflict.kept', statusMs = 8000, base, baseUpdatedAt }) {
    const app = editorHost();
    const onPage = app.currentPage?.id === pageId;
    const draftOk = writeDraft(
      pageId, html,
      base !== undefined ? base : app.originalHtml,
      baseUpdatedAt !== undefined ? baseUpdatedAt : app.currentPage?.updated_at,
    );
    if (!onPage) return;
    app.draftPersistFailed = !draftOk;
    if (draftOk) app.lastDraftSavedAt = Date.now();
    app.saveOffline = true;
    // Fehlerklasse Konflikt: die Statuszeile sagt dann nicht «Offline». Ein
    // Netz-/Serverfehler setzt danach über _noteSaveFailure seine eigene.
    app.saveFailKind = 'conflict';
    noteSaveOutage(pageId, { kind: 'conflict' });
    if (banner) app.editConflict = banner;
    if (statusKey) app.setStatus(app.t(statusKey), false, statusMs);
  },


  // Konflikt-Klärung VOR dem PUT. SSoT für saveEdit + quickSave — vorher lag
  // dieser Block in beiden Methoden als Kopie (inkl. der Banner-Objekt-
  // Konstruktion) und driftete bei jeder Änderung auseinander.
  //
  // `silent: true` (quickSave/Autosave) zeigt niemals ein Modal — Pflicht-
  // Invariante #9: ein Hintergrund-Save darf den User nicht unterbrechen.
  //
  // Rückgabe:
  //   { proceed: true, saveHtml, expectedAt, merged? } — Aufrufer speichert saveHtml
  //   { proceed: false } — abgebrochen (Banner/Auflösungs-Modal offen, Draft gesichert)
  //
  // `pageId`/`expectedAt` pinnt der Aufrufer beim Save-Start. Nach jedem `await`
  // prüft der Pfad, ob die Edit-Session noch auf dieser Seite steht — sonst
  // `{ proceed: false, stale: true }`, und nichts (Banner, Merge ins Live-DOM,
  // Modal) wirkt auf die inzwischen offene Seite.
  async _resolveConflictBeforeSave({ localHtml, source, silent, pageId, expectedAt }) {
    const app = editorHost();
    if (pageId == null) pageId = app.currentPage.id;
    if (expectedAt === undefined) expectedAt = app.currentPage.updated_at;
    const conflict = await this._checkPageConflict(pageId, expectedAt);
    if (!this._stillEditing(pageId)) return { proceed: false, stale: true };
    if (!conflict) return { proceed: true, saveHtml: localHtml, expectedAt };

    const merge = await this._attemptBlockMerge({
      localHtml, source, pageId, liveLocal: true,
      remoteHtml: conflict.remoteHtml, remoteUpdatedAt: conflict.remoteUpdatedAt,
    });
    if (merge?.stale) return { proceed: false, stale: true };
    if (merge?.conflict) return { proceed: false }; // Auflösungs-Modal offen
    if (merge?.merged) {
      // Stiller Auto-Merge: nicht-kollidierende Block-Edits zusammengeführt.
      app.editConflict = null;
      // Eigener verspäteter Save: nichts zusammengeführt — kein «zusammengeführt»-Hinweis.
      return { proceed: true, saveHtml: merge.saveHtml, expectedAt: merge.expectedAt, merged: !merge.own };
    }

    // Kein Merge (Flag off / leere Base / Read-Fehler) → klassischer Pfad.
    const banner = this._conflictBannerFrom(conflict);
    app.editConflict = banner;
    if (silent) {
      app.saveOffline = true;
      app.saveFailKind = 'conflict';
      noteSaveOutage(pageId, { kind: 'conflict' });
      app.setStatus(this._conflictHintText(banner), false, 8000);
      return { proceed: false };
    }
    const okOverwrite = await app.appConfirm({
      message: conflictText(app.t.bind(app), conflict, 'modal', {
        time: app.formatDate(conflict.remoteUpdatedAt),
      }),
      confirmLabel: app.t('edit.conflict.saveAnyway'),
      danger: true,
    });
    if (!this._stillEditing(pageId)) return { proceed: false, stale: true };
    if (!okOverwrite) {
      this._keepAsDraft({ pageId, html: localHtml, statusKey: 'edit.conflict.kept', statusMs: 6000 });
      return { proceed: false };
    }
    if (FEATURE_BLOCK_MERGE) trackMerge('fallback_overwrite');
    // Bewusstes Überschreiben MUSS den frischen Remote-Stempel mitschicken:
    // der OCC-Guard im Backend prüft `WHERE updated_at = expected_updated_at`.
    // Mit dem stale Editor-Stempel würde der PUT erneut 409 liefern und die
    // Entscheidung des Users („trotzdem speichern") wäre wirkungslos.
    return { proceed: true, saveHtml: localHtml, expectedAt: conflict.remoteUpdatedAt };
  },


  // 409-Race NACH dem PUT: zwischen Pre-Check und Write hat jemand geschrieben.
  // Gegen den jetzt frischen Remote-Stand neu block-mergen und den gemergten
  // Stand nachspeichern. SSoT für saveEdit + quickSave + submitConflictResolution.
  //
  // Rückgabe:
  //   { saved, html } — erfolgreich nachgespeichert
  //   { conflict: true } — Auflösungs-Modal offen, Aufrufer bricht ab
  //   { stale: true } — Seite inzwischen gewechselt, Aufrufer sichert nur den Draft
  //   null — kein Merge möglich → Aufrufer macht den _keepAsDraft-Fallback
  async _retryAfterConflict({ localHtml, source, pageId, pageName, tag, liveLocal = false }) {
    // `editSaving` bleibt bis zum Schluss gesetzt: während Merge-Read und
    // Re-Save darf weder der Autosave-Tick noch ein zweiter Klick einen
    // parallelen PUT absetzen. Öffnet der Merge das Auflösungs-Modal, kehren
    // alle Aufrufer sofort zurück und setzen das Flag im `finally` zurück —
    // ohne dazwischenliegendes `await`, das Modal ist bis dahin nicht klickbar.
    const merge = await this._attemptBlockMerge({ localHtml, source, pageId, liveLocal });
    if (merge?.stale) return { stale: true };
    if (merge?.conflict) return { conflict: true };
    if (!merge?.merged) return null;
    // Während des Merge-Reads verworfen oder Seite gewechselt: nichts speichern.
    if (!this._stillEditing(pageId)) return { stale: true };
    try {
      const saved = await savePage(pageId, {
        html: merge.saveHtml, pageName, source, expectedUpdatedAt: merge.expectedAt,
        reason: merge.own ? 'own-echo' : 'remerge',
      });
      return { saved, html: merge.saveHtml };
    } catch (e) {
      console.warn(`[${tag}] merged re-save failed`, e);
      return null;
    }
  },

  // Notebook-Einstieg in den geteilten Pre-Save-Conflict-Check
  // (shared/page-conflict.js). Die Prüfung selbst ist eine Eigenschaft der
  // Seite und liegt darum nicht mehr hier — der Bucheditor importiert dieselbe
  // Funktion direkt, statt über die Root-Trampoline in diese Karte zu greifen.
  _checkPageConflict(pageId, expectedUpdatedAt) {
    return checkPageConflict(pageId, expectedUpdatedAt);
  },


  // Steht die Edit-Session noch auf `pageId`? Save-Pfade pinnen die Seite beim
  // Start und prüfen das nach jedem `await` — ein Seitenwechsel mitten im Save
  // darf HTML von Seite A nicht in Seite B mergen, speichern oder als deren
  // Draft ablegen.
  _stillEditing(pageId) {
    const app = editorHost();
    return !!app?.editMode && app.currentPage?.id === pageId;
  },


  // Block-Level-3-Way-Merge gegen den frischen Remote-Stand. base = originalHtml
  // (zuletzt geladene/gespeicherte Server-Fassung = common ancestor). Liefert
  // { merged, conflicts } oder null → Aufrufer fällt auf klassischen Banner zurück
  // (Flag off, leere Base = frische Page → 2-Way-Fallback, oder Merge wirft).
  _computeBlockMerge(localHtml, remoteHtml) {
    const app = editorHost();
    if (!FEATURE_BLOCK_MERGE) return null;
    const base = app.originalHtml || '';
    if (!base) return null;
    try {
      return mergeBlocks(base, localHtml, remoteHtml);
    } catch (e) {
      console.warn('[blockMerge] compute failed, fallback to classic', e);
      return null;
    }
  },


  // Gemergtes HTML in den Live-Editor spiegeln, damit Folge-Edits auf dem
  // gemergten Stand aufbauen (sonst würde der nächste Save remote-Blöcke
  // wieder „zurückeditieren"). Quelle ist server-sanitiertes Page-HTML (gleiche
  // Vertrauensstufe wie startEdit, das ebenfalls direkt setzt). Der Caret
  // bleibt in seinem Block (shared/block-caret.js) — der Merge läuft auch still
  // mitten im Tippen (Autosave, Collab-Pull), ein Sprung an den Seitenanfang
  // risse den User aus dem Satz.
  //
  // Läuft über `mountEditorHtml` (dieselbe Pipeline wie startEdit + Undo-Restore):
  // ein gemergtes Block-Set kann auf einer `<hr>` enden oder einen kindlosen
  // `<p>` enthalten — ohne Caret-Slot stünde der User danach ohne Schreib-Anker da.
  //
  // Der gemergte Stand ist die neue Undo-Baseline: ein Undo dahinter zurück
  // nähme die Remote-Blöcke wieder heraus, und der nächste Save liefe gegen das
  // inzwischen übernommene `updated_at` ohne 409 durch — die Änderung des
  // anderen Geräts wäre still überschrieben.
  _applyMergedToEditor(html) {
    const el = this._getEditEl();
    if (!el || el.innerHTML === html) return;
    const caret = captureBlockCaret(el);
    mountEditorHtml(el, html);
    restoreBlockCaret(el, caret);
    this._historyReset?.(el.innerHTML);
  },


  // Auflösungs-Modal öffnen: kollidierende Blöcke + Auflösungs-State festhalten.
  //  - Das Partial lädt lazy (app-ui.js#_ensurePartial) — ohne den Aufruf
  //    stünde der State, aber kein Modal.
  //  - Autosave-Timer räumen: solange das Modal offen ist, speichert nichts im
  //    Hintergrund (`_canBackgroundSave`); ein armierter Max-Timer feuerte
  //    sonst direkt nach der Auflösung gegen einen veralteten Stand.
  //  - Ersetzt ein Folge-Konflikt (409 beim Übernehmen) ein offenes Modal
  //    derselben Seite, bleiben bereits getroffene Entscheidungen stehen.
  //  - `view` je Konflikt: Klartext + Wort-Diff für die Vorschau
  //    (shared/conflict-diff.js); übernommen wird das rohe Block-HTML.
  _openConflictResolution({ merged, conflicts: rawConflicts, source, remoteUpdatedAt }) {
    const conflicts = rawConflicts.map(c => ({ ...c, view: conflictDiffView(c) }));
    const app = editorHost();
    const pageId = app.currentPage?.id;
    const prev = app.conflictResolution?.pageId === pageId ? app.conflictResolution.decisions : null;
    const decisions = {};
    for (const c of conflicts) decisions[c.bid] = prev?.[c.bid] || 'local';
    this._clearAutosaveTimers();
    app._ensurePartial?.('conflict-resolution');
    app.conflictResolution = {
      pageId,
      source,
      merged,
      conflicts,
      remoteUpdatedAt,
      decisions,
    };
    trackMerge('conflict_shown');
  },


  // Konflikt-Orchestrierung: versucht Block-Merge gegen den Remote-Stand.
  // remoteHtml/remoteUpdatedAt können aus _checkPageConflict mitgegeben werden
  // (spart einen fresh-Load); fehlen sie (409-Race), wird frisch geladen.
  // Rückgabe:
  //   { merged:true, saveHtml, expectedAt } — kollisionsfrei, Aufrufer speichert saveHtml
  //     (`own:true`: Remote war ein eigener verspäteter Save, saveHtml = lokal).
  //   { conflict:true } — Auflösungs-Banner geöffnet, Aufrufer bricht ab.
  //   { stale:true } — Seite während des Remote-Reads gewechselt.
  //   null — kein Merge (Flag off / leere Base / Read-Fehler) → klassischer Pfad.
  //
  // `liveLocal`: die lokale Seite des Merge ist der Editor selbst (saveEdit,
  // quickSave, Pull). Dann zählt der Live-Stand NACH den Reads, nicht der beim
  // Save-Start gefangene `localHtml` — der Editor bleibt während Conflict-Check,
  // PUT und Remote-Read beschreibbar, und `_applyMergedToEditor` überschreibt
  // das DOM. Ein Merge mit dem alten Schnappschuss löschte, was in dieser Zeit
  // getippt wurde. Aus bei submitConflictResolution: dort ist die lokale Seite
  // die getroffene Auflösung, nicht das DOM.
  async _attemptBlockMerge({ localHtml, source, pageId, remoteHtml = null, remoteUpdatedAt = null, liveLocal = false }) {
    const app = editorHost();
    if (!FEATURE_BLOCK_MERGE || !app.currentPage) return null;
    if (pageId == null) pageId = app.currentPage.id;
    if (remoteHtml === null || remoteUpdatedAt === null) {
      try {
        const remote = await contentRepo.loadPage(pageId, { fresh: true });
        remoteHtml = remote?.html || '';
        remoteUpdatedAt = remote?.updated_at || null;
      } catch { return null; }
    }
    // Base (originalHtml), Live-DOM und Auflösungs-Banner gehören der offenen
    // Seite — nach einem Wechsel wäre der Merge gegen die falsche Base gerechnet.
    if (app.currentPage?.id !== pageId) return { stale: true };
    if (!remoteUpdatedAt) return null;
    if (liveLocal) {
      const el = this._getEditEl();
      if (el) {
        this._ensureLiveBlockIds();
        localHtml = stripLektoratMarks(el.innerHTML);
      }
    }
    // Server-Stand ist ein eigener, verspätet angekommener Save dieses Tabs
    // (../sent-saves.js): der lokale Stand ist sein Nachfahre, kein Merge.
    if (isOwnSentSave(pageId, remoteHtml)) {
      return { merged: true, own: true, saveHtml: localHtml, expectedAt: remoteUpdatedAt };
    }
    const m = this._computeBlockMerge(localHtml, remoteHtml);
    if (!m) return null;
    if (m.conflicts.length === 0) {
      const saveHtml = mergedToHtml(m.merged);
      this._applyMergedToEditor(saveHtml);
      trackMerge('silent_success');
      return { merged: true, saveHtml, expectedAt: remoteUpdatedAt };
    }
    // Draft sichern, aber ohne Status-Zeile — das Auflösungs-Modal ist der
    // sichtbare Hinweis, ein zweiter Toast daneben wäre Rauschen.
    this._keepAsDraft({ pageId, html: localHtml, statusKey: null });
    this._openConflictResolution({ merged: m.merged, conflicts: m.conflicts, source, remoteUpdatedAt });
    return { conflict: true };
  },


  // Remote-Stand der offenen Seite in die laufende Edit-Session holen, bevor
  // der nächste Save mit dem alten Stempel in 409 läuft. Auslöser: Collab-
  // Treffer auf der offenen Seite (app-collab.js#_onCurrentPageRemoteEdit) und
  // das Aufwachen eines versteckten Tabs (app-view/bookscope.js#
  // _checkEditedPageAfterWake).
  //  - clean → Remote-HTML in den Editor, Base + Stempel vorrücken.
  //  - dirty → 3-Way-Block-Merge über `_attemptBlockMerge`: kollisionsfrei wird
  //    der gemergte Stand gespiegelt und die Base auf Remote vorgerückt (die
  //    eigenen Edits bleiben als Diff dazu dirty, der Autosave speichert sie);
  //    bei Kollision öffnet die Auflösung sofort statt erst beim Save.
  //  - kein Merge möglich → Konflikt-Banner, der nächste Save klärt.
  // DOM, `originalHtml` und `updated_at` immer gemeinsam: ein frischer Stempel
  // ohne frischen Editor-Inhalt liesse den nächsten Save die Remote-Änderung
  // still überschreiben.
  async _pullRemoteIntoEditor(change = null) {
    const app = editorHost();
    const pageId = app.currentPage?.id;
    if (!pageId || !app.editMode || app.editSaving || app.conflictResolution) return;
    let remote;
    try { remote = await contentRepo.loadPage(pageId, { fresh: true }); } catch { return; }
    if (!this._stillEditing(pageId) || app.editSaving || app.conflictResolution) return;
    if (!remote?.updated_at || remote.updated_at === app.currentPage.updated_at) return;
    const remoteHtml = remote.html || '';
    const el = this._getEditEl();
    if (el) this._ensureLiveBlockIds();
    const localHtml = el ? stripLektoratMarks(el.innerHTML) : '';
    // Am Editor-Inhalt entscheiden, nicht nur am `editDirty`-Flag: ein
    // Tastendruck, dessen input-Event noch aussteht, ginge sonst beim
    // Überschreiben verloren.
    if (!app.editDirty && isNoChange(localHtml, app.originalHtml)) {
      this._applyMergedToEditor(remoteHtml);
      app.originalHtml = remoteHtml;
      app.currentPage.updated_at = remote.updated_at;
      app.updatePageView?.();
      return;
    }
    const source = app.focusActive ? 'focus' : 'main';
    const merge = await this._attemptBlockMerge({
      localHtml, source, pageId, remoteHtml, remoteUpdatedAt: remote.updated_at, liveLocal: true,
    });
    if (merge?.stale || merge?.conflict) return;
    if (merge?.merged) {
      app.originalHtml = remoteHtml;
      app.currentPage.updated_at = remote.updated_at;
      // Draft auf die neue Basis umschreiben: mit der alten Basis liefe er beim
      // nächsten Öffnen (startEdit → _reconcileDraftWithServer) noch einmal
      // gegen den schon eingearbeiteten Remote-Stand.
      this._flushDraftSaveNow();
      if (!merge.own) app.setStatus(app.t('edit.conflict.merged.silent'), false, 5000);
      return;
    }
    app.editConflict = this._conflictBannerFrom({
      remoteUserName: change?.last_editor_name || remote.updated_by_name || null,
      remoteUpdatedAt: remote.updated_at,
      remoteIsSelf: !!change?.is_self,
      remoteDevice: change?.device_label || remote.last_editor?.device_name || null,
    });
  },


  // Draft-Wiederaufnahme in startEdit: ein Draft trägt seine eigene Basis
  // (`originalHtml` + `originalUpdatedAt` beim Schreiben). Ist die Seite seither
  // weitergeschrieben worden (anderes Gerät, anderer User), steht der Server-
  // Stand von heute als Base und Stempel im Editor — `draft.html` direkt
  // einzusetzen hiesse: der nächste Save läuft ohne 409 durch und nimmt die
  // Remote-Änderung still zurück. Darum 3-Way gegen den Server-Stand, mit der
  // Draft-Basis als gemeinsamem Vorfahren:
  //   { html }            — Basis aktuell, oder kollisionsfrei gemergt
  //   { html, conflict }  — echte Kollision; Aufrufer öffnet die Auflösung
  // Ohne Draft-Basis (Alt-Draft) oder ohne Merge bleibt es beim Draft.
  _reconcileDraftWithServer(draft) {
    const app = editorHost();
    const serverHtml = app.originalHtml || '';
    const serverAt = app.currentPage?.updated_at || null;
    if (!FEATURE_BLOCK_MERGE || !draft.originalUpdatedAt || !serverAt
        || draft.originalUpdatedAt === serverAt || !draft.originalHtml) {
      return { html: draft.html };
    }
    // Server-Stand ist ein Zwischenstand, den dieser Tab selbst geschickt hat
    // (Antwort verloren, danach neu geladen): der Draft ist sein Nachfahre.
    if (isOwnSentSave(app.currentPage.id, serverHtml)) return { html: draft.html };
    let m;
    try { m = mergeBlocks(draft.originalHtml, draft.html, serverHtml); }
    catch (e) {
      console.warn('[draftRestore] merge failed, restore draft as-is', e);
      return { html: draft.html };
    }
    if (m.conflicts.length === 0) {
      trackMerge('silent_success');
      return { html: mergedToHtml(m.merged), merged: true };
    }
    return { html: draft.html, conflict: { merged: m.merged, conflicts: m.conflicts, remoteUpdatedAt: serverAt } };
  },


  // Auflösungs-Entscheidung pro Block (UI). choice: 'local'|'remote'|'both'.
  resolveBlock(bid, choice) {
    const app = editorHost();
    if (!app.conflictResolution) return;
    app.conflictResolution.decisions[bid] = choice;
  },


  // Bulk: alle Konflikte auf eine Seite setzen.
  resolveAllConflicts(choice) {
    const app = editorHost();
    if (!app.conflictResolution) return;
    for (const c of app.conflictResolution.conflicts) {
      app.conflictResolution.decisions[c.bid] = choice;
    }
  },


  // Auflösung übernehmen: finales HTML aus merged + decisions bauen und mit
  // expected_updated_at = remoteUpdatedAt speichern.
  async submitConflictResolution() {
    const app = editorHost();
    const cr = app.conflictResolution;
    if (!cr || app.editSaving) return;
    const finalHtml = buildResolvedHtml(cr.merged, cr.decisions);
    const source = cr.source || (app.focusActive ? 'focus' : 'main');
    // Name beim Start festhalten (siehe _pinSaveTarget): nach einem `await`
    // kann `currentPage` schon die nächste Seite sein.
    const pageName = app.currentPage?.name;
    app.editSaving = true;
    app.setStatus(app.t('edit.saving'), true);
    try {
      const saved = await savePage(cr.pageId, {
        html: finalHtml,
        pageName,
        source,
        expectedUpdatedAt: cr.remoteUpdatedAt,
        reason: 'resolve',
      });
      // Auf dem Server ist die Auflösung; den State einer inzwischen geöffneten
      // anderen Seite fasst sie nicht an.
      if (!this._stillEditing(cr.pageId)) { clearDraft(cr.pageId); return; }
      this._applySaveSuccess(saved, finalHtml, { pageId: cr.pageId, applyToEditor: true });
      trackMerge('conflict_resolved', { mix: this._resolutionMix(cr) });
      app.conflictResolution = null;
      app.setStatus('');
    } catch (e) {
      if (isPageConflict(e)) {
        // Dritter Schreibvorgang zwischen Konflikt-Anzeige und „Auflösung
        // übernehmen": der finale PUT (expected = cr.remoteUpdatedAt) trifft
        // erneut 409. Statt Sackgasse (User klickt immer in denselben 409) die
        // lokal aufgelöste Fassung gegen den jetzt frischen Remote-Stand neu
        // block-mergen — gemeinsamer Pfad mit saveEdit/quickSave, nur mit
        // finalHtml als lokaler Quelle (= die gerade getroffene Auflösung).
        // Seite gewechselt: der Draft vom Konflikt-Zeitpunkt liegt schon
        // (_attemptBlockMerge), Merge und Banner gehörten der alten Seite.
        if (!this._stillEditing(cr.pageId)) return;
        const retry = await this._retryAfterConflict({
          localHtml: finalHtml, source, pageId: cr.pageId,
          pageName, tag: 'submitConflictResolution',
        });
        if (retry?.stale) return;
        // _openConflictResolution hat den conflictResolution-State auf den neuen
        // Remote-Stand ersetzt → User löst die neue Kollision auf.
        if (retry?.conflict) return;
        if (retry) {
          if (!this._stillEditing(cr.pageId)) { clearDraft(cr.pageId); return; }
          this._applySaveSuccess(retry.saved, retry.html, { pageId: cr.pageId, applyToEditor: true });
          trackMerge('conflict_resolved', { mix: this._resolutionMix(cr) });
          app.conflictResolution = null;
          app.setStatus(app.t('edit.conflict.merged.silent'), false, 3000);
          return;
        }
        // Fallback (kein Merge: Flag off / leere Base / Read-Fehler): die
        // aufgelöste Arbeit als Draft sichern, Offline-/Konflikt-Banner zeigen.
        // conflictResolution bleibt offen — User kann erneut übernehmen/abbrechen.
        this._keepAsDraft({ pageId: cr.pageId, html: finalHtml, banner: readConflictBody(e) });
        return;
      }
      console.error('[submitConflictResolution]', e);
      app.setStatus(this._saveFailureText(classifySaveError(e), e), false, 8000);
    } finally {
      app.editSaving = false;
    }
  },


  // Auflösungs-Mix (Meine/Andere/Beide) für Telemetrie aus dem
  // conflictResolution-State zählen.
  _resolutionMix(cr) {
    const mix = { local: 0, remote: 0, both: 0 };
    for (const c of cr.conflicts) {
      const choice = cr.decisions[c.bid] || 'local';
      if (mix[choice] != null) mix[choice]++;
    }
    return mix;
  },


  // Auflösung abbrechen = die eigene Fassung der kollidierenden Seite
  // verwerfen und den Server-Stand laden. Nur ausdrücklich (Abbrechen-Knopf,
  // Esc) und nur nach Rückfrage — ein Klick neben das Modal bricht nichts ab.
  // Die verworfene Fassung landet als Sicherung im Draft-Slot
  // `<pageId>:discarded` (draft-storage.js; Outbox und Pending-Zähler sehen
  // ihn nicht, weil die ID keine Zahl ist) — eine Revision entsteht dabei
  // nicht, es wird ja nichts gespeichert.
  async cancelConflictResolution() {
    const app = editorHost();
    const cr = app.conflictResolution;
    if (!cr || _cancelAsking) return;
    _cancelAsking = true;
    let ok = false;
    try {
      ok = await app.appConfirm({
        message: app.t('edit.conflict.cancelConfirm'),
        confirmLabel: app.t('edit.conflict.cancelDiscard'),
        danger: true,
      });
    } finally {
      _cancelAsking = false;
    }
    // Während der Rückfrage übernommen oder durch einen Folge-Konflikt ersetzt.
    if (!ok || app.conflictResolution !== cr) return;
    const el = this._stillEditing(cr.pageId) ? this._getEditEl() : null;
    const localHtml = el ? stripLektoratMarks(el.innerHTML) : readDraft(cr.pageId)?.html;
    if (localHtml) writeDraft(`${cr.pageId}:discarded`, localHtml, app.originalHtml, app.currentPage?.updated_at);
    app.conflictResolution = null;
    app.editConflict = null;
    if (!cr.pageId) return;
    try {
      const remote = await contentRepo.loadPage(cr.pageId, { fresh: true });
      if (!this._stillEditing(cr.pageId)) return;
      if (remote?.html != null) {
        this._applyMergedToEditor(remote.html);
        app.originalHtml = remote.html;
        if (remote.updated_at) app.currentPage.updated_at = remote.updated_at;
        app.editDirty = false;
        app.saveOffline = false;
        app.saveFailKind = null;
        clearDraft(cr.pageId);
        app.lastDraftSavedAt = null;
        app.updatePageView?.();
      }
    } catch (e) {
      // Editor behält die eigene Fassung (dirty, Draft liegt) — der nächste
      // Save läuft über den OCC-Guard wieder in den Merge.
      console.warn('[cancelConflictResolution] reload failed', e);
    }
  },
};
