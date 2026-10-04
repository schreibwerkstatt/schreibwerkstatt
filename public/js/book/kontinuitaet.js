// Kontinuitätsprüfer-Methoden (werden in Alpine.data('kontinuitaetCard')
// gespreadet). Ergebnisse stammen aus der Komplettanalyse (Phase 8) und werden
// via _loadKontinuitaetHistory (GET) angezeigt; Anzeige + Filter + Resolve-Toggle.

import { fetchJson, escHtml } from '../utils.js';
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
// „kein Fehler"), 'open' = nur offene, 'dismissed' = nur als „kein Fehler" markierte.
function _matchesStatus(issue, status) {
  if (status === 'dismissed') return !!issue.dismissed;
  if (issue.dismissed) return false;
  if (status === 'open') return !issue.resolved;
  return true;
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
  kontinuitaetRun() { return this._kontinuitaetStartJob('/jobs/kontinuitaet', 'kontinuitaet.run.starting'); },
  faktencheckRun() { return this._kontinuitaetStartJob('/jobs/faktencheck', 'kontinuitaet.faktencheck.starting'); },

  async _kontinuitaetStartJob(url, startingKey) {
    const root = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.kontinuitaetLoading) return;
    this.kontinuitaetLoading = true;
    this.kontinuitaetProgress = 1;
    this.kontinuitaetStatus = runningJobStatus(root.t, startingKey);
    const clearRunState = () => {
      this.kontinuitaetLoading = false;
      this.kontinuitaetProgress = 0;
      this.kontinuitaetStatus = '';
    };
    const showError = (key) => {
      clearRunState();
      this.kontinuitaetStatus = `<span>${escHtml(root.t(key))}</span>`;
    };
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, book_name: root.selectedBookName || '' }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.jobId) {
        // 401 behandelt der globale fetch-Wrapper (Session-Banner).
        if (resp.status === 401) { clearRunState(); return; }
        showError(START_ERROR_KEYS[data.error_code] || 'kontinuitaet.error.startFailed');
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
        onDone: async () => { clearRunState(); await this._loadKontinuitaetHistory(); },
        onError: async () => { showError('kontinuitaet.error.jobFailed'); },
        onNotFound: () => { clearRunState(); },
      });
    } catch (e) {
      showError('kontinuitaet.error.startFailed');
      console.error('[_kontinuitaetStartJob]', e);
    }
  },

  async _loadKontinuitaetHistory() {
    const bookId = Alpine.store('nav').selectedBookId;
    try {
      const data = await fetchJson('/jobs/kontinuitaet/' + bookId);
      if (!isSelectedBook(bookId)) return;
      this._memos = {};
      this.kontinuitaetResult = data;
    } catch (e) {
      console.error('[_loadKontinuitaetHistory]', e);
    }
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
      if (filters.schwere) {
        const s = issue.schwere || 'niedrig';
        if (s !== filters.schwere) return false;
      }
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
      const sa = order[a.schwere || 'niedrig'] ?? 2;
      const sb = order[b.schwere || 'niedrig'] ?? 2;
      return sa - sb;
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
  // zur nächsten Komplettanalyse (frische Issue-Zeilen, resolved=0).
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
      console.error('[kontinuitaetToggleDismissed]', e);
    }
  },

  // Status-Wechsel in place: gefilterte UND sortierte Liste neu berechnen.
  _invalidateKontinuitaetSort() {
    if (this._memos) { delete this._memos.sorted; delete this._memos.filtered; }
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
  // LLM-generierter String – Format nominal "Kapitel: Seite", kann aber
  // auch nur "Kapitel" sein. Authoritativer Kontext: issue.chapter_ids.
  //
  // Wichtig: Reine Kapitelreferenz (kein ":" oder part1 == Kapitelname)
  // verlinkt IMMER auf die erste Kapitelseite, NIE auf eine gleichnamige
  // Seite – sonst landet "Der Vater" (Kapitel) versehentlich auf einer
  // Seite namens "Der Vater" (in irgendeinem Kapitel). Globalen Page-
  // Fallback gibt es nicht: ohne Kapitelkontext kein Link.
  kontinuitaetResolveStelle(stelle, issue, side) {
    if (!stelle) return null;
    const chapters = this._kontinuitaetChapters();
    // Seiten-Anker aus dem Speichern (Zitat bzw. zitierter Fakt im Buchtext gefunden)
    // ist autoritativ — er zeigt auf die Seite der Stelle, nicht auf die erste
    // Kapitelseite. Fehlt er (Altbefund, Stelle nicht auffindbar), greift die
    // Namensauflösung unten.
    const anchorId = side === 'b' ? issue?.page_b_id : issue?.page_a_id;
    if (anchorId != null) {
      for (const c of chapters.list) {
        const hit = (c.pages || []).find(p => p.id === anchorId);
        if (hit) return hit;
      }
    }
    const chIds = issue?.chapter_ids || [];
    const idx = side === 'b' && chIds.length > 1 ? 1 : 0;
    const targetCh = chIds[idx] ? (chapters.byId.get(chIds[idx]) || null) : null;

    const ci = stelle.indexOf(':');
    const part1 = (ci > 0 ? stelle.slice(0, ci) : stelle).trim();
    const part2 = ci > 0 ? stelle.slice(ci + 1).trim() : '';

    const chapter = targetCh || chapters.list.find(c => c.name === part1) || null;
    if (!chapter) return null;

    const pageByName = (pages, needle) => {
      if (!pages?.length || !needle) return null;
      const nLower = needle.toLowerCase();
      return pages.find(p => p.name === needle)
        || pages.find(p => p.name.toLowerCase() === nLower)
        || null;
    };

    if (!part2) {
      // Reine Kapitelreferenz → erste Kapitelseite (auch wenn gleichnamige
      // Seite existiert). Wenn part1 nicht der Kapitelname ist, kann es
      // ein Seitenname innerhalb des Kapitels sein.
      if (part1.toLowerCase() === chapter.name.toLowerCase()) {
        return chapter.pages?.[0] || null;
      }
      return pageByName(chapter.pages, part1) || chapter.pages?.[0] || null;
    }
    return pageByName(chapter.pages, part2) || chapter.pages?.[0] || null;
  },

  // Spec für die Entitäts-Referenz einer Stelle (x-entity-ref). Label bleibt
  // der KI-Text. Eine reine Kapitelreferenz verweist aufs Kapitel (→ Kapitel-
  // bewertung), sonst auf die über kontinuitaetResolveStelle aufgelöste Seite;
  // ohne Treffer bleibt die Referenz unaufgelöst (kein globaler Seiten-Fallback).
  kontinuitaetStelleRef(stelle, issue, side) {
    const label = stelle || '';
    const page = this.kontinuitaetResolveStelle(stelle, issue, side);
    if (!page) return { type: 'seite', label };
    const ch = this._kontinuitaetChapters().list.find(c => (c.pages || []).includes(page)) || null;
    const ci = label.indexOf(':');
    const part1 = (ci > 0 ? label.slice(0, ci) : label).trim().toLowerCase();
    if (ch && ci <= 0 && part1 === String(ch.name || '').toLowerCase()) {
      return { type: 'kapitel', id: ch.id, label };
    }
    return { type: 'seite', id: page.id, label };
  },

  // ── Namens-/Konsistenz-Waechter ────────────────────────────────────────────
  // Regelbasierte Erkennung buchweiter Schreibvarianten/Tippfehler von Eigennamen
  // (Figuren + Orte). Synchroner Endpunkt, kein KI-Job. Auf Knopfdruck.
  async nameGuardRun() {
    const root = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.nameGuardLoading) return;
    this.nameGuardLoading = true;
    try {
      const data = await fetchJson('/name-guard/' + bookId + '/check', { method: 'POST' });
      this.nameGuardResult = data;
      this.selectedNameGuardKey = null;
    } catch (e) {
      console.error('[nameGuardRun]', e);
      this.nameGuardResult = { clusters: [], error: true };
    } finally {
      this.nameGuardLoading = false;
    }
  },

  nameGuardKey(cluster) {
    return 'ng:' + (cluster?.canonical || '');
  },

  nameGuardConfidenceSeverity(conf) {
    // Auf die bestehende severity-tag-Farbskala mappen (Farbe = Aufmerksamkeit):
    // hohe Konfidenz = stark hervorgehoben.
    return conf === 'hoch' ? 'kritisch' : (conf === 'mittel' ? 'mittel' : 'niedrig');
  },

  // Eine Variante als gewollt akzeptieren → serverseitige Ignore-Liste + lokal entfernen.
  async nameGuardIgnore(cluster, variant) {
    const root = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !cluster || !variant) return;
    try {
      await fetchJson('/name-guard/' + bookId + '/ignore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canonical: cluster.canonical, variant: variant.form }),
      });
      cluster.variants = (cluster.variants || []).filter(v => v.form !== variant.form);
      if (!cluster.variants.length && this.nameGuardResult?.clusters) {
        this.nameGuardResult.clusters = this.nameGuardResult.clusters.filter(c => c !== cluster);
      }
    } catch (e) {
      console.error('[nameGuardIgnore]', e);
    }
  },
};
