// Spellcheck-Dispatcher — eine Instanz pro App. Beobachtet Editor-State auf
// dem Root (`editMode`, `focusActive`, `showBookEditorCard`) und attached
// einen Controller auf das jeweils aktive contenteditable-Element. Hält
// genau einen aktiven Controller (oder keinen).
//
// Wechselt der aktive Editor (z.B. Notebook -> Focus, oder Block-Switch im
// Bucheditor), detached der Dispatcher den alten und attached einen neuen.
//
// Sprache: bestimmt der Server (Buch-Locale ueber `bookId`, sonst Profil-
// Default). Das Frontend schickt 'auto' — die Buchliste traegt keine Locale.

import { createSpellcheckController } from './controller.js';
import { createFormFieldSpellcheck } from './form-controller.js';
import { applySpellcheckReplacement } from '../../editor/shared/apply-replacement.js';
import { EVT } from '../../events.js';

const NOTEBOOK_SEL = '.page-content-view--editing';
const FOCUS_SEL = '.focus-editor__content';
const BOOK_SEL = '.book-editor-page-body[contenteditable="true"]';
const FORM_FIELD_SEL = 'input[data-spellcheck="spelling"], textarea[data-spellcheck="spelling"]';
// Focus-Editor: `.focus-editor__content` ist gleichzeitig contenteditable-root
// UND Scroll-Container (overflow-y:auto, siehe focus-mode.css). Scroll-Events
// bubblen nicht — Listener muss am scrollenden Element selbst sitzen, sonst
// feuert `_reposition` beim internen Scroll nicht und Squiggles kleben fest.
const FOCUS_SCROLL_SEL = '.focus-editor__content';
const BOOK_CARD_SEL = '.card--bookeditor';

