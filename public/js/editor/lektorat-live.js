// Lektorat-Befunde im Notebook-Edit-Modus: die Befundliste bleibt neben dem
// Editor stehen, die Fundstellen sind im Live-Text markiert, einzelne oder alle
// angehakten Befunde lassen sich direkt im Editor übernehmen, und ein neuer
// Lauf startet aus der Edit-Session heraus. In den Root gespreadet (app.js)
// neben lektoratMethods; `this` ist die Alpine-Root-Komponente.
//
// Markiert wird über die CSS-Custom-Highlight-API, nicht mit <mark>-Spans: die
// Highlights gehören zum Dokument, nicht zum DOM-Baum, und können darum nie in
// den gespeicherten Abschnitt geraten. Notebook-only — im Fokusmodus ist alles
// aus, der Focus-Editor wird nicht angefasst.
//
// Fundstellen werden nach jeder Tipp-Pause neu gesucht (MutationObserver am
// contenteditable, LIVE_RELOCATE_MS). Steht `original` nicht mehr im Text,
// trägt der Befund `umgeschrieben: true` (transient wie `userEdited`): grau,
// nicht mehr übernehmbar, aber nicht als angenommen gezählt — das entscheidet
// der nächste Lauf. Angenommen (`applied_errors_json`) wird nur, was über
// «Übernehmen» in den Text kam, und erst, wenn ein Save es auf den Server
// gebracht hat (`_flushLektoratLiveApplied` aus `_applySaveSuccess`, aus dem
// Save nach einem Abschnittswechsel und aus der Outbox). Eine Übernahme
// speichert sofort (input.js#_applyLektoratInEditor) — «Abbrechen» verwirft
// darum nur, was dieser Save noch nicht erreicht hat; zurückgenommen wird eine
// Übernahme mit Strg+Z. Das öffnet auch eine schon gebuchte wieder; ausgebucht
// wird sie nach derselben Regel erst mit dem Save, der den zurückgenommenen
// Stand trägt. Ob Strg+Z eine Übernahme zurückgenommen hat, entscheidet ihr
// Positions-Anker (lektorat/anchors.js), nicht eine Suche im ganzen Text;
// steht dort per Redo wieder die Korrektur, ist sie wieder übernommen.
//
// Ein Befund kennt seine Stelle nur über den Text (`original`); Markieren und
// Übernehmen treffen das erste Vorkommen. Steht die Stelle beim Schreiben
// gerade mehrfach da, trägt der Befund `mehrfach` (transient, nur Anzeige,
// gelesen über lektorat.js#findingAmbiguousNow):
// alle Vorkommen gestrichelt, Tag „mehrdeutig", «Übernehmen» überspringt ihn.
// Steht sie wieder einmal da, fällt das Flag — Tipp-Zwischenstände werden weder
// abgewählt noch am Lauf gespeichert. Das Server-Flag `mehrdeutig` aus dem Lauf
// (markAmbiguous) bleibt davon unberührt.

import { findInHtml } from '../utils.js';
import { findingKind } from '../book/page-view.js';
import { buildLocateIndex, locateInIndex, locateAllInIndex, locateAtOffset, offsetInIndex, pointAfterOffset } from './shared/text-locate.js';
import { anchorState, correctionDelta, shiftAnchors, shiftAnchorsByEdits } from './lektorat/anchors.js';
import { normalizeMatchText } from '../utils/text-match.js';
import { rangeOf } from './shared/text-find.js';
import { stripLektoratMarks } from './shared/html-clean.js';
import { isNoChange } from './shared/save-pipeline.js';
import { loadQuoteStyle } from './shared/quote-normalize/api.js';
import { patchBookedLists, mergeByOriginal, withoutOriginals, bookingEntry } from './lektorat-booking.js';
import { highlightRegistry, registerHighlight } from './shared/highlights.js';

const LIVE_RELOCATE_MS = 500;
// Ein Save, der beim Start eines Laufs schon unterwegs ist, wird abgewartet
// (höchstens so lange), statt den Lauf auf altem Text zu starten.
const SAVE_WAIT_MS = 5000;

const KINDS = ['hard', 'soft', 'editorial'];

