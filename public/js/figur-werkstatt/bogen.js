// Figuren-Werkstatt — Bogen im Buch (Ist-Index + Messung).
//
// Das Pendant zum Kapitel-Verlaufsband der Motiv-Werkstatt und zum Drift-Badge
// der Plot-Werkstatt: Kern × Kapitel als Heatmap. Jede Zeile ein psychologischer
// Kern (want/need/wound/lie/bogen/konflikt), jede Spalte ein Kapitel in Lese-
// reihenfolge, Zell-Intensität = Ist-Dichte aus `draft_figure_occurrences`.
//
// Warum das die zentrale Ansicht der Werkstatt ist: die Mindmap sagt, was die
// Figur sein SOLL. Ob ihre Wunde im Text trägt und ob ihre Lüge irgendwo
// bricht, stand bisher nirgends — und genau das IST der Figurenbogen. Rein
// rückwärtsgewandt, nie generativ im Text.
//
// Datenpfad: GET /draft-figures/:bookId/arc liefert Ist-Zahlen, Kapitel-
// Aufschlüsselung UND die Messbefunde in EINER Antwort — dieselbe Liste, die
// die Befund-Sammelstelle liest (ein zweiter Lesepfad zeigte zwei Bestände).

import { fetchJson } from '../utils.js';
import { startWerkstattJobPoll, reattachWerkstattJob } from './job-poll.js';
import { werkstattErrorText } from './crud.js';

