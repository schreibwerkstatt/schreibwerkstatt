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
// Save nach einem Abschnittswechsel und aus der Outbox); «Abbrechen» verwirft
// die noch nicht gespeicherten Übernahmen samt Markierung.
//
// Ein Befund kennt seine Stelle nur über den Text (`original`); Markieren und
// Übernehmen treffen das erste Vorkommen. Kommt die Stelle beim Schreiben
// mehrfach vor, wird der Befund `mehrdeutig` (dasselbe Flag, das der Server
// beim Lauf setzt): abgewählt, alle Vorkommen gestrichelt markiert, «Übernehmen»
// verweigert, solange er mehrfach dasteht. Das Flag bleibt — auch wenn danach
// nur noch ein Vorkommen steht, kann es das falsche sein — und wird am Lauf
// gespeichert (PATCH /history/check/:id/ambiguous).

import { findInHtml } from '../utils.js';
import { findingKind } from '../book/page-view.js';
import { buildLocateIndex, locateInIndex, locateAllInIndex, offsetInIndex, pointAfterOffset } from './shared/text-locate.js';
import { normalizeMatchText } from '../utils/text-match.js';
import { rangeOf } from './shared/text-find.js';
import { stripLektoratMarks } from './shared/html-clean.js';
import { isNoChange } from './shared/save-pipeline.js';
import { loadQuoteStyle } from './shared/quote-normalize/api.js';

const LIVE_RELOCATE_MS = 500;
// Ein Save, der beim Start eines Laufs schon unterwegs ist, wird abgewartet
// (höchstens so lange), statt den Lauf auf altem Text zu starten.
const SAVE_WAIT_MS = 5000;
// Neu mehrdeutige Befunde gesammelt am Lauf speichern.
const AMBIGUOUS_FLUSH_MS = 1000;

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
// Im Editor übernommen, noch nicht gespeichert: [{ pageId, checkId, f }].
// Trägt auch Übernahmen ohne Lauf-ID — Strg+Z muss sie wieder öffnen können;
// gebucht wird nur, was eine ID hat.
let _pending = [];
// Je Lauf schon gebuchte Listen (PATCH ersetzt die ganze Liste, nicht additiv).
const _recorded = new Map();
// Neu mehrdeutig gewordene Befunde, noch nicht am Lauf gespeichert: checkId → Set(original).
const _ambQueue = new Map();
let _ambTimer = null;

function _highlights() {
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return null;
  if (!_hl) {
    _hl = {};
    for (const k of [...KINDS, 'ambiguous', 'active']) {
      _hl[k] = new Highlight();
      CSS.highlights.set('lektorat-live-' + k, _hl[k]);
    }
  }
  return _hl;
}

function _clearHighlights() {
  if (_hl) for (const k in _hl) _hl[k].clear();
  _ranges = [];
}

function _stopLive() {
  clearTimeout(_timer);
  _timer = null;
  _observer?.disconnect();
  _observer = null;
  _observedEl = null;
  _selAbort?.abort();
  _selAbort = null;
  _clearHighlights();
}

// Persistierte Form eines Befunds: ohne die transienten Laufzeit-Flags.
function _entryOf(f) {
  const { umgeschrieben, erledigt, ...rest } = f;
  return rest;
}

// Gebuchte Listen eines Laufs: vom geladenen Verlaufseintrag, sonst vom Server.
async function _bookedLists(checkId, entry) {
  if (entry && entry.errors_json !== undefined) {
    return { applied: entry.applied_errors_json || [], selected: entry.selected_errors_json || [] };
  }
  const r = await fetch('/history/check/' + checkId + '/details');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return { applied: d.applied_errors_json || [], selected: d.selected_errors_json || [] };
}

function _mergeByOriginal(existing, items) {
  const seen = new Set((existing || []).map(e => e.original));
  return [...(existing || []), ...items.filter(e => !seen.has(e.original))];
}