export function setupSpellcheckDispatch(app) {
  if (!app || typeof app.$watch !== 'function') return;

  let current = null;        // { kind, root, ctl }
  let bookBlockObserver = null;  // MutationObserver fuer Bucheditor (Block-Wechsel) — lebt unabhaengig vom Controller

  function _locale() { return 'auto'; }
  function _bookId() {
    const id = Alpine.store('nav').selectedBookId;
    return id ? Number(id) : null;
  }
  function _pageId() {
    const pid = app.currentPage?.page_id ?? app.currentPage?.id ?? null;
    return pid ? Number(pid) : null;
  }
  function _isEnabled() { return !!app.$store.config.languagetoolEnabled; }
  function _debounceMs() {
    const v = Number(app.$store.config.languagetoolDebounceMs);
    return Number.isFinite(v) && v > 0 ? v : 1500;
  }

  function _detach() {
    if (current?.ctl) {
      try { current.ctl.detach(); } catch {}
    }
    current = null;
  }

  function _setupBookObserver() {
    if (bookBlockObserver) return;
    const card = document.querySelector(BOOK_CARD_SEL);
    if (!card) return;
    bookBlockObserver = new MutationObserver(() => {
      if (!_isEnabled() || !app.showBookEditorCard) return;
      const active = document.querySelector(BOOK_SEL);
      if (active && active !== current?.root) {
        _attachKind('book');
      } else if (!active && current?.kind === 'book') {
        _detach();
      }
    });
    bookBlockObserver.observe(card, { attributes: true, subtree: true, attributeFilter: ['contenteditable'] });
  }

  function _teardownBookObserver() {
    if (bookBlockObserver) { bookBlockObserver.disconnect(); bookBlockObserver = null; }
  }

  function _attachKind(kind) {
    _detach();
    if (!_isEnabled()) return;
    let root = null;
    let scrollContainer = null;
    if (kind === 'focus') {
      root = document.querySelector(FOCUS_SEL);
      scrollContainer = document.querySelector(FOCUS_SCROLL_SEL);
    } else if (kind === 'notebook') {
      root = document.querySelector(NOTEBOOK_SEL);
      // `.page-content-view--editing` ist selbst der Scroll-Container
      // (overflow-y:auto + max-height:70vh). `_findScrollParent` startet bei
      // parentElement und wuerde Root ueberspringen — explizit setzen, damit
      // Wheel-Forwarding (controller.js) die Squiggles-bubbled-Wheel-Events
      // an den richtigen Scroller weiterleitet.
      scrollContainer = root;
    } else if (kind === 'book') {
      root = document.querySelector(BOOK_SEL);
      // Bucheditor scrollt am Window — controller#_findScrollParent loest auf.
      scrollContainer = null;
    }
    if (!root) return;
    const ctl = createSpellcheckController({
      root,
      scrollContainer,
      getHtml: () => root.innerHTML,
      onApplyReplacement: (range, text) => applySpellcheckReplacement(range, text),
      editorKind: kind,
      getBookLocale: _locale,
      getBookId: _bookId,
      // Bucheditor: die Seite des aktiven Blocks, nicht `currentPage` (die
      // Baum-Auswahl, die der Bucheditor nicht nachfuehrt).
      getPageId: kind === 'book'
        ? () => (Number(root.dataset.bookEditorPage) > 0 ? Number(root.dataset.bookEditorPage) : null)
        : _pageId,
      isEnabled: _isEnabled,
      getDebounceMs: _debounceMs,
      i18n: (k) => (typeof app.t === 'function' ? app.t(k) : k),
    });
    ctl.attach();
    current = { kind, root, ctl };
  }

  function _evaluate() {
    if (!_isEnabled()) { _detach(); _teardownBookObserver(); return; }
    // Prioritaet: Focus > Notebook > Bucheditor (kann nicht ko-existieren).
    if (app.focusActive) {
      _teardownBookObserver();
      _afterPaint(() => _attachKind('focus'));
    } else if (app.editMode) {
      _teardownBookObserver();
      _afterPaint(() => _attachKind('notebook'));
    } else if (app.showBookEditorCard) {
      // Block-Observer lebt so lange Bucheditor offen ist — unabhaengig
      // davon, ob gerade ein Block aktiv (contenteditable="true") ist.
      _afterPaint(() => {
        _setupBookObserver();
        _attachKind('book');
      });
    } else {
      _teardownBookObserver();
      _detach();
    }
  }

  function _afterPaint(fn) {
    // Alpine rendert :spellcheck/contenteditable Toggles im naechsten Tick;
    // ein Frame Verzoegerung garantiert, dass das Root im DOM ist.
    requestAnimationFrame(() => requestAnimationFrame(fn));
  }

  // Explizites Recheck-Signal (z.B. nach Quote-Normalisierung): aktiven
  // Controller debounced neu prüfen lassen, auch wenn der Text identisch ist.
  window.addEventListener(EVT.LANGUAGETOOL_RECHECK, () => {
    try { current?.ctl?.refresh?.(); } catch {}
  });

  app.$watch(() => app.$store.config.languagetoolEnabled, () => { _evaluate(); _evalForms(); });
  app.$watch('editMode',            _evaluate);
  app.$watch('focusActive',         _evaluate);
  app.$watch('showBookEditorCard',  _evaluate);
  // Buchwechsel im Bucheditor: gleiche Karte, anderes Buch -> Re-Attach mit
  // anderem Locale-Context.
  app.$watch(() => Alpine.store('nav').selectedBookId,      () => {
    if (current) _evaluate();
    _refreshAllForms();
  });
  // Seitenwechsel: persistente Form-Felder (z.B. Seitentitel auf der Pageview)
  // werden via :value rebindet — kein input-Event, also kein Auto-Recheck. Ein
  // Frame Verzoegerung, damit der :value-Bind angewandt ist, bevor refresh()
  // den neuen Wert liest.
  app.$watch('currentPage?.id',     () => { requestAnimationFrame(_refreshAllForms); });

  // Initial-Eval (falls bereits ein Editor offen ist beim Boot).
  _evaluate();

  // ─── Form-Felder (input/textarea mit data-spellcheck="spelling") ────────
  // Eine Controller-Instanz pro Feld. focusin-getrieben (Lazy-Mount), Cleanup
  // ueber MutationObserver auf DOM-Entfernung. Lebt parallel zu den drei
  // grossen Editoren — kein Single-Active-Constraint.
  const formCtls = new WeakMap();      // el -> ctl
  const formCtlSet = new Set();        // alle aktiven Controller (fuer Bulk-Detach)
  let formObserver = null;

  function _ensureFormCtl(el) {
    if (!el || formCtls.has(el)) return formCtls.get(el);
    const ctl = createFormFieldSpellcheck({
      el,
      getBookLocale: _locale,
      getBookId: _bookId,
      isEnabled: _isEnabled,
      i18n: (k) => (typeof app.t === 'function' ? app.t(k) : k),
    });
    formCtls.set(el, ctl);
    formCtlSet.add(ctl);
    ctl.attach();
    return ctl;
  }

  function _detachFormCtl(el) {
    const ctl = formCtls.get(el);
    if (!ctl) return;
    try { ctl.detach(); } catch {}
    formCtls.delete(el);
    formCtlSet.delete(ctl);
  }

  // Auch die WeakMap-Eintraege fallen weg: sonst faende `_ensureFormCtl` nach
  // dem Wiedereinschalten den abgehaengten Controller und haengte ihn nie neu an.
  function _detachAllForms() {
    for (const ctl of Array.from(formCtlSet)) {
      try { ctl.detach(); } catch {}
      formCtlSet.delete(ctl);
      const el = ctl.getElement?.();
      if (el) formCtls.delete(el);
    }
  }

  function _refreshAllForms() {
    for (const ctl of formCtlSet) {
      try { ctl.refresh(); } catch {}
    }
  }

  function _onFocusIn(ev) {
    if (!_isEnabled()) return;
    const t = ev.target;
    if (!t || !t.matches || !t.matches(FORM_FIELD_SEL)) return;
    _ensureFormCtl(t);
  }

  // Native Browser-Spellcheck auf LT-verwalteten Form-Feldern unterdruecken,
  // solange LT aktiv ist — sonst konkurrieren zwei Squiggle-Systeme (v.a.
  // Mobile mit installiertem Woerterbuch unterstreicht jedes Feld nativ, nicht
  // klickbar als LT-Popover). LT-Indikator ist das Badge. Analog zu den drei
  // Editoren (`:spellcheck="!$store.config.languagetoolEnabled"`). LT aus -> native als
  // Fallback wieder an.
  function _setNative(el, on) {
    try { el.spellcheck = on; } catch {}
    el.setAttribute('spellcheck', on ? 'true' : 'false');
  }
  function _sweepNative() {
    const on = !_isEnabled();
    document.querySelectorAll(FORM_FIELD_SEL).forEach((el) => _setNative(el, on));
  }

  function _setupFormObserver() {
    if (formObserver) return;
    formObserver = new MutationObserver((muts) => {
      // Reparent (z.B. unser eigenes lt-field-wrap wickelt das Input ein) loest
      // ein removedNode-Event aus, obwohl der Knoten weiterhin im DOM haengt.
      // Nur echte Removals (isConnected === false) triggern detach.
      const detachIfGone = (node) => {
        if (node.nodeType !== 1) return;
        if (node.isConnected) return;
        if (node.matches?.(FORM_FIELD_SEL)) _detachFormCtl(node);
        const inner = node.querySelectorAll?.(FORM_FIELD_SEL);
        if (inner && inner.length) inner.forEach((el) => { if (!el.isConnected) _detachFormCtl(el); });
      };
      // Neu eingehaengte Felder (Tab-Wechsel, x-if-Templates) sofort nativ
      // entschaerfen — sie werden u.U. nie fokussiert, leuchten auf Mobile aber
      // trotzdem nativ.
      const suppressIfNew = (node) => {
        if (node.nodeType !== 1) return;
        if (node.matches?.(FORM_FIELD_SEL)) _setNative(node, false);
        node.querySelectorAll?.(FORM_FIELD_SEL).forEach((el) => _setNative(el, false));
      };
      for (const m of muts) {
        if (m.type !== 'childList') continue;
        for (const node of m.removedNodes) detachIfGone(node);
        for (const node of m.addedNodes) suppressIfNew(node);
      }
    });
    formObserver.observe(document.body, { childList: true, subtree: true });
  }

  function _teardownFormObserver() {
    if (formObserver) { formObserver.disconnect(); formObserver = null; }
  }

  function _evalForms() {
    if (_isEnabled()) {
      _setupFormObserver();
      document.addEventListener('focusin', _onFocusIn, true);
      _sweepNative();
      // Schon-fokussiertes Feld einmalig nachziehen.
      const active = document.activeElement;
      if (active && active.matches?.(FORM_FIELD_SEL)) _ensureFormCtl(active);
    } else {
      document.removeEventListener('focusin', _onFocusIn, true);
      _detachAllForms();
      _teardownFormObserver();
      _sweepNative();
    }
  }

  _evalForms();

  // Cleanup-Hook (App-Destroy ist rare; best-effort).
  window.addEventListener('beforeunload', () => {
    _detach();
    _teardownBookObserver();
    _detachAllForms();
    _teardownFormObserver();
  });
}
