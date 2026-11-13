// Kontinuitätsprüfer-Methoden (werden in Alpine.data('kontinuitaetCard')
// gespreadet). Ergebnisse stammen aus der Komplettanalyse (Phase 8) und werden
// via _loadKontinuitaetHistory (GET) angezeigt; Anzeige + Filter + Resolve-Toggle.

import { fetchJson, sendJson, escHtml } from '../utils.js';
import { i18nMarkerKey } from '../i18n.js';
import { startPoll, runningJobStatus } from '../cards/job-helpers.js';
import { isSelectedBook } from '../cards/book-guard.js';
import { memoMethods } from '../cards/card-memo.js';
import { nameGuardMethods } from './kontinuitaet-nameguard.js';
import { kontinuitaetViewMethods, kontinuitaetSeverity } from './kontinuitaet-view.js';

export { KONTINUITAET_SEVERITIES, kontinuitaetSeverity } from './kontinuitaet-view.js';

// Server-Fehlercodes der Start-Routen → Hinweis in der Karte (Rest: generisch).
const START_ERROR_KEYS = {
  CONTINUITY_PROVIDER_UNSUPPORTED: 'kontinuitaet.error.providerUnsupported',
  FACTCHECK_NOT_ENABLED_FOR_BOOK: 'kontinuitaet.faktencheck.hint',
  FACTCHECK_CLAUDE_ONLY: 'kontinuitaet.faktencheck.claudeOnly',
  FACTCHECK_NO_TOOLS: 'kontinuitaet.faktencheck.noTools',
  FACTCHECK_NO_WEBSEARCH: 'kontinuitaet.faktencheck.noWebsearch',
  FACTCHECK_DISABLED: 'kontinuitaet.faktencheck.disabled',
  KOMPLETT_ANALYSIS_RUNNING: 'error.KOMPLETT_ANALYSIS_RUNNING',
};

// Quellen-URL der Faktencheck-Befunde ist KI-Output: nur http(s) wird ein Link.
export function kontinuitaetSafeUrl(url) {
  const u = typeof url === 'string' ? url.trim() : '';
  return /^https?:\/\//i.test(u) ? u : '';
}

