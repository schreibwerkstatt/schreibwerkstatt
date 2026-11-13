// Motiv-Werkstatt — Kapitel-Verlaufsband (zweite Ansicht neben Konstellation und
// Konsistenz-Befunden; die Ansichts-Umschaltung selbst liegt hier).
// Motiv × Kapitel als Heatmap: jede Zeile ein Motiv, jede Spalte ein Kapitel in
// Lesereihenfolge, Zell-Intensität = Ist-Dichte (Fundstellen aus motif_occurrences,
// bereits im Graph-Payload als m.occChapters aggregiert). Zeigt, wo über den
// Buchbogen ein Motiv trägt und wo es verschwindet — die Konstellation zeigt nur
// OB, nicht WO. Rein rückwärtsgewandt/überwachend, nie generativ im Text.
//
// Kein eigener Datenpfad: occChapters [{ chapterId, n }] kommt aus GET /motifs
// (getGraph), die Kapitel-Reihenfolge + Namen aus dem geladenen Sidebar-Tree.

import { fetchJson } from '../../utils.js';
import { isSelectedBook } from '../../cards/book-guard.js';
import { isChapterItem } from '../tree/chapter-items.js';

export const bandMethods = {
  // Ansicht umschalten (Konstellation / Verlaufsband / Befunde / Gliederung). Zurück auf den Graph muss
  // neu gezeichnet + eingepasst werden (Canvas war ausgeblendet → 0-Grösse).
  setMotivView(mode) {
    const next = ['band', 'checks', 'outline'].includes(mode) ? mode : 'graph';
    if (this.motivView === next) return;
    this.motivView = next;
    // Zell-Detail gehört zum Band; es beim Verlassen offen zu lassen, hiesse beim
    // Zurückkommen eine Aufklappung ohne den Klick zu zeigen, der sie erzeugt hat.
    this.activeBandDetailKey = null;
    if (next === 'graph') this.$nextTick(() => { this.renderMotivGraph(); this.fitGraph(); });
  },

  // Kapitel in Lesereihenfolge (depth-first) aus dem Sidebar-Tree — nur echte
  // Kapitel (keine Solo-Seiten-Pseudo-Kapitel; occChapters kennt nur echte
  // chapter_ids, Top-Level-Seiten fallen server-seitig raus).
  // `name` ist das Auswertungs-Label mit Kapitelnummer (app-ui.js#_kapitelLabel),
  // `num` die Nummer allein — sie steht im schmalen Spaltenkopf, der Name im Tooltip.
  bandChapters() {
    const root = globalThis.window?.__app;
    return this._memo('bandChapters', [this.$store.nav.tree, root?._chapterLabelMap], () =>
      (this.$store.nav.tree || [])
        .filter(t => isChapterItem(t))
        .map(t => ({ id: t.id, name: root?._kapitelLabel?.(t.id) || t.name, num: root?._kapitelNummer?.(t.id) || '', depth: t.depth || 1 })));
  },

  // Motive fürs Band: nur solche mit ≥1 Fundstelle (all-leere Zeilen wären Rauschen;
  // Geist-/nie-gefundene Motive fehlen bewusst). Nach Thema-Position, dann Motiv-
  // Position sortiert, damit thematisch verwandte Zeilen beieinanderstehen.
  bandMotifs() {
    return this._memo('bandMotifs', [this.motifs, this.themes], () => {
      const themePos = new Map(this.themes.map((t, i) => [t.id, i]));
      return this.motifs
        .filter(m => (m.occurrenceCount || 0) > 0)
        .slice()
        .sort((a, b) => {
          const ta = a.theme_id != null ? (themePos.get(a.theme_id) ?? 1e9) : 1e9;
          const tb = b.theme_id != null ? (themePos.get(b.theme_id) ?? 1e9) : 1e9;
          if (ta !== tb) return ta - tb;
          return (a.position || 0) - (b.position || 0);
        });
    });
  },

  // Fundstellen-Index: motifId → Map(chapterId → n). Memoized über die Motive.
  _bandIndex() {
    return this._memo('bandIndex', [this.motifs], () => {
      const idx = new Map();
      for (const m of this.motifs) {
        const byCh = new Map();
        for (const oc of (m.occChapters || [])) byCh.set(oc.chapterId, oc.n);
        idx.set(m.id, byCh);
      }
      return idx;
    });
  },

  bandCount(motifId, chapterId) {
    return this._bandIndex().get(motifId)?.get(chapterId) || 0;
  },

  // ── Spalten: Hauptkapitel, aufklappbar ─────────────────────────────────────
  // Spalten sind die obersten Kapitel; ein zugeklapptes Kapitel zählt seinen
  // GANZEN Teilbaum (wie die Präsenz-Matrix der Buchübersicht — dieselben Daten,
  // dieselben Zahlen). Aufgeklappt zeigt es eine Spalte für seinen eigenen Text
  // und daneben seine Unterkapitel (die ihrerseits aufklappbar sind).
  // Spalte = { key, id, name, num, depth, ids[], collapsible, expanded }; `key` trennt
  // die Teilbaum-Summe (`<id>+`) von der eigenen Spalte (`<id>`).
  bandColumns() {
    return this._memo('bandColumns', [this.$store.nav.tree, this.bandExpanded, globalThis.window?.__app?._chapterLabelMap],
      () => this._computeBandColumns(this.bandChapters(), this.$store.nav.tree || [], this.bandExpanded));
  },

  _computeBandColumns(chapters, tree, expanded) {
    const known = new Set(chapters.map(c => c.id));
    const parentOf = new Map();
    for (const t of tree) if (isChapterItem(t)) parentOf.set(t.id, t.parent_id ?? null);
    const kids = new Map();
    const roots = [];
    for (const c of chapters) {
      const p = parentOf.get(c.id);
      if (p != null && known.has(p)) {
        if (!kids.has(p)) kids.set(p, []);
        kids.get(p).push(c);
      } else roots.push(c);
    }
    const subtree = (c) => [c.id, ...(kids.get(c.id) || []).flatMap(subtree)];
    const out = [];
    const emit = (c) => {
      const children = kids.get(c.id) || [];
      if (!children.length) {
        out.push({ key: String(c.id), id: c.id, name: c.name, num: c.num, depth: c.depth, ids: [c.id], collapsible: false, expanded: false });
      } else if (!expanded[c.id]) {
        out.push({ key: c.id + '+', id: c.id, name: c.name, num: c.num, depth: c.depth, ids: subtree(c), collapsible: true, expanded: false });
      } else {
        out.push({ key: String(c.id), id: c.id, name: c.name, num: c.num, depth: c.depth, ids: [c.id], collapsible: true, expanded: true });
        children.forEach(emit);
      }
    };
    roots.forEach(emit);
    return out;
  },

  toggleBandColumn(col) {
    if (!col?.collapsible) return;
    this.bandExpanded = { ...this.bandExpanded, [col.id]: !col.expanded };
    // Die Spalte des offenen Details gibt es danach evtl. nicht mehr.
    this.activeBandDetailKey = null;
  },

  // Fundstellen eines Motivs in einer Spalte (Summe über deren Kapitel).
  bandColCount(motifId, col) {
    const byCh = this._bandIndex().get(motifId);
    if (!byCh || !col) return 0;
    let n = 0;
    for (const id of col.ids) n += byCh.get(id) || 0;
    return n;
  },

  // Grösste Zellen-Zahl über die SICHTBAREN Spalten — Normierungs-Basis der
  // Intensität (eine Teilbaum-Summe ist grösser als jede Einzelspalte).
  bandMax() {
    return this._memo('bandMax', [this.motifs, this.bandColumns()], () => {
      let max = 0;
      const cols = this.bandColumns();
      for (const m of this.motifs) {
        for (const col of cols) { const n = this.bandColCount(m.id, col); if (n > max) max = n; }
      }
      return max;
    });
  },

  // Zeilensummen (Fundstellen je Motiv über alle Kapitel) für die Summenspalte.
  // Als EINE memoisierte Karte statt einer Summe pro Aufruf: motiv.html liest den
  // Wert pro Motivzeile, und jede Summe lief über alle Kapitel des Motivs.
  _bandRowTotals() {
    return this._memo('bandRowTotals', [this.motifs], () => {
      const totals = new Map();
      for (const [motifId, byCh] of this._bandIndex()) {
        let sum = 0;
        for (const n of byCh.values()) sum += n;
        totals.set(motifId, sum);
      }
      return totals;
    });
  },

  bandRowTotal(motifId) {
    return this._bandRowTotals().get(motifId) || 0;
  },

  // Zell-Klasse: leer (schraffiert, kein Klick) vs. getönt (Intensität via --heatmap-t).
  bandCellClass(n) {
    return n > 0 ? 'heatmap-cell--primary' : 'heatmap-cell--empty';
  },
  // Intensität als CSS-Custom-Prop. √-gedämpft, damit auch dünne Vorkommen sichtbar
  // sind; Boden bei 14 %, sonst verschwinden 1er-Zellen optisch ganz.
  bandCellVars(n) {
    const max = this.bandMax();
    if (n <= 0 || max <= 0) return {};
    const t = Math.max(14, Math.round(Math.sqrt(n / max) * 100));
    return { '--heatmap-t': t + '%' };
  },

  // Rowhead-Klick: Motiv wählen und in die Konstellation wechseln (Detail-Panel +
  // Knoten-Highlight leben dort). Das Band ist die Übersicht, der Graph das Detail.
  bandSelectMotif(motifId) {
    return this._selectMotifInGraph(motifId);
  },

  // Motiv wählen und in die Konstellation wechseln — aber nur, wenn die Auswahl
  // gelang: schlägt der Commit offener Edits fehl, bleibt die alte Auswahl stehen,
  // und ein Ansichtswechsel zeigte das falsche Motiv im Panel. Geteilt von Band,
  // Befunden und KI-Urteil.
  async _selectMotifInGraph(motifId) {
    await this.selectMotif(motifId);
    if (this.selectedMotifId === motifId) this.setMotivView('graph');
  },

  // Farb-Swatch der Motiv-Zeile (Thema-Farbe, deckungsgleich mit dem Graph).
  bandMotifColor(m) {
    if (m.theme_id == null) return 'var(--color-muted)';
    const theme = this.themeById(m.theme_id);
    if (!theme) return 'var(--color-muted)';
    return `var(--palette-${this.themeSwatchKey(theme)})`;
  },

  // ── Zell-Detail: die Fundstellen HINTER einer Färbung ──────────────────────
  // Die Zelle nennt eine Zahl; ohne Auflösung bleibt sie eine Behauptung. Klick
  // klappt darum die Fundstellen dieses (Motiv × Kapitel) auf — dieselben Zeilen
  // wie im Panel, inklusive Sprung an die Textstelle. Muster + geteilte Klassen
  // wie die Fehler-Heatmap (`heatmap-cell--clickable`/`--active` + `heatmap-detail`).

  // Eine leere Zelle hat nichts aufzulösen und darf weder Klick-Cursor noch
  // Tab-Stopp anbieten (SSoT für :class-Bindung UND Handler, damit die Optik
  // nicht mehr verspricht, als der Klick einlöst).
  bandCellClickable(motifId, col) {
    return this.bandColCount(motifId, col) > 0;
  },

  bandDetailKey(motifId, col) { return `${motifId}:${col.key}`; },

  async toggleBandDetail(motifId, col) {
    if (!this.bandCellClickable(motifId, col)) return;
    const key = this.bandDetailKey(motifId, col);
    if (this.activeBandDetailKey === key) { this.activeBandDetailKey = null; return; }
    this.activeBandDetailKey = key;
    await this._ensureBandOccurrences(motifId);
  },

  // Fundstellen eines Motivs holen und pro Motiv merken: eine Band-Zeile hat so
  // viele Zellen wie das Buch Kapitel, und jede Zelle fragt dieselbe Route.
  // Der Cache lebt nur bis zum nächsten loadBoard() (Scan-Lauf → frische Zahlen).
  async _ensureBandOccurrences(motifId) {
    if (this.bandOccCache[motifId]) return;
    // Generation + Buch merken: ein loadBoard (Scan-Lauf) oder Buchwechsel während
    // der Lesung macht diese Antwort zur alten Wahrheit — nicht in den frischen Cache.
    const gen = this._bandOccGen;
    const bookId = this.$store.nav.selectedBookId;
    this.bandDetailLoading = true;
    try {
      const data = await fetchJson(`/motifs/${motifId}/occurrences`);
      if (gen !== this._bandOccGen || !isSelectedBook(bookId)) return;
      // NEUES Objekt statt Mutation: bandActiveDetail() memoisiert über die
      // Cache-Referenz — eine In-Place-Ergänzung verschiebt sie nicht und das
      // Detail bliebe nach dem Laden leer.
      this.bandOccCache = { ...this.bandOccCache, [motifId]: data.occurrences || [] };
    } catch (e) {
      // Fundstellen sind optional (wie im Panel): kein harter Fehler. NICHT als
      // leere Liste cachen — sonst gilt ein Netz-Aussetzer bis zum nächsten
      // loadBoard() als „Kapitel ohne Fundstellen"; ein zweiter Klick darf es
      // erneut versuchen.
    } finally { this.bandDetailLoading = false; }
  },

  // Aktives Zell-Detail: Motiv, Kapitel und die Fundstellen GENAU dieses Kapitels.
  // Gefiltert wird auf `chapter_id` — dieselbe Auflösung, aus der die Zellzahl
  // stammt (Szenen-Funde mappen server-seitig über ihre Ankerseite).
  // Memoized: das Detail-Panel liest den Wert mehrfach pro Render (Titel, Liste,
  // beide x-show), und jeder Aufruf filtert sonst die Fundstellenliste erneut.
  bandActiveDetail() {
    return this._memo('bandActiveDetail',
      [this.activeBandDetailKey, this.bandOccCache, this.motifs, this.bandColumns()],
      () => this._computeBandActiveDetail());
  },

  // Gefiltert auf die Kapitel DER SPALTE — bei einer zugeklappten Teilbaum-Spalte
  // also auf alle ihre Unterkapitel, genau wie die Zellzahl.
  _computeBandActiveDetail() {
    const key = this.activeBandDetailKey;
    if (!key) return null;
    const sep = key.indexOf(':');
    const motifId = parseInt(key.slice(0, sep), 10);
    const colKey = key.slice(sep + 1);
    const motif = this.motifById(motifId);
    const col = this.bandColumns().find(c => c.key === colKey);
    if (!motif || !col) return null;
    const ids = new Set(col.ids);
    const loaded = this.bandOccCache[motifId];
    return {
      key,
      motifId,
      chapterId: col.id,
      motifName: motif.name,
      chapterName: col.name,
      count: this.bandColCount(motifId, col),
      occurrences: loaded ? loaded.filter(o => ids.has(o.chapter_id)) : [],
    };
  },
};
