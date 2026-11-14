// Undo/Redo des Ideen-Boards — die fachliche Haelfte zum Kern
// public/js/cards/board-history.js (Stack, Deckel, Flight-Schutz, Epoche).
// `this` = die ideenBoardCard-Instanz.
//
// Record-Typen (jeder traegt before UND after, derselbe Record bedient beide
// Richtungen):
//   { kind: 'idee-fields', id, before, after, cellBefore? }
//        before/after: Teilmenge von { content, status, page_id, chapter_id }
//        (Text, Stufe, Ort). `cellBefore` = Reihenfolge der Quellzelle vor einem
//        Stufenwechsel — der Server setzt die Idee beim Wechsel auf 0 (oben), das
//        Undo stellt ihren alten Platz wieder her.
//   { kind: 'idee-order', before: [ids], after: [ids] }   — Reihenfolge EINER Zelle
//   { kind: 'idee-link', id, op: 'add'|'remove', target_kind, target_id }
//   { kind: 'create-ideen', ids }                         — Anlegen (auch mehrere Zeilen)
//   { kind: 'delete-ideen', snaps: [{ id, row }] }        — Snapshot: Undo legt neu an
//   { kind: 'group', recs }                               — EIN Schritt aus mehreren
//        (Drag = Stufe + Reihenfolge, Sammelaktion der Liste)
//
// Undo einer Loeschung legt die Idee neu an (Text, Ort), setzt die Stufe und
// haengt die Verknuepfungen wieder an; die neue ID wird per `_remapHistory` in
// alle uebrigen Records geschrieben. Das Anlegedatum ist danach das von heute
// (POST /ideen setzt es selbst).
//
// Nicht aufgezeichnet, sondern Historie verwerfen: Zusammenfuehren (mehrere
// Ideen gehen in einer auf — kein Gegenweg) und jedes Neuladen mit fremden
// Daten (loadBoard). Stufen-Einstellung und «+ Kapitel» sind keine Ideen-
// Aenderungen und stehen nicht auf dem Stack.
//
// Die Applier rufen die Schreibwege direkt (`_patchIdee`, repo/ideen-queue.js),
// nie die interaktiven Methoden — die zeichnen selbst auf.

import { fetchJson } from '../../utils.js';
import { createIdee, deleteIdee as removeIdee } from '../../repo/ideen-queue.js';
import { ideeStatus } from '../ideen-shared.js';

const FIELD_KEYS = ['content', 'status', 'page_id', 'chapter_id'];

/** Teil-Snapshot der Felder einer Idee. Pure. */
export function ideeFieldSnap(idee, keys = FIELD_KEYS) {
  const out = {};
  for (const k of keys) {
    if (k === 'status') out.status = ideeStatus(idee);
    else out[k] = idee?.[k] ?? null;
  }
  return out;
}

/** PATCH-Body aus einem Feld-Snapshot: Ort als Anker-Body (Buch = beide null). Pure. */
export function ideePatchBody(fields) {
  const body = {};
  if ('content' in fields) body.content = fields.content;
  if ('status' in fields) body.status = fields.status;
  if ('page_id' in fields || 'chapter_id' in fields) {
    if (fields.page_id != null) body.page_id = fields.page_id;
    else if (fields.chapter_id != null) body.chapter_id = fields.chapter_id;
    else { body.page_id = null; body.chapter_id = null; }
  }
  return body;
}

/** Alte ID `from` in einem Record (auch verschachtelt) auf `to` umschreiben. Pure. */
export function remapIdeeRecord(rec, from, to) {
  if (!rec) return;
  const swap = (v) => (v === from ? to : v);
  if (rec.id === from) rec.id = to;
  if (Array.isArray(rec.ids)) rec.ids = rec.ids.map(swap);
  if (Array.isArray(rec.before) && rec.kind === 'idee-order') rec.before = rec.before.map(swap);
  if (Array.isArray(rec.after) && rec.kind === 'idee-order') rec.after = rec.after.map(swap);
  if (Array.isArray(rec.cellBefore)) rec.cellBefore = rec.cellBefore.map(swap);
  if (Array.isArray(rec.snaps)) for (const s of rec.snaps) if (s.id === from) s.id = to;
  if (Array.isArray(rec.recs)) for (const r of rec.recs) remapIdeeRecord(r, from, to);
}

