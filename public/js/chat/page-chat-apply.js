// Seiten-Chat: Vorschläge übernehmen, rückgängig machen, verwerfen — und
// Titelvarianten übernehmen/kopieren. In `chatCard` gespreadet (über chat.js);
// `this` ist die Karte, Root-Zugriffe laufen über window.__app.
//
// ZWEI WEGE, JE NACH EDITOR-ZUSTAND DER SEITE:
//   - Leseansicht: Server-Write über die Lektorat-Pipeline
//     (`_loadApplyAndSave`, Quelle 'chat-apply') — frisch laden, Guards,
//     `expectedUpdatedAt`-PUT (409 bei Fremd-Write dazwischen).
//   - Notebook-Edit-Modus: Ersetzung IM Live-Editor (`_applyTextReplacement`,
//     editor/notebook/edit/input.js) → Dirty/Draft/Autosave/Undo wie Tippen. Ein
//     Server-Write liesse das contenteditable auf dem alten Stand stehen, und der
//     nächste Autosave überschriebe die Übernahme still.
//   - Fokusmodus: blockiert (der Focus-Editor ist stabilisiert und wird von hier
//     nicht angefasst).
// Beide Wege prüfen dieselben Guards: Stelle fehlt → 'notFound', mehrdeutig →
// 'ambiguous', No-Op von `replaceInHtmlRich` → `richSkipReason` (Link/Marker/
// Absatzgrenze/nicht teilbarer Absatz). Ein `ersatz` darf *kursiv*/**fett** und
// eine Leerzeile (Absatzteilung) tragen: utils/html-replace-rich.js. Ein solcher
// Ersatz ist hier nicht rückgängig zu machen (der eingesetzte Text steht nicht
// mehr als ein Stück Klartext da) — dafür gibt es Strg+Z im Editor bzw. die
// Revisionen des Abschnitts.
// Der Server-Weg prüft Mehrdeutigkeit zweimal: gegen den ersten Load (nichts
// speichern, wenn alles scheitert) und gegen den zweiten in `_loadApplyAndSave`.
// Übernehmen/Rückgängig nur mit Schreibrecht (`canEdit`) — der PUT verlangt editor.

import { escHtml, countInHtml, replaceInHtmlRich, richSkipReason, parseRichReplacement, clearStatusAfter, stripFocusArtefacts } from '../utils.js';
import { contentRepo } from '../repo/content.js';
import { loadQuoteStyle } from '../editor/shared/quote-normalize/api.js';

const REASON_KEYS = {
  notFound: 'chat.originalNotFound',
  ambiguous: 'chat.originalAmbiguous',
  spansLink: 'chat.spansLink',
  spansMarker: 'chat.spansMarker',
  boundary: 'chat.crossesBlockBoundary',
  paragraphSplit: 'chat.paragraphSplitBlocked',
  unchanged: 'chat.replacementUnchanged',
  focus: 'chat.applyFocusBlocked',
  notEditing: 'chat.pageNotLoaded',
  busy: 'chat.applyBusy',
};
// Rückgängig: „nicht gefunden" heisst hier „der eingesetzte Text wurde seither
// verändert" — eine andere Aussage als beim Übernehmen.
const UNDO_REASON_KEYS = { ...REASON_KEYS, notFound: 'chat.undoChanged', ambiguous: 'chat.undoAmbiguous' };

/** Trägt der Ersatz Auszeichnung oder eine Absatzteilung? Dann kein Rückgängig
 *  über den Vorschlag (siehe Modulkopf). */
export function isRichErsatz(ersatz) {
  const r = parseRichReplacement(ersatz);
  return r.hasMarkup || r.split;
}

/** Lokalisierter Text eines gescheiterten Speicherns/Ladens — nach HTTP-Status
 *  statt der rohen Fehlermeldung („HTTP 409"). */
export function saveErrorText(t, e) {
  const s = e?.status;
  if (s === 409) return t('chat.saveConflict');
  if (s === 403) return t('chat.saveForbidden');
  if (s === 423) return t('chat.saveLocked');
  if (s === 0 || e instanceof TypeError || e?.name === 'TimeoutError') return t('chat.saveNetwork');
  if (typeof s === 'number') return t('chat.saveFailedStatus', { status: s });
  // Ohne Status: eigene, schon lokalisierte Abbrüche (z.B. lektorat.unsafeHtml).
  return e?.message ? t('chat.saveFailedPrefix') + e.message : t('chat.pageLoadFailed');
}

/** Guard einer Ersetzung `from → to` gegen `html`: null = ersetzbar, sonst Grund. */
export function replacementBlocker(html, from, to) {
  const n = countInHtml(html, from);
  if (n === 0) return 'notFound';
  if (n > 1) return 'ambiguous';
  if (replaceInHtmlRich(html, from, to) === html) return richSkipReason(html, from, to);
  return null;
}

