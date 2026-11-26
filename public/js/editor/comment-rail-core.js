// Geteilter Kern der zwei Kommentar-Leisten (Notebook-Read-Modus + Bucheditor).
// Beide zeigen verankerte Share-Link-Leser-Kommentare als Margin-Rail neben dem
// Text; sie unterscheiden sich nur im Scope-Element, den Highlight-Namen, den
// State-Feldnamen und ein paar Verhaltens-Hooks (Read-Modus-Guard, Mirror auf
// Root-Flags, Scroll-Container). Die eigentliche Logik — Laden, Thread-Gruppieren,
// Re-Anchoring, Diff der „Stelle geändert"-Threads, Reply/Resolve/Delete — ist
// identisch und lebt hier (SSoT). Die CSS/DOM-Klassen der zwei Editoren bleiben
// getrennt (Editor-Entkopplung); geteilt wird nur das Verhalten.
//
// `createCommentRail(cfg)` liefert ein Methoden-Bündel (`_rail*`), das die
// Editor-Module spreaden und unter ihren Partial-erwarteten Namen aliasen.
// Ranges werden NIE im (reaktiven) Karten-State gehalten — ein in einen
// Alpine-Proxy gewrapptes Range bricht (Host-Objekt) —, sondern pro Aufruf
// frisch via locateRange lokalisiert.

import { fetchJson, sendJson, escHtml } from '../utils.js';
import { loadDiff } from '../lazy-libs.js';
import { renderInline } from '../page-revision-diff.js';
import { locateRange, resolveCurrentQuote, caretPosFromPoint, anchorFromRow, quoteWindow } from '../share-anchor.js';
import { groupThreads } from './comment-threads.js';
import { avatarInitials } from '../avatar.js';
import { compareText } from '../i18n.js';
import { highlightRegistry } from './shared/highlights.js';
import { contentRepo } from '../repo/content.js';
import { savePage } from './shared/page-api.js';
import { stripFocusArtefacts } from '../utils.js';
import { applySuggestionToHtml, suggestionReasonKey } from './comment-suggestion.js';
import { suggestionDiffParts } from '../diff/suggestion-diff.js';

// Template ruft je Render; der LCS läuft nur einmal je (Stelle, Vorschlag).
const _suggestionDiffMemo = new Map();

const anchorOf = anchorFromRow;

const highlightsApi = highlightRegistry;

// Plaintext für renderInline (block-/wort-basiert) als ein <p> verpacken;
// HTML-Sonderzeichen escapen, damit der DOMParser sie als Text liest.
function wrapP(text) {
  return `<p>${escHtml(text == null ? '' : String(text))}</p>`;
}

