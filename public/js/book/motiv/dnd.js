// Motiv-Werkstatt — Drag im Baum des Seitenpanels (SortableJS, lazy):
//   1. Themen-Reihenfolge: ein Container, Griff am Thema → PUT /motifs/themes/order.
//   2. Motive: je Themengruppe eine Liste (plus «Ohne Thema»), gemeinsame
//      Sortable-Gruppe → ein Motiv lässt sich innerhalb eines Themas umsortieren
//      oder in ein anderes ziehen (PATCH theme_id + PUT /motifs/order).
// Wie Buchorganizer/Plot: SortableJS bewegt physisch, revertSortable nimmt den Move
// zurück, danach wird das Modell mutiert und x-for rendert daraus neu.
// Bei aktiver Suche gibt es keinen Griff (motivTreeDraggable) — eine gefilterte
// Liste ist nicht die ganze Gruppe.

import { sendJson } from '../../utils.js';
import { loadSortable } from '../../lazy-libs.js';
import { patchSortableOnce, revertSortable, markDragIgnore, unmarkDragIgnore, BASE_SORTABLE_OPTS } from '../../sortable-dnd.js';

// IDs der Drag-Items eines Containers in DOM-Reihenfolge (Template-Anker übergehen).
function childIds(el, attr) {
  const ids = [];
  for (const child of el.children) {
    if (child.tagName === 'TEMPLATE') continue;
    const id = parseInt(child.dataset?.[attr], 10);
    if (Number.isFinite(id)) ids.push(id);
  }
  return ids;
}

// Gruppen-Schlüssel eines Motiv-Containers (`data-group` = Thema-ID oder leer).
function groupKeyOf(el) {
  const g = el?.dataset?.group;
  return g ? 't' + g : 'none';
}

// Neue Gesamt-Reihenfolge der Motive: Gruppen in Anzeige-Reihenfolge, die beiden
// beteiligten Listen in ihrer neuen DOM-Reihenfolge, alle anderen unverändert.
export function mergeMotifOrder(groups, changed) {
  const out = [];
  for (const g of groups) {
    const ids = changed.has(g.key) ? changed.get(g.key) : g.motifs.map(m => m.id);
    for (const id of ids) if (!out.includes(id)) out.push(id);
  }
  return out;
}

async function sortableLib() {
  try {
    const Sortable = await loadSortable();
    if (Sortable) patchSortableOnce(Sortable);
    return Sortable || null;
  } catch (e) { return null; /* ohne Lib kein Drag — Baum bleibt statisch */ }
}