// Modul-Zustand ausserhalb von Alpine: Ranges, Highlights und Beobachter sollen
// keine Effekte auslösen. Es gibt genau eine Root-Komponente.
let _hl = null;
let _ranges = [];
let _timer = null;
let _observer = null;
let _observedEl = null;
let _selAbort = null;
let _applyBusy = false;
// Im Editor übernommen, noch nicht gespeichert: [{ pageId, checkId, f, at }]
// (`at`: Positions-Anker der Korrektur im Index-Text, -1 = unbekannt).
// Trägt auch Übernahmen ohne Lauf-ID — Strg+Z muss sie wieder öffnen können;
// gebucht wird nur, was eine ID hat.
let _pending = [];
// Übernommen und gespeichert (gebucht, sofern mit Lauf-ID): Strg+Z öffnet auch
// diese wieder — Übernahmen speichern sofort, ohne diese Liste ginge Undo ins Leere.
let _booked = [];
// Per Strg+Z wieder geöffnet, aber noch gebucht: ausgebucht wird erst, wenn ein
// Save den zurückgenommenen Stand trägt (Spiegel zu `_pending`).
let _unbook = [];
// Per Strg+Z wieder geöffnet, nie gebucht (aus `_pending`): behält den Anker,
// damit Redo die Übernahme zurückholt (Spiegel zu `_unbook`).
let _undone = [];
// Index-Text, auf den die Anker zuletzt nachgeführt wurden (null = noch keiner
// für den beobachteten Editor — Anker gelten dann erst nach dem Abgleich).
let _anchorText = null;

function _highlights() {
  if (!highlightRegistry()) return null;
  if (!_hl) {
    _hl = {};
    for (const k of [...KINDS, 'ambiguous', 'active']) _hl[k] = registerHighlight('lektorat-live-' + k);
  }
  return _hl;
}

// Fundstellen-Markierungen des letzten Laufs: [{ kind, range }]. Registriert
// sind davon nur die im sichtbaren Band des Editors (± eine Bandhöhe): Chromium
// malt bei JEDER Textänderung alle registrierten Highlight-Ranges neu (Paint,
// PrePaint, Compositing) — 40 Markierungen kosteten auf einem 34K-Abschnitt
// ~9 ms je Taste (4× gedrosselt), fünf ~1,5 ms. Ausserhalb des Bands sieht man
// sie ohnehin nicht; beim Scrollen wird nachgeführt.
let _marks = [];
let _visRaf = 0;

function _paintVisibleMarks() {
  _visRaf = 0;
  if (!_hl) return;
  for (const k of [...KINDS, 'ambiguous']) _hl[k].clear();
  if (!_observedEl || !_marks.length) return;
  const box = _observedEl.getBoundingClientRect();
  const top = Math.max(box.top, 0);
  const bottom = Math.min(box.bottom, window.innerHeight);
  const band = Math.max(bottom - top, window.innerHeight / 2);
  const lo = top - band;
  const hi = bottom + band;
  for (const { kind, range } of _marks) {
    let r;
    try { r = range.getBoundingClientRect(); } catch { continue; }
    if (r.bottom >= lo && r.top <= hi) _hl[kind].add(range);
  }
}

function _scheduleVisibleMarks() {
  if (!_visRaf) _visRaf = requestAnimationFrame(_paintVisibleMarks);
}

function _clearHighlights() {
  if (_visRaf) cancelAnimationFrame(_visRaf);
  _visRaf = 0;
  if (_hl) for (const k in _hl) _hl[k].clear();
  _ranges = [];
  _marks = [];
}

function _stopLive() {
  clearTimeout(_timer);
  _timer = null;
  _observer?.disconnect();
  _observer = null;
  _observedEl = null;
  _selAbort?.abort();
  _selAbort = null;
  _anchorText = null;
  _clearHighlights();
}

// Übernahmen des offenen Abschnitts — nur deren Anker leben im beobachteten Text.
function _anchoredOn(pageId) {
  return [..._pending, ..._booked, ..._unbook, ..._undone].filter(p => String(p.pageId) === String(pageId));
}

// Per Strg+Z geöffnete Übernahme von `f`, an deren Anker wieder die Korrektur
// steht (Redo) — nur mit Anker: eine kurze Korrektur steht oft auch anderswo.
function _redoneEntry(index, f) {
  return [..._unbook, ..._undone].find(p => p.f === f && anchorState(index.text, p) === 'applied') || null;
}

// Anker auf den aktuellen Index-Text nachführen (Tippen seit dem letzten Stand).
function _trackAnchors(text, pageId) {
  shiftAnchors(_anchorText, text, _anchoredOn(pageId));
  _anchorText = text;
}

