// Kontinuitätsprüfer-Methoden (werden in Alpine.data('kontinuitaetCard')
// gespreadet). Ergebnisse stammen aus der Komplettanalyse (Phase 8) und werden
// via _loadKontinuitaetHistory (GET) angezeigt; Anzeige + Filter + Resolve-Toggle.

import { fetchJson, escHtml } from '../utils.js';
import { i18nMarkerKey } from '../i18n.js';
import { startPoll, runningJobStatus } from '../cards/job-helpers.js';
import { isSelectedBook } from '../cards/book-guard.js';
import { memoMethods } from '../cards/card-memo.js';

// Server-Fehlercodes der Start-Routen → Hinweis in der Karte (Rest: generisch).
const START_ERROR_KEYS = {
  CONTINUITY_PROVIDER_UNSUPPORTED: 'kontinuitaet.error.providerUnsupported',
  FACTCHECK_NOT_ENABLED_FOR_BOOK: 'kontinuitaet.faktencheck.hint',
  FACTCHECK_CLAUDE_ONLY: 'kontinuitaet.faktencheck.claudeOnly',
  FACTCHECK_DISABLED: 'kontinuitaet.faktencheck.disabled',
  KOMPLETT_ANALYSIS_RUNNING: 'error.KOMPLETT_ANALYSIS_RUNNING',
};

// Triage-Status eines Befunds (Filter `status`): '' = aktiv (offen + erledigt, ohne
// „kein Fehler"), 'open' = nur offene, 'resolved' = nur erledigte, 'dismissed' = nur
// als „kein Fehler" markierte.
export const KONTINUITAET_STATUS_FILTERS = ['', 'open', 'resolved', 'dismissed'];
function _matchesStatus(issue, status) {
  if (status === 'dismissed') return !!issue.dismissed;
  if (issue.dismissed) return false;
  if (status === 'open') return !issue.resolved;
  if (status === 'resolved') return !!issue.resolved;
  return true;
}

