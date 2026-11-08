// Motiv-Werkstatt — Gliederung (Thema → Motiv) für zwei Orte:
//   1. den Baum im Seitenpanel neben der Konstellation (ohne Auswahl), und
//   2. die vierte Ansicht «Gliederung» (bearbeitbare Baum-Tabelle, aufklappbare
//      Zeilen mit dem geteilten Detail-Editor, siehe detail.js).
// Beide lesen dieselbe Gruppierung (`motivGroups`), dieselbe Suche (`motivQuery`)
// und dieselben Kennzahlen je Motiv — eine Zeile sagt an beiden Orten dasselbe.

// Suchtreffer: Name, Beschreibung oder ein Trigger-Begriff enthält die Anfrage.
export function motifMatchesQuery(m, q) {
  if (!q) return true;
  const hay = [m.name, m.beschreibung, ...(m.trigger_terms || [])]
    .filter(Boolean).join('\n').toLocaleLowerCase();
  return hay.includes(q);
}

// Gruppen in Anzeige-Reihenfolge: Themen (nach Position), dann «Ohne Thema».
// Mit Suchanfrage: ein Thema, dessen Name trifft, zeigt alle seine Motive; sonst
// nur die treffenden. Leere Gruppen fallen bei aktiver Suche weg; ohne Suche
// bleiben leere Gruppen stehen (Drop-Ziel im Baum, «+ Motiv») — «Ohne Thema»
// nur, wenn es überhaupt Themen gibt, sonst wäre es die einzige Gruppe.
export function buildMotifGroups(themes, motifs, query = '') {
  const q = String(query || '').trim().toLocaleLowerCase();
  const byPos = (a, b) => (a.position || 0) - (b.position || 0) || a.id - b.id;
  const themeIds = new Set(themes.map(t => t.id));
  const groups = themes.slice().sort(byPos).map(t => {
    const own = motifs.filter(m => m.theme_id === t.id).sort(byPos);
    const themeHit = !!q && t.name.toLocaleLowerCase().includes(q);
    const shown = (!q || themeHit) ? own : own.filter(m => motifMatchesQuery(m, q));
    return { key: 't' + t.id, theme: t, motifs: shown, total: own.length };
  });
  const loose = motifs.filter(m => !m.theme_id || !themeIds.has(m.theme_id)).sort(byPos);
  const looseShown = loose.filter(m => motifMatchesQuery(m, q));
  groups.push({ key: 'none', theme: null, motifs: looseShown, total: loose.length });
  return groups.filter(g => (q ? g.motifs.length > 0 : (g.theme || g.motifs.length > 0 || themes.length > 0)));
}

// Mini-Verlauf eines Motivs über die Kapitel (Lesereihenfolge): pro Kapitel die
// Fundstellen-Zahl und eine Intensität 0–100, normiert auf das Maximum DIESER
// Zeile — die Zeile zeigt die Form des Bogens, nicht den Vergleich zu anderen
// Motiven (dafür gibt es das Verlaufsband). √-gedämpft, Boden 14 % wie im Band.
//
// Die Leiste hat eine feste Breite, deshalb höchstens SPARK_MAX_CELLS Zellen:
// Unterkapitel zählen zum Oberkapitel (wie im zugeklappten Verlaufsband), und
// hat das Buch mehr Oberkapitel als Zellen, fassen gleich grosse Folgen
// benachbarter Kapitel je eine Zelle zusammen («K1 – K3»). Bei 40+ Kapiteln
// wären Einzelzellen sonst Haarstriche oder liefen über den Rand.
export const SPARK_MAX_CELLS = 24;

