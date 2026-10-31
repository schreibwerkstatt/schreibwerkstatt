// Teil von bookEditorCard (Facade cards/book-editor-card.js): lokale Entwürfe
// der Blöcke und der Weg zurück, wenn das Netz fehlt. Methoden in den
// Card-Scope gespreadet (gemeinsames `this`).
//
// Ein ungespeicherter Block liegt — wie im Notebook-Editor — als Entwurf im
// geteilten Draft-Speicher (editor/draft-storage.js, Schreiber `book`):
// `html` + Basis (`originalHtml`, `originalUpdatedAt`). Damit übersteht er
// Schliessen, Absturz und Neuladen, und die Reconnect-Outbox
// (app/app-outbox.js) kann ihn nachsenden, wenn der Bucheditor nicht mehr
// offen ist. Solange der Bucheditor einen Block hält (ungespeichert,
// speichernd, Konflikt), markiert er ihn als live (editor/live-edit.js) — die
// Outbox dieses und anderer Tabs lässt ihn dann in Ruhe.
//
// Beim Laden wird ein liegengebliebener Entwurf mit SEINER Basis in den Block
// gesetzt; der reguläre Save prüft gegen den Server-Stand und mergt
// (book-editor/conflict.js) — ein Entwurf auf altem Stand überschreibt so nie
// still eine Remote-Änderung.

import { readDraft, writeDraft, clearDraft, draftsLoaded, moveDraftToBackup } from '../../editor/draft-storage.js';
import { fetchBookContents } from './blocks.js';
import { EVT } from '../../events.js';
import { setLiveEditPages, isLiveEditedElsewhere, isLiveEditedHere } from '../../editor/live-edit.js';
import { stripLektoratMarks } from '../../editor/shared/html-clean.js';
import { isNoChange } from '../../editor/shared/save-pipeline.js';
import { createTimerBag } from '../../editor/shared/timers.js';
import { isSelectedBook } from '../book-guard.js';

// Gleicher Takt wie der Notebook-Draft (editor/notebook/edit/_shared.js).
const DRAFT_DEBOUNCE_MS = 500;
// Nachspeichern, wenn nur der Server weg ist (Browser bleibt online, kein
// `online`-Event): wie die Outbox (app/app-outbox.js#nextOutboxBackoff).
const OFFLINE_RETRY_MIN_MS = 15 * 1000;
const OFFLINE_RETRY_MAX_MS = 5 * 60 * 1000;

const HOLDER = 'book';