// Schwere eines Befunds, normalisiert: fehlend/unbekannt = niedrig. SSoT für
// Filter, Sortierung, Tab-Zähler und Tag — sonst zählt ein Tab andere Zeilen,
// als sein Filter zeigt.
export const KONTINUITAET_SEVERITIES = ['kritisch', 'mittel', 'niedrig'];
export function kontinuitaetSeverity(issue) {
  const s = issue?.schwere;
  return KONTINUITAET_SEVERITIES.includes(s) ? s : 'niedrig';
}

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
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, book_name: root.selectedBookName || '' }),
      });
      const data = await resp.json().catch(() => ({}));
      // Buchwechsel während des Starts: der Reset (book:changed) hat die Karte
      // schon geleert — nichts mehr hineinschreiben, keinen Poller anhängen.
      if (!isSelectedBook(bookId)) return;
      if (!resp.ok || !data.jobId) {
        // 401 behandelt der globale fetch-Wrapper (Session-Banner).
        if (resp.status === 401) { clearRunState(); return; }
        showError(this._kontinuitaetStartErrorText(data));
        return;
      }
      startPoll(this, {
        jobId: data.jobId,
        timerProp: '_kontinuitaetPollTimer',
        progressProp: 'kontinuitaetProgress',
        onProgress: (job) => {
          this.kontinuitaetStatus = runningJobStatus(
            root.t, job.statusText, job.tokensIn, job.tokensOut,
            Alpine.store('config').claudeMaxTokens, job.progress, job.tps, job.statusParams);
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
      showError(root.t('kontinuitaet.error.startFailed'));
      console.error('[_kontinuitaetStartJob]', e);
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

  // Alle Filter auf ihre Defaults (Zustand „Alle weggefiltert").
  kontinuitaetResetFilters() {
    Object.assign(Alpine.store('catalogUi').kontinuitaetFilters, { figurId: '', kapitel: '', schwere: '', status: '' });
  },

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

  // Issues gefiltert nach UI-Filtern (figurId, kapitel). Reads figuren+tree
  // from root. Muss eine Methode sein (keine `get`-Syntax): `kontinuitaetMethods`
  // wird per `...spread` in die Alpine.data-Factory übernommen, und Spread ruft
  // Getter auf und speichert nur den Wert — die Reaktivität auf Filter/Result
  // ginge verloren, und der Wert wäre zur Spread-Zeit `[]`.
  //
  // Memoisiert, weil das Template die Liste (ueber kontinuitaetIssuesSorted)
  // viermal pro Render liest und jeder Durchlauf den Kapitelnamen-Index neu aufbaute.
  kontinuitaetIssuesFiltered() {
    const filters = Alpine.store('catalogUi').kontinuitaetFilters;
    const issues = this.kontinuitaetResult?.issues || [];
    const chapters = this._kontinuitaetChapters();
    const figuren = window.__app.$store.catalog.figuren || [];
    return this._memo(
      'filtered',
      [issues, chapters, figuren, filters.figurId, filters.kapitel, filters.schwere, filters.status],
      () => this._computeKontinuitaetIssuesFiltered(issues, chapters, figuren, filters),
    );
  },

  _computeKontinuitaetIssuesFiltered(issues, chapters, figuren, filters) {
    const chapterNames = new Set(chapters.list.map(t => t.name));
    const fromStelle = (s) => {
      if (!s) return null;
      const ci = s.indexOf(':');
      const c = ci > 0 ? s.substring(0, ci).trim() : s.trim();
      return chapterNames.has(c) ? c : null;
    };
    return issues.filter(issue => {
      if (!_matchesStatus(issue, filters.status || '')) return false;
      if (filters.figurId) {
        if (issue.fig_ids?.length) {
          if (!issue.fig_ids.includes(filters.figurId)) return false;
        } else {
          const selectedName = figuren.find(f => f.id === filters.figurId)?.name || '';
          if (selectedName && !(issue.figuren || []).includes(selectedName)) return false;
        }
      }
      if (filters.kapitel) {
        const f = filters.kapitel;
        const selectedId = chapters.list.find(t => t.name === f)?.id;
        const idMatch    = selectedId !== undefined && issue.chapter_ids?.includes(selectedId);
        const nameMatch  = (issue.kapitel || []).includes(f);
        const stelleMatch = fromStelle(issue.stelle_a) === f || fromStelle(issue.stelle_b) === f;
        if (!idMatch && !nameMatch && !stelleMatch) return false;
      }
      if (filters.schwere && kontinuitaetSeverity(issue) !== filters.schwere) return false;
      return true;
    });
  },

  // Memoisiert auf die (ihrerseits memoisierte) gefilterte Liste: das Template
  // liest sie viermal pro Render (Zaehler, Leer-Zustand, x-for).
  kontinuitaetIssuesSorted() {
    const filtered = this.kontinuitaetIssuesFiltered();
    return this._memo('sorted', [filtered], () => this._sortKontinuitaetIssues(filtered));
  },

  _sortKontinuitaetIssues(filtered) {
    const order = { kritisch: 0, mittel: 1, niedrig: 2 };
    const list = filtered.slice();
    list.sort((a, b) => {
      // Erledigte ans Ende, danach nach Schwere.
      const ra = a.resolved ? 1 : 0;
      const rb = b.resolved ? 1 : 0;
      if (ra !== rb) return ra - rb;
      return order[kontinuitaetSeverity(a)] - order[kontinuitaetSeverity(b)];
    });
    return list;
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

  // Status-Wechsel in place: gefilterte UND sortierte Liste sowie Tab-Zähler neu berechnen.
  _invalidateKontinuitaetSort() {
    if (this._memos) { delete this._memos.sorted; delete this._memos.filtered; delete this._memos.counts; }
  },

  // Anzahl offener Befunde (nicht erledigt, nicht „kein Fehler") im aktuellen Check.
  kontinuitaetOpenCount() {
    return (this.kontinuitaetResult?.issues || []).filter(i => !i.resolved && !i.dismissed).length;
  },

  // Befunde, die der Status-Filter zeigt — Basis der Schwere-Zähler in den Tabs,
  // damit „Kritisch 3" auch drei sichtbare Zeilen meint.
  kontinuitaetIssuesInStatus() {
    const status = Alpine.store('catalogUi').kontinuitaetFilters.status || '';
    return (this.kontinuitaetResult?.issues || []).filter(i => _matchesStatus(i, status));
  },

  // Tab-Zähler { all, kritisch, mittel, niedrig } im aktuellen Status-Filter,
  // mit derselben Schwere-Normalisierung wie der Filter. Memoisiert (pro Render
  // sieben Lesezugriffe).
  kontinuitaetSeverityCounts() {
    const status = Alpine.store('catalogUi').kontinuitaetFilters.status || '';
    const issues = this.kontinuitaetResult?.issues || [];
    return this._memo('counts', [issues, status], () => {
      const counts = { all: 0, kritisch: 0, mittel: 0, niedrig: 0 };
      for (const i of issues) {
        if (!_matchesStatus(i, status)) continue;
        counts.all++;
        counts[kontinuitaetSeverity(i)]++;
      }
      return counts;
    });
  },

  // Menschliches Label für den Issue-Typ. Freitext-Feld (Prompt-gesteuert) → i18n-Key
  // mit Fallback auf den Rohwert, damit unbekannte/neue Typen nie leer rendern.
  kontinuitaetTypLabel(typ) {
    const t = window.__app.t('kontinuitaet.typ.' + (typ || ''));
    return t === 'kontinuitaet.typ.' + (typ || '') ? (typ || '') : t;
  },

  kontinuitaetKapitelListe() {
    const root = window.__app;
    const chapters = this._kontinuitaetChapters();
    const chapterNames = new Set(chapters.list.map(t => t.name));
    const fromStelle = (s) => {
      if (!s) return null;
      const ci = s.indexOf(':');
      const c = ci > 0 ? s.substring(0, ci).trim() : s.trim();
      return chapterNames.has(c) ? c : null;
    };
    const names = new Set();
    for (const issue of (this.kontinuitaetResult?.issues || [])) {
      if (issue.chapter_ids?.length) {
        for (const id of issue.chapter_ids) { const n = chapters.byId.get(id)?.name; if (n) names.add(n); }
      }
      if (issue.kapitel?.length) {
        for (const k of issue.kapitel) if (k && chapterNames.has(k)) names.add(k);
      }
      const a = fromStelle(issue.stelle_a); if (a) names.add(a);
      const b = fromStelle(issue.stelle_b); if (b) names.add(b);
    }
    return root._sortByChapterOrder([...names]);
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

  // ── Namens-/Konsistenz-Waechter ────────────────────────────────────────────
  // Regelbasierte Erkennung buchweiter Schreibvarianten/Tippfehler von Eigennamen
  // (Figuren + Orte). Synchroner Endpunkt, kein KI-Job. Auf Knopfdruck.
  // Das Ergebnis trägt seine bookId mit: nameGuardIgnore schreibt die Ignore-Liste
  // des Buchs, zu dem der Cluster gehört, nicht des gerade gewählten.
  async nameGuardRun() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.nameGuardLoading) return;
    this.nameGuardLoading = true;
    try {
      const data = await fetchJson('/name-guard/' + bookId + '/check', { method: 'POST' });
      if (!isSelectedBook(bookId)) return;
      this.nameGuardResult = { ...data, bookId };
      this.selectedNameGuardKey = null;
    } catch (e) {
      if (!isSelectedBook(bookId)) return;
      console.error('[nameGuardRun]', e);
      this.nameGuardResult = { clusters: [], error: true, bookId };
    } finally {
      // Nach Buchwechsel hat der Reset nameGuardLoading schon zurückgesetzt.
      if (isSelectedBook(bookId)) this.nameGuardLoading = false;
    }
  },

  nameGuardKey(cluster) {
    return 'ng:' + (cluster?.canonical || '');
  },

  // Cluster-Zeile auf-/zuklappen (Klick + Enter/Space).
  nameGuardToggle(cluster) {
    const key = this.nameGuardKey(cluster);
    this.selectedNameGuardKey = this.selectedNameGuardKey === key ? null : key;
  },

  nameGuardConfidenceSeverity(conf) {
    // Auf die bestehende severity-tag-Farbskala mappen (Farbe = Aufmerksamkeit):
    // hohe Konfidenz = stark hervorgehoben.
    return conf === 'hoch' ? 'kritisch' : (conf === 'mittel' ? 'mittel' : 'niedrig');
  },

  // Eine Variante als gewollt akzeptieren → serverseitige Ignore-Liste + lokal entfernen.
  async nameGuardIgnore(cluster, variant) {
    const result = this.nameGuardResult;
    const bookId = result?.bookId;
    if (!bookId || !cluster || !variant || !isSelectedBook(bookId)) return;
    try {
      await fetchJson('/name-guard/' + bookId + '/ignore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canonical: cluster.canonical, variant: variant.form }),
      });
      // Gespeichert ist es; die lokale Liste nur anfassen, wenn sie noch dieses Ergebnis zeigt.
      if (!isSelectedBook(bookId) || this.nameGuardResult !== result) return;
      cluster.variants = (cluster.variants || []).filter(v => v.form !== variant.form);
      if (!cluster.variants.length && this.nameGuardResult?.clusters) {
        this.nameGuardResult.clusters = this.nameGuardResult.clusters.filter(c => c !== cluster);
      }
    } catch (e) {
      console.error('[nameGuardIgnore]', e);
    }
  },
};