// Kapitel (Lesereihenfolge) → Zellen [{ key, label, ids }]. `parentOf`
// (chapterId → parentId) ist optional; ohne ihn gilt jedes Kapitel als oben.
export function sparkBuckets(chapters, parentOf = null, maxCells = SPARK_MAX_CELLS) {
  const known = new Set(chapters.map(c => String(c.id)));
  const rootOf = (id) => {
    let cur = String(id);
    for (let guard = 0; guard < 32; guard++) {
      const p = parentOf?.get(cur);
      if (p == null || !known.has(String(p))) return cur;
      cur = String(p);
    }
    return cur;
  };
  const roots = [];
  const byRoot = new Map();
  for (const c of chapters) {
    const r = rootOf(c.id);
    if (!byRoot.has(r)) {
      const root = chapters.find(x => String(x.id) === r) || c;
      const entry = { id: r, name: root.name, ids: [] };
      byRoot.set(r, entry);
      roots.push(entry);
    }
    byRoot.get(r).ids.push(String(c.id));
  }
  const k = Math.min(roots.length, Math.max(1, maxCells));
  const out = [];
  for (let i = 0; i < k; i++) {
    const part = roots.slice(Math.floor(i * roots.length / k), Math.floor((i + 1) * roots.length / k));
    const first = part[0], last = part[part.length - 1];
    out.push({
      key: part.map(p => p.id).join('+'),
      label: part.length === 1 ? first.name : `${first.name || '?'} – ${last.name || '?'}`,
      ids: part.flatMap(p => p.ids),
    });
  }
  return out;
}

export function motifSparkCells(occChapters, buckets) {
  const byCh = new Map((occChapters || []).map(o => [String(o.chapterId), o.n]));
  const sums = buckets.map(b => b.ids.reduce((s, id) => s + (byCh.get(id) || 0), 0));
  const max = Math.max(0, ...sums);
  return buckets.map((b, i) => {
    const n = sums[i];
    const t = n > 0 && max > 0 ? Math.max(14, Math.round(Math.sqrt(n / max) * 100)) : 0;
    return { key: b.key, name: b.label, n, t };
  });
}

