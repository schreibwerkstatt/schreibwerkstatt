// View-Slice: UI-State (collapse, search, jump) + Filter + Helper für die
// Comboboxen. Keine Daten-Mutation — alles, was Server-State ändert, lebt in
// dnd/persist/crud.
//
// chapterOpen ist ein per-chapter-id Object-Map. Beim ersten Snapshot wird
// COLLAPSE_THRESHOLD geprüft: > N Kapitel → alle zu, sonst alle auf. Inkremen-
// telle Re-Snapshots (z.B. nach pages:loaded) übernehmen den User-Zustand und
// ergänzen nur neue/entfernte IDs.

import { MAX_CHAPTER_DEPTH, COLLAPSE_THRESHOLD } from './constants.js';
import { memoMethods } from '../cards/card-memo.js';
import { numberFormat } from '../utils.js';

function _walkAllIds(chapters, out = []) {
  for (const c of chapters) {
    out.push(c.id);
    _walkAllIds(c.subchapters || [], out);
  }
  return out;
}

export const viewMethods = {
  _recomputeInitialOpenState() {
    const ids = _walkAllIds(this.workTree);
    const knownKeys = Object.keys(this.chapterOpen);
    if (knownKeys.length === 0) {
      const wantOpen = ids.length <= COLLAPSE_THRESHOLD;
      const next = {};
      for (const id of ids) next[id] = wantOpen;
      this.chapterOpen = next;
      return;
    }
    const next = { ...this.chapterOpen };
    for (const id of ids) if (next[id] === undefined) next[id] = false;
    for (const k of knownKeys) {
      const id = parseInt(k, 10);
      if (!ids.includes(id)) delete next[k];
    }
    this.chapterOpen = next;
  },

  // Pages-UL ist x-if-gated: nach Open/Close erscheinen/verschwinden ULs im DOM,
  // Sortable muss daher neu gebunden werden (_reattachSortables wartet auf den
  // nextTick und zieht die Such-Disable-Invariante mit).
  toggleChapter(id) {
    this.chapterOpen = { ...this.chapterOpen, [id]: !this.chapterOpen[id] };
    this._reattachSortables();
  },

  expandAll() {
    this._setAllChaptersOpen(true);
  },

  collapseAll() {
    this._setAllChaptersOpen(false);
  },

  _setAllChaptersOpen(open) {
    const next = {};
    for (const id of _walkAllIds(this.workTree)) next[id] = open;
    this.chapterOpen = next;
    this._reattachSortables();
  },

  // Rekursiver Suchfilter: zeigt Kapitel, wenn Name-Match ODER ein Sub-/Page
  // tief drunter matched. Ein Kapitel mit Name-Match bleibt komplett sichtbar
  // (alle Seiten UND alle Sub-Kapitel, als Kontext); sonst nur die passenden
  // Seiten und die Sub-Kapitel, in denen etwas passt.
  _filterChapter(ch, q) {
    if (ch.name.toLowerCase().includes(q)) return ch;
    const pages = ch.pages.filter(p => p.name.toLowerCase().includes(q));
    const subs = (ch.subchapters || [])
      .map(s => this._filterChapter(s, q))
      .filter(Boolean);
    if (pages.length === 0 && subs.length === 0) return null;
    return { ...ch, pages, subchapters: subs };
  },

  _searchQuery() {
    return (this.organizerSearch || '').trim().toLowerCase();
  },

  // Methoden, keine Getter: beim {...viewMethods}-Spread in der Facade wuerden
  // Getter-Definitionen sofort ausgefuehrt (this = POJO) und das Ergebnis als
  // statisches Property eingefroren. Methoden bleiben reaktiv.
  filteredWorkTree() {
    const q = this._searchQuery();
    if (!q) return this.workTree;
    return this.workTree.map(ch => this._filterChapter(ch, q)).filter(Boolean);
  },

  filteredSoloPages() {
    const q = this._searchQuery();
    if (!q) return this.soloPages;
    return this.soloPages.filter(p => p.name.toLowerCase().includes(q));
  },

  // Findet ein Kapitel im workTree (rekursiv). Liefert den Knoten, seine
  // Geschwister-Liste (`parentList`), den Index darin und den Eltern-Knoten
  // (`parent`, null bei Top-Level) — genug fuer splice-basierte Struktur-Moves.
  _findChapter(id) {
    const stack = [{ list: this.workTree, parent: null }];
    while (stack.length) {
      const { list, parent } = stack.pop();
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c.id === id) return { node: c, parent, parentList: list, index: i };
        if (c.subchapters?.length) stack.push({ list: c.subchapters, parent: c });
      }
    }
    return null;
  },

  // Sammelt alle Nachfahren-Kapitel-IDs eines Knotens (Cycle-Prevention bei DnD).
  _descendantIdsOf(ch) {
    const ids = new Set();
    function walk(node) {
      for (const sub of (node.subchapters || [])) {
        ids.add(sub.id);
        walk(sub);
      }
    }
    walk(ch);
    return ids;
  },

  // Maximale Tiefe im Subtree (1 = nur dieses Kapitel, keine Subs).
  _subtreeDepth(ch) {
    if (!ch.subchapters?.length) return 1;
    return 1 + Math.max(...ch.subchapters.map(s => this._subtreeDepth(s)));
  },

  // SortableJS bei aktiver Suche disablen — gefilterter DOM-Zustand würde
  // Reorder verfälschen. Teil von _reattachSortables, damit kein Re-Init die
  // Invariante vergisst.
  _refreshSortableDisabled() {
    const disabled = !!this._searchQuery();
    for (const s of (this._sortables || [])) {
      try { s.option('disabled', disabled); } catch {}
    }
  },

  async jumpToChapter(chIdRaw) {
    const chId = parseInt(chIdRaw, 10);
    if (!chId) return;
    // Alle Vorfahren oeffnen, damit das Kapitel sichtbar ist.
    const opens = { ...this.chapterOpen, [chId]: true };
    let cur = this._findChapter(chId)?.parent || null;
    while (cur) {
      opens[cur.id] = true;
      cur = this._findChapter(cur.id)?.parent || null;
    }
    this.chapterOpen = opens;
    // Aufklappen erzeugt x-if-gatete Seiten-/Sub-Kapitel-Listen → Sortable neu
    // binden (wie toggleChapter), sonst ist DnD dort tot. Wartet den nextTick ab.
    await this._reattachSortables();
    this._cardRoot().querySelector(`[data-chapter-id="${chId}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    this.jumpToChapterId = '';
  },

  // Alle Kapitel als Combobox-Optionen, rekursiv mit Einrueckungspraefix, damit
  // die Hierarchie im Picker erkennbar bleibt. `exclude` haelt das eigene
  // Kapitel aus der Move-Liste.
  _chapterOptions({ exclude = null } = {}) {
    const opts = [];
    const walk = (list, depth) => {
      for (const ch of list) {
        if (ch.id !== exclude) {
          opts.push({ value: ch.id, label: (depth > 1 ? '— '.repeat(depth - 1) : '') + ch.name });
        }
        walk(ch.subchapters || [], depth + 1);
      }
    };
    walk(this.workTree, 1);
    return opts;
  },

  // Move-Combobox pro Page. Wird im x-effect aufgerufen — die gelesenen
  // Reactive-Felder (workTree, ch.name) sind damit Alpine-getrackt.
  chapterMoveOptions(currentChId) {
    const opts = this._chapterOptions({ exclude: currentChId });
    if (currentChId !== 0) {
      opts.unshift({ value: 0, label: window.__app.t('bookOrganizer.soloHeader') });
    }
    return opts;
  },

  jumpChapterOptions() {
    return this._chapterOptions();
  },

  // Options-Array fuer die „In anderes Buch"-Combobox: Buecher, in die der User
  // schreiben darf (`role` aus /content/books), ohne das aktuelle und ohne
  // archivierte. Der Server erzwingt die ACL ohnehin (editor auf beiden) — hier
  // geht es darum, kein Ziel anzubieten, das erst NACH der Rueckfrage mit 403
  // scheitert.
  // Memo, weil jede Seitenzeile die Liste fuer ihr `x-if` abfragt.
  bookMoveOptions() {
    const nav = Alpine.store('nav');
    return this._memo('bookMoveOpts', [nav.books, nav.selectedBookId], () => {
      const cur = String(nav.selectedBookId);
      return (nav.books || [])
        .filter(b => String(b.id) !== cur && !b.archived
          && (b.role == null || b.role === 'owner' || b.role === 'editor'))
        .map(b => ({ value: b.id, label: b.name || ('#' + b.id) }));
    });
  },

  // Zeilen-Comboboxen („Verschieben nach", „In anderes Buch", Redaktions-Stufe)
  // montieren erst beim Klick auf ihren Platzhalter-Trigger und bauen sich beim
  // Schliessen wieder ab (organizer-page-actions.html). Pro Zeile drei echte
  // Comboboxen waeren bei hunderten Seiten tausend Alpine-Komponenten mit je
  // zwei globalen Listenern, und jede Kapitel-Umbenennung liesse alle
  // Options-Effekte neu laufen. Es ist hoechstens EINE offen: `activeRowCombo`.
  isRowCombo(pageId, kind) {
    return this.activeRowCombo === pageId + ':' + kind;
  },

  openRowCombo(pageId, kind) {
    this.activeRowCombo = pageId + ':' + kind;
  },

  // Fokus nur zuruecksetzen, wenn er in der Combobox lag (Escape/Enter) — beim
  // Klick ausserhalb gehoert er dem angeklickten Element.
  closeRowCombo(pageId, kind, ev) {
    const key = pageId + ':' + kind;
    if (this.activeRowCombo !== key) return;
    const hadFocus = !!ev?.target?.contains?.(document.activeElement);
    this.activeRowCombo = null;
    if (hadFocus) {
      this.$nextTick(() => this._cardRoot().querySelector(`[data-row-combo="${key}"]`)?.focus());
    }
  },

  // Promote-Validierung: Kapitel auf Top-Level (depth=1) hat keinen Parent.
  canPromoteChapter(id) {
    const found = this._findChapter(id);
    return !!(found && found.node.depth > 1);
  },

  // Demote-Validierung: Vor-Geschwister muss existieren UND subtreeDepth + 1 darf
  // MAX_CHAPTER_DEPTH nicht ueberschreiten.
  canDemoteChapter(id) {
    const found = this._findChapter(id);
    if (!found) return false;
    if (found.index === 0) return false; // kein Vor-Geschwister
    const newDepth = found.node.depth + 1;
    return (newDepth + this._subtreeDepth(found.node) - 1) <= MAX_CHAPTER_DEPTH;
  },

  // Tab / Shift+Tab im Kapitel-Input: bei moeglicher Aktion preventDefault +
  // promote/demote; sonst native Tab durchlassen (Fokus-Move).
  onChapterTab(ev, id) {
    if (ev.shiftKey) {
      if (this.canPromoteChapter(id)) {
        ev.preventDefault();
        this.promoteChapter(id);
      }
    } else if (this.canDemoteChapter(id)) {
      ev.preventDefault();
      this.demoteChapter(id);
    }
  },

  // Kapitel-Längenverteilung (Zeichen) für die Collapse-Tile am Organizer-Fuss.
  // Quelle: nav.tree Top-Level-Kapitel mit .stats (von _refreshChapterStats
  // gefüllt, Sub-Kapitel-Zeichen sind bereits aufaggregiert). Diverging-Bar um
  // Median analog overviewChapterDistribution. Reihenfolge = Lese-Reihenfolge.
  chapterLengthDist() {
    const roots = (Alpine.store('nav').tree || [])
      .filter(it => it.type === 'chapter' && !it.solo && it.parent_id == null);
    // Signatur statt tree-Ref: stats wird in-place mutiert (kein neuer Ref),
    // sonst bliebe das Memo nach DnD/Stats-Refresh stale.
    const sig = roots.map(c => c.id + ':' + (c.stats?.chars || 0)).join('|');
    return this._memo('chapterLenDist', [sig], () => _computeChapterLengthDist(roots));
  },

  _fmtNum(n) {
    return numberFormat(Alpine.store('shell').uiLocale).format(Number(n || 0));
  },

  // Eine Nachkommastelle (Normseiten in der Längenverteilung).
  _fmtDec1(n) {
    return numberFormat(Alpine.store('shell').uiLocale,
      { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Number(n || 0));
  },

  // Memo-Helper (cards/card-memo.js), gemeinsamer this._memos-Speicher.
  ...memoMethods,
};

// Reiner Compute-Body des Memos (CLAUDE.md „Memo-Pattern"): nimmt die
// Top-Level-Kapitel-Items des Sidebar-Trees und liefert die Zeilen der
// Diverging-Bar. Ohne `this` → unit-testbar (tests/unit/book-organizer.test.mjs).
export function _computeChapterLengthDist(roots) {
  const out = roots
    .map(c => ({
      id: c.id,
      name: c.name,
      chars: c.stats?.chars || 0,
      words: c.stats?.words || 0,
      pages: c.stats?.count || 0,
      normseiten: c.stats?.normseiten || 0,
    }))
    .filter(c => c.chars > 0);
  if (out.length === 0) return [];
  const maxChars = Math.max(1, ...out.map(c => c.chars));
  const minChars = Math.min(...out.map(c => c.chars));
  const sorted = out.map(c => c.chars).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  const withDelta = out.map(c => ({
    ...c,
    deltaPct: median > 0 ? Math.round(((c.chars - median) / median) * 100) : 0,
    isMax: c.chars === maxChars && maxChars > 0 && maxChars !== minChars,
    isMin: c.chars === minChars && maxChars !== minChars,
  }));
  const maxAbsDelta = Math.max(1, ...withDelta.map(c => Math.abs(c.deltaPct)));
  const HALF = 48; // % of full track (cap, damit Bars nicht an Rand stossen)
  return withDelta.map(c => {
    const halfPct = (Math.abs(c.deltaPct) / maxAbsDelta) * HALF;
    return {
      ...c,
      median,
      barWidthPct: halfPct,
      barLeftPct: c.deltaPct >= 0 ? 50 : 50 - halfPct,
      isPositive: c.deltaPct >= 0,
    };
  });
}