export const ideenBoardHistory = {
  // ── Aufzeichnen ─────────────────────────────────────────────────────────
  // Waehrend eine Sammelaktion bzw. ein Drop laeuft, sammeln die Einzelschritte
  // in `_historyGroup` und landen am Ende als EIN Record.
  _recordIdee(rec) {
    if (!rec) return;
    if (Array.isArray(this._historyGroup)) { this._historyGroup.push(rec); return; }
    this._pushUndo(rec);
  },
  _beginHistoryGroup() { this._historyGroup = []; },
  _endHistoryGroup() {
    const recs = this._historyGroup || [];
    this._historyGroup = null;
    if (recs.length === 1) this._pushUndo(recs[0]);
    else if (recs.length > 1) this._pushUndo({ kind: 'group', recs });
  },

  _recordIdeeFields(before, row, keys, extra = {}) {
    if (!before || !row) return;
    this._recordIdee({ kind: 'idee-fields', id: row.id, before: ideeFieldSnap(before, keys), after: ideeFieldSnap(row, keys), ...extra });
  },

  // Hook aus ideen-links.js (gilt nur im Board; die Ideen-Karte hat keine Historie).
  _recordIdeeLink(op, ideeId, targetKind, targetId) {
    this._recordIdee({ kind: 'idee-link', id: ideeId, op, target_kind: targetKind, target_id: Number(targetId) });
  },

  // ── Hooks des Kerns ─────────────────────────────────────────────────────
  _historyBusy() { return !!(this.busy || this.loading); },
  _historyBeforeApply() {
    if (this.editingId != null) this.cancelEdit();
    this.closeActionMenu?.();
  },

  async _applyInverse(rec) { return this._applyIdeeRecord(rec, 'undo', rec); },
  async _applyForward(rec) { return this._applyIdeeRecord(rec, 'redo', rec); },

  async _applyIdeeRecord(rec, dir, top) {
    try {
      const ok = await this._applyIdeeRecordInner(rec, dir, top);
      this._memos = {};
      this._publishCounts();
      await this._ensureBoardSortables();
      return ok;
    } catch {
      this.errorMessage = window.__app.t('ideenBoard.error.save');
      return false;
    }
  },

  async _applyIdeeRecordInner(rec, dir, top) {
    const undo = dir === 'undo';
    switch (rec.kind) {
      case 'group': {
        const list = undo ? [...rec.recs].reverse() : rec.recs;
        for (const r of list) if (!await this._applyIdeeRecordInner(r, dir, top)) return false;
        return true;
      }
      case 'idee-fields': {
        const idee = this._findIdee(rec.id);
        if (!idee) return false;
        const row = await this._patchIdee(idee, ideePatchBody(undo ? rec.before : rec.after));
        if (!row) return false;
        if (undo && Array.isArray(rec.cellBefore) && rec.cellBefore.length > 1) await this._putIdeenOrder(rec.cellBefore);
        return true;
      }
      case 'idee-order':
        return this._putIdeenOrder(undo ? rec.before : rec.after);
      case 'idee-link': {
        const add = (rec.op === 'add') !== undo;
        const idee = this._findIdee(rec.id);
        if (!idee) return false;
        if (add) {
          const row = await fetchJson(`/ideen/${idee.id}/links`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target_kind: rec.target_kind, target_id: rec.target_id }),
          });
          this._replaceIdee(row);
          return true;
        }
        const link = (idee.links || []).find(l => l.target_kind === rec.target_kind && Number(l.target_id) === rec.target_id);
        if (!link) return true;
        this._replaceIdee(await fetchJson(`/ideen/${idee.id}/links/${link.link_id}`, { method: 'DELETE' }));
        return true;
      }
      case 'create-ideen':
        // Redo gibt es nicht (Kern: `create-*` leert den Redo-Stack).
        return undo ? this._removeIdeenByIds(rec.ids) : false;
      case 'delete-ideen':
        if (!undo) return this._removeIdeenByIds(rec.snaps.map(s => s.id));
        for (const s of rec.snaps) {
          const id = await this._restoreIdee(s.row);
          if (id == null) return false;
          const from = s.id;
          this._remapHistory((r) => remapIdeeRecord(r, from, id), top);
        }
        return true;
      default:
        return false;
    }
  },

  async _removeIdeenByIds(ids) {
    for (const id of ids) {
      const idee = this._findIdee(id);
      if (!idee) continue;
      await removeIdee(idee);
      this.ideen = this.ideen.filter(i => i.id !== id);
    }
    return true;
  },

  async _putIdeenOrder(ids) {
    const have = new Set((this.ideen || []).map(i => i.id));
    const list = (ids || []).filter(id => have.has(id) && id > 0);
    if (list.length < 2) return true;
    await fetchJson('/ideen/order', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: Alpine.store('nav').selectedBookId, ids: list }),
    });
    const rank = new Map(list.map((id, i) => [id, i + 1]));
    this.ideen = this.ideen.map(i => (rank.has(i.id) ? { ...i, sort_order: rank.get(i.id) } : i));
    return true;
  },

  // Geloeschte Idee aus dem Snapshot neu anlegen: Text, Ort und Stand (Anlege-
  // datum, Stufe samt Zeitpunkt, Rang) in einem POST (`restore`, routes/ideen.js),
  // dann die Verknuepfungen. Liefert die neue ID oder null.
  async _restoreIdee(row) {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !row) return null;
    const body = { book_id: bookId, content: row.content };
    if (row.page_id != null) body.page_id = row.page_id;
    else if (row.chapter_id != null) body.chapter_id = row.chapter_id;
    if (row.created_at) {
      body.restore = {
        created_at: row.created_at, status: ideeStatus(row),
        status_at: row.status_at || null, sort_order: row.sort_order || 0,
      };
    }
    let created = await createIdee(body);
    this.ideen = [created, ...this.ideen];
    for (const l of (row.links || [])) {
      if (created.id < 0) break; // offline vorgemerkt: Verknuepfungen gehen nur online
      try {
        created = await fetchJson(`/ideen/${created.id}/links`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_kind: l.target_kind, target_id: l.target_id }),
        });
      } catch { /* Ziel inzwischen weg: die Idee steht trotzdem wieder */ }
    }
    this._replaceIdee(created);
    return created.id;
  },
};
