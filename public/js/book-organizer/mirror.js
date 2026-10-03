// In-Place-Mirror-Helpers: spiegeln Mutationen aus workTree/soloPages in
// nav.tree + nav.pages, ohne loadPages() (sonst Re-Render der ganzen App).
//
// Ordnungs-Invariante: `nav.tree` ist flach, aber DEPTH-FIRST sortiert — die
// Sidebar (app.js#filteredTree) filtert nur und rendert in Array-Reihenfolge,
// Sub-Kapitel muessen also direkt hinter ihrem Parent stehen. Reihenfolge
// darum NIE global nach `priority` sortieren: priority ist die Position
// INNERHALB des Parents und wuerde Sub-Kapitel aus ihrem Parent herausreissen.
// Massgeblich ist stattdessen die Depth-First-Reihenfolge von workTree
// (`_chapterDfsRank`), plus soloPages davor.

export const mirrorMethods = {
  // chapter-id → Depth-First-Rang aus dem Workstate (0-basiert, ueber alle Tiefen).
  _chapterDfsRank() {
    const rank = new Map();
    let i = 0;
    const walk = (list) => {
      for (const c of list) {
        rank.set(c.id, i++);
        walk(c.subchapters || []);
      }
    };
    walk(this.workTree);
    return rank;
  },

  // Bringt nav.tree in die Reihenfolge, die die Sidebar erwartet: Solo-Seiten
  // zuerst (soloPages-Order), dann Kapitel depth-first. Stabiler Sort — Items,
  // die der Workstate nicht kennt, behalten ihre relative Position am Ende.
  _reorderNavTree() {
    const nav = Alpine.store('nav');
    const chapterRank = this._chapterDfsRank();
    const rank = new Map();
    let i = 0;
    for (const sp of this.soloPages) rank.set('solo-' + sp.id, i++);
    const chapterBase = i;
    for (const [id, r] of chapterRank) rank.set(id, chapterBase + r);
    const tail = chapterBase + chapterRank.size;
    nav.tree.sort((a, b) => (rank.get(a.id) ?? tail) - (rank.get(b.id) ?? tail));
  },

  // Kapitel-Struktur spiegeln: Position innerhalb des Parents (`priority`),
  // Tiefe, Parent-Referenz und das hasChildren-Flag der Sidebar. Deckt damit
  // auch Cross-Level-Moves (DnD, promote/demote) ab, nicht nur Top-Level-Reorder.
  _mirrorChapterOrderInRoot() {
    const nav = Alpine.store('nav');
    const meta = new Map();
    const walk = (list) => {
      list.forEach((c, i) => {
        meta.set(c.id, {
          priority: i + 1,
          depth: c.depth,
          parent_id: c.parent_id ?? null,
          hasChildren: (c.subchapters?.length || 0) > 0,
        });
        walk(c.subchapters || []);
      });
    };
    walk(this.workTree);
    for (const it of nav.tree) {
      if (it.type !== 'chapter' || it.solo) continue;
      const m = meta.get(it.id);
      if (!m) continue;
      it.priority = m.priority;
      it.depth = m.depth;
      it.parent_id = m.parent_id;
      it.hasChildren = m.hasChildren;
    }
    this._reorderNavTree();
    this._resortRootPages();
    this._rebuildOrderMaps();
    this._refreshChapterStats();
  },

  // Seiten-Zugehoerigkeit + -Reihenfolge spiegeln. `affectedChapterIds` grenzt
  // den Rebuild der treeCh.pages-Arrays ein; null = alle Kapitel (History-Replay).
  _mirrorPageMembershipInRoot(affectedChapterIds = null) {
    const nav = Alpine.store('nav');
    // Fuer jede Page im Workstate: chapter_id + priority auf nav.pages
    // spiegeln. Rekursiv — Seiten in Sub-Kapiteln muessen mit, sonst bleibt
    // nav.pages nach einem Move in der Tiefe stale. Bewusst OHNE `name`: ein
    // Move aendert keinen Namen, und ein History-Snapshot traegt die Namen von
    // damals — nach einer Umbenennung anderswo schriebe er den alten zurueck.
    const updates = new Map();
    const collect = (list) => {
      for (const c of list) {
        c.pages.forEach((p, i) => {
          updates.set(p.id, { chapter_id: c.id, priority: i + 1 });
        });
        collect(c.subchapters || []);
      }
    };
    collect(this.workTree);
    this.soloPages.forEach((p, i) => {
      updates.set(p.id, { chapter_id: 0, priority: i + 1 });
    });
    const chapterName = new Map();
    for (const it of nav.tree) {
      if (it.type === 'chapter' && !it.solo) chapterName.set(it.id, it.name);
    }
    for (const p of nav.pages) {
      const u = updates.get(p.id);
      if (!u) continue;
      p.chapter_id = u.chapter_id || 0;
      p.priority = u.priority;
      p.chapterName = u.chapter_id ? (chapterName.get(u.chapter_id) || p.chapterName) : null;
    }
    // Betroffene Kapitel: pages-Array im Tree-Eintrag aus nav.pages neu filtern.
    const targets = affectedChapterIds != null
      ? new Set(affectedChapterIds)
      : new Set(this._chapterDfsRank().keys());
    for (const chapId of targets) {
      if (!chapId) continue;
      const treeCh = nav.tree.find(it => it.type === 'chapter' && !it.solo && it.id === chapId);
      if (!treeCh) continue;
      treeCh.pages = nav.pages
        .filter(p => p.chapter_id === chapId)
        .sort((a, b) => (a.priority || 0) - (b.priority || 0));
    }
    // Solo-Entries: rebuild (Pages, die jetzt root-level sind bzw. waren).
    this._rebuildSoloEntries();
    this._reorderNavTree();
    this._resortRootPages();
    this._rebuildOrderMaps();
    this._refreshChapterStats();
  },

  _rebuildSoloEntries() {
    const nav = Alpine.store('nav');
    for (let i = nav.tree.length - 1; i >= 0; i--) {
      if (nav.tree[i].type === 'chapter' && nav.tree[i].solo) nav.tree.splice(i, 1);
    }
    // Frisch nach soloPages-Reihenfolge anlegen; _reorderNavTree schiebt sie
    // anschliessend vor die Kapitel.
    for (const sp of this.soloPages) {
      const rp = nav.pages.find(p => p.id === sp.id);
      if (!rp) continue;
      nav.tree.push(this._buildSoloEntry(rp));
    }
  },

  // Solo-Tree-Item einer kapitellosen Seite. Shape muss zu tree/load.js passen.
  _buildSoloEntry(rp) {
    return {
      type: 'chapter',
      id: 'solo-' + rp.id,
      name: rp.name,
      priority: rp.priority ?? Number.MAX_SAFE_INTEGER,
      depth: 1,
      parent_id: null,
      open: true,
      solo: true,
      url: null,
      pages: [rp],
    };
  },

  // nav.pages nach Kapitel-Depth-First-Rang + Page-Position sortieren.
  // Kapitellose Seiten kommen zuerst (Rang -1).
  _resortRootPages() {
    const nav = Alpine.store('nav');
    const rank = this._chapterDfsRank();
    const tail = rank.size;
    nav.pages.sort((a, b) => {
      const aO = a.chapter_id ? (rank.get(a.chapter_id) ?? tail) : -1;
      const bO = b.chapter_id ? (rank.get(b.chapter_id) ?? tail) : -1;
      if (aO !== bO) return aO - bO;
      return (a.priority || 0) - (b.priority || 0);
    });
  },

  // Sortier-Indexe (`_chapterOrderMap`/`_pageOrderMap`/`_pageIdOrderMap`) —
  // SSoT ist der Root-Builder aus tree/build.js, kein Nachbau hier.
  _rebuildOrderMaps() {
    window.__app._rebuildTreeOrderMaps?.();
  },

  _refreshChapterStats() {
    const root = window.__app;
    if (typeof root._refreshChapterStats === 'function') root._refreshChapterStats();
  },

  // Setzt die nav.pages-Array-Identität neu (gleiche Elemente, neuer Container).
  // Der Diary-Kalender-Cache invalidiert identity-gated (cache.pagesRef ===
  // nav.pages) und keyt auf den YYYY-MM-DD-Page-Namen — nach Create/Delete/Rename
  // einer Page muss er rebuilden. Nicht bei reinem Reorder/Move nötig (Namen
  // unverändert), darum kein Aufruf aus den Mirror-Pfaden.
  _invalidateDiaryCache() {
    Alpine.store('nav').pages = [...Alpine.store('nav').pages];
  },
};