export const kontinuitaetMethods = {
  // ── Prüf-Jobs starten ───────────────────────────────────────────────────────
  // Beide Knöpfe der Karte starten einen eigenen KI-Job und teilen Fortschritt,
  // Polling und Fehleranzeige:
  //  - „Nur Kontinuität prüfen" (/jobs/kontinuitaet): P8 ohne die volle
  //    Extraktions-Pipeline, auf dem vorhandenen Katalog.
  //  - Weltfakten-Faktencheck (/jobs/faktencheck): prüft extrahierte Welt-Fakten per
  //    Web-Suche; Ergebnisse (typ='faktenfehler') hängen am neuesten Check. Nur wenn
  //    instanzweit freigeschaltet (Karte zeigt den Button nur dann) UND das Buch
  //    opt-in hat.
  kontinuitaetRun() { return this._kontinuitaetStartJob('kontinuitaet', '/jobs/kontinuitaet', 'kontinuitaet.run.starting'); },
  faktencheckRun() { return this._kontinuitaetStartJob('faktencheck', '/jobs/faktencheck', 'kontinuitaet.faktencheck.starting'); },

  // `kind` ('kontinuitaet' | 'faktencheck') steuert nur die Knopf-Beschriftung:
  // „Welt-Fakten werden geprüft …" darf nicht stehen, während die Kontinuität läuft.
  async _kontinuitaetStartJob(kind, url, startingKey) {
    const root = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.kontinuitaetLoading) return;
    this.kontinuitaetLoading = true;
    this.kontinuitaetRunKind = kind;
    this.kontinuitaetProgress = 1;
    this.kontinuitaetWarnings = [];
    this.kontinuitaetStatus = runningJobStatus(root.t, startingKey);
    const clearRunState = () => {
      this.kontinuitaetLoading = false;
      this.kontinuitaetRunKind = '';
      this.kontinuitaetProgress = 0;
      this.kontinuitaetStatus = '';
    };
    const showError = (text) => {
      clearRunState();
      this.kontinuitaetStatus = `<span class="error-msg">${escHtml(text)}</span>`;
    };
    try {
      const data = await sendJson(url, 'POST', { book_id: bookId, book_name: root.selectedBookName || '' });
      // Buchwechsel während des Starts: der Reset (book:changed) hat die Karte
      // schon geleert — nichts mehr hineinschreiben, keinen Poller anhängen.
      if (!isSelectedBook(bookId)) return;
      if (!data?.jobId) { showError(this._kontinuitaetStartErrorText(data)); return; }
      startPoll(this, {
        jobId: data.jobId,
        timerProp: '_kontinuitaetPollTimer',
        progressProp: 'kontinuitaetProgress',
        onProgress: (job) => {
          this.kontinuitaetStatus = runningJobStatus(
            root.t, job.statusText, job.tokensIn, job.tokensOut,
            Alpine.store('config').claudeMaxTokens, job.progress, job.tokensPerSec, job.statusParams);
        },
        onDone: async (job) => {
          clearRunState();
          // Teil-Degradierungen (job.warn.*) des Laufs — gleiche Form wie
          // komplett-analyse (`result.warnings: [{ key, params? }]`).
          this.kontinuitaetWarnings = Array.isArray(job?.result?.warnings) ? job.result.warnings : [];
          await this._loadKontinuitaetHistory();
        },
        onError: async (job) => { showError(this._kontinuitaetJobErrorText(job)); },
        onNotFound: () => { clearRunState(); },
      });
    } catch (e) {
      if (!isSelectedBook(bookId)) return;
      // 401 behandelt der globale fetch-Wrapper (Session-Banner).
      if (e.status === 401) { clearRunState(); return; }
      // Abgelehnter Start: karteneigener Hinweis bzw. error.CODE, sonst generisch.
      showError(this._kontinuitaetStartErrorText(e.body));
      if (!e.body) console.error('[_kontinuitaetStartJob]', e);
    }
  },

  // Fehlertext einer abgelehnten Start-Antwort: karteneigener Hinweis, sonst die
  // übersetzte `error.CODE`-Meldung, sonst generisch.
  _kontinuitaetStartErrorText(data) {
    const t = (k, p) => window.__app.t(k, p);
    const code = data?.error_code;
    if (code && START_ERROR_KEYS[code]) return t(START_ERROR_KEYS[code], data.params || {});
    if (code) {
      const key = 'error.' + code;
      const msg = t(key, data.params || {});
      if (msg !== key) return msg;
    }
    return t('kontinuitaet.error.startFailed');
  },

  // Terminaler Fehlstatus des Jobs: Abbruch ist kein Fehlschlag; ein konkreter
  // Fehler-Key (failJob mit i18nError) wird angehängt, Rohtext nicht.
  _kontinuitaetJobErrorText(job) {
    const t = (k, p) => window.__app.t(k, p);
    if (job?.status === 'cancelled') return t('kontinuitaet.run.cancelled');
    const err = job?.error;
    if (typeof err === 'string' && err && err !== 'job.cancelled') {
      const detail = t(err, job.errorParams || {});
      if (detail !== err) return t('kontinuitaet.error.jobFailedDetail', { detail });
    }
    return t('kontinuitaet.error.jobFailed');
  },

  async _loadKontinuitaetHistory() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    try {
      const data = await fetchJson('/jobs/kontinuitaet/' + bookId);
      if (!isSelectedBook(bookId)) return;
      this._memos = {};
      this.kontinuitaetLoadError = false;
      this.kontinuitaetResult = data;
      // Der Fokus «Nicht mehr gemeldet» ist nur sichtbar, solange es solche Befunde
      // gibt — sonst stünde der Filter auf einer leeren, unsichtbaren Liste.
      const filters = Alpine.store('catalogUi').kontinuitaetFilters;
      if (filters.fokus === 'missing' && !(data?.issues || []).some(i => i.missing_since && !i.resolved && !i.dismissed)) filters.fokus = '';
    } catch (e) {
      if (!isSelectedBook(bookId)) return;
      // Nur ohne angezeigtes Ergebnis zum Fehlerzustand: ein fehlgeschlagener
      // Refresh soll die vorhandene Liste nicht wegwerfen.
      if (!this.kontinuitaetResult) this.kontinuitaetLoadError = true;
      console.error('[_loadKontinuitaetHistory]', e);
    }
  },

  // Zusammenfassung des Checks; der Faktencheck persistiert sie als
  // `__i18n:key__`-Marker → in der Locale des Betrachters auflösen.
  kontinuitaetSummaryText() {
    const s = this.kontinuitaetResult?.summary || '';
    const key = i18nMarkerKey(s);
    return key ? window.__app.t(key) : s;
  },

  kontinuitaetSafeUrl(url) { return kontinuitaetSafeUrl(url); },
  kontinuitaetSeverity(issue) { return kontinuitaetSeverity(issue); },

  // Zeile auf-/zuklappen (Klick + Enter/Space).
  kontinuitaetToggleIssue(issue, i) {
    const key = this.kontinuitaetIssueKey(issue, i);
    this.selectedKontinuitaetIssueKey = this.selectedKontinuitaetIssueKey === key ? null : key;
  },

  // Memo-Helper (cards/card-memo.js); Reset über this._memos = {} im Lade-/Reset-Pfad (kontinuitaet-card.js).
  ...memoMethods,

  // Kapitel des Baums als Liste + Id-Index. Memoisiert, weil die Befundliste den
  // Index PRO ZEILE braucht: kontinuitaet.html liest kontinuitaetResolveStelle()
  // sechsmal je Befund, und jeder Aufruf baute vorher ein frisches, gefiltertes
  // Kapitel-Array ueber den ganzen Baum auf.
  //
  // Deps sind bewusst O(1) (ein Signatur-Durchlauf kostete genau das, was der
  // Cache spart): Baum-Referenz + Kapitelzahl. `type`/`solo`/`id` werden nie in
  // place veraendert, der Index bleibt darum gueltig. Kapitelnamen dagegen
  // schon (Buchorganizer benennt in place um) — deshalb haelt der Index die
  // LEBENDEN Baum-Objekte und es gibt bewusst KEINEN Namens-Index; die
  // Namenssuche laeuft weiter ueber `list` und sieht damit jede Umbenennung.
  _kontinuitaetChapters() {
    const tree = Alpine.store('nav').tree || [];
    return this._memo('chapters', [tree, tree.length], () => {
      const list = tree.filter(t => t.type === 'chapter');
      const byId = new Map();
      for (const c of list) if (!byId.has(c.id)) byId.set(c.id, c);
      return { list, byId };
    });
  },

  // Suchtext = was Zeile + Detail zeigen (Typ, Text, Empfehlung, Figuren, Stellen, Quelle).
  _kontinuitaetSearchText(i) {
    return [this.kontinuitaetTypLabel(i.typ), i.beschreibung, i.empfehlung, ...(i.figuren || []),
      i.stelle_a, i.stelle_b, i.quelle].filter(Boolean).join('\n').toLowerCase();
  },

  // Selektions-/Render-Key: bevorzugt die DB-Issue-ID (stabil bis zum nächsten
  // Komplettanalyse-Lauf), Fallback auf Komposit für Alt-Antworten ohne ID.
  kontinuitaetIssueKey(issue, i) {
    if (issue?.id != null) return 'id:' + issue.id;
    return (issue.typ || '') + '|' + (issue.stelle_a || '') + '|' + (issue.stelle_b || '') + '|' + i;
  },

  // Erledigt-Status umschalten. Optimistisch + Rollback bei Fehler. Gültig bis
  // zum nächsten Prüflauf (frische Issue-Zeilen, resolved=0) — anders als „kein
  // Fehler" übernimmt ein neuer Lauf „erledigt" nicht.
  async kontinuitaetToggleResolved(issue) {
    if (!issue || issue.id == null) return;
    const next = !issue.resolved;
    issue.resolved = next;
    // `resolved` wird in place umgeschaltet; Sortierung (Erledigte ans Ende) und
    // Status-Filter haengen daran → beide Memo-Slots verwerfen.
    this._invalidateKontinuitaetSort();
    try {
      await fetchJson('/jobs/kontinuitaet/issue/' + issue.id + '/resolved', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved: next }),
      });
    } catch (e) {
      issue.resolved = !next;
      this._invalidateKontinuitaetSort();
      this._kontinuitaetTriageFailed();
      console.error('[kontinuitaetToggleResolved]', e);
    }
  },

  // „Kein Fehler" umschalten. Optimistisch + Rollback. Anders als „erledigt"
  // übernehmen spätere Läufe diesen Status für denselben Befund (Server-Wiedererkennung).
  async kontinuitaetToggleDismissed(issue) {
    if (!issue || issue.id == null) return;
    const next = !issue.dismissed;
    issue.dismissed = next;
    this._invalidateKontinuitaetSort();
    try {
      await fetchJson('/jobs/kontinuitaet/issue/' + issue.id + '/dismissed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dismissed: next }),
      });
    } catch (e) {
      issue.dismissed = !next;
      this._invalidateKontinuitaetSort();
      this._kontinuitaetTriageFailed();
      console.error('[kontinuitaetToggleDismissed]', e);
    }
  },

  // Rollback sichtbar machen: ohne Hinweis springt der Knopf kommentarlos zurück.
  // 401 meldet der globale Session-Banner; der Toast steht trotzdem (harmlos).
  _kontinuitaetTriageFailed() {
    const root = window.__app;
    root?._showJobToast?.({
      message: root.t('kontinuitaet.error.triageFailed'),
      severity: 'err',
      jobType: 'kontinuitaet',
      bookId: Alpine.store('nav').selectedBookId ?? null,
    });
  },

  // Anzahl offener Befunde (nicht erledigt, nicht „kein Fehler") im aktuellen Check.
  kontinuitaetOpenCount() {
    return (this.kontinuitaetResult?.issues || []).filter(i => !i.resolved && !i.dismissed).length;
  },

  // Grund eines Verwurfs als Satz (i18n), Rohwert als Fallback.
  kontinuitaetDiscardReasonText(issue) {
    const key = 'kontinuitaet.discard.reason.' + (issue?.discard_reason || '');
    const t = window.__app.t(key);
    return t === key ? (issue?.discard_reason || '') : t;
  },

  // „Doch ein Fehler": Verwurf aufheben → der Befund ist wieder offen (Server setzt
  // dismissed=0 und löscht den Verwurfsgrund). Danach neu laden, weil der Befund von
  // `discarded` nach `issues` wandert.
  async kontinuitaetRestoreDiscarded(issue) {
    if (!issue || issue.id == null || !issue.discarded) return;
    const bookId = Alpine.store('nav').selectedBookId;
    try {
      await fetchJson('/jobs/kontinuitaet/issue/' + issue.id + '/dismissed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dismissed: false }),
      });
      if (!isSelectedBook(bookId)) return;
      await this._loadKontinuitaetHistory();
    } catch (e) {
      this._kontinuitaetTriageFailed();
      console.error('[kontinuitaetRestoreDiscarded]', e);
    }
  },

  // Menschliches Label für den Issue-Typ. Freitext-Feld (Prompt-gesteuert) → i18n-Key
  // mit Fallback auf den Rohwert, damit unbekannte/neue Typen nie leer rendern.
  kontinuitaetTypLabel(typ) {
    const t = window.__app.t('kontinuitaet.typ.' + (typ || ''));
    return t === 'kontinuitaet.typ.' + (typ || '') ? (typ || '') : t;
  },

  kontinuitaetKapitelOptionen() {
    const root = window.__app;
    const issues = this.kontinuitaetAllIssues();
    const chapters = this._kontinuitaetChapters();
    return this._memo('kapOpt', [this.kontinuitaetResult, chapters, Alpine.store('nav').pages, root._chapterLabelMap, root._chapterIdOrderMap], () => {
      const chapterOf = this._kontinuitaetChapterResolver(chapters);
      return root._kapitelOptionen(issues.flatMap(issue => [...chapterOf(issue)])
        .map(key => chapters.byId.get(Number(key))?.id ?? key));
    });
  },

  // Kapitel-IDs (als String) eines Befunds, geteilt von Filter und Filter-Auswahl.
  // Die verankerten Abschnitte (page_a_id/page_b_id) sind massgeblich: ihr Kapitel
  // stammt aus dem Baum, nicht aus dem KI-Text. Das `kapitel`-Feld des Modells
  // fehlt oft und kann einen gleichnamigen Abschnitt für ein Kapitel halten; die
  // Stelle beginnt meist mit dem Abschnitts-, nicht dem Kapitelnamen. Ist eine
  // vorhandene Stelle unverankert, kommen chapter_ids hinzu, ersatzweise ein
  // EINDEUTIGER Kapitelname aus `kapitel` oder vor dem Doppelpunkt der Stelle (ein
  // Name, den zwei Kapitel tragen, löst nicht auf).
  _kontinuitaetChapterResolver(chapters) {
    const pageChapter = new Map();
    for (const p of Alpine.store('nav').pages || []) if (p.chapter_id != null) pageChapter.set(p.id, p.chapter_id);
    const nameIds = new Map();
    for (const c of chapters.list) if (!c.solo) nameIds.set(c.name, nameIds.has(c.name) ? null : c.id);
    const idOfName = (n) => (n ? nameIds.get(String(n).trim()) ?? null : null);
    const fromStelle = (s) => {
      if (!s) return null;
      const ci = s.indexOf(':');
      return idOfName(ci > 0 ? s.substring(0, ci) : s);
    };
    return (issue) => {
      const ids = new Set();
      let allAnchored = true;
      for (const [st, pid] of [[issue.stelle_a, issue.page_a_id], [issue.stelle_b, issue.page_b_id]]) {
        const cid = pid != null ? pageChapter.get(pid) : null;
        if (cid != null && chapters.byId.has(cid)) ids.add(String(cid));
        else if (st) allAnchored = false;
      }
      if (ids.size && allAnchored) return ids;
      const anchored = ids.size;
      for (const id of issue.chapter_ids || []) if (chapters.byId.has(id)) ids.add(String(id));
      if (ids.size > anchored) return ids;
      for (const k of issue.kapitel || []) { const id = idOfName(k); if (id != null) ids.add(String(id)); }
      for (const st of [issue.stelle_a, issue.stelle_b]) { const id = fromStelle(st); if (id != null) ids.add(String(id)); }
      return ids;
    };
  },

  // Löst "stelle_a/stelle_b" zu einem Page-Objekt auf. `stelle` ist ein
  // LLM-generierter String – nominal "Kapitel: «Zitat»", in der Praxis auch
  // "Kapitel, Abschnitt «Zitat»", "Abschnitt: «Zitat»" (das Modell sieht im Prompt
  // die Abschnittstitel als `### Titel`) oder nur "Kapitel". Reihenfolge:
  //   1. Seiten-Anker vom Speichern (Zitat im Buchtext gefunden) — autoritativ.
  //   2. Kapitel aus issue.chapter_ids, sonst ein Verweis-Segment, das exakt ein
  //      Kapitelname ist; darin ein Segment mit Abschnittsnamen, sonst die erste
  //      Kapitelseite.
  //   3. Ohne Kapitel: ein Segment, das buchweit genau EINEN Abschnitt benennt.
  //   4. Ein Kapitelname, der im Verweis-Teil vorkommt (längster Treffer).
  // Reine Kapitelreferenz verlinkt IMMER auf die erste Kapitelseite, NIE auf einen
  // gleichnamigen Abschnitt; ein mehrdeutiger Abschnittsname ohne Kapitelkontext
  // bleibt unaufgelöst — lieber kein Link als ein falscher.
  kontinuitaetResolveStelle(stelle, issue, side) {
    if (!stelle) return null;
    return this._kontinuitaetResolveStelleDetail(stelle, issue, side)?.page || null;
  },

  // { page, chapterRef, approx } — chapterRef = die Stelle nennt nur ein Kapitel,
  // keinen Abschnitt; approx = kein Abschnitt gefunden, `page` ist nur der
  // Kapitelanfang (Karte kennzeichnet das, statt still dorthin zu springen).
  _kontinuitaetResolveStelleDetail(stelle, issue, side) {
    const chapters = this._kontinuitaetChapters();
    const anchorId = side === 'b' ? issue?.page_b_id : issue?.page_a_id;
    if (anchorId != null) {
      for (const c of chapters.list) {
        const hit = (c.pages || []).find(p => p.id === anchorId);
        if (hit) return { page: hit, chapterRef: false };
      }
    }
    const lc = (s) => String(s || '').trim().toLowerCase();
    // Verweis-Teil ohne Zitate, in Segmente zerlegt («Kapitel: Abschnitt», «A › B», «A, B»).
    const ref = String(stelle).replace(/[«„"“][^»"”“]*[»"”“]?/g, ' ');
    const segs = ref.split(/\s*(?::|›|>|,|\s[–—-]\s)\s*/).map(s => s.trim()).filter(Boolean);
    const segsLc = segs.map(lc);

    const chIds = issue?.chapter_ids || [];
    const idx = side === 'b' && chIds.length > 1 ? 1 : 0;
    const chapter = (chIds[idx] ? chapters.byId.get(chIds[idx]) : null)
      || chapters.list.find(c => segs.includes(c.name))
      || chapters.list.find(c => segsLc.includes(lc(c.name)))
      || null;

    if (chapter) {
      const pages = this._kontinuitaetSubtreePages(chapter, chapters.list);
      const chName = lc(chapter.name);
      for (const s of segsLc) {
        if (s === chName) continue;
        const hit = pages.find(p => lc(p.name) === s);
        if (hit) return { page: hit, chapterRef: false };
      }
      const first = chapter.pages?.[0] || pages[0] || null;
      if (!first) return null;
      const chapterRef = segsLc.length > 0 && segsLc.every(s => s === chName);
      return { page: first, chapterRef, approx: !chapterRef };
    }

    const allPages = chapters.list.flatMap(c => c.pages || []);
    for (const s of segsLc) {
      const hits = allPages.filter(p => lc(p.name) === s);
      if (hits.length === 1) return { page: hits[0], chapterRef: false };
    }

    const refLc = lc(ref);
    const contained = chapters.list
      .filter(c => !c.solo && lc(c.name).length >= 3 && refLc.includes(lc(c.name)))
      .sort((a, b) => b.name.length - a.name.length)[0];
    const first = contained ? (contained.pages?.[0] || this._kontinuitaetSubtreePages(contained, chapters.list)[0]) : null;
    return first ? { page: first, chapterRef: false, approx: true } : null;
  },

  // Abschnitte eines Kapitels inkl. aller Unterkapitel (nav.tree ist flach, parent_id).
  _kontinuitaetSubtreePages(chapter, list) {
    const out = [...(chapter.pages || [])];
    const stack = [chapter.id];
    while (stack.length) {
      const pid = stack.pop();
      for (const c of list) {
        if (c.parent_id === pid && c !== chapter) { out.push(...(c.pages || [])); stack.push(c.id); }
      }
    }
    return out;
  },

  // Spec für die Entitäts-Referenz einer Stelle (x-entity-ref). Label bleibt
  // der KI-Text. Eine reine Kapitelreferenz verweist aufs Kapitel (→ Kapitel-
  // bewertung), sonst auf den aufgelösten Abschnitt; ohne Treffer bleibt die
  // Referenz unaufgelöst (siehe kontinuitaetResolveStelle).
  kontinuitaetStelleRef(stelle, issue, side) {
    const label = stelle || '';
    const hit = stelle ? this._kontinuitaetResolveStelleDetail(stelle, issue, side) : null;
    if (!hit) return { type: 'seite', label };
    if (hit.chapterRef) {
      const ch = this._kontinuitaetChapters().list.find(c => (c.pages || []).includes(hit.page));
      if (ch) return { type: 'kapitel', id: ch.id, label };
    }
    return { type: 'seite', id: hit.page.id, label };
  },

  // true = die Stelle verlinkt nur den Kapitelanfang, weil kein Abschnitt passt.
  kontinuitaetStelleApprox(stelle, issue, side) {
    if (!stelle) return false;
    return !!this._kontinuitaetResolveStelleDetail(stelle, issue, side)?.approx;
  },

  // Namens-/Konsistenz-Waechter (eigenes Modul, gleiche Karte).
  ...nameGuardMethods,
  ...kontinuitaetViewMethods,
};