// cfg:
//   scopeEl()              → Element|null (Wurzel mit den data-bid-Blöcken)
//   hlAll, hlActive        → CSS-Custom-Highlight-Namen (pro Editor eindeutig)
//   keys                   → Mapping abstrakter Felder auf die Karten-State-Namen:
//     { comments, threads, selectedRootId, railVisible, replyDrafts,
//       savingReply, savingResolve, loadingBookId, recomputeRaf,
//       pendingGotoToken?, generalThreads?, filterStatus?, filterReviewer?,
//       totalCount?, openCount? }
//     totalCount/openCount: Threads dieser Ansicht OHNE Triage-Filter (alle bzw.
//     nicht erledigte) — treiben Knopf-Sichtbarkeit und Badge, damit ein Filter
//     ohne Treffer den Zugang zur Leiste nicht wegnimmt.
//   generalFilter(root, app) → optional. Liefert true ⇒ dieser nicht-verankerte
//     (allgemeine) Kommentar gehört in diese Leiste. Nur ausgewertet, wenn
//     keys.generalThreads gesetzt ist; ohne Filter werden allgemeine Kommentare
//     verworfen (altes Verhalten). Notebook: nur Page-Share der offenen Seite;
//     Bucheditor: alle (ganzes Buch).
//   idle(app)              → true ⇒ keine Threads zeigen (z.B. Notebook-Edit-Modus). Default: false
//   shouldWait(ctx, app)   → true ⇒ Recompute verschieben (Render noch nicht da)
//   afterRecompute(ctx)    → optionaler Hook nach Thread-Set (z.B. Root-Flags spiegeln)
//   scrollToRange(range, ctx) → Range in den Sichtbereich scrollen
//   suggestionTarget(thread, ctx) → { pageId, pageName } | { busy: true } | null
//     Abschnitt, in dem die verankerte Stelle eines Änderungsvorschlags steht.
//     `busy`: die Oberfläche hat dort ungespeicherte Änderungen (Bucheditor) —
//     Übernehmen wartet, statt sie zu überschreiben.
//   afterSuggestionApplied({ pageId, html, saved }, ctx) → neuen Stand anzeigen
export function createCommentRail(cfg) {
  const K = cfg.keys;

  // Aktions-Fehler (Antworten/Erledigt/Löschen) sichtbar machen — die Leiste
  // hat keine eigene Fehlerzeile, die globale Statuszeile trägt es.
  const reportError = (key, e) => {
    console.warn('[comment-rail]', key, e);
    const app = window.__app;
    app?.setStatus?.(app.t(key), false, 6000);
  };

  // Laufendes Recompute-Scheduling abbrechen. Das Handle hält rAF UND den
  // inneren Retry-Timeout: nur den rAF zu canceln liesse eine bereits laufende
  // Retry-Kette weiterlaufen (parallele Ketten, Recompute nach destroy).
  const cancelSchedule = (ctx) => {
    const h = ctx[K.recomputeRaf];
    if (h && typeof h === 'object') {
      h.dead = true;
      if (h.raf) cancelAnimationFrame(h.raf);
      if (h.timer) clearTimeout(h.timer);
    } else if (h) {
      cancelAnimationFrame(h);
    }
    ctx[K.recomputeRaf] = null;
  };

  const clearHL = () => {
    const api = highlightsApi();
    if (!api) return;
    try { api.delete(cfg.hlAll); } catch {}
    try { api.delete(cfg.hlActive); } catch {}
  };

  return {
    _railClearHL: clearHL,

    // Aus destroy()/Reset der Karte: Scheduling stoppen + laufenden Load
    // entwerten (seine Antwort gehört zu einem Buch, das nicht mehr offen ist).
    _railCancelSchedule() { cancelSchedule(this); },
    _railInvalidateLoad() { this[K.loadingBookId] = null; },

    // Buch-Kommentare laden (alle Links des Owners zum Buch) + auflösen.
    async _railLoad(bookId) {
      const id = bookId || Alpine.store('nav').selectedBookId;
      if (!id) { this[K.loadingBookId] = null; this[K.comments] = []; this[K.threads] = []; return; }
      this[K.loadingBookId] = id;
      let rows;
      try {
        rows = await fetchJson(`/share/api/book-comments/${encodeURIComponent(id)}`);
      } catch {
        rows = [];
      }
      // Buch in der Zwischenzeit gewechselt oder Karte zurückgesetzt? Verwerfen —
      // auch im Fehlerfall, sonst leert ein später Fehler die Liste des neuen Buchs.
      if (this[K.loadingBookId] !== id) return;
      this[K.comments] = Array.isArray(rows) ? rows : [];
      this._railSchedule();
    },

    // Recompute debouncen + auf Seiten-/Stream-Render warten (Container wird erst
    // nach x-html/x-init befüllt). Mehrere Versuche, dann aufgeben.
    _railSchedule() {
      cancelSchedule(this);
      // Lokales Handle (roh, nicht der reaktive Proxy im State): `dead` beendet
      // die Kette, egal in welchem Schritt sie gerade wartet.
      const h = { raf: null, timer: null, dead: false };
      let tries = 0;
      const run = () => {
        h.raf = null;
        h.timer = null;
        if (h.dead) return;
        if (cfg.shouldWait(this, window.__app) && tries++ < 20) {
          h.raf = requestAnimationFrame(() => {
            h.raf = null;
            if (!h.dead) h.timer = setTimeout(run, 80);
          });
          return;
        }
        h.dead = true;
        this[K.recomputeRaf] = null;
        this._railRecompute();
      };
      this[K.recomputeRaf] = h;
      h.raf = requestAnimationFrame(run);
    },

    _railRecompute() {
      const app = window.__app;
      const view = cfg.scopeEl();
      if (cfg.idle?.(app) || !this[K.comments]?.length || !view) {
        this[K.threads] = [];
        if (K.generalThreads) this[K.generalThreads] = [];
        if (K.totalCount) this[K.totalCount] = 0;
        if (K.openCount) this[K.openCount] = 0;
        this[K.selectedRootId] = null;
        clearHL();
        cfg.afterRecompute?.(this);
        return;
      }

      const blockIndex = new Map();
      view.querySelectorAll('[data-bid]').forEach((b, i) => blockIndex.set(b.getAttribute('data-bid'), i));

      const onView = [];
      const general = [];
      const rangeById = new Map(); // root.id → Range (lokal, NIE in reaktiven State)
      for (const g of groupThreads(this[K.comments])) {
        const root = g.root;
        if (!root.anchor_bid) {
          // Allgemeine (nicht-verankerte) Kommentare: in den General-Bucket, wenn
          // diese Leiste sie führt (Notebook: Page-Share der Seite; Bucheditor: alle).
          if (K.generalThreads && cfg.generalFilter?.(root, app)) general.push({ root, replies: g.replies });
          continue;
        }
        const sortKey = (bi) => bi * 1e6 + (Number.isInteger(root.anchor_start) ? root.anchor_start : 0);
        const bi = blockIndex.has(String(root.anchor_bid)) ? blockIndex.get(String(root.anchor_bid)) : 1e6;
        const range = locateRange(view, anchorOf(root));
        if (range) {
          onView.push({ root, replies: g.replies, changed: false, currentText: '', _diffHtml: '', _sort: sortKey(bi) });
          rangeById.set(root.id, range);
          continue;
        }
        // Kein Range: Block da, Quote weg → „Stelle geändert"; Block ganz weg →
        // nicht auf dieser Seite / nicht im Stream. resolveCurrentQuote trennt beides.
        const res = resolveCurrentQuote(view, anchorOf(root));
        if (res.status !== 'changed') continue;
        // Diff gegen den Ausschnitt, der dem Zitat heute entspricht (auf
        // Wortgrenzen, mit „…") — gesucht im ganzen Block, weil die Offsets des
        // Ankers sich auf den Block beziehen, nicht auf res.currentText.
        let blockText = res.currentText;
        try { blockText = view.querySelector(`[data-bid="${CSS.escape(String(root.anchor_bid))}"]`)?.textContent ?? blockText; } catch {}
        onView.push({ root, replies: g.replies, changed: true, currentText: quoteWindow(blockText, anchorOf(root)), _diffHtml: undefined, _sort: sortKey(bi) });
        // kein Highlight (Stelle nicht mehr lokalisierbar)
      }
      onView.sort((a, b) => a._sort - b._sort);
      // Triage-Filter (#5): Status (offen/erledigt) + Reviewer-Name. Nur wenn die
      // Karte die Filter-State-Keys deklariert; ohne Keys bleibt alles sichtbar.
      const fStatus = K.filterStatus ? (this[K.filterStatus] || 'all') : 'all';
      const fReviewer = K.filterReviewer ? (this[K.filterReviewer] || '') : '';
      const unfiltered = fStatus === 'all' && !fReviewer;
      const passes = (root) => {
        if (fStatus === 'open' && root.resolved_at) return false;
        if (fStatus === 'resolved' && !root.resolved_at) return false;
        if (fReviewer && (root.reader_name || '') !== fReviewer) return false;
        return true;
      };
      const onViewF = unfiltered ? onView : onView.filter(t => passes(t.root));
      // Ungefilterte Zähler (Knopf + Badge): verankerte + allgemeine dieser Ansicht.
      const generalAll = K.generalThreads ? general : [];
      if (K.totalCount) this[K.totalCount] = onView.length + generalAll.length;
      if (K.openCount) {
        this[K.openCount] = onView.filter(t => !t.root.resolved_at).length
          + generalAll.filter(t => !t.root.resolved_at).length;
      }
      this[K.threads] = onViewF;
      // Allgemeine zuletzt zugefügt zuerst (neueste oben) — analog zur alten Karte.
      let generalF = general;
      if (K.generalThreads) {
        general.sort((a, b) => new Date(b.root.created_at) - new Date(a.root.created_at));
        generalF = unfiltered ? general : general.filter(t => passes(t.root));
        this[K.generalThreads] = generalF;
      }
      const inView = (id) => onViewF.some(t => t.root.id === id) || generalF.some(t => t.root.id === id);
      if (this[K.selectedRootId] && !inView(this[K.selectedRootId])) this[K.selectedRootId] = null;

      // Anker-Highlights nur bei sichtbarer Leiste — eingeklappt = Kommentare aus,
      // also auch keine markierten Stellen im Text. Nur die sichtbaren (gefilterten)
      // verankerten Threads markieren. Erledigte Threads bleiben in der Leiste, ihre
      // Stelle wird aber nicht mehr im Manuskript hervorgehoben.
      const ranges = onViewF.filter(t => !t.changed && !t.root.resolved_at && rangeById.has(t.root.id)).map(t => rangeById.get(t.root.id));
      const api = highlightsApi();
      if (api) {
        try { if (this[K.railVisible] && ranges.length) api.set(cfg.hlAll, new Highlight(...ranges)); else api.delete(cfg.hlAll); } catch {}
      }
      cfg.afterRecompute?.(this);
      this._railComputeDiffs();

      // Sprung aus der „Geteilte Links"-Karte: ersten offenen verankerten Thread
      // dieses Links (Dokument-Reihenfolge) öffnen, sonst den ersten überhaupt.
      if (K.pendingGotoToken && this[K.pendingGotoToken]) {
        const token = this[K.pendingGotoToken];
        this[K.pendingGotoToken] = null;
        const ofLink = onViewF.filter(x => x.root.share_token === token);
        const t = ofLink.find(x => !x.root.resolved_at) || ofLink[0];
        if (t && this[K.selectedRootId] !== t.root.id) this._railSelect(t.root.id);
      }
    },

    // „Stelle geändert"-Threads: Quote→aktuell-Diff lazy via jsdiff + renderInline.
    async _railComputeDiffs() {
      const pending = this[K.threads].filter(t => t.changed && t._diffHtml === undefined);
      if (!pending.length) return;
      let diffLib;
      try { diffLib = await loadDiff(); } catch { pending.forEach(t => { t._diffHtml = ''; }); return; }
      for (const t of pending) {
        try {
          const out = renderInline(wrapP(t.root.anchor_quote || ''), wrapP(t.currentText || ''), diffLib);
          t._diffHtml = out.unchanged ? '' : out.html;
        } catch { t._diffHtml = ''; }
      }
    },

    // Thread selektieren: Stelle hervorheben + hinscrollen (Toggle).
    _railSelect(rootId) {
      this[K.selectedRootId] = this[K.selectedRootId] === rootId ? null : rootId;
      const api = highlightsApi();
      if (api) { try { api.delete(cfg.hlActive); } catch {} }
      if (!this[K.selectedRootId]) return;
      // Verankerte Threads hervorheben; allgemeine (General-Bucket, kein Anker)
      // klappen nur ihre Aktionen auf — kein Range zum Markieren/Scrollen.
      const thread = this[K.threads].find(t => t.root.id === rootId);
      const view = cfg.scopeEl();
      if (!thread || !view) return;
      const range = locateRange(view, anchorOf(thread.root));
      if (!range) return;
      if (api) { try { api.set(cfg.hlActive, new Highlight(range)); } catch {} }
      cfg.scrollToRange(range, this);
    },

    // Klick im Text → rootId des verankerten Threads, dessen Range den Klickpunkt
    // enthält (oder null). „Stelle geändert"-Threads haben keine Range → übersprungen.
    _railHitTest(clientX, clientY) {
      const view = cfg.scopeEl();
      if (!view) return null;
      const pos = caretPosFromPoint(clientX, clientY);
      if (!pos || !pos.node) return null;
      for (const t of (this[K.threads] || [])) {
        if (t.changed) continue;
        const range = locateRange(view, anchorOf(t.root));
        if (!range) continue;
        try { if (range.isPointInRange(pos.node, pos.offset)) return t.root.id; } catch {}
      }
      return null;
    },

    // Auswahl ausgehend vom Text-Klick: immer selektieren (kein Toggle), Stelle
    // hervorheben und die LEISTE zum Thread scrollen (Gegenrichtung zu _railSelect,
    // das den Text scrollt — der User ist hier schon an der Textstelle).
    _railSelectFromText(rootId) {
      this[K.selectedRootId] = rootId;
      const api = highlightsApi();
      if (api) { try { api.delete(cfg.hlActive); } catch {} }
      const thread = this[K.threads].find(t => t.root.id === rootId);
      const view = cfg.scopeEl();
      if (thread && view) {
        const range = locateRange(view, anchorOf(thread.root));
        if (range && api) { try { api.set(cfg.hlActive, new Highlight(range)); } catch {} }
      }
      cfg.scrollRailToThread?.(rootId, this);
    },

    // Klick irgendwo ausserhalb des selektierten Threads → Thread schliessen
    // (Auswahl + Reply-Box + Aktionen klappen zu, Anker-Highlight weg). Klicks in
    // der Leiste selbst (`.comment-rail` — anderer Thread, Reply-Box, Aktionen)
    // bleiben der Leisten-Logik überlassen; ein Klick auf eine markierte
    // Kommentarstelle im Text selektiert dort weiter (Bucheditor) statt zu schliessen.
    _railDeselectOutside(ev) {
      if (!this[K.selectedRootId]) return;
      const target = ev.target;
      if (target?.closest?.('.comment-rail')) return;
      if (this._railHitTest(ev.clientX, ev.clientY) != null) return;
      this[K.selectedRootId] = null;
      const api = highlightsApi();
      if (api) { try { api.delete(cfg.hlActive); } catch {} }
      cfg.afterRecompute?.(this);
    },

    // Distinct Reviewer-Namen (Root-Kommentare von Lesern) der geladenen
    // Kommentare — speist die Reviewer-Combobox des Triage-Filters (#5).
    // Owner-Antworten (author_email) und Replies zählen nicht.
    _railReviewerNames() {
      const set = new Set();
      for (const c of (this[K.comments] || [])) {
        if (!c.author_email && !c.parent_id && c.reader_name) set.add(c.reader_name);
      }
      return [...set].sort(compareText);
    },

    // Triage-Filter setzen + neu auflösen (#5). status: 'all'|'open'|'resolved',
    // reviewer: Name oder '' (alle). Schliesst eine ggf. offene Auswahl, die der
    // Filter ausblendet (Recompute nullt selectedRootId, wenn nicht mehr sichtbar).
    _railSetFilter({ status, reviewer } = {}) {
      if (K.filterStatus && status !== undefined) this[K.filterStatus] = status;
      if (K.filterReviewer && reviewer !== undefined) this[K.filterReviewer] = reviewer;
      this._railRecompute();
    },

    // Triage-Filter auf „alle" zurück (ohne Recompute — der Aufrufer löst ohnehin
    // neu auf, z. B. beim Seitenwechsel).
    _railResetFilter() {
      if (K.filterStatus) this[K.filterStatus] = 'all';
      if (K.filterReviewer) this[K.filterReviewer] = '';
    },

    // Avatar-Daten für die Meta-Zeile (Google-Docs-Optik): Label + Initialen-Pip
    // mit deterministischer Hue pro Person (wiederverwendet die presence-pip-Optik,
    // DESIGN.md). Leser haben keine Email → Initialen/Hue leiten sich aus dem
    // Anzeigenamen ab; Owner-Antworten nutzen author_display_name (Fallback Badge).
    commentAvatar(c) {
      const app = window.__app;
      const isAuthor = !!c.author_email;
      const label = isAuthor
        ? (c.author_display_name || app.t('share.reader.author_badge'))
        : (c.reader_name || app.t('share.reader.anon'));
      const seed = isAuthor ? (c.author_email || label) : (c.reader_name || 'anon');
      return { label, initials: avatarInitials(label), hue: app.userAvatarHue(seed) };
    },

    // Änderungsvorschlag als Wort-Diff, gekürzt auf die geänderten Sätze
    // (diff/suggestion-diff.js) — dieselbe Darstellung wie im Share-Reader.
    // Zu langer Text: neuer Text ungemarkert als Einfügung.
    commentSuggestionParts(root) {
      const quote = root.anchor_quote || '';
      const text = root.suggestion_text || '';
      const key = `${quote}\u0000${text}`;
      let parts = _suggestionDiffMemo.get(key);
      if (!parts) {
        parts = suggestionDiffParts(quote, text) || [{ t: 'add', v: text, c: 'diff-add' }];
        if (_suggestionDiffMemo.size > 200) _suggestionDiffMemo.clear();
        _suggestionDiffMemo.set(key, parts);
      }
      return parts;
    },

    async _railReply(thread) {
      const rootId = thread.root.id;
      const token = thread.root.share_token;
      const body = (this[K.replyDrafts][rootId] || '').trim();
      if (!body || !token) return;
      this[K.savingReply] = rootId;
      try {
        const reply = await sendJson(`/share/api/links/${encodeURIComponent(token)}/comments`, 'POST', { parent_id: rootId, body });
        this[K.comments] = [...this[K.comments], reply];
        this[K.replyDrafts][rootId] = '';
        this._railRecompute();
      } catch (e) {
        // Entwurf bleibt stehen — der User kann erneut senden.
        reportError('share.comments.replyFailed', e);
      } finally {
        this[K.savingReply] = null;
      }
    },

    async _railResolve(comment) {
      const resolved = !comment.resolved_at;
      this[K.savingResolve] = comment.id;
      try {
        await sendJson(`/share/api/comments/${comment.id}/resolve`, 'PATCH', { resolved });
        comment.resolved_at = resolved ? new Date().toISOString() : null;
        // Neu auflösen: erledigte Stellen verlieren ihr Highlight, und der
        // Status-Filter (offen/erledigt) blendet den Thread ggf. aus.
        this._railRecompute();
        // Tree-/Seiten-Badge (offene Reviewer-Kommentare) syncen — Resolve ändert
        // die Pro-Seite-Zählung.
        window.__app?.refreshShareCommentCounts?.();
      } catch (e) {
        reportError('share.comments.resolveFailed', e);
      } finally {
        this[K.savingResolve] = null;
      }
    },

    // Änderungsvorschlag (Review-Modus) übernehmen oder ablehnen. Übernehmen:
    // Abschnitt frisch laden, Stelle im verankerten Block ersetzen (genau ein
    // Treffer, comment-suggestion.js), mit Versionsprüfung speichern, dann den
    // Entscheid festhalten — in dieser Reihenfolge, damit ein gescheiterter Save
    // nie als «übernommen» dasteht. Revisions-Quelle 'review': die Revisions-
    // liste zeigt, dass die Änderung aus dem Review kam.
    async _railDecideSuggestion(thread, decision) {
      const root = thread?.root;
      if (!root || root.suggestion_text == null || this[K.savingResolve] === root.id) return;
      const app = window.__app;
      this[K.savingResolve] = root.id;
      try {
        if (decision === 'accept') {
          const target = cfg.suggestionTarget?.(thread, this);
          if (target?.busy) { reportError('share.comments.suggestion.busy', null); return; }
          if (!target?.pageId) { reportError(suggestionReasonKey('blockGone'), null); return; }
          const page = await contentRepo.loadPage(target.pageId, { fresh: true });
          const res = applySuggestionToHtml(stripFocusArtefacts(page.html || ''), {
            bid: root.anchor_bid, quote: root.anchor_quote, replacement: root.suggestion_text,
          });
          const already = res.reason === 'alreadyApplied';
          if (res.reason && !already) { reportError(suggestionReasonKey(res.reason), null); return; }
          if (!already) {
            let saved;
            try {
              saved = await savePage(target.pageId, {
                html: res.html, pageName: page.name || target.pageName, source: 'review',
                expectedUpdatedAt: page.updated_at || null,
              });
            } catch (e) {
              reportError(e?.status === 409 ? 'share.comments.suggestion.conflict' : 'share.comments.suggestion.failed', e);
              return;
            }
            app?._syncPageStatsAfterSave?.({ id: target.pageId, updated_at: saved?.updated_at || null }, res.html);
            // Der Abschnitt ist gespeichert — die Oberfläche zieht nach, auch wenn
            // der Status-PATCH gleich scheitert (sonst zeigte sie den alten Text).
            await cfg.afterSuggestionApplied?.({ pageId: target.pageId, html: res.html, saved }, this);
          }
          try {
            await sendJson(`/share/api/comments/${root.id}/suggestion`, 'PATCH', { state: 'accepted' });
          } catch (e) {
            // Text steht, Status nicht: ein erneutes «Übernehmen» erkennt den
            // übernommenen Text (alreadyApplied) und setzt nur den Status.
            reportError(already ? 'share.comments.suggestion.failed' : 'share.comments.suggestion.statusFailed', e);
            return;
          }
          root.suggestion_state = 'accepted';
          if (!root.resolved_at) root.resolved_at = new Date().toISOString();
          app?.setStatus?.(app.t(already ? 'share.comments.suggestion.alreadyApplied' : 'share.comments.suggestion.applied'), false, 4000);
        } else {
          const state = decision === 'reject' ? 'rejected' : 'open';
          await sendJson(`/share/api/comments/${root.id}/suggestion`, 'PATCH', { state });
          root.suggestion_state = state;
        }
        this._railRecompute();
        app?.refreshShareCommentCounts?.();
      } catch (e) {
        reportError('share.comments.suggestion.failed', e);
      } finally {
        this[K.savingResolve] = null;
      }
    },

    async _railDelete(comment) {
      const ok = await window.__app.appConfirm({
        message: window.__app.t('share.comments.deleteConfirm'),
        confirmLabel: window.__app.t('common.delete'),
        danger: true,
      });
      if (!ok) return;
      try {
        await fetchJson(`/share/api/comments/${comment.id}`, { method: 'DELETE' });
        // Root-Delete kaskadiert serverseitig — Buch-Kommentare neu laden + Badge syncen.
        await this._railLoad();
        window.__app?.refreshShareCommentCounts?.();
      } catch (e) {
        reportError('share.comments.deleteFailed', e);
      }
    },
  };
}