export const bookEditorDraftMethods = {
  _draftTimers: null,
  _offlineRetryTimer: null,
  _offlineRetryMs: 0,
  _serverProbe: false,   // Re-Entry-Guard für _reloadIfServerBack
  // Abschnitte, für die der Hinweis „in anderem Tab offen" schon kam.
  _elsewhereWarned: null,

  // Aus init(): Timer, Live-Markierung, Online-Retry, Sicherung beim Verlassen.
  _initDrafts(signal) {
    this._draftTimers = createTimerBag();
    this.$watch(() => this._heldPageIds().join(','), () => {
      setLiveEditPages(HOLDER, this._heldPageIds());
    });
    window.addEventListener('online', () => this._retryOfflineBlocks(), { signal });
    // Server war weg, ohne dass der Browser offline meldete: kein `online`-Event.
    window.addEventListener('focus', () => this._retryOfflineBlocks(), { signal });
    // Schliessen/Neuladen: ausstehende Entwürfe sofort schreiben.
    window.addEventListener('pagehide', () => this._flushBlockDrafts(), { signal });
    // Entwurf liess sich nachträglich nicht sichern (editor/draft-storage.js).
    window.addEventListener(EVT.DRAFT_PERSIST_FAILED, (e) => {
      const b = this._blockById?.(e.detail?.pageId);
      if (!b) return;
      b.draftFailed = true;
      const app = window.__app;
      app?.setStatus?.(app.t('edit.draftPersistFailedLate'), true, 10000);
    }, { signal });
    signal.addEventListener('abort', () => {
      this._flushBlockDrafts();
      setLiveEditPages(HOLDER, []);
      clearTimeout(this._offlineRetryTimer);
      this._offlineRetryTimer = null;
    }, { once: true });
  },

  // Erstes Tippen in einem Abschnitt, den ein anderer Tab gerade bearbeitet:
  // einmal sagen (der Entwurf des anderen wird nicht überschrieben, sondern
  // als Sicherung behalten — editor/draft-storage.js#writeDraft).
  _warnIfEditedElsewhere(block) {
    if (!isLiveEditedElsewhere(block.pageId)) return;
    this._elsewhereWarned ||= new Set();
    if (this._elsewhereWarned.has(block.pageId)) return;
    this._elsewhereWarned.add(block.pageId);
    const app = window.__app;
    app?.setStatus?.(app.t('edit.openElsewhere'), true, 8000);
  },

  // Backoff-Wiederholung für Blöcke, deren Save am Netz/Server scheiterte.
  _scheduleOfflineRetry() {
    this._offlineRetryMs = Math.min(OFFLINE_RETRY_MAX_MS, this._offlineRetryMs ? this._offlineRetryMs * 2 : OFFLINE_RETRY_MIN_MS);
    clearTimeout(this._offlineRetryTimer);
    this._offlineRetryTimer = setTimeout(() => {
      this._offlineRetryTimer = null;
      this._retryOfflineBlocks();
    }, this._offlineRetryMs);
  },

  // Blöcke, deren Stand dieser Tab verantwortet (Outbox-Skip).
  _heldPageIds() {
    const ids = [];
    for (const b of this.blocks) {
      if (b.kind === 'page' && (b.dirty || b.saving || b.conflict)) ids.push(b.pageId);
    }
    return ids;
  },

  _scheduleBlockDraft(block) {
    this._draftTimers?.set(block.pageId, () => this._writeBlockDraft(block), DRAFT_DEBOUNCE_MS);
  },

  _flushBlockDrafts() {
    if (!this._draftTimers) return;
    for (const b of this.blocks) {
      if (b.kind === 'page' && this._draftTimers.has(b.pageId)) {
        this._draftTimers.clear(b.pageId);
        this._writeBlockDraft(b);
      }
    }
  },

  // Entwurf nach dem aktuellen Block-Stand schreiben bzw. räumen. Die Block-IDs
  // werden vorher eindeutig gemacht: der Entwurf ist Eingabe eines späteren
  // Merges, doppelte IDs verlören dort Text.
  _writeBlockDraft(block) {
    this._draftTimers?.clear(block.pageId);
    if (!block.dirty) { clearDraft(block.pageId); return; }
    this._syncBlockIds(block);
    const html = stripLektoratMarks(block.html);
    if (isNoChange(html, block.originalHtml)) { clearDraft(block.pageId); return; }
    const ok = writeDraft(block.pageId, html, block.originalHtml, block.originalUpdatedAt, { writer: HOLDER });
    block.draftFailed = !ok;
  },

  // Nach dem Laden: liegengebliebene Entwürfe in ihre Blöcke setzen. Ein
  // Entwurf ohne Basis-Stempel (Alt-Format) bleibt dem `pendingDraft`-Banner
  // des Notebook-Editors; einer, den gerade ein anderer Tab oder der Notebook-
  // Editor dieses Tabs bearbeitet, gehört dorthin.
  //
  // Läuft zweimal: direkt nach dem Laden und noch einmal, sobald das Start-
  // Laden aus IndexedDB wirklich durch ist (`late`) — ein langsames IndexedDB
  // überholt sonst den Deckel von whenDraftsReady, und ein liegengebliebener
  // Entwurf käme nie in seinen Block. Ein schon bearbeiteter Block bleibt
  // dabei unberührt; trifft der späte Entwurf den gerade aktiven, aber noch
  // unveränderten Block, wird er Sicherung statt den DOM unter dem Caret zu
  // tauschen.
  _restoreBlockDrafts({ late = false } = {}) {
    let restored = 0;
    for (const b of this.blocks) {
      if (b.kind !== 'page' || b.dirty || b.saving || b.conflict) continue;
      const d = readDraft(b.pageId);
      if (!d?.html || !d.originalUpdatedAt || typeof d.originalHtml !== 'string') continue;
      if (isLiveEditedElsewhere(b.pageId) || isLiveEditedHere(b.pageId)) continue;
      if (isNoChange(d.html, b.html)) {
        // Der Server hat diesen Stand schon (Antwort verloren, Outbox war schneller).
        clearDraft(b.pageId);
        continue;
      }
      if (late && this.activePageId === b.pageId) {
        moveDraftToBackup(b.pageId, 'recovered');
        continue;
      }
      b.html = d.html;
      b.originalHtml = d.originalHtml;
      b.originalUpdatedAt = d.originalUpdatedAt;
      b._draftOwn = Array.isArray(d.ownSaveIds) && d.ownSaveIds.length ? d.ownSaveIds : null;
      b.dirty = true;
      b._rev++;
      restored++;
    }
    if (!restored) return;
    const app = window.__app;
    app?.setStatus?.(app.t('bookEditor.draftsRestored', { n: restored }), false, 6000);
    this._retryOfflineBlocks({ all: true });
  },

  // Nur neu aufbauen, wenn der Server wirklich wieder antwortet: meldet der
  // Browser „online", ist aber nur der Server weg, käme wieder der Rückfall —
  // und jeder Fokuswechsel liesse den Stream flackern und die Scrollposition
  // springen. Erst prüfen (eine Anfrage), dann regulär laden.
  async _reloadIfServerBack(bookId) {
    if (this._serverProbe) return;
    this._serverProbe = true;
    try {
      const data = await fetchBookContents(bookId).catch(() => null);
      if (!data || data.offline) return;
      // Buchwechsel während der Probe: nicht das alte Buch über das neue laden.
      if (!isSelectedBook(bookId)) return;
      if (this.offlineSource && this.dirtyCount === 0 && this.activePageId == null) await this._load(bookId);
    } finally {
      this._serverProbe = false;
    }
  },

  // Netz zurück (bzw. Entwürfe wiederhergestellt): ungespeicherte Blöcke
  // speichern. Ohne `all` nur die, deren letzter Save am Netz scheiterte — die
  // übrigen hat der Autosave ohnehin eingeplant.
  _retryOfflineBlocks({ all = false } = {}) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    let pending = 0;
    for (const b of this.blocks) {
      if (b.kind === 'page' && b.dirty && !b.conflict && (all || b.offline)) { this._enqueueSave(b.pageId); pending++; }
    }
    if (!pending && !this.blocks.some((b) => b.offline)) {
      clearTimeout(this._offlineRetryTimer);
      this._offlineRetryTimer = null;
      this._offlineRetryMs = 0;
    }
    // Offline-Kopie geladen und nichts offen: frisch nachladen, damit der Stream
    // nicht auf dem Stand des Caches stehen bleibt.
    if (this.offlineSource && !all && this.dirtyCount === 0 && this.activePageId == null) {
      const bookId = window.Alpine?.store('nav')?.selectedBookId;
      if (bookId) this._reloadIfServerBack(bookId);
    }
  },
};
