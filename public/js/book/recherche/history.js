// Undo/Redo des Recherche-Boards — die fachliche Haelfte zum Kern
// public/js/cards/board-history.js (Stack, Deckel, Flight-Schutz, Epoche).
// `this` = die rechercheCard-Instanz. Gilt fuer Liste UND Status-Board (ein
// Bestand, eine Historie).
//
// Record-Typen (jeder traegt before UND after):
//   { kind: 'item-fields', id, before, after }
//        Teilmenge von { kind, title, body, urls, source, tags, status, pinned,
//        archived } — Bearbeiten, Stufe (auch per Drag), Anheften, Archivieren.
//   { kind: 'item-link', id, op: 'add'|'remove', target_kind, target_id }
//   { kind: 'create-item', id }                       — Undo = loeschen, kein Redo
//   { kind: 'delete-items', snaps: [{ id, row }] }    — Undo legt neu an
//   { kind: 'bulk', action, ids, extra, before: { [id]: snap } }
//        EIN Schritt fuer eine Sammelaktion (Stufe, Tag, Archiv, Verknuepfen).
//
// Loeschen ist nur rueckgaengig zu machen, wenn das Fundstueck ohne Anhang
// wieder entstehen kann: Bild, PDF und Interview-Aufnahme liegen nicht im
// Snapshot. Fehlt so etwas, verwirft das Loeschen die Historie (ein Undo davor
// zielte auf ein Objekt, das es nicht mehr gibt). Wiederhergestellt werden
// Text, Links, Tags, Stufe, Anheften, Archiv und die Verknuepfungen; Befunde des
// Abgleichs und Ideen-Verknuepfungen der Gegenseite nicht.
//
// Nach jedem Schritt laedt die Liste neu: Position und Sichtbarkeit bestimmen
// Sortierung und Filter des Servers (wie nach Anheften und Anlegen).
//
// Die Applier sprechen die Routen direkt an, nie die interaktiven Methoden —
// die zeichnen selbst auf.

import { fetchJson } from '../../utils.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const TEXT_KEYS = ['kind', 'title', 'body', 'urls', 'source', 'tags'];
const MEDIA_KINDS = new Set(['image', 'document', 'transcript']);

/** Feld-Snapshot eines Fundstuecks fuer die genannten Schluessel. Pure. */
export function researchFieldSnap(item, keys) {
  const out = {};
  for (const k of keys) {
    if (k === 'urls') out.urls = (item?.urls || []).map(u => ({ url: u.url || '', label: u.label || '' }));
    else if (k === 'tags') out.tags = [...(item?.tags || [])];
    else if (k === 'pinned' || k === 'archived') out[k] = !!item?.[k];
    else out[k] = item?.[k] ?? (k === 'status' ? 'offen' : '');
  }
  return out;
}

/** Kann ein geloeschtes Fundstueck aus seinem Snapshot neu entstehen? Pure. */
export function isRestorableResearch(item) {
  return !!item && !item.has_image && !item.has_doc && !MEDIA_KINDS.has(item.kind);
}

/** Alte ID `from` in einem Record auf `to` umschreiben. Pure. */
export function remapResearchRecord(rec, from, to) {
  if (!rec) return;
  if (rec.id === from) rec.id = to;
  if (Array.isArray(rec.ids)) rec.ids = rec.ids.map(id => (id === from ? to : id));
  if (rec.before && typeof rec.before === 'object' && from in rec.before && rec.kind === 'bulk') {
    rec.before[to] = rec.before[from];
    delete rec.before[from];
  }
  if (Array.isArray(rec.snaps)) for (const s of rec.snaps) if (s.id === from) s.id = to;
}