const _isOpen = v => !v._applied && !v._discarded && !v._stale && !v._notFound && !v._ambiguous;

export const pageChatApplyMethods = {

  // Kern: führt Ersetzungen `[{ from, to }]` auf der offenen Seite aus.
  // Liefert { mode: 'editor'|'server', done: [item], failed: [{ item, reason }], stale? }
  // oder null, wenn die Seite vor dem Speichern gewechselt hat (nichts geschrieben).
  // `stale: true`: gespeichert, aber inzwischen ist eine andere Seite offen — der
  // Aufrufer persistiert den Vorschlags-Status, fasst den View-State aber nicht an.
  async _runChatReplacements(items) {
    const root = window.__app;
    if (!root.currentPage) return { mode: 'server', done: [], failed: items.map(item => ({ item, reason: 'notEditing' })) };

    if (root.editMode) {
      if (root.focusActive) return { mode: 'editor', done: [], failed: items.map(item => ({ item, reason: 'focus' })) };
      // Anführungszeichen wie im Server-Pfad auf den Stil des Buchs ziehen.
      const quoteStyle = await loadQuoteStyle(root.$store?.nav?.selectedBookId);
      if (!root.editMode || root.focusActive) return { mode: 'editor', done: [], failed: items.map(item => ({ item, reason: 'notEditing' })) };
      const done = [];
      const failed = [];
      for (const item of items) {
        const r = root._applyTextReplacement(item.from, item.to, { quoteStyle });
        if (r?.ok) done.push(item); else failed.push({ item, reason: r?.reason || 'notEditing' });
      }
      return { mode: 'editor', done, failed };
    }

    // Läuft schon ein Server-Apply (Lektorat-Save, anderer Vorschlag)? Dann
    // nicht parallel schreiben — und dessen Fortschritt nicht zurücksetzen.
    if (root.saveApplying != null) return { mode: 'server', done: [], failed: items.map(item => ({ item, reason: 'busy' })) };

    // Seite beim Start pinnen: der User kann zwischen den awaits wechseln; der
    // Vorschlag gehört zu der Seite, auf der er entstand.
    const pageIdAtStart = root.currentPage.id;
    const samePage = () => root.currentPage?.id === pageIdAtStart;
    // Synchron VOR dem ersten await: `saveApplying` sperrt Bearbeiten/Fokus
    // (startEdit, editor-page-actions.html) — sonst öffnet ein Klick während des
    // Ladens den Editor auf dem alten Stand, und dessen Autosave überschriebe
    // die Übernahme.
    root.saveApplying = 5;
    try {
      // `fresh: true`: der Guard muss den aktuellen Server-Stand sehen, sonst
      // überschreibt der folgende PUT Edits, die seit dem letzten GET kamen.
      const page = await contentRepo.loadPage(pageIdAtStart, { fresh: true });
      if (!samePage()) return null;
      // Sequenziell gegen den mitwandernden Stand prüfen: zwei Vorschläge auf
      // dieselbe Stelle dürfen nicht beide als ersetzbar gelten.
      let html = stripFocusArtefacts(page.html || '');
      const eligible = [];
      const failed = [];
      for (const item of items) {
        const reason = replacementBlocker(html, item.from, item.to);
        if (reason) { failed.push({ item, reason }); continue; }
        html = replaceInHtmlRich(html, item.from, item.to);
        eligible.push(item);
      }
      if (!eligible.length) return { mode: 'server', done: [], failed };

      const corrections = eligible.map(item => ({ original: item.from, korrektur: item.to, _item: item }));
      // onProgress setzt saveApplying (→ Editor-Progressbar) und chatStatus.
      // `checkAmbiguous`: `_loadApplyAndSave` lädt ein zweites Mal frisch — was
      // inzwischen mehrdeutig wurde, wird dort übersprungen statt blind ersetzt.
      const { finalHtml, skipped } = await root._loadApplyAndSave(
        corrections,
        (pct, text) => {
          root.saveApplying = pct;
          if (text) this.chatStatus = `<span class="spinner"></span>${escHtml(text)}`;
        },
        'chat-apply',
        { checkAmbiguous: true, rich: true },
      );
      const skippedByItem = new Map((skipped || []).map(s => [s.f?._item, s.reason]));
      const done = [];
      for (const c of corrections) {
        if (skippedByItem.has(c._item)) failed.push({ item: c._item, reason: skippedByItem.get(c._item) || 'boundary' });
        else done.push(c._item);
      }
      if (!samePage()) return { mode: 'server', done, failed, stale: true };
      root.originalHtml = finalHtml;
      this._chatPendingRefresh = true;
      root.updatePageView();
      return { mode: 'server', done, failed };
    } finally {
      root.saveApplying = null;
    }
  },

  // Liefert true, wenn der Server den Status gespeichert hat. Bei false setzt der
  // Aufrufer den sichtbaren Zustand zurück bzw. zeigt `chat.statusNotSaved` —
  // sonst zeigte die Karte einen Stand, den der nächste Reload widerruft.
  async _patchChatVorschlag(msgId, vIdx, action, body) {
    if (!msgId) return true;
    try {
      const r = await fetch(`/chat/message/${msgId}/vorschlag/${vIdx}/${action}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return true;
    } catch (e) {
      console.warn(`[chat vorschlag ${action}] nicht persistiert:`, e.message);
      return false;
    }
  },

  _chatStatusFlash(key, params) {
    const root = window.__app;
    const msg = `<span class="success-msg">${escHtml(root.t(key, params))}</span>`;
    this.chatStatus = msg;
    clearStatusAfter(this, 'chatStatus', msg, 3000);
  },

  // Übernimmt die Vorschläge `vIdxs` einer Nachricht (ein Klick = ein Save).
  async _applyChatVorschlaege(msgIdx, vIdxs) {
    const root = window.__app;
    const msg = this.chatMessages[msgIdx];
    if (!msg || !Array.isArray(msg.vorschlaege)) return;
    if (!root.canEdit?.()) return;
    const msgId = msg.id;
    const gen = this._chatGen;
    const items = vIdxs
      .map(vIdx => ({ vIdx, v: msg.vorschlaege[vIdx] }))
      .filter(x => x.v && !x.v._applied && !x.v._applying)
      .map(x => ({ ...x, from: x.v.original, to: x.v.ersatz }));
    if (!items.length) return;
    for (const { v } of items) { v._applying = true; v._error = null; }
    try {
      const res = await this._runChatReplacements(items);
      if (!res) return;
      for (const { item, reason } of res.failed) item.v._error = root.t(REASON_KEYS[reason] || REASON_KEYS.boundary);
      // Gespeichert ist gespeichert — auch wenn inzwischen eine andere Seite
      // offen ist (res.stale): der Status gehört persistiert, sonst stünde der
      // Vorschlag beim nächsten Laden wieder offen da, obwohl der Text ersetzt ist.
      for (const item of res.done) {
        item.v._applied = true;
        item.v.applied = true;
        item.v._discarded = false;
        delete item.v.status;
        // Der Text ist ersetzt — scheitert nur das Status-Speichern, bleibt die
        // Übernahme stehen, aber der User erfährt, dass der Vermerk fehlt.
        this._patchChatVorschlag(msgId, item.vIdx, 'applied', { applied: true }).then((ok) => {
          if (!ok) item.v._error = root.t('chat.statusNotSaved');
        });
      }
      if (res.stale || this._chatGen !== gen) return;
      if (items.length > 1) {
        if (res.done.length) this._chatStatusFlash('chat.applyAllResult', { applied: res.done.length, skipped: res.failed.length });
        else this.chatStatus = '';
      } else if (res.done.length) {
        this._chatStatusFlash(res.mode === 'editor' ? 'chat.appliedToEditor' : 'chat.changeSaved');
      } else {
        this.chatStatus = '';
      }
    } catch (e) {
      console.error('[applyChatVorschlag]', e);
      const errMsg = saveErrorText(root.t.bind(root), e);
      for (const { v } of items) v._error = errMsg;
      this.chatStatus = '';
    } finally {
      for (const { v } of items) v._applying = false;
      if (this._chatGen === gen) this._refreshVorschlagStates();
    }
  },

  applyChatVorschlag(_vorschlag, msgIdx, vIdx) {
    return this._applyChatVorschlaege(msgIdx, [vIdx]);
  },

  // „Alle passenden übernehmen": nur offene Vorschläge der Nachricht, deren
  // Stelle eindeutig dasteht. Blockierte fallen im Guard heraus und behalten
  // ihre Begründung am Vorschlag. `typ` ('korrektur'|'stil') schränkt ein —
  // „Nur Korrekturen übernehmen".
  applyAllChatVorschlaege(msgIdx, typ = null) {
    const msg = this.chatMessages[msgIdx];
    if (!msg || !Array.isArray(msg.vorschlaege)) return;
    const vIdxs = msg.vorschlaege
      .map((v, i) => (_isOpen(v) && (!typ || v.typ === typ) ? i : -1))
      .filter(i => i >= 0);
    return this._applyChatVorschlaege(msgIdx, vIdxs);
  },

  chatOpenVorschlagCount(msg, typ = null) {
    if (!Array.isArray(msg?.vorschlaege)) return 0;
    return msg.vorschlaege.filter(v => _isOpen(v) && (!typ || v.typ === typ)).length;
  },

  // Knopf „Nur Korrekturen" lohnt nur, wenn neben offenen Korrekturen auch
  // offene Stil-Vorschläge stehen (sonst täte er dasselbe wie „Alle").
  chatShowCorrectionsOnly(msg) {
    const k = this.chatOpenVorschlagCount(msg, 'korrektur');
    return k > 0 && k < this.chatOpenVorschlagCount(msg);
  },

  // Rückgängig: der eingesetzte Text muss noch genau einmal und unverändert in
  // der Seite stehen — sonst wird nichts angefasst (der User hat weitergeschrieben).
  async undoChatVorschlag(msgIdx, vIdx) {
    const root = window.__app;
    const msg = this.chatMessages[msgIdx];
    const v = msg?.vorschlaege?.[vIdx];
    if (!v || !v._applied || v._applying) return;
    if (!root.canEdit?.()) return;
    if (isRichErsatz(v.ersatz)) { v._error = root.t('chat.undoRich'); return; }
    const msgId = msg.id;
    const gen = this._chatGen;
    v._applying = true;
    v._error = null;
    try {
      const res = await this._runChatReplacements([{ vIdx, v, from: v.ersatz, to: v.original }]);
      if (!res) return;
      if (res.failed.length) {
        v._error = root.t(UNDO_REASON_KEYS[res.failed[0].reason] || UNDO_REASON_KEYS.boundary);
        return;
      }
      v._applied = false;
      delete v.applied;
      this._patchChatVorschlag(msgId, vIdx, 'applied', { applied: false }).then((ok) => {
        if (!ok) v._error = root.t('chat.statusNotSaved');
      });
      if (!res.stale && this._chatGen === gen) this._chatStatusFlash(res.mode === 'editor' ? 'chat.undoneInEditor' : 'chat.undone');
    } catch (e) {
      console.error('[undoChatVorschlag]', e);
      v._error = saveErrorText(root.t.bind(root), e);
    } finally {
      v._applying = false;
      if (this._chatGen === gen) this._refreshVorschlagStates();
    }
  },

  // Verwerfen ↔ wieder öffnen. Persistiert als `status` im vorschlaege-JSON.
  async toggleDiscardChatVorschlag(msgIdx, vIdx) {
    const msg = this.chatMessages[msgIdx];
    const v = msg?.vorschlaege?.[vIdx];
    if (!v || v._applied || v._applying) return;
    const discard = !v._discarded;
    const setDiscarded = (on) => {
      v._discarded = on;
      if (on) v.status = 'discarded'; else delete v.status;
    };
    setDiscarded(discard);
    v._error = null;
    this._refreshVorschlagStates();
    const ok = await this._patchChatVorschlag(msg.id, vIdx, 'status', { status: discard ? 'discarded' : null });
    if (!ok) {
      setDiscarded(!discard);
      v._error = window.__app.t('chat.statusNotSaved');
      this._refreshVorschlagStates();
    }
  },

  // ── Titelvarianten ───────────────────────────────────────────────────────

  chatTitelVarianten(msg) {
    const list = msg?.context_info?.titel_varianten;
    return Array.isArray(list) ? list : [];
  },

  // Variante gleicht einem anderen Abschnittstitel → { page_id, name }, sonst null
  // (serverseitig markiert, routes/jobs/chat/page-chat-verify.js#titelCollisions).
  chatTitelDoppelt(msg, ti) {
    const list = msg?.context_info?.titel_doppelt;
    return Array.isArray(list) ? (list.find(d => d.i === ti) || null) : null;
  },

  // Setzt den Seitentitel über denselben Weg wie das Inline-Rename im Editor-
  // Kopf (app-view/page.js#renameCurrentPage → contentRepo.updatePage); der
  // spiegelt den Namen auch in Sidebar-Baum und Seitenliste.
  async applyChatTitel(titel) {
    const root = window.__app;
    if (!root.currentPage || !root.canEdit?.()) return;
    await root.renameCurrentPage({ target: { value: titel } });
    if (root.currentPage?.name === titel) this._chatStatusFlash('chat.titleApplied');
  },

  async copyChatTitel(titel) {
    const root = window.__app;
    try {
      await navigator.clipboard.writeText(titel);
      this._chatStatusFlash('chat.titleCopied');
    } catch (e) {
      console.warn('[copyChatTitel]', e?.message);
      this.chatStatus = `<span class="error-msg">${escHtml(root.t('chat.titleCopyFailed'))}</span>`;
    }
  },
};