export const dndMethods = {
  // ── Themen ────────────────────────────────────────────────────────────
  async _initThemeSortable(el) {
    if (!el) return;
    this._destroyThemeSortable();
    const Sortable = await sortableLib();
    if (!Sortable || !el.isConnected) return;
    this._themeSortable = new Sortable(el, {
      ...BASE_SORTABLE_OPTS,
      draggable: '.motiv-tree-group',
      handle: '.motiv-theme-grip',
      ghostClass: 'motiv-tree-ghost',
      onChoose: markDragIgnore,
      onUnchoose: unmarkDragIgnore,
      onEnd: (evt) => { unmarkDragIgnore(evt); this.onThemeSortEnd(evt); },
    });
  },

  _destroyThemeSortable() {
    if (this._themeSortable) { try { this._themeSortable.destroy(); } catch {} this._themeSortable = null; }
  },

  async onThemeSortEnd(evt) {
    if (evt.oldIndex === evt.newIndex) return;
    const ids = childIds(evt.to, 'themeId');
    revertSortable(evt);
    if (ids.length !== this.themes.length) return; // DOM/Modell divergiert — nicht raten
    const byId = new Map(this.themes.map(t => [t.id, t]));
    const reordered = ids.map(id => byId.get(id)).filter(Boolean);
    if (reordered.length !== this.themes.length) return;
    // Optimistisch (sortable-dnd.js#revertSortable): sofort umsortiert, bei
    // Fehler zurueck auf Reihenfolge und Positionen von vorher.
    const prev = this.themes;
    const prevOrder = this._themeOrder();
    const prevPos = new Map(prev.map(t => [t.id, t.position]));
    reordered.forEach((t, i) => { t.position = i; });
    this.themes = reordered;
    this._memos = {};
    try {
      await sendJson('/motifs/themes/order', 'PUT', { book_id: this.$store.nav.selectedBookId, order: ids });
      this._pushUndo({ kind: 'theme-order', before: prevOrder, after: ids });
    } catch (e) {
      prev.forEach(t => { t.position = prevPos.get(t.id); });
      this.themes = prev;
      this._memos = {};
      this.errorMessage = window.__app.t('motiv.error.save');
    }
  },

  // ── Motive (zwischen Themen) ──────────────────────────────────────────
  // Aus x-init jeder Motiv-Liste. Instanzen abgehängter Listen (Gruppe gelöscht,
  // Baum neu gemountet) werden bei jedem Init geräumt.
  async _initMotifSortable(el) {
    if (!el) return;
    this._motifSortables ||= new Map();
    for (const [node, inst] of this._motifSortables) {
      if (!node.isConnected || node === el) { try { inst.destroy(); } catch {} this._motifSortables.delete(node); }
    }
    const Sortable = await sortableLib();
    if (!Sortable || !el.isConnected) return;
    this._motifSortables.set(el, new Sortable(el, {
      ...BASE_SORTABLE_OPTS,
      group: 'motiv-motifs',
      draggable: '.motiv-tree-motif',
      handle: '.motiv-motif-grip',
      ghostClass: 'motiv-tree-ghost',
      onChoose: markDragIgnore,
      onUnchoose: unmarkDragIgnore,
      onEnd: (evt) => { unmarkDragIgnore(evt); this.onMotifSortEnd(evt); },
    }));
  },

  _destroyMotifSortables() {
    for (const inst of (this._motifSortables?.values() || [])) { try { inst.destroy(); } catch {} }
    this._motifSortables = null;
  },

  async onMotifSortEnd(evt) {
    if (evt.from === evt.to && evt.oldIndex === evt.newIndex) return;
    const movedId = parseInt(evt.item?.dataset?.motifId, 10);
    const changed = new Map([[groupKeyOf(evt.to), childIds(evt.to, 'motifId')]]);
    if (evt.from !== evt.to) changed.set(groupKeyOf(evt.from), childIds(evt.from, 'motifId'));
    revertSortable(evt);
    const m = this.motifById(movedId);
    if (!m || !this.motivTreeDraggable()) return;
    const order = mergeMotifOrder(this.motivGroups(), changed);
    if (order.length !== this.motifs.length) return; // DOM/Modell divergiert — nicht raten
    const target = evt.to.dataset.group ? Number(evt.to.dataset.group) : null;
    const themeChanged = (m.theme_id || null) !== target;
    // Optimistisch: Modell sofort angleichen, damit der Baum nicht zurückspringt;
    // bei Fehler zurück auf den Stand von vorher.
    const prev = this.motifs;
    const rec = { kind: 'motif-move', id: m.id, beforeTheme: m.theme_id || null, afterTheme: target, beforeOrder: this._motifOrder(), afterOrder: order };
    const pos = new Map(order.map((id, i) => [id, i]));
    this.motifs = this.motifs.map(x => ({
      ...x, position: pos.get(x.id) ?? x.position, ...(x.id === m.id ? { theme_id: target } : {}),
    }));
    this._memos = {};
    const bookId = this.$store.nav.selectedBookId;
    try {
      if (themeChanged) await sendJson(`/motifs/${m.id}`, 'PATCH', { theme_id: target });
      await sendJson('/motifs/order', 'PUT', { book_id: bookId, order });
      this._pushUndo(rec);
    } catch (e) {
      this.errorMessage = window.__app.t('motiv.error.save');
      // Schlug erst die Reihenfolge fehl, steht das Thema schon auf dem
      // Server — dann laedt der Thema-Wechsel unten den echten Stand.
      if (!themeChanged) { this.motifs = prev; this._memos = {}; }
    }
    // Thema-Wechsel ändert die Graph-Farbe und die Befunde → frisch laden.
    if (themeChanged) await this.loadBoard();
  },
};
