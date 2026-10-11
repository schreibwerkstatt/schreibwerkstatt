// Bearbeitungsstand im Root-Scope (docs/bearbeitungsstand.md): laden, setzen,
// Kapitelstand ableiten. `this` = die Alpine-Root-Komponente.
//
// Der Stand lebt in `$store.badges.editStatus` (Map page_id → Eintrag mit
// status/stale/updated_by) und `$store.badges.editStatusChain` (Kette des
// Buchs) — dieselbe Map lesen Seitenbaum, Buchorganizer, Buchübersicht und
// Buchstatistik. Ein eigener Kapitel-Stand existiert nicht: er ist die
// schwaechste Stufe der Abschnitte darunter (`weakestStatus`).

import { fetchJson, sendJson } from '../../utils/net.js';
import { statusLabelKey, weakestStatus } from '../../redaktion/status.js';

// Memos ausserhalb von Alpine: in den reaktiven Root geschrieben, loeste jedes
// Nachtragen (Map.set im Render) einen erneuten Render aus. Es gibt genau eine
// Root-Instanz, darum reicht Modul-State.
let _chapterMemo = null;
let _filterMemo = null;

export const treeEditStatusMethods = {
  async refreshPageStatus(bookId = this.$store.nav.selectedBookId, signal) {
    if (!bookId) return;
    let r;
    try {
      r = await fetchJson('/redaktion/' + bookId, { signal });
    } catch { return; }
    if (String(this.$store.nav.selectedBookId) !== String(bookId)) return;
    this._applyPageStatus(r);
  },

  _applyPageStatus(r) {
    const badges = this.$store.badges;
    badges.editStatus = r?.pages || {};
    badges.editStatusChain = r?.stufen || [];
  },

  pageEditStatus(pageId) {
    return this.$store.badges.editStatus[String(pageId)] || null;
  },

  editStatusLabel(status) {
    return status ? this.t(statusLabelKey(status)) : this.t('redaktion.status.none');
  },

  // CSS-Modifier der Sidebar-Zeile: Position in der Kette (0–3), damit eine
  // Skala beide Ketten traegt; `stale` als eigener Modifier. Nie leer — der Wert
  // ist ein Klassen-Schluessel im :class-Objekt, und ein leerer Token wirft.
  editStatusClass(entry) {
    if (!entry?.status) return 'edit-status--none';
    const rank = (this.$store.badges.editStatusChain || []).indexOf(entry.status);
    if (rank < 0) return 'edit-status--none';
    return 'edit-status--' + rank + (entry.stale ? ' edit-status--stale' : '');
  },

  // Plakette (Notebook-Kopf, Kapitelbewertung, Bucheditor): Farbe je Rang wie im
  // Buchorganizer (badge--redaktion-<stufe>), gestrichelter Rahmen bei `stale`.
  editStatusBadgeClass(entry) {
    if (!entry?.status) return 'badge--edit-none';
    return 'badge--redaktion-' + entry.status + (entry.stale ? ' badge--edit-stale' : '');
  },

  // Tooltip-Zeile im Status-Popover der Sidebar.
  editStatusTipLine(entry) {
    if (!entry?.status) return '';
    const label = this.editStatusLabel(entry.status);
    return entry.stale
      ? this.t('editStatus.tipStale', { status: label })
      : this.t('editStatus.tip', { status: label });
  },

  // Wie viele der Abschnitte stehen auf der Fertig-Stufe und sind seither
  // unveraendert? Spiegel von db/redaktion.js#doneUnchangedPageIds fuer die
  // Rueckfrage des Serien-Lektorats.
  doneUnchangedCount(pageIds) {
    const chain = this.$store.badges.editStatusChain || [];
    const done = chain[chain.length - 1];
    if (!done) return 0;
    const map = this.$store.badges.editStatus;
    return (pageIds || []).filter(id => {
      const e = map[String(id)];
      return e?.status === done && !e.stale;
    }).length;
  },

  // Tooltip-Zeile «final, aber n offene Pendenzen» — der Widerspruch, den
  // Baum, Board und Übersicht sichtbar machen (docs/bearbeitungsstand.md).
  editStatusFinalOpenLine(pageId) {
    const chain = this.$store.badges.editStatusChain || [];
    const n = this.$store.badges.ideenCounts[pageId] || 0;
    if (!n || !chain.length || this.pageEditStatus(pageId)?.status !== chain[chain.length - 1]) return '';
    return this.t('editStatus.finalOpenTip', { n });
  },

  // Stand-Filter des Seitenbaums: behaelt Abschnitte, die nicht auf der letzten
  // Stufe stehen oder seither bearbeitet wurden, samt ihrer Vorfahren-Kapitel;
  // alles aufgeklappt (Kopien, wie der Such-Zweig in app.js#filteredTree).
  // Memo auf Quelle + Map + Kette: der Getter laeuft bei jedem Render.
  _editFilterTree(source) {
    const map = this.$store.badges.editStatus;
    const chain = this.$store.badges.editStatusChain || [];
    const memo = _filterMemo;
    if (memo && memo.source === source && memo.map === map && memo.chain === chain) return memo.val;
    const done = chain[chain.length - 1];
    const keep = (p) => { const e = map[String(p.id)]; return !(e?.status === done && !e.stale); };
    const matched = new Map();
    for (const item of source) {
      const pages = (item.pages || []).filter(keep);
      if (pages.length) matched.set(item.id, pages);
    }
    const byId = new Map(source.map(it => [it.id, it]));
    const addAncestors = (id) => {
      const it = byId.get(id);
      if (!it?.parent_id) return;
      if (!matched.has(it.parent_id)) matched.set(it.parent_id, []);
      addAncestors(it.parent_id);
    };
    for (const id of [...matched.keys()]) addAncestors(id);
    const val = source.filter(it => matched.has(it.id))
      .map(it => ({ ...it, pages: matched.get(it.id), open: true }));
    _filterMemo = { source, map, chain, val };
    return val;
  },

  // Seiten-IDs eines Kapitels inkl. Unterkapitel, aus der Sidebar-Struktur.
  _chapterSubtreePageIds(item) {
    const tree = this.$store.nav.tree || [];
    const ids = [];
    const walk = (it) => {
      for (const p of it.pages || []) ids.push(p.id);
      for (const child of tree) {
        if (child.type === 'chapter' && !child.solo && child.parent_id === it.id) walk(child);
      }
    };
    walk(item);
    return ids;
  },

  // Kapitelstand = schwaechste Stufe darunter. Memo auf die Identitaet von Map
  // und Baum: der Sidebar-Render fragt jedes Kapitel bei jedem Durchlauf.
  chapterEditStatus(item) {
    if (!item || item.type !== 'chapter') return null;
    const map = this.$store.badges.editStatus;
    const tree = this.$store.nav.tree;
    if (!_chapterMemo || _chapterMemo.map !== map || _chapterMemo.tree !== tree) {
      _chapterMemo = { map, tree, byId: new Map() };
    }
    const byId = _chapterMemo.byId;
    if (!byId.has(item.id)) {
      const ids = this._chapterSubtreePageIds(item);
      byId.set(item.id, weakestStatus(ids.map(id => map[String(id)] || null)));
    }
    return byId.get(item.id);
  },

  async setPageEditStatus(pageId, status) {
    if (!this.canEdit() || pageId == null) return;
    const key = String(pageId);
    const before = this._doneScopes();
    try {
      const r = await sendJson(`/redaktion/page/${pageId}`, 'PUT', { status: status || null });
      const next = { ...this.$store.badges.editStatus };
      if (r.entry) next[key] = r.entry; else delete next[key];
      this.$store.badges.editStatus = next;
    } catch {
      this.setStatus(this.t('redaktion.saveFailed'));
      return;
    }
    await this._offerSnapshot(before);
  },

  // Alle Abschnitte eines Kapitels (inkl. Unterkapitel) auf eine Stufe. Rueckfrage,
  // sobald dabei abweichende Einzelstaende ueberschrieben wuerden.
  async setChapterEditStatus(chapterId, status) {
    if (!this.canEdit() || chapterId == null) return;
    const item = (this.$store.nav.tree || []).find(i => i.type === 'chapter' && i.id === chapterId);
    const ids = item ? this._chapterSubtreePageIds(item) : [];
    const map = this.$store.badges.editStatus;
    const differing = ids.filter(id => (map[String(id)]?.status || null) !== (status || null)
      && map[String(id)]?.status).length;
    if (differing > 0 && !await this.appConfirm({
      message: this.t('editStatus.confirmChapter', { n: differing, status: this.editStatusLabel(status) }),
      confirmLabel: this.t('editStatus.confirmChapterOk'),
    })) return;
    const before = this._doneScopes();
    try {
      const r = await sendJson(`/redaktion/chapter/${chapterId}`, 'PUT', { status: status || null });
      const next = { ...this.$store.badges.editStatus };
      for (const [key, entry] of Object.entries(r.entries || {})) {
        if (entry) next[key] = entry; else delete next[key];
      }
      this.$store.badges.editStatus = next;
    } catch {
      this.setStatus(this.t('redaktion.saveFailed'));
      return;
    }
    await this._offerSnapshot(before);
  },

  // Fertige Einheiten: Kapitel der obersten Ebene, deren schwaechste Stufe die
  // letzte der Kette ist, und das ganze Buch (Schluessel 'book').
  _doneScopes() {
    const chain = this.$store.badges.editStatusChain || [];
    const done = chain[chain.length - 1];
    const out = new Set();
    if (!done) return out;
    const tops = (this.$store.nav.tree || []).filter(i => i.type === 'chapter' && !i.solo && !i.parent_id);
    for (const c of tops) if (this.chapterEditStatus(c)?.status === done) out.add(c.id);
    const map = this.$store.badges.editStatus;
    const pages = this.$store.nav.pages || [];
    if (pages.length && pages.every(p => map[String(p.id)]?.status === done)) out.add('book');
    return out;
  },

  // Wird durch die letzte Aenderung ein Kapitel oder das Buch vollstaendig
  // fertig, bietet die App an, den Stand als Fassung festzuhalten — der
  // natuerliche Moment dafuer (docs/fassungen.md). Nur beim Uebergang, nicht
  // bei jedem Setzen; das Buch geht dem Kapitel vor.
  async _offerSnapshot(before) {
    const after = this._doneScopes();
    const fresh = [...after].filter(k => !before.has(k));
    if (!fresh.length) return;
    const bookId = this.$store.nav.selectedBookId;
    const chapter = fresh.includes('book') ? null
      : (this.$store.nav.tree || []).find(i => i.type === 'chapter' && i.id === fresh[0]);
    const name = chapter ? chapter.name : this.selectedBookName;
    const status = this.editStatusLabel((this.$store.badges.editStatusChain || []).at(-1));
    if (!await this.appConfirm({
      message: this.t(chapter ? 'editStatus.snapshotOfferChapter' : 'editStatus.snapshotOfferBook', { name, status }),
      confirmLabel: this.t('editStatus.snapshotOfferOk'),
    })) return;
    try {
      await sendJson(`/snapshots/${bookId}`, 'POST', {
        label: this.t(chapter ? 'editStatus.snapshotLabelChapter' : 'editStatus.snapshotLabelBook', { name, status }),
      });
      this.setStatus(this.t('editStatus.snapshotSaved'), false, 4000);
    } catch {
      this.setStatus(this.t('editStatus.snapshotFailed'), false, 6000);
    }
  },
};
