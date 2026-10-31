import { fetchJson } from '../utils.js';
import { tFetchError } from '../i18n.js';
import { attachReflow, positionPopupNearRect } from './utils.js';
import { startPoll } from '../cards/job-helpers.js';
import { EVT } from '../events.js';
import { applySpellcheckReplacement } from './shared/apply-replacement.js';
import { normalizeSynonymWord, wordBoundsAt, synonymContext, matchSynonymCase } from './shared/synonym-text.js';

// Synonym-Ermittler für den contenteditable-Editor.
// Cmd/Ctrl+Shift+S auf markiertem Wort (oder Cursor in Wort) → Custom-Menü →
// KI-Call → Picker mit Synonymvorschlägen → Klick ersetzt das Wort im DOM.
// Trigger bewusst per Hotkey statt Rechtsklick — Rechtsklick gehört dem nativen
// Browser-Menü inkl. Spellcheck.
//
// Zweigeteilt:
//   - `synonymMethods`: Root-Trigger (Hotkey + contextmenu für macOS-Figuren-
//     Lookup-Fallback). Dispatcht `editor:synonym:open {range, word}`.
//     Trampoline `closeSynonymMenu/Picker`, `requestSynonyms`.
//   - `synonymCardMethods`: Menü/Picker-Display + Thesaurus/KI-Fetch in
//     Alpine.data('editorSynonymeCard').

export const synonymMethods = {
  // contextmenu-Handler: fängt NUR macOS-Ctrl+Leftclick ab (feuert kein `click`,
  // sondern `contextmenu`) — wenn das Wort eine Figur trifft, öffnet das
  // Lookup-Popover. Plain Rechtsklick fällt durch zum nativen Browser-Menü
  // (inkl. Spellcheck/Diktionär). Mobile bleibt komplett unangetastet.
  _onEditContextMenu(e) {
    if (!this.editMode) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    this._tryOpenFigurLookupAt?.(e);
  },

  // Cmd/Ctrl+Shift+S → Synonyme für markiertes Wort oder Wort unter Cursor.
  // Nur im Edit-Mode aktiv (Fokus-Mode hat editMode=true → läuft mit).
  handleSynonymHotkey(e) {
    if (!this.editMode) return;
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return;
    if ((e.key || '').toLowerCase() !== 's') return;
    if (window.innerWidth <= 768) return;
    const editEl = this._getEditEl?.();
    if (!editEl) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    if (!editEl.contains(r.commonAncestorContainer)) return;
    // Griff gehört ab hier dem Editor — auch wenn kein Wort passt, sonst
    // öffnet Firefox auf Cmd/Ctrl+Shift+S seinen Bildschirmfoto-Dialog.
    e.preventDefault();
    let range = null;
    let wort = '';
    if (!sel.isCollapsed) {
      wort = normalizeSynonymWord(sel.toString());
      if (!wort) return;
      range = r.cloneRange();
    } else {
      // Caret in Wort: Range expandieren über die Wortgrenzen.
      const node = r.startContainer;
      if (node.nodeType !== Node.TEXT_NODE) return;
      const hit = wordBoundsAt(node.textContent || '', r.startOffset);
      if (!hit) return;
      const expanded = document.createRange();
      expanded.setStart(node, hit.start);
      expanded.setEnd(node, hit.end);
      range = expanded;
      wort  = hit.word;
      sel.removeAllRanges();
      sel.addRange(expanded.cloneRange());
    }
    window.dispatchEvent(new CustomEvent(EVT.EDITOR_SYNONYM_OPEN, {
      detail: { range, word: wort },
    }));
  },

  // Toolbar-Button („Syn"): liest aktuelle Selection (muss Einzelwort sein) und
  // öffnet das Synonym-Menü. Bubble-Toolbar zeigt den Button nur, wenn die
  // Selection als Einzelwort matcht — der Handler doppelt-prüft.
  openSynonymForCurrentSelection() {
    if (!this.editMode) return;
    const editEl = this._getEditEl?.();
    if (!editEl) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const wort = normalizeSynonymWord(sel.toString());
    if (!wort) return;
    const r = sel.getRangeAt(0);
    if (!editEl.contains(r.commonAncestorContainer)) return;
    window.dispatchEvent(new CustomEvent(EVT.EDITOR_SYNONYM_OPEN, {
      detail: { range: r.cloneRange(), word: wort },
    }));
  },

  // Trampoline für Legacy-Aufrufer.
  closeSynonymMenu() {
    window.dispatchEvent(new CustomEvent(EVT.EDITOR_SYNONYM_CLOSE_MENU));
  },
  closeSynonymPicker() {
    window.dispatchEvent(new CustomEvent(EVT.EDITOR_SYNONYM_CLOSE_PICKER));
  },
  // Wird vom Menü-Button im Partial aufgerufen (Root-Scope wegen Event-Bubble).
  requestSynonyms() {
    window.dispatchEvent(new CustomEvent(EVT.EDITOR_SYNONYM_REQUEST));
  },
};

