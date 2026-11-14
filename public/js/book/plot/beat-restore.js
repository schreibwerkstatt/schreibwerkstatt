// Plot-Werkstatt: Beat-Löschen rückgängig machen (Record `delete-beat`).
//
// Der Record trägt einen Snapshot von allem, was der Server beim Löschen
// mitnimmt und die API wieder anlegen kann: alle Beat-Felder (POST /plot/beats
// nimmt sie in einem Zug), die Platzierung (Akt, Strang, Position), die
// Beziehungen in beide Richtungen und die Ideen-Verknüpfungen (POST
// /ideen/:id/links). Nicht wiederherstellbar ist nur, was der Server selbst
// erzeugt: die Verankerung (occ_count/occ_top kommt mit dem nächsten Anchor-Lauf).
//
// Undo legt neu an; die neue Beat-ID (und die neuen Beziehungs-IDs) schreibt
// `_remapBeatIds` in jeden Record beider Stacks, auch in den gerade fliegenden.
// Redo löscht den Beat unter seiner aktuellen ID und nimmt dabei einen frischen
// Snapshot, damit ein späteres Undo wieder alles hat.

import { fetchJson } from '../../utils.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export const beatRestoreMethods = {
  // Snapshot eines Board-Beats VOR dem Löschen (Plain-Objekte, keine Referenzen).
  _beatDeleteSnapshot(beat) {
    const relations = (this.relations || [])
      .filter(r => r.from_beat_id === beat.id || r.to_beat_id === beat.id)
      .map(r => ({ id: r.id, from_beat_id: r.from_beat_id, to_beat_id: r.to_beat_id, typ: r.typ }));
    const ideaIds = (this.ideasFor?.(beat.id) || []).map(i => i.idea_id).filter(Boolean);
    return {
      fields: { ...this._beatFieldSnapshot(beat), verworfen: beat.verworfen ? 1 : 0 },
      act_id: beat.act_id,
      thread_id: beat.thread_id ?? null,
      sort_order: beat.sort_order,
      relations,
      ideaIds,
    };
  },

  _recordDeleteBeat(beat, snapshot) {
    this._pushUndo({ kind: 'delete-beat', id: beat.id, snapshot });
  },

  // Alte Beat-/Beziehungs-IDs in allen Records ersetzen (inkl. `extra`, dem
  // gerade fliegenden Record, den der Kern erst danach zurücklegt).
  _remapBeatIds(oldId, newId, relMap = new Map(), ...extra) {
    const b = (id) => (id === oldId ? newId : id);
    this._remapHistory((rec) => {
      if (rec.kind === 'beat-place') {
        for (const p of [...(rec.before || []), ...(rec.after || [])]) p.id = b(p.id);
      } else if (rec.kind === 'beat-fields' || rec.kind === 'create-beat' || rec.kind === 'delete-beat') {
        rec.id = b(rec.id);
      } else if (rec.kind === 'beat-fields-batch') {
        for (const it of rec.items || []) it.id = b(it.id);
      } else if (rec.kind === 'create-relation' && relMap.has(rec.id)) {
        rec.id = relMap.get(rec.id);
      }
      if (rec.kind === 'delete-beat' && rec.snapshot) {
        for (const r of rec.snapshot.relations || []) {
          r.from_beat_id = b(r.from_beat_id);
          r.to_beat_id = b(r.to_beat_id);
          if (relMap.has(r.id)) r.id = relMap.get(r.id);
        }
      }
    }, ...extra);
  },

  // Undo: Beat aus dem Snapshot neu anlegen, Platz, Kanten und Ideen-Links
  // wiederherstellen, IDs umschreiben. Scheitert schon das Anlegen (Akt weg,
  // Netz), bleibt alles beim Alten → false (der Kern legt den Record einmal zurück).
  async _hRestoreBeat(rec) {
    const app = window.__app;
    const snap = rec.snapshot;
    if (!snap) return false;
    const bookId = Alpine.store('nav').selectedBookId;
    let beat;
    try {
      beat = await fetchJson('/plot/beats', {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({ book_id: bookId, act_id: snap.act_id, thread_id: snap.thread_id, ...snap.fields }),
      });
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
      return false;
    }
    const oldId = rec.id;
    this.beats = [...(this.beats || []), beat];
    this._memos = {};
    // An die alte Position: sort_order zurücksetzen, die Zelle neu nummerieren
    // und persistieren (dieselbe Mechanik wie jedes Platzierungs-Undo).
    await this._hApplyPlacements([{ id: beat.id, act_id: snap.act_id, thread_id: snap.thread_id, sort_order: snap.sort_order }]);

    // Beziehungen: nur zu Beats, die es noch gibt. Best-effort — ein Fehlschlag
    // hier lässt den wiederhergestellten Beat stehen.
    const relMap = new Map();
    const alive = new Set((this.beats || []).map(x => x.id));
    for (const r of snap.relations || []) {
      const from = r.from_beat_id === oldId ? beat.id : r.from_beat_id;
      const to = r.to_beat_id === oldId ? beat.id : r.to_beat_id;
      if (!alive.has(from) || !alive.has(to)) continue;
      try {
        const rel = await fetchJson('/plot/beat-relations', {
          method: 'POST', headers: JSON_HEADERS,
          body: JSON.stringify({ book_id: bookId, from_beat_id: from, to_beat_id: to, typ: r.typ }),
        });
        if (rel?.id != null) {
          relMap.set(r.id, rel.id);
          if (!this.relations.some(x => x.id === rel.id)) this.relations = [...this.relations, rel];
        }
      } catch (e) { /* Kante bleibt weg */ }
    }
    let ideasRestored = false;
    for (const ideaId of snap.ideaIds || []) {
      try {
        await fetchJson(`/ideen/${ideaId}/links`, {
          method: 'POST', headers: JSON_HEADERS,
          body: JSON.stringify({ target_kind: 'beat', target_id: beat.id }),
        });
        ideasRestored = true;
      } catch (e) { /* Idee inzwischen gelöscht */ }
    }
    if (ideasRestored) this.loadIdeaBacklinks?.('beat');

    this._remapBeatIds(oldId, beat.id, relMap, rec);
    this._memos = {};
    app.refreshPlotBeatCounts?.();
    this.loadTimeChecks?.();
    this.errorMessage = '';
    return true;
  },

  // Redo: erneut löschen, vorher frisch fotografieren.
  async _hRedeleteBeat(rec) {
    const app = window.__app;
    const beat = (this.beats || []).find(b => b.id === rec.id);
    if (!beat) return false;
    const snapshot = this._beatDeleteSnapshot(beat);
    try {
      await fetchJson(`/plot/beats/${beat.id}`, { method: 'DELETE' });
    } catch (e) {
      this.errorMessage = app.t('plot.error.delete');
      return false;
    }
    rec.snapshot = snapshot;
    this._pruneBeatsLocal([beat.id]);
    this.errorMessage = '';
    return true;
  },
};
