// Tastatur + Fokus im Seitenbaum (WAI-ARIA-Tree-Muster) und das Aufdecken der
// geoeffneten Seite. `this` = die Alpine-Komponente.
//
// Der Baum hat genau EINEN Tab-Stopp (`_treeTabStop`, Schluessel 'c<id>' fuer
// einen Kapitelkopf, 'p<id>' fuer eine Seite); alle anderen Eintraege tragen
// tabindex=-1. Tab springt so in einem Schritt durch den Baum statt durch jede
// Seite. Innerhalb wandern die Pfeiltasten:
//   ↓/↑        naechster/vorheriger sichtbarer Eintrag
//   Home/End   erster/letzter sichtbarer Eintrag
//   →          zugeklapptes Kapitel aufklappen, offenes → erstes Kind
//   ←          offenes Kapitel zuklappen, sonst → uebergeordnetes Kapitel
// Enter/Space bleiben am Eintrag selbst (Kapitelkopf: Aktivieren, Seite: Link).
//
// Die Eintraege tragen `data-tree-key` und `data-tree-parent` (sidebar.html).
// Gelesen wird der DOM, nicht `filteredTree`: sichtbar ist, was gerendert und
// nicht per x-show versteckt ist — genau die Menge, durch die ein Pfeil gehen soll.

const NAV_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft']);

function visibleItems(root) {
  return [...root.querySelectorAll('[data-tree-key]')].filter(el => el.offsetParent !== null);
}

// Naechster eigene Scroll-Container. Auf Desktop ist das die Sidebar-Karte
// (twocolumn.css); mobil scrollt die ganze Seite — dort NICHT scrollen, sonst
// risse das Aufdecken den Blick vom gerade geoeffneten Editor weg.
function scrollParent(el) {
  for (let cur = el.parentElement; cur && cur !== document.body; cur = cur.parentElement) {
    const oy = getComputedStyle(cur).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && cur.scrollHeight > cur.clientHeight) return cur;
  }
  return null;
}

export const treeKeyboardMethods = {
  _onTreeKeydown(e) {
    if (!NAV_KEYS.has(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
    const item = e.target?.closest?.('[data-tree-key]');
    // Nur der Eintrag selbst — eine fokussierte Plakette darin behaelt ihre Tasten.
    if (!item || item !== e.target) return;
    const items = visibleItems(e.currentTarget);
    const i = items.indexOf(item);
    if (i < 0) return;
    e.preventDefault();
    const expanded = item.getAttribute('aria-expanded');
    const isChapter = item.dataset.treeKind === 'chapter';
    let target = null;
    switch (e.key) {
      case 'ArrowDown': target = items[i + 1]; break;
      case 'ArrowUp': target = items[i - 1]; break;
      case 'Home': target = items[0]; break;
      case 'End': target = items[items.length - 1]; break;
      case 'ArrowRight':
        if (isChapter && expanded === 'false') { this._setTreeItemOpen(item, true); return; }
        if (isChapter && expanded === 'true') target = items[i + 1];
        break;
      case 'ArrowLeft':
        if (isChapter && expanded === 'true' && !this.pageSearch) { this._setTreeItemOpen(item, false); return; }
        if (item.dataset.treeParent) target = items.find(el => el.dataset.treeKey === item.dataset.treeParent);
        break;
    }
    if (!target) return;
    this._treeTabStop = target.dataset.treeKey;
    target.focus();
  },

  // Waehrend der Suche sind alle Treffer-Kapitel offen (Kopien in
  // filteredTree) — Auf-/Zuklappen hat dort keine Wirkung und bleibt aus.
  _setTreeItemOpen(el, value) {
    if (this.pageSearch) return;
    const item = this._findTreeChapter?.(String(el.dataset.treeKey).slice(1));
    if (item && !item.solo) this.setChapterOpen(item, value);
  },

  _onTreeFocusIn(e) {
    const key = e.target?.dataset?.treeKey;
    if (key && key !== this._treeTabStop) this._treeTabStop = key;
  },

  // Haelt den Tab-Stopp auf einem sichtbaren Eintrag (x-effect am Baum): faellt
  // er weg (Kapitel zugeklappt, Suche, Reload), rueckt er auf die offene Seite
  // bzw. den ersten Eintrag. Schreibt nur bei Ungueltigkeit — kein Effekt-Loop.
  _syncTreeTabStop() {
    const keys = new Set();
    let first = null;
    for (const it of this.filteredTree) {
      if (!it.solo) { keys.add('c' + it.id); first ??= 'c' + it.id; }
      if (it.solo || it.open) {
        for (const p of it.pages) { keys.add('p' + p.id); first ??= 'p' + p.id; }
      }
    }
    if (this._treeTabStop && keys.has(this._treeTabStop)) return;
    const cur = this.currentPage?.id;
    const next = cur != null && keys.has('p' + cur) ? 'p' + cur : first;
    if (next !== this._treeTabStop) this._treeTabStop = next;
  },

  // Die geoeffnete Seite im Baum sichtbar machen: Kapitel und Vorfahren
  // aufklappen, Tab-Stopp darauf, in den Sidebar-Scrollbereich holen. Laeuft
  // bei jedem Seitenwechsel (app-init.js) — auch wenn die Seite ueber einen
  // Link, die Suchkarte oder das Wiederherstellen beim Start kam und ihr
  // Kapitel zugeklappt war.
  _revealPageInTree(pageId) {
    const page = this.$store.nav.pages.find(p => p.id === pageId);
    if (!page) return;
    let changed = false;
    for (let ch = page.chapter_id ? this._findTreeChapter(page.chapter_id) : null;
      ch; ch = ch.parent_id ? this._findTreeChapter(ch.parent_id) : null) {
      if (!ch.open) { ch.open = true; changed = true; }
    }
    if (changed) this._persistTreeOpenState();
    this._treeTabStop = 'p' + pageId;
    this.$nextTick(() => {
      const el = document.querySelector(`#partial-sidebar [data-tree-key="p${pageId}"]`);
      if (!el || el.offsetParent === null) return;
      const box = scrollParent(el);
      if (!box) return;
      const r = el.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      if (r.top < b.top) box.scrollTop -= (b.top - r.top) + r.height;
      else if (r.bottom > b.bottom) box.scrollTop += (r.bottom - b.bottom) + r.height;
    });
  },
};