// Hat Strg+Z die Übernahme zurückgenommen? Mit Anker: steht dort wieder das
// Original. Ohne (Anker nicht bestimmbar): Korrektur nirgends, Original da.
function _isUndone(index, p) {
  const state = anchorState(index.text, p);
  if (state) return state === 'undone';
  return !locateInIndex(index, p.f.korrektur) && !!locateInIndex(index, p.f.original);
}

// Stelle einer Übernahme im Text: am Anker, sonst die erste Fundstelle der Korrektur.
function _appliedMatch(index, p) {
  if (anchorState(index.text, p) === 'applied') return locateAtOffset(index, p.at, normalizeMatchText(p.f.korrektur).length);
  return locateInIndex(index, p.f.korrektur);
}

// Befund-Index, dessen Stelle den Caret enthält, sonst -1.
function _caretFindingIdx() {
  const sel = document.getSelection();
  if (!sel?.rangeCount) return -1;
  const { startContainer: node, startOffset: offset } = sel.getRangeAt(0);
  if (!_observedEl?.contains(node)) return -1;
  return _ranges.findIndex(r => {
    try { return !!r && r.comparePoint(node, offset) === 0; } catch { return false; }
  });
}

// Caret in einer markierten Stelle → Befund in der Liste hervorheben; verlässt
// der Caret die Stelle, erlischt die Hervorhebung.
function _onSelectionChange() {
  const app = window.__app;
  if (!app?._lektoratLiveOn?.()) return;
  const sel = document.getSelection();
  if (!sel?.rangeCount || !_observedEl?.contains(sel.getRangeAt(0).startContainer)) return;
  const idx = _caretFindingIdx();
  if (idx === app.lektoratLiveActiveIdx) return;
  app.lektoratLiveActiveIdx = idx;
  app._paintLektoratLiveActive();
  if (idx === -1) return;
  document.querySelector(`.lektorat-split-findings [data-finding-idx="${idx}"]`)
    ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

export const lektoratLiveMethods = {
  // Befunde im Edit-Modus aktiv: Notebook-Edit (nicht Fokus) + Prüfmodus.
  _lektoratLiveOn() {
    return !!(this.editMode && this.checkDone && !this.focusActive && this.lektoratFindings?.length);
  },

  // Aus app-init.js: an- und abschalten, wenn Edit-Modus, Fokus, Prüfmodus
  // oder der Lauf wechseln. Neu suchen nach dem Tippen übernimmt der Observer.
  _setupLektoratLive() {
    this.$watch(
      () => `${!!this.editMode}|${!!this.checkDone}|${!!this.focusActive}|${this.lastCheckId}|${this.lektoratFindings?.length || 0}`,
      () => this.$nextTick(() => this._syncLektoratLive()),
    );
    // Die Vorschau der Leseansicht ruht im Edit-Modus (lektorat.js#_recomputeCorrectedHtml).
    this.$watch('editMode', (on) => { if (!on && this.checkDone) this._recomputeCorrectedHtml(); });
  },

  _syncLektoratLive() {
    if (!this._lektoratLiveOn()) {
      _stopLive();
      this.lektoratLiveActiveIdx = -1;
      return;
    }
    const el = this._getEditEl?.();
    if (!el) return;
    this._rebindLektoratLiveSession();
    if (_observedEl !== el) {
      _stopLive();
      _observedEl = el;
      _observer = new MutationObserver(() => this._scheduleLektoratLive());
      _observer.observe(el, { childList: true, subtree: true, characterData: true });
      _selAbort = new AbortController();
      document.addEventListener('selectionchange', _onSelectionChange, { signal: _selAbort.signal });
      // Sichtbares Band nachführen: Editor scrollt selbst, die Seite auch.
      el.addEventListener('scroll', _scheduleVisibleMarks, { passive: true, signal: _selAbort.signal });
      window.addEventListener('scroll', _scheduleVisibleMarks, { passive: true, capture: true, signal: _selAbort.signal });
      window.addEventListener('resize', _scheduleVisibleMarks, { passive: true, signal: _selAbort.signal });
    }
    this._relocateLektoratLive();
  },

  // Befundliste neu gesetzt (Lauf aus dem Verlauf geladen, ab- und wieder
  // angewählt): die Übernahmen dieser Session an die neuen Befund-Objekte
  // binden und „übernommen" nach ihnen richten — der Verlauf kennt nur den
  // gebuchten Stand, eine noch ungespeicherte Übernahme sähe sonst offen aus
  // und liesse sich ein zweites Mal anwenden („sagte er,,"). Gebuchte
  // Übernahmen anderer Abschnitte haben nichts mehr zu tun und fallen weg.
  _rebindLektoratLiveSession() {
    const pageId = this.currentPage?.id;
    const checkId = this.lastCheckId;
    const findings = this.lektoratFindings;
    const current = (p) => String(p.pageId) === String(pageId) && p.checkId === checkId;
    _booked = _booked.filter(p => String(p.pageId) === String(pageId));
    _undone = _undone.filter(p => String(p.pageId) === String(pageId));
    const rebind = (p) => {
      if (!current(p) || findings.includes(p.f)) return;
      const f = findings.find(x => x.original === p.f.original);
      if (f) p.f = f;
    };
    _pending.forEach(rebind);
    _booked.forEach(rebind);
    _unbook.forEach(rebind);
    _undone.forEach(rebind);
    const want = new Set([..._pending, ..._booked].filter(current).map(p => p.f.original));
    const undone = new Set(_unbook.filter(current).map(p => p.f.original));
    const next = this.appliedOriginals.filter(o => !undone.has(o));
    for (const o of want) if (!next.includes(o)) next.push(o);
    if (next.length !== this.appliedOriginals.length || next.some((o, i) => o !== this.appliedOriginals[i])) {
      this.appliedOriginals = next;
      findings.forEach((f, i) => { if (want.has(f.original) && this.selectedFindings[i]) this.selectedFindings[i] = false; });
    }
  },

  _scheduleLektoratLive() {
    clearTimeout(_timer);
    _timer = setTimeout(() => this._relocateLektoratLive(), LIVE_RELOCATE_MS);
  },

  // Alle Fundstellen im Live-Text neu suchen und markieren; `umgeschrieben`
  // nachführen. Eine im Editor übernommene Korrektur, die Strg+Z zurückgenommen
  // hat (Korrektur weg, Original wieder da), ist wieder offen — ungespeichert
  // wartet sie in `_undone`, schon gebucht in `_unbook` auf den Save. Steht an
  // ihrem Anker wieder die Korrektur (Redo), ist sie wieder übernommen.
  _relocateLektoratLive() {
    clearTimeout(_timer);
    _timer = null;
    _clearHighlights();
    if (!this._lektoratLiveOn() || !_observedEl) return;
    const hl = _highlights();
    const index = buildLocateIndex(_observedEl);
    _trackAnchors(index.text, this.currentPage?.id);
    const findings = this.lektoratFindings;
    let redonePending = false;
    for (let i = 0; i < findings.length; i++) {
      const f = findings[i];
      if (this.appliedOriginals.includes(f.original)) {
        const p = _pending.findIndex(x => x.f === f);
        const b = p === -1 ? _booked.findIndex(x => x.f === f) : -1;
        const entry = p !== -1 ? _pending[p] : _booked[b];
        if (!entry || !_isUndone(index, entry)) {
          // Übernommen: nicht markiert, aber per Klick/Caret auffindbar.
          const m = entry ? _appliedMatch(index, entry) : locateInIndex(index, f.korrektur);
          try { if (m) _ranges[i] = rangeOf(m); } catch { /* DOM hat sich bewegt — nächster Lauf */ }
          continue;
        }
        if (p !== -1) _undone.push(..._pending.splice(p, 1));
        else _unbook.push(..._booked.splice(b, 1));
        this.appliedOriginals = this.appliedOriginals.filter(o => o !== f.original);
      } else {
        const redo = _redoneEntry(index, f);
        if (redo) {
          if (_undone.includes(redo)) { _undone = _undone.filter(x => x !== redo); _pending.push(redo); redonePending = true; }
          else { _unbook = _unbook.filter(x => x !== redo); _booked.push(redo); }
          this.appliedOriginals = [...this.appliedOriginals, f.original];
          if (this.selectedFindings[i]) this.selectedFindings[i] = false;
          if (f.umgeschrieben) f.umgeschrieben = false;
          if (f.erledigt) f.erledigt = false;
          try { const m = _appliedMatch(index, redo); if (m) _ranges[i] = rangeOf(m); } catch { /* DOM hat sich bewegt — nächster Lauf */ }
          continue;
        }
      }
      const all = locateAllInIndex(index, f.original);
      this._setFindingPresence(i, all.length > 0);
      if (!all.length) continue;
      const multi = all.length > 1;
      if (!!f.mehrfach !== multi) f.mehrfach = multi;
      try {
        _ranges[i] = rangeOf(all[0]);
        if (!hl) continue;
        if (multi || f.mehrdeutig) for (const m of all) _marks.push({ kind: 'ambiguous', range: rangeOf(m) });
        else _marks.push({ kind: findingKind(f.typ), range: _ranges[i] });
      } catch { /* DOM hat sich bewegt — nächster Lauf */ }
    }
    _paintVisibleMarks();
    this._paintLektoratLiveActive();
    // Redo einer ungebuchten Übernahme, deren Korrektur ein Save schon auf den
    // Server gebracht hat: der Text gleicht dem gespeicherten, ein weiterer Save
    // käme nicht — gegen den gespeicherten Stand buchen.
    if (redonePending) this._flushLektoratLiveApplied(this.originalHtml || '');
  },

  _paintLektoratLiveActive() {
    const hl = _highlights();
    if (!hl) return;
    hl.active.clear();
    const r = _ranges[this.lektoratLiveActiveIdx];
    if (r) hl.active.add(r);
  },

  // Hover auf einen Befund (lektorat-findings-card.js#handleFindingPointer):
  // Stelle im Editor nur hervorheben — Scrollen beim Überfahren der Liste liesse
  // den Text springen, an dem geschrieben wird.
  lektoratLiveFocus(i) {
    if (!this._lektoratLiveOn()) return;
    this.lektoratLiveActiveIdx = i;
    this._paintLektoratLiveActive();
  },

  // Mauszeiger verlässt den Befund: Hervorhebung zurück auf den Befund unter
  // dem Caret (oder keinen) — sonst bliebe der zuletzt überfahrene stehen.
  lektoratLiveBlur(i) {
    if (!this._lektoratLiveOn() || this.lektoratLiveActiveIdx !== i) return;
    this.lektoratLiveActiveIdx = _caretFindingIdx();
    this._paintLektoratLiveActive();
  },

  // Klick auf den Befundtext: hervorheben und die Stelle in Sicht bringen —
  // bei einem übernommenen die eingesetzte Korrektur.
  lektoratLiveReveal(i) {
    if (!this._lektoratLiveOn()) return;
    this.lektoratLiveFocus(i);
    const r = _ranges[i];
    if (!r) return;
    const node = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    node?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  },

  // Befunde (Indizes in lektoratFindings) im Live-Editor übernehmen — ein
  // Undo-Schritt für alle. Nur Auswählbares (findingSelectable): Übernommenes,
  // Umgeschriebenes und Vorschlagloses bleiben aussen vor.
  async applyLektoratLive(indices) {
    if (!this._lektoratLiveOn() || this.saveApplying != null || _applyBusy) return;
    const list = indices.map(i => this.lektoratFindings[i]).filter(f => f && this.findingSelectable(f));
    if (!list.length) return;
    _applyBusy = true;
    try {
      const pageId = this.currentPage?.id;
      const checkId = this.lastCheckId;
      const quoteStyle = await loadQuoteStyle(this.$store.nav.selectedBookId);
      if (!this._lektoratLiveOn() || this.currentPage?.id !== pageId || this.lastCheckId !== checkId) return;
      // Vorher offen und auffindbar: verschwindet so eine Stelle durch DIESE
      // Übernahme, ist sie „durch andere Korrektur erledigt", nicht umgeschrieben.
      const openBefore = this.lektoratFindings.filter((f, i) => _ranges[i] && !this.appliedOriginals.includes(f.original));
      // Stellen vor dem Mount: Anker der neuen Übernahmen und Caret danach.
      const before = buildLocateIndex(_observedEl);
      _trackAnchors(before.text, pageId);
      const origAt = new Map(list.map(f => [f, offsetInIndex(before, f.original)]));
      const { applied, skipped, reason } = this._applyLektoratInEditor(list, { quoteStyle });
      if (reason) return;
      // Ersetzt wurden die Stellen in Textreihenfolge: jede verschiebt die
      // dahinter um ihre Längenänderung — bestehende Anker wie neue.
      const edits = applied.filter(f => origAt.get(f) >= 0)
        .map(f => ({ f, at: origAt.get(f), len: normalizeMatchText(f.original).length, delta: correctionDelta(f) }))
        .sort((a, b) => a.at - b.at);
      shiftAnchorsByEdits(edits, _anchoredOn(pageId));
      const after = buildLocateIndex(_observedEl);
      _anchorText = after.text;
      let shift = 0;
      const newAt = new Map();
      for (const ed of edits) { newAt.set(ed.f, ed.at + shift); shift += ed.delta; }
      for (const f of applied) {
        if (!this.appliedOriginals.includes(f.original)) this.appliedOriginals.push(f.original);
        const i = this.lektoratFindings.indexOf(f);
        if (i >= 0) this.selectedFindings[i] = false;
        _unbook = _unbook.filter(x => x.f !== f);
        _undone = _undone.filter(x => x.f !== f);
        const entry = { pageId, checkId, f, at: newAt.has(f) ? newAt.get(f) : -1 };
        // Steht dort nicht die Korrektur (Ersatz anders normalisiert): ohne Anker.
        if (anchorState(after.text, entry) !== 'applied') entry.at = -1;
        _pending.push(entry);
      }
      const caretAt = applied.length === 1 && newAt.has(applied[0]) ? newAt.get(applied[0]) : -1;
      const params = { n: applied.length, details: skipped.length ? this._skipSummary(skipped) : '' };
      this.setStatus(this.tn(skipped.length ? 'lektorat.liveAppliedWithSkips' : 'lektorat.liveApplied', applied.length, params), false, 6000);
      this._relocateLektoratLive();
      for (const f of openBefore) {
        if (f.umgeschrieben && !applied.includes(f)) f.erledigt = true;
      }
      if (applied.length === 1 && caretAt >= 0) this._placeCaretAfterCorrection(caretAt, applied[0].korrektur);
    } finally {
      _applyBusy = false;
    }
  },

  // Caret hinter die eben eingesetzte Korrektur — nur wenn an der gemerkten
  // Stelle wirklich die Korrektur steht (Quote-Normalisierung ist längentreu).
  _placeCaretAfterCorrection(offset, korrektur) {
    const el = _observedEl;
    const want = normalizeMatchText(korrektur);
    if (!el || !want) return;
    const index = buildLocateIndex(el);
    if (index.text.slice(offset, offset + want.length) !== want) return;
    const p = pointAfterOffset(index, offset + want.length);
    if (!p) return;
    el.focus({ preventScroll: true });
    document.getSelection()?.setBaseAndExtent(p.node, p.offset, p.node, p.offset);
  },

  // Nach jedem erfolgreichen Save eines Abschnitts: Übernahmen, deren Korrektur
  // jetzt gespeichert ist, am Lauf als angenommen buchen. Was der Save noch nicht
  // enthält (Save lief schon vor der Übernahme), wartet auf den nächsten.
  // Aufrufer: lifecycle.js#_applySaveSuccess (offene Seite), save-guard.js#
  // _releaseDraftAfterSave (Save, der erst nach dem Abschnittswechsel ankam) und
  // app-outbox.js (Entwurf eines verlassenen Abschnitts nachgereicht) — darum
  // `pageId` explizit statt der gerade offenen Seite.
  async _flushLektoratLiveApplied(savedHtml, pageId = this.currentPage?.id) {
    if ((!_pending.length && !_unbook.length) || pageId == null) return;
    const onPage = (p) => String(p.pageId) === String(pageId);
    const book = new Map();
    _pending = _pending.filter(p => {
      if (!onPage(p) || !findInHtml(savedHtml, p.f.korrektur)) return true;
      if (!p.checkId) { _booked.push(p); return false; }
      if (!book.has(p.checkId)) book.set(p.checkId, []);
      book.get(p.checkId).push(p);
      return false;
    });
    const unbook = new Map();
    _unbook = _unbook.filter(p => {
      if (!onPage(p) || findInHtml(savedHtml, p.f.korrektur) || !findInHtml(savedHtml, p.f.original)) return true;
      if (!p.checkId) return false;
      if (!unbook.has(p.checkId)) unbook.set(p.checkId, []);
      unbook.get(p.checkId).push(p);
      return false;
    });
    // Verlaufsliste gehört zur offenen Seite — nur dort lokal nachführen.
    const entryOf = (checkId) => String(this.currentPage?.id) === String(pageId) ? (this.pageHistory?.find(e => e.id === checkId) || null) : null;
    for (const [checkId, ps] of book) {
      const items = ps.map(p => bookingEntry(p.f));
      // Schon während der Buchung als gebucht führen: Strg+Z und eine neu
      // gesetzte Befundliste (_rebindLektoratLiveSession) sehen sie sonst nicht.
      _booked.push(...ps);
      try {
        await patchBookedLists(checkId, prev => ({ applied: mergeByOriginal(prev.applied, items), selected: mergeByOriginal(prev.selected, items) }), { entry: entryOf(checkId) });
        this.refreshPageAges?.();
      } catch (e) {
        console.error('[lektorat-live history]', e);
        // Noch nicht gebucht: zurück nach `_pending` (ein inzwischen per Strg+Z
        // Zurückgenommenes hat in `_unbook` nichts mehr auszubuchen).
        _booked = _booked.filter(p => !ps.includes(p));
        _unbook = _unbook.filter(p => !ps.includes(p));
        _pending.push(...ps.filter(p => this.appliedOriginals.includes(p.f.original)));
        this.setStatus(this.t('lektorat.historySaveFailed'), false, 8000);
      }
    }
    for (const [checkId, ps] of unbook) {
      const originals = new Set(ps.map(p => p.f.original));
      try {
        await patchBookedLists(checkId, prev => ({ applied: withoutOriginals(prev.applied, originals), selected: withoutOriginals(prev.selected, originals) }), { entry: entryOf(checkId) });
        this.refreshPageAges?.();
      } catch (e) {
        console.error('[lektorat-live history]', e);
        _unbook.push(...ps);
        this.setStatus(this.t('lektorat.historySaveFailed'), false, 8000);
      }
    }
  },

  // «Abbrechen» der Edit-Session (lifecycle.js#cancelEdit): ungespeicherte
  // Übernahmen sind mit dem Text verworfen — Markierung „übernommen" zurück.
  _discardLektoratLivePending() {
    const pageId = this.currentPage?.id;
    const dropped = new Set(_pending.filter(p => p.pageId === pageId).map(p => p.f.original));
    _pending = _pending.filter(p => p.pageId !== pageId);
    // Nie gespeichert: der gespeicherte Stand kennt sie nicht, Redo ist mit dem Text weg.
    _undone = _undone.filter(p => p.pageId !== pageId);
    if (dropped.size) this.appliedOriginals = this.appliedOriginals.filter(o => !dropped.has(o));
    // Ungespeichertes Strg+Z einer gebuchten Übernahme: der gespeicherte Stand
    // trägt die Korrektur — wieder „übernommen".
    const restored = _unbook.filter(p => p.pageId === pageId);
    _unbook = _unbook.filter(p => p.pageId !== pageId);
    _booked.push(...restored);
    for (const p of restored) if (!this.appliedOriginals.includes(p.f.original)) this.appliedOriginals.push(p.f.original);
  },

  // Lauf aus der Edit-Session: erst speichern — der Job liest den gespeicherten
  // Stand. Scheitert der Save, bleibt `editDirty`/`saveOffline` stehen und der
  // Guard in runCheck meldet es. `false` nur im Fokusmodus (dort kein Lauf).
  async _saveBeforeLiveCheck() {
    if (!this.editMode) return true;
    if (this.focusActive) return false;
    for (let waited = 0; this.editSaving && waited < SAVE_WAIT_MS; waited += 100) {
      await new Promise(res => setTimeout(res, 100));
    }
    if (this.editDirty || this.saveOffline) await this.quickSave?.();
    return true;
  },

  // Job-Ende während einer Edit-Session: die Befunde gelten gegen den LIVE-Text
  // (dort wird übernommen), nicht gegen den gespeicherten Stand — und
  // `originalHtml` bleibt die Save-Basis der Session, der Server-Refetch des
  // Leseansicht-Pfads fasst sie nicht an. null = nicht im Notebook-Edit-Modus.
  _lektoratLiveBase(jobHtml) {
    if (!this.editMode || this.focusActive) return null;
    const el = this._getEditEl?.();
    if (!el) return null;
    const html = stripLektoratMarks(el.innerHTML);
    return { html, changed: !isNoChange(html, jobHtml || '') };
  },
};