// ── Sub-Komponenten-Methoden ──────────────────────────────────────────────
// `this` zeigt auf die Alpine.data('editorSynonymeCard')-Instanz.
export const synonymCardMethods = {
  _openSynonymMenu({ range, word, clientX, clientY }) {
    if (!range || !word) return;
    this._cancelSynonymRequest();
    this._synonymRange = range;
    this._synonymWord  = word;
    this.showSynonymPicker = false;
    this.synonymThesList = [];
    this.synonymThesError = '';
    this.synonymThesDisabled = false;
    this.synonymKiList = [];
    this.synonymKiError = '';
    this.showSynonymMenu = true;
    this._syncOpenFlag();
    this._attachSynonymScroll();
    this.$nextTick(() => this._positionSynonymUI(clientX, clientY));
    this._positionSynonymUI(clientX, clientY);
  },

  // Spiegelt den Sichtbarkeits-Zustand an den Root, damit focus-onKey
  // (Escape) weiss, ob ein Menü/Picker offen ist, ohne in die Sub zu greifen.
  _syncOpenFlag() {
    const app = window.__app;
    if (app) {
      app._synonymMenuOpen   = this.showSynonymMenu;
      app._synonymPickerOpen = this.showSynonymPicker;
    }
  },

  // Neupositionierung anhand der aktuellen Range. Wird initial und bei jedem
  // Scroll/Resize aufgerufen. Flippt nach oben, wenn unten kein Platz ist.
  _positionSynonymUI() {
    const range = this._synonymRange;
    if (!range) return;
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      // Range ungültig geworden (z.B. DOM-Änderung)
      this.closeSynonymMenu();
      this.closeSynonymPicker();
      return;
    }
    const isPicker = this.showSynonymPicker;
    const el = document.querySelector(isPicker ? '.synonym-picker' : '.synonym-menu');
    const { x, y } = positionPopupNearRect(rect, el, {
      gap: 4,
      fallbackWidth:  isPicker ? 300 : 220,
      fallbackHeight: isPicker ? 360 : 44,
    });
    this.synonymMenuX = x;
    this.synonymMenuY = y;
  },

  _attachSynonymScroll() {
    if (this._synonymReflowDetach) return;
    this._synonymReflowDetach = attachReflow(() => this._positionSynonymUI());
  },

  _detachSynonymScroll() {
    if (!this._synonymReflowDetach) return;
    this._synonymReflowDetach();
    this._synonymReflowDetach = null;
  },

  closeSynonymMenu() {
    this.showSynonymMenu = false;
    this._syncOpenFlag();
    if (!this.showSynonymPicker) this._detachSynonymScroll();
  },

  closeSynonymPicker() {
    this.showSynonymPicker = false;
    this._syncOpenFlag();
    this._cancelSynonymRequest();
    this.synonymThesList = [];
    this.synonymThesError = '';
    this.synonymThesDisabled = false;
    this.synonymKiList = [];
    this.synonymKiError = '';
    this.synonymKiLoading = false;
    this.synonymThesLoading = false;
    if (!this.showSynonymMenu) this._detachSynonymScroll();
  },

  // Bricht die laufende Anfrage ab: Thesaurus-Fetch, Job-POST, Polling und den
  // KI-Job selbst. Jede Antwort, die danach noch eintrifft, trägt eine veraltete
  // Anfrage-Nummer und wird verworfen (`_isCurrentSynonymReq`).
  _cancelSynonymRequest() {
    this._synonymReqSeq = (this._synonymReqSeq || 0) + 1;
    this._synonymFetchAbort?.abort();
    this._synonymFetchAbort = null;
    if (this._synonymPollTimer) { clearInterval(this._synonymPollTimer); this._synonymPollTimer = null; }
    const jobId = this._synonymJobId;
    this._synonymJobId = null;
    if (jobId) fetch('/jobs/' + jobId, { method: 'DELETE' }).catch(() => {});
  },

  _isCurrentSynonymReq(seq) {
    return seq === this._synonymReqSeq && this.showSynonymPicker;
  },

  async requestSynonyms() {
    if (!this._synonymRange || !this._synonymWord) return;
    const app = window.__app;
    const wort = this._synonymWord;
    const { satz, sentenceStart } = synonymContext(this._synonymRange, wort, app?._getEditEl?.());
    this._synonymSentenceStart = sentenceStart;
    const bookId = app?.currentPage?.book_id || null;
    const pageId = app?.currentPage?.page_id || null;
    this._cancelSynonymRequest();
    const seq = this._synonymReqSeq;
    const abort = new AbortController();
    this._synonymFetchAbort = abort;
    const { signal } = abort;
    this.showSynonymMenu = false;
    this.synonymThesLoading = true;
    this.synonymThesError = '';
    this.synonymThesDisabled = false;
    this.synonymThesList = [];
    this.synonymKiLoading = true;
    this.synonymKiError = '';
    this.synonymKiList = [];
    this.showSynonymPicker = true;
    this._syncOpenFlag();
    this._attachSynonymScroll();
    this.$nextTick(() => this._positionSynonymUI());

    // OpenThesaurus: paralleler Sync-Call, keine Job-Queue
    const thesUrl = `/openthesaurus/synonyms?word=${encodeURIComponent(wort)}` + (bookId ? `&book_id=${bookId}` : '');
    fetchJson(thesUrl, { signal })
      .then(d => {
        if (!this._isCurrentSynonymReq(seq)) return;
        this.synonymThesDisabled = !!d.disabled;
        this.synonymThesList = Array.isArray(d.synonyme) ? d.synonyme : [];
      })
      .catch(e => {
        if (e?.name === 'AbortError' || !this._isCurrentSynonymReq(seq)) return;
        this.synonymThesError = tFetchError(e);
      })
      .finally(() => {
        if (!this._isCurrentSynonymReq(seq)) return;
        this.synonymThesLoading = false;
        this.$nextTick(() => this._positionSynonymUI());
      });

    // KI via Job-Queue
    try {
      const { jobId } = await fetchJson('/jobs/synonym', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wort, satz, book_id: bookId, page_id: pageId }),
        signal,
      });
      if (!jobId) throw new Error('no_job');
      // Picker inzwischen zu oder neue Anfrage: Job gleich wieder einsammeln.
      if (!this._isCurrentSynonymReq(seq)) {
        fetch('/jobs/' + jobId, { method: 'DELETE' }).catch(() => {});
        return;
      }
      this._synonymJobId = jobId;
      this._startSynonymPoll(jobId, seq);
    } catch (e) {
      if (e?.name === 'AbortError' || !this._isCurrentSynonymReq(seq)) return;
      this.synonymKiLoading = false;
      this.synonymKiError = e?.body ? tFetchError(e) : (app?.t('synonym.jobFailed') || '');
    }
  },

  _startSynonymPoll(jobId, seq) {
    const app = window.__app;
    startPoll(this, {
      timerProp: '_synonymPollTimer',
      jobId,
      lsKey: null,
      onProgress: () => { /* keine Progress-Anzeige, kurzer Call */ },
      onNotFound: () => {
        if (!this._isCurrentSynonymReq(seq)) return;
        this.synonymKiLoading = false;
        this.synonymKiError = app?.t('synonym.jobUnavailable') || '';
        this._synonymJobId = null;
      },
      onError: (job) => {
        if (!this._isCurrentSynonymReq(seq)) return;
        this.synonymKiLoading = false;
        this.synonymKiError = job.error ? app.t(job.error, job.errorParams) : app.t('synonym.kiFailed');
        this._synonymJobId = null;
      },
      onDone: (job) => {
        if (!this._isCurrentSynonymReq(seq)) return;
        this.synonymKiLoading = false;
        this._synonymJobId = null;
        this.synonymKiList = Array.isArray(job.result?.synonyme) ? job.result.synonyme : [];
        this.$nextTick(() => this._positionSynonymUI());
      },
    });
  },

  applySynonym(entry) {
    const range = this._synonymRange;
    const app = window.__app;
    if (!range || !entry?.wort) { this.closeSynonymPicker(); return; }
    const editEl = app?._getEditEl?.();
    if (!editEl || !editEl.contains(range.startContainer)) { this.closeSynonymPicker(); return; }
    const text = matchSynonymCase(this._synonymWord, entry.wort, this._synonymSentenceStart);
    try {
      // Range-Mutation + Caret-Restore + bubbelndes `input` über die geteilte
      // SSoT — derselbe Weg, den Spellcheck-Apply und der Mac-Synonym-Controller
      // nehmen. Caret landet am Ende des eingefügten Wortes (nicht hinter dem
      // Block; Begründung im Header von shared/apply-replacement.js).
      if (!applySpellcheckReplacement(range, text)) { this.closeSynonymPicker(); return; }
      app?._markEditDirty?.();
    } catch (e) {
      console.error('[applySynonym]', e);
    }
    this.closeSynonymPicker();
  },
};