export const outlineMethods = {
  motivGroups() {
    return this._memo('motivGroups', [this.themes, this.motifs, this.motivQuery], () =>
      buildMotifGroups(this.themes, this.motifs, this.motivQuery));
  },
  motivGroupLabel(g) {
    return g.theme ? g.theme.name : window.__app.t('motiv.noTheme');
  },
  motivVisibleCount() {
    return this.motivGroups().reduce((s, g) => s + g.motifs.length, 0);
  },
  // Drag nur ohne Suche: in einer gefilterten Liste wäre die abgelegte
  // Reihenfolge nicht die ganze Gruppe.
  motivTreeDraggable() {
    return !(this.motivQuery || '').trim();
  },

  // ── Kennzahlen je Motiv (SSoT für Baum-Zeile und Gliederungs-Spalten) ──
  motifSpark(m) {
    const map = this._memo('motifSparks', [this.motifs, this.$store.nav.tree], () => {
      const parentOf = new Map();
      for (const t of (this.$store.nav.tree || [])) {
        if (t.type === 'chapter' && !t.solo && t.parent_id != null) parentOf.set(String(t.id), String(t.parent_id));
      }
      const buckets = sparkBuckets(this.bandChapters(), parentOf);
      return new Map(this.motifs.map(x => [x.id, motifSparkCells(x.occChapters, buckets)]));
    });
    return map.get(m.id) || [];
  },
  sparkCellVars(c) {
    return c.t > 0 ? { '--heatmap-t': c.t + '%' } : {};
  },
  sparkCellTip(c) {
    return window.__app.tn('motiv.outline.sparkTip', c.n, { chapter: c.name || '?' });
  },
  motifAvgPct(m) {
    return (m.occurrenceCount || 0) > 0 && m.occAvgScore ? Math.round(m.occAvgScore * 100) : null;
  },
  _motifCheckCounts() {
    return this._memo('motifCheckCounts', [this.checks], () => {
      const counts = new Map();
      const bump = (id) => { if (id != null) counts.set(id, (counts.get(id) || 0) + 1); };
      for (const f of (this.checks || [])) {
        bump(f.motiv_id);
        if (f.partner_id != null && f.partner_id !== f.motiv_id) bump(f.partner_id);
      }
      return counts;
    });
  },
  motifCheckCount(id) {
    return this._motifCheckCounts().get(id) || 0;
  },
  _motifRelationCounts() {
    return this._memo('motifRelationCounts', [this.relations], () => {
      const counts = new Map();
      for (const r of this.relations) {
        counts.set(r.from_motif_id, (counts.get(r.from_motif_id) || 0) + 1);
        counts.set(r.to_motif_id, (counts.get(r.to_motif_id) || 0) + 1);
      }
      return counts;
    });
  },
  motifRelationCount(id) {
    return this._motifRelationCounts().get(id) || 0;
  },

  // ── Baum im Seitenpanel ───────────────────────────────────────────────
  // Hover hebt den Knoten in der Konstellation hervor, Verlassen nimmt es zurück.
  hoverTreeMotif(id) { this._hoverNode(id); },

  // ── Gliederung (vierte Ansicht) ───────────────────────────────────────
  // Zeilen für sortableTable: flach, mit Gruppen-Schlüssel und Sortierwerten.
  // `pos` (Default) = Themen-Reihenfolge × Motiv-Position, also die Gliederung
  // selbst; jede andere Spalte sortiert innerhalb der Themengruppen.
  outlineRows() {
    return this._memo('outlineRows', [this.motivGroups(), this.checks, this.relations], () => {
      const rows = [];
      this.motivGroups().forEach((g, gi) => {
        g.motifs.forEach((m, mi) => {
          rows.push({
            id: m.id, group: g.key, pos: gi * 100000 + mi, name: m.name,
            occ: m.occurrenceCount || 0, avg: this.motifAvgPct(m) ?? -1,
            links: this.motifLinkCount(m), rels: this.motifRelationCount(m.id),
            checks: this.motifCheckCount(m.id),
          });
        });
      });
      return rows;
    });
  },
  // Render-Liste der Tabelle: je Gruppe ein Kopf, darunter ihre Zeilen in der
  // Reihenfolge der (sortierten) Tabelle. Jeder Eintrag wird ein eigenes <tbody>
  // (Zeile + aufgeklappte Detailzeile brauchen eine gemeinsame Wurzel).
  outlineItems(sortedRows) {
    const byGroup = new Map();
    for (const r of (sortedRows || [])) {
      if (!byGroup.has(r.group)) byGroup.set(r.group, []);
      byGroup.get(r.group).push(r);
    }
    const items = [];
    for (const g of this.motivGroups()) {
      // Leeres «Ohne Thema» ist im Baum ein Drop-Ziel, hier nur Rauschen.
      if (!g.theme && !g.motifs.length) continue;
      items.push({ kind: 'group', key: 'g:' + g.key, g });
      for (const r of (byGroup.get(g.key) || [])) {
        const m = this.motifById(r.id);
        if (m) items.push({ kind: 'motif', key: 'm:' + m.id, m, r });
      }
    }
    return items;
  },
  toggleOutlineMotif(id) {
    return this.selectMotif(this.selectedMotifId === id ? null : id);
  },
  toggleOutlineTheme(id) {
    return this.selectedThemeId === id ? this.deselectTheme() : this.selectTheme(id);
  },
  // Klick neben die aufgeklappte Zeile speichert (Inline-Edit-Regel), lässt sie
  // aber offen — schliessen ist ein eigener Klick. Teleportierte Ebenen (Menü,
  // Rückfrage-Dialog, Tooltip) liegen ausserhalb der Zeile, gehören aber dazu.
  _isOutlineOverlayClick(ev) {
    return !!ev?.target?.closest?.('dialog, .context-menu, .picker-popover, .tip-layer, .combobox-wrap');
  },
  onOutlineMotifOutside(ev, id) {
    if (this.motivView !== 'outline' || this.selectedMotifId !== id || this._isOutlineOverlayClick(ev)) return;
    this._commitPendingMotifEdit();
  },
  onOutlineThemeOutside(ev, id) {
    if (this.motivView !== 'outline' || this.selectedThemeId !== id || this._isOutlineOverlayClick(ev)) return;
    this._commitPendingThemeEdit();
  },
};