// Caret in einer markierten Stelle → Befund in der Liste hervorheben.
function _onSelectionChange() {
  const app = window.__app;
  if (!app?._lektoratLiveOn?.()) return;
  const sel = document.getSelection();
  if (!sel?.rangeCount) return;
  const { startContainer: node, startOffset: offset } = sel.getRangeAt(0);
  if (!_observedEl?.contains(node)) return;
  const idx = _ranges.findIndex(r => {
    try { return !!r && r.comparePoint(node, offset) === 0; } catch { return false; }
  });
  if (idx === -1 || idx === app.lektoratLiveActiveIdx) return;
  app.lektoratLiveActiveIdx = idx;
  app._paintLektoratLiveActive();
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
  },

  _syncLektoratLive() {
    if (!this._lektoratLiveOn()) {
      _stopLive();
      this.lektoratLiveActiveIdx = -1;
      return;
    }
    const el = this._getEditEl?.();
    if (!el) return;
    if (_observedEl !== el) {
      _stopLive();
      _observedEl = el;
      _observer = new MutationObserver(() => this._scheduleLektoratLive());
      _observer.observe(el, { childList: true, subtree: true, characterData: true });
      _selAbort = new AbortController();
      document.addEventListener('selectionchange', _onSelectionChange, { signal: _selAbort.signal });
    }
    this._relocateLektoratLive();
  },

  _scheduleLektoratLive() {
    clearTimeout(_timer);
    _timer = setTimeout(() => this._relocateLektoratLive(), LIVE_RELOCATE_MS);
  },

  // Alle Fundstellen im Live-Text neu suchen und markieren; `umgeschrieben`
  // nachführen. Eine im Editor übernommene, noch ungespeicherte Korrektur, die
  // Strg+Z zurückgenommen hat (Korrektur weg, Original wieder da), ist wieder offen.
  _relocateLektoratLive() {
    clearTimeout(_timer);
    _timer = null;
    _clearHighlights();
    if (!this._lektoratLiveOn() || !_observedEl) return;
    const hl = _highlights();
    const index = buildLocateIndex(_observedEl);
    const findings = this.lektoratFindings;
    for (let i = 0; i < findings.length; i++) {
      const f = findings[i];
      if (this.appliedOriginals.includes(f.original)) {
        const p = _pending.findIndex(x => x.f === f);
        const undone = p !== -1 && !locateInIndex(index, f.korrektur) && locateInIndex(index, f.original);
        if (!undone) continue;
        _pending.splice(p, 1);
        this.appliedOriginals = this.appliedOriginals.filter(o => o !== f.original);
      }
      const all = locateAllInIndex(index, f.original);
      if (!!f.umgeschrieben !== !all.length) f.umgeschrieben = !all.length;
      if (!all.length) {
        if (this.selectedFindings[i]) this.selectedFindings[i] = false;
        continue;
      }
      // Stelle steht wieder da (z.B. Strg+Z): nicht mehr „durch andere Korrektur erledigt".
      if (f.erledigt) f.erledigt = false;
      if (all.length > 1 && !f.mehrdeutig) {
        f.mehrdeutig = true;
        if (this.selectedFindings[i]) this.selectedFindings[i] = false;
        this._queueLektoratAmbiguous(f.original);
      }
      try {
        _ranges[i] = rangeOf(all[0]);
        if (f.mehrdeutig) for (const m of all) hl?.ambiguous.add(rangeOf(m));
        else hl?.[findingKind(f.typ)].add(_ranges[i]);
      } catch { /* DOM hat sich bewegt — nächster Lauf */ }
    }
    this._paintLektoratLiveActive();
  },

  // Neu mehrdeutig gewordenen Befund zum Speichern am Lauf vormerken (ohne Lauf-ID
  // gilt das Flag nur für die Session).
  _queueLektoratAmbiguous(original) {
    const checkId = this.lastCheckId;
    if (!checkId || !original) return;
    if (!_ambQueue.has(checkId)) _ambQueue.set(checkId, new Set());
    _ambQueue.get(checkId).add(original);
    clearTimeout(_ambTimer);
    _ambTimer = setTimeout(() => this._flushLektoratAmbiguous(), AMBIGUOUS_FLUSH_MS);
  },

  async _flushLektoratAmbiguous() {
    _ambTimer = null;
    const batches = [..._ambQueue.entries()];
    _ambQueue.clear();
    for (const [checkId, set] of batches) {
      const originals = [...set];
      try {
        const r = await fetch('/history/check/' + checkId + '/ambiguous', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ originals }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        // Geladener Verlaufseintrag: dasselbe Flag, sonst käme es beim erneuten Öffnen nicht mit.
        const entry = this.pageHistory?.find(e => e.id === checkId);
        if (Array.isArray(entry?.errors_json)) {
          for (const e of entry.errors_json) if (set.has(e.original)) e.mehrdeutig = true;
        }
      } catch (e) {
        console.error('[lektorat-live ambiguous]', e);
      }
    }
  },

  _paintLektoratLiveActive() {
    const hl = _highlights();
    if (!hl) return;
    hl.active.clear();
    const r = _ranges[this.lektoratLiveActiveIdx];
    if (r) hl.active.add(r);
  },

  // Hover auf einen Befund (lektorat-findings-card.js#handleFindingPointer):
  // Stelle im Editor hervorheben und in Sicht bringen.
  lektoratLiveFocus(i) {
    if (!this._lektoratLiveOn()) return;
    this.lektoratLiveActiveIdx = i;
    this._paintLektoratLiveActive();
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
      // Einzel-Übernahme: Caret danach hinter die Korrektur (Offset vor dem Mount).
      const caretAt = list.length === 1 ? offsetInIndex(buildLocateIndex(_observedEl), list[0].original) : -1;
      const { applied, skipped, reason } = this._applyLektoratInEditor(list, { quoteStyle });
      if (reason) return;
      for (const f of applied) {
        if (!this.appliedOriginals.includes(f.original)) this.appliedOriginals.push(f.original);
        const i = this.lektoratFindings.indexOf(f);
        if (i >= 0) this.selectedFindings[i] = false;
        _pending.push({ pageId, checkId, f });
      }
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

  applyLektoratLiveSelected() {
    return this.applyLektoratLive(this.selectedFindings.flatMap((v, i) => (v ? [i] : [])));
  },

  lektoratLiveSelectedCount() {
    return this.selectedFindings.filter(Boolean).length;
  },

  // Nach jedem erfolgreichen Save eines Abschnitts: Übernahmen, deren Korrektur
  // jetzt gespeichert ist, am Lauf als angenommen buchen. Was der Save noch nicht
  // enthält (Save lief schon vor der Übernahme), wartet auf den nächsten.
  // Aufrufer: lifecycle.js#_applySaveSuccess (offene Seite), save-guard.js#
  // _releaseDraftAfterSave (Save, der erst nach dem Abschnittswechsel ankam) und
  // app-outbox.js (Entwurf eines verlassenen Abschnitts nachgereicht) — darum
  // `pageId` explizit statt der gerade offenen Seite.
  async _flushLektoratLiveApplied(savedHtml, pageId = this.currentPage?.id) {
    if (!_pending.length || pageId == null) return;
    const byCheck = new Map();
    _pending = _pending.filter(p => {
      if (String(p.pageId) !== String(pageId) || !findInHtml(savedHtml, p.f.korrektur)) return true;
      if (!p.checkId) return false;
      if (!byCheck.has(p.checkId)) byCheck.set(p.checkId, []);
      byCheck.get(p.checkId).push(p.f);
      return false;
    });
    for (const [checkId, fs] of byCheck) {
      // Verlaufsliste gehört zur offenen Seite — nur dort lokal nachführen.
      const entry = String(this.currentPage?.id) === String(pageId) ? (this.pageHistory?.find(e => e.id === checkId) || null) : null;
      const items = fs.map(_entryOf);
      try {
        // PATCH ersetzt die Listen: Ausgangsstand ist, was schon gebucht ist —
        // aus dieser Session, dem geladenen Eintrag oder frisch vom Server.
        const prev = _recorded.get(checkId) || await _bookedLists(checkId, entry);
        const next = { applied: _mergeByOriginal(prev.applied, items), selected: _mergeByOriginal(prev.selected, items) };
        const r = await fetch('/history/check/' + checkId + '/saved', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ applied_errors_json: next.applied, selected_errors_json: next.selected }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        _recorded.set(checkId, next);
        if (entry) {
          entry.saved = true;
          entry.applied_errors_json = next.applied;
          entry.selected_errors_json = next.selected;
        }
        this.refreshPageAges?.();
      } catch (e) {
        console.error('[lektorat-live history]', e);
        for (const f of fs) _pending.push({ pageId, checkId, f });
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
    if (dropped.size) this.appliedOriginals = this.appliedOriginals.filter(o => !dropped.has(o));
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
