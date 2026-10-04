// Ideen-Tile: Snapshot des Ideen-Boards — offene Pendenzen (Zahl), Verteilung auf
// die Stufen, Buch-Ideen ohne Ort und Ideen mit planerischer Verknüpfung.
// Datenquelle: /ideen/board?book_id → { statuses, stages, ideen } (user-privat:
// nur die eigenen Ideen). Rein abgeleitet, kein KI-Job. Reader ohne Editor-Recht
// bekommen 403 → overviewIdeen=null → Tile via x-if aus (siehe load.js).
import { ideeStatus } from '../book/ideen-shared.js';

export const IDEEN_TILE_STATUSES = ['offen', 'in_arbeit', 'erledigt', 'verworfen'];

// Pure Aggregation (testbar ohne Alpine).
export function ideenTileStats(ideen) {
  const by = { offen: 0, in_arbeit: 0, erledigt: 0, verworfen: 0 };
  let ohneOrt = 0, verknuepft = 0;
  for (const i of ideen || []) {
    const st = ideeStatus(i);
    if (by[st] != null) by[st]++;
    const open = st === 'offen' || st === 'in_arbeit';
    if (open && i.page_id == null && i.chapter_id == null) ohneOrt++;
    if (open && (i.links || []).length) verknuepft++;
  }
  return { total: (ideen || []).length, open: by.offen + by.in_arbeit, by, ohneOrt, verknuepft };
}

export const ideenMethods = {
  overviewHasIdeen() {
    return Array.isArray(this.overviewIdeen) && this.overviewIdeen.length > 0;
  },
  overviewIdeenStats() {
    const list = this.overviewIdeen;
    return this._memo('ideenStats', [list], () => ideenTileStats(list));
  },
};