export const bogenMethods = {
  // Kapitel in Lesereihenfolge (depth-first) aus dem Sidebar-Tree — nur echte
  // Kapitel, wortgleich mit dem Motiv-Band: `occChapters` kennt nur echte
  // chapter_ids, Solo-Seiten fallen server-seitig raus.
  arcChapters() {
    return this._memo('arcChapters', [this.$store.nav.tree], () =>
      (this.$store.nav.tree || [])
        .filter(t => t.type === 'chapter' && !t.solo)
        .map(t => ({ id: t.id, name: t.name, depth: t.depth || 1 })));
  },

  // Der Bogen-Datensatz der AUSGEWÄHLTEN Figur. Ohne Lauf (`arc === null`)
  // bleibt er null und das Band zeigt seinen Leerzustand — nicht eine Tabelle
  // aus Nullen, die wie ein Befund aussähe.
  arcDraft() {
    return this._memo('arcDraft', [this.arc, this.selectedDraftId], () => {
      if (!this.arc || !this.selectedDraftId) return null;
      return (this.arc.drafts || []).find(d => d.id === this.selectedDraftId) || null;
    });
  },

  // Sichtbar, sobald die Figur überhaupt einen ausgearbeiteten Kern hat —
  // auch ohne Lauf. Dann trägt das Band den „noch nicht verankert"-Hinweis
  // statt zu verschwinden (gleiche Regel wie die Alters-Tabelle: sie
  // funktioniert ohne Lauf).
  arcVisible() {
    const d = this.arcDraft();
    if (!d) return false;
    return Object.values(d.geplant || {}).some(Boolean);
  },

  // Zeilen des Bands: nur GEPLANTE Kerne. Ein Kern, den der Autor nicht
  // ausgearbeitet hat, ist keine leere Zeile, sondern keine Zeile — sonst steht
  // die halbe Tabelle als Vorwurf da, wo nichts behauptet wurde.
  arcKerne() {
    return this._memo('arcKerne', [this.arcDraft(), this.arc], () => {
      const d = this.arcDraft();
      if (!d) return [];
      return (this.arc?.kerne || []).filter(k => d.geplant?.[k]);
    });
  },

  // Fundstellen-Index der gewählten Figur: kern → Map(chapterId → n).
  _arcIndex() {
    return this._memo('arcIndex', [this.arcDraft()], () => {
      const idx = new Map();
      const d = this.arcDraft();
      for (const [kern, rows] of Object.entries(d?.occ || {})) {
        const byCh = new Map();
        for (const r of rows) byCh.set(r.chapterId, r.n);
        idx.set(kern, byCh);
      }
      return idx;
    });
  },

  arcCount(kern, chapterId) {
    return this._arcIndex().get(kern)?.get(chapterId) || 0;
  },

  arcRowTotal(kern) {
    return this.arcDraft()?.counts?.[kern] || 0;
  },

  // Normierungs-Basis der Intensität: grösste Zellenzahl dieser Figur.
  arcMax() {
    return this._memo('arcMax', [this.arcDraft()], () => {
      let max = 0;
      for (const byCh of this._arcIndex().values()) {
        for (const n of byCh.values()) if (n > max) max = n;
      }
      return max;
    });
  },

  arcCellClass(n) {
    return n > 0 ? 'heatmap-cell--primary' : 'heatmap-cell--empty';
  },

  // √-gedämpft mit Boden bei 14 % — wortgleich mit dem Motiv-Band, damit
  // dieselbe Färbung in beiden Karten dasselbe heisst.
  arcCellVars(n) {
    const max = this.arcMax();
    if (n <= 0 || max <= 0) return {};
    const t = Math.max(14, Math.round(Math.sqrt(n / max) * 100));
    return { '--heatmap-t': t + '%' };
  },

  // SSoT für :class-Bindung UND Handler: eine leere Zelle hat nichts
  // aufzulösen und darf weder Klick-Cursor noch Tab-Stopp anbieten.
  arcCellClickable(kern, chapterId) {
    return this.arcCount(kern, chapterId) > 0;
  },

  arcKernLabel(kern) {
    return window.__app.t('werkstatt.tree.' + kern) || kern;
  },

  // ── Zell-Detail: die Fundstellen hinter einer Färbung ─────────────────────
  arcDetailKey(kern, chapterId) { return `${kern}:${chapterId}`; },

  async toggleArcDetail(kern, chapterId) {
    if (!this.arcCellClickable(kern, chapterId)) return;
    const key = this.arcDetailKey(kern, chapterId);
    if (this.activeArcDetailKey === key) { this.activeArcDetailKey = null; return; }
    this.activeArcDetailKey = key;
    await this._ensureArcOccurrences();
  },

  // Fundstellen der gewählten Figur einmal holen und merken — eine Bandzeile
  // hat so viele Zellen wie das Buch Kapitel. Cache lebt bis zum nächsten
  // loadArc() (ein Anchor-Lauf verschiebt die Zahlen darunter).
  async _ensureArcOccurrences() {
    const id = this.selectedDraftId;
    if (!id || this.arcOccCache[id]) return;
    this.arcDetailLoading = true;
    try {
      const rows = await fetchJson(`/draft-figures/by-id/${id}/occurrences`);
      // NEUES Objekt statt Mutation: arcActiveDetail() memoisiert über die
      // Cache-Referenz — eine In-Place-Ergänzung verschiebt sie nicht und das
      // Detail bliebe nach dem Laden leer.
      this.arcOccCache = { ...this.arcOccCache, [id]: Array.isArray(rows) ? rows : [] };
    } catch {
      // Fundstellen sind optional: kein harter Fehler und NICHT als leere Liste
      // cachen — sonst gälte ein Netz-Aussetzer bis zum nächsten Laden als
      // „Kapitel ohne Fundstellen"; ein zweiter Klick darf es erneut versuchen.
    } finally { this.arcDetailLoading = false; }
  },

  arcActiveDetail() {
    return this._memo('arcActiveDetail',
      [this.activeArcDetailKey, this.arcOccCache, this.selectedDraftId, this.$store.nav.tree],
      () => this._computeArcActiveDetail());
  },

  _computeArcActiveDetail() {
    const key = this.activeArcDetailKey;
    if (!key) return null;
    const [kern, chapterIdStr] = key.split(':');
    const chapterId = parseInt(chapterIdStr, 10);
    const chapter = this.arcChapters().find(c => c.id === chapterId);
    if (!chapter) return null;
    const loaded = this.arcOccCache[this.selectedDraftId];
    return {
      key, kern, chapterId,
      kernLabel: this.arcKernLabel(kern),
      chapterName: chapter.name,
      count: this.arcCount(kern, chapterId),
      occurrences: loaded ? loaded.filter(o => o.kern === kern && o.chapter_id === chapterId) : [],
    };
  },

  // Sprung an die belegende Textstelle (wie im Motiv-Panel und im Plot-
  // Fundstellen-Popover). Szenen-Funde tragen ihre Ankerseite.
  gotoArcOccurrence(occ) {
    const pageId = occ?.page_id || occ?.scene_page_id;
    if (!pageId) return;
    window.__app.gotoPageById(pageId);
  },

  // ── Messbefunde dieser Figur ──────────────────────────────────────────────
  // Die Messung ist gratis und immer aktuell; das KI-Urteil bleibt der
  // Consistency-Lauf. `quelle` trennt beides sichtbar (wie in der Motiv-
  // Werkstatt) — eine Messung darf nicht wie eine Modellmeinung aussehen.
  arcFindings() {
    return this._memo('arcFindings', [this.arc, this.selectedDraftId], () =>
      (this.arc?.befunde || []).filter(b => b.draft_id === this.selectedDraftId));
  },

  arcFindingText(b) {
    return window.__app.t('werkstatt.arc.check.' + b.code, {
      kern: this.arcKernLabel(b.kern),
      ...(b.params || {}),
    }) || b.code;
  },

  // ── Laden + Lauf ──────────────────────────────────────────────────────────
  async loadArc() {
    const bookId = window.Alpine?.store('nav').selectedBookId;
    if (!bookId) { this.arc = null; return; }
    // Stale-Schutz wie loadDrafts: die Antwort eines inzwischen verlassenen
    // Buchs darf den Bogen des neuen nicht überschreiben.
    const isStale = () => window.Alpine?.store('nav').selectedBookId !== bookId;
    let arc = null;
    try {
      arc = await fetchJson(`/draft-figures/${bookId}/arc`);
    } catch {
      // Best-effort wie die Plot-Beteiligung: der Bogen ist eine Nebenansicht,
      // sein Ausfall darf die Werkstatt nicht blockieren.
      arc = null;
    }
    if (isStale()) return;
    this.arc = arc;
    this.arcOccCache = {};
    this.activeArcDetailKey = null;
    this._memos = {};
  },

  // Die Verankerung läuft buchweit (ein Job für alle Figuren), nicht pro Figur:
  // sie ist billig (kein callAI) und ein Lauf pro Draft wäre eine Job-Flut.
  async runFigurAnchor() {
    const app = window.__app;
    const bookId = window.Alpine?.store('nav').selectedBookId;
    if (!bookId || this.anchorLoading) return;
    if (this.isDirty()) {
      const ok = await this.saveDraft();
      if (!ok) return;   // sonst verankert der Lauf eine veraltete Mindmap
    }
    this.anchorLoading = true;
    this.anchorStatus = '';
    try {
      const resp = await fetchJson('/jobs/figur-anchor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      this._anchorJobId = resp.jobId;
      startWerkstattJobPoll(this, 'anchor', resp.jobId);
    } catch (e) {
      this.anchorLoading = false;
      this.errorMessage = werkstattErrorText(e, 'werkstatt.error.anchor');
    }
  },

  // Läuft die buchweite Verankerung noch (Karte neu geöffnet, Reload), den
  // Fortschritt wieder anhängen — sonst stünde der Knopf bereit, während der
  // Lauf im Hintergrund weiterarbeitet.
  async _reattachAnchorJob() {
    const bookId = window.Alpine?.store('nav').selectedBookId;
    if (!bookId || this._anchorJobId || this.anchorLoading) return;
    let queue;
    try {
      const queued = window.Alpine?.store('jobs')?.jobQueueItems;
      queue = Array.isArray(queued) && queued.length > 0 ? queued : await fetchJson('/jobs/queue');
    } catch { return; }
    if (!Array.isArray(queue)) return;
    if (window.Alpine?.store('nav').selectedBookId !== bookId || this._anchorJobId || this.anchorLoading) return;
    // /jobs/queue liefert nur aktive (queued/running) Jobs des Users.
    const job = queue.find(j => j.type === 'figur-anchor' && String(j.bookId) === String(bookId));
    if (job) reattachWerkstattJob(this, 'anchor', job, null);
  },

  // Ohne semantische Suche kann der Lauf nichts finden: ein Kern ist eine
  // Bedeutung, keine Zeichenfolge. Der Knopf bleibt sichtbar, sagt aber warum.
  arcSemanticActive() {
    return !!window.Alpine?.store('config')?.semanticSearchEnabled;
  },
};