export const rechercheHistoryMethods = {
  // ── Aufzeichnen ─────────────────────────────────────────────────────────
  // `{ kind: 'clear' }` = kein Rueckweg (Loeschen mit Anhang): Historie verwerfen.
  _recordResearch(rec) {
    if (!rec) return;
    if (rec.kind === 'clear') this._clearHistory();
    else this._pushUndo(rec);
  },

  _recordResearchFields(before, row, keys) {
    if (!before || !row) return;
    this._recordResearch({
      kind: 'item-fields', id: row.id,
      before: researchFieldSnap(before, keys), after: researchFieldSnap(row, keys),
    });
  },
  _recordResearchEdit(before, row) { this._recordResearchFields(before, row, TEXT_KEYS); },

  // Loeschen: Snapshot, wenn alle wieder entstehen koennen — sonst Historie weg.
  _recordResearchDeleted(rows) { this._recordResearch(this._researchDeleteRecord(rows)); },
  _researchDeleteRecord(rows) {
    const list = (rows || []).filter(Boolean);
    if (!list.length) return null;
    if (!list.every(isRestorableResearch)) return { kind: 'clear' };
    return {
      kind: 'delete-items',
      snaps: list.map(r => ({ id: r.id, row: { ...r, urls: [...(r.urls || [])], tags: [...(r.tags || [])], links: [...(r.links || [])] } })),
    };
  },

  // Sammelaktion: Record aus dem Stand der markierten Fundstuecke VOR dem
  // Request; aufgezeichnet wird er erst nach dem Erfolg (bulk.js).
  _researchBulkRecord(action, ids, extra) {
    if (action === 'delete') return this._researchDeleteRecord(ids.map(id => (this.items || []).find(i => i.id === id)));
    const before = {};
    for (const id of ids) {
      const it = (this.items || []).find(i => i.id === id);
      if (it) before[id] = { ...researchFieldSnap(it, ['status', 'archived', 'tags']), links: (it.links || []).map(l => `${l.target_kind}:${l.target_id}`) };
    }
    return { kind: 'bulk', action, ids: [...ids], extra: { ...extra }, before };
  },

  // ── Hooks des Kerns ─────────────────────────────────────────────────────
  _historyBusy() { return !!(this.busy || this.loading || this.refreshing); },
  _historyBeforeApply() {
    if (this.detailEditing) this.cancelEdit();
    this.closeActionMenu?.();
    this.cancelLinkPicker?.();
  },

  async _applyInverse(rec) { return this._applyResearchRecord(rec, true); },
  async _applyForward(rec) { return this._applyResearchRecord(rec, false); },

  async _applyResearchRecord(rec, undo) {
    this.busy = true;
    let ok = false;
    try {
      ok = await this._applyResearchRecordInner(rec, undo);
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = this._rechercheErrorText(e, 'recherche.error.save');
    } finally {
      this.busy = false;
    }
    // Neu laden (Sortierung/Filter des Servers) und die Nebenlesungen nachziehen.
    await this.loadRecherche();
    this._loadTags();
    this._loadResearchTotals();
    this._refreshRechercheCounts('page');
    this._refreshRechercheCounts('chapter');
    return ok;
  },

  async _applyResearchRecordInner(rec, undo) {
    switch (rec.kind) {
      case 'item-fields':
        await this._patchItem(rec.id, this._researchPatchBody(undo ? rec.before : rec.after));
        return true;
      case 'item-link': {
        const add = (rec.op === 'add') !== undo;
        if (add) {
          await fetchJson(`/research/${rec.id}/links`, {
            method: 'POST', headers: JSON_HEADERS,
            body: JSON.stringify({ target_kind: rec.target_kind, target_id: rec.target_id }),
          });
        } else {
          await this._researchBulk('unlink', [rec.id], { target_kind: rec.target_kind, target_id: rec.target_id });
        }
        return true;
      }
      case 'create-item':
        if (!undo) return false;
        await fetchJson(`/research/${rec.id}`, { method: 'DELETE' });
        if (this.detailItemId === rec.id) this.closeDetail();
        return true;
      case 'delete-items':
        if (!undo) {
          await this._researchBulk('delete', rec.snaps.map(s => s.id));
          return true;
        }
        for (const s of rec.snaps) {
          const id = await this._restoreResearch(s.row);
          const from = s.id;
          this._remapHistory((r) => remapResearchRecord(r, from, id), rec);
        }
        return true;
      case 'bulk':
        return this._applyResearchBulk(rec, undo);
      default:
        return false;
    }
  },

  async _applyResearchBulk(rec, undo) {
    const { action, ids, extra, before } = rec;
    if (!undo) { await this._researchBulk(action, ids, extra); return true; }
    if (action === 'status') {
      const byStatus = new Map();
      for (const id of ids) {
        const st = before[id]?.status;
        if (!st) continue;
        if (!byStatus.has(st)) byStatus.set(st, []);
        byStatus.get(st).push(id);
      }
      for (const [status, list] of byStatus) await this._researchBulk('status', list, { status });
      return true;
    }
    if (action === 'archive' || action === 'unarchive') {
      const want = action === 'unarchive';
      const list = ids.filter(id => before[id] && before[id].archived === want);
      if (list.length) await this._researchBulk(want ? 'archive' : 'unarchive', list);
      return true;
    }
    if (action === 'add_tag') {
      const tag = String(extra.tag || '').toLowerCase();
      for (const id of ids) {
        const tags = before[id]?.tags;
        if (!tags || tags.some(t => String(t).toLowerCase() === tag)) continue;
        await this._patchItem(id, { tags });
      }
      return true;
    }
    if (action === 'link') {
      const key = `${extra.target_kind}:${extra.target_id}`;
      const list = ids.filter(id => before[id] && !before[id].links.includes(key));
      if (list.length) await this._researchBulk('unlink', list, { target_kind: extra.target_kind, target_id: extra.target_id });
      return true;
    }
    return false;
  },

  _researchPatchBody(fields) {
    const body = { ...fields };
    if ('pinned' in body) body.pinned = !!body.pinned;
    if ('archived' in body) body.archived = !!body.archived;
    return body;
  },

  _researchBulk(action, ids, extra = {}) {
    return fetchJson('/research/bulk', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ book_id: Alpine.store('nav').selectedBookId, ids, action, ...extra }),
    });
  },

  // Geloeschtes Fundstueck aus dem Snapshot neu anlegen. Liefert die neue ID.
  async _restoreResearch(row) {
    const bookId = Alpine.store('nav').selectedBookId;
    const created = await fetchJson('/research', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({
        book_id: bookId, kind: row.kind, title: row.title || '', body: row.body || '',
        source: row.source || '', urls: (row.urls || []).map(u => ({ url: u.url, label: u.label || '' })),
        tags: row.tags || [], allow_duplicate: true,
        // Stand aus dem Snapshot (routes/research.js): Anlegedatum, Status samt
        // Zeitpunkt, Anheften, Archiv — sonst käme es als «heute angelegt» zurück.
        ...(row.created_at ? { restore: {
          created_at: row.created_at, status: row.status || null, status_at: row.status_at || null,
          pinned: !!row.pinned, archived: !!row.archived,
        } } : {}),
      }),
    });
    for (const l of (row.links || [])) {
      try {
        await fetchJson(`/research/${created.id}/links`, {
          method: 'POST', headers: JSON_HEADERS,
          body: JSON.stringify({ target_kind: l.target_kind, target_id: l.target_id }),
        });
      } catch { /* Ziel inzwischen weg: das Fundstueck steht trotzdem wieder */ }
    }
    return created.id;
  },
};
