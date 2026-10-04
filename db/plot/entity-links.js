'use strict';
// Cross-Feature-Lesepfad der Plot-Werkstatt (Facade: db/plot.js): welche Beats
// hängen an einer Katalog-Figur, einem Schauplatz, einer Szene? Gegenrichtung der
// Beat-Brücken für die Detailansichten von Figuren-, Orte- und Szenen-Karte.
//
// Alle drei Achsen liefern dieselbe Antwortform — Map Ziel-ID (Frontend-Identität:
// fig_id / loc_id / figure_scenes.id) → Beats in Board-Lesereihenfolge. Verworfene
// Beats fallen raus: sie sollen nicht mehr ins Buch und sind kein Plan „hier".
//
//   figure    plot_beat_figures + Live-Vererbung der Strang-Hauptfigur
//             (inherited: true — dieselbe Menge wie Badge und Filter im Board)
//   location  plot_beat_locations
//   scene     plot_beat_occurrences (kind='scene') — der abgeleitete Ist-Index der
//             Beat-Verankerung, nicht handgepflegt. minScore wie der Board-Payload.

const { db } = require('../connection');

const _BEAT_COLS = `b.id, b.titel, b.status, a.position AS act_pos, b.sort_order`;
const _BEAT_JOIN = `
  JOIN plot_acts a ON a.id = b.act_id AND a.book_id = b.book_id AND a.user_email = b.user_email`;
const _BEAT_WHERE = `b.book_id = ? AND b.user_email = ? AND b.verworfen = 0`;

const _stmtFigureDirect = db.prepare(`
  SELECT f.fig_id AS target, ${_BEAT_COLS}
    FROM plot_beat_figures pbf
    JOIN plot_beats b ON b.id = pbf.beat_id ${_BEAT_JOIN}
    JOIN figures    f ON f.id = pbf.figure_id AND f.book_id = b.book_id
   WHERE ${_BEAT_WHERE}
`);
const _stmtFigureInherited = db.prepare(`
  SELECT f.fig_id AS target, ${_BEAT_COLS}
    FROM plot_beats b ${_BEAT_JOIN}
    JOIN plot_threads t ON t.id = b.thread_id AND t.book_id = b.book_id AND t.user_email = b.user_email
    JOIN figures      f ON f.id = t.figure_id AND f.book_id = b.book_id
   WHERE ${_BEAT_WHERE}
`);
const _stmtLocation = db.prepare(`
  SELECT l.loc_id AS target, ${_BEAT_COLS}
    FROM plot_beat_locations pbl
    JOIN plot_beats b ON b.id = pbl.beat_id ${_BEAT_JOIN}
    JOIN locations  l ON l.id = pbl.location_id AND l.book_id = b.book_id
   WHERE ${_BEAT_WHERE}
`);
const _stmtScene = db.prepare(`
  SELECT o.scene_id AS target, o.score, ${_BEAT_COLS}
    FROM plot_beat_occurrences o
    JOIN plot_beats b ON b.id = o.beat_id ${_BEAT_JOIN}
   WHERE ${_BEAT_WHERE} AND o.kind = 'scene' AND o.scene_id IS NOT NULL
`);

function _push(map, row, extra) {
  const key = String(row.target);
  let list = map.get(key);
  if (!list) { list = []; map.set(key, list); }
  const prev = list.find(x => x.id === row.id);
  if (prev) {
    // Direkt verknüpft schlägt geerbt — dieselbe Regel wie im Board-Badge.
    if (prev.inherited && !extra.inherited) prev.inherited = false;
    return;
  }
  list.push({ id: row.id, titel: row.titel, status: row.status, ...extra, _pos: [row.act_pos, row.sort_order, row.id] });
}

function _finish(map) {
  const out = {};
  for (const [key, list] of map) {
    list.sort((x, y) => x._pos[0] - y._pos[0] || x._pos[1] - y._pos[1] || x._pos[2] - y._pos[2]);
    out[key] = list.map(({ _pos, ...b }) => b);
  }
  return out;
}

/**
 * @param {number} bookId
 * @param {string} userEmail
 * @param {'figure'|'location'|'scene'} kind
 * @param {{ minScore?: number }} [opts]  nur `scene`: Score-Floor wie plot.anchor.min_score
 * @returns {Record<string, Array<{ id:number, titel:string, status:string, inherited?:boolean }>>}
 */
function plotEntityLinks(bookId, userEmail, kind, opts = {}) {
  const bid = parseInt(bookId);
  const map = new Map();
  if (kind === 'figure') {
    for (const r of _stmtFigureDirect.all(bid, userEmail)) _push(map, r, { inherited: false });
    for (const r of _stmtFigureInherited.all(bid, userEmail)) _push(map, r, { inherited: true });
  } else if (kind === 'location') {
    for (const r of _stmtLocation.all(bid, userEmail)) _push(map, r, {});
  } else if (kind === 'scene') {
    const minScore = Number(opts.minScore) || 0;
    for (const r of _stmtScene.all(bid, userEmail)) {
      if (minScore > 0 && r.score != null && r.score < minScore) continue;
      _push(map, r, {});
    }
  } else {
    return {};
  }
  return _finish(map);
}

module.exports = { plotEntityLinks };
