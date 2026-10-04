// Szenen eines Buchs: GET /figures/scenes/:book_id, Merge, Stale-Cleanup, Delete.
//
// Eigenes Modul aus demselben Grund wie ./zeitstrahl.js: Szenen sind kein
// Figuren-Thema — sie leben in `figure_scenes` (+ den Bruecken `scene_figures`
// und `scene_locations`) und teilen mit `figures` nur den Router-Prefix und
// dessen ACL-Guard. Registriert ueber `register(router)` auf DEMSELBEN Router,
// damit `router.param` (ACL + Log-Kontext) greift und die Reihenfolge erhalten
// bleibt: alle `/scenes/...`-Pfade muessen VOR `/:book_id` stehen, sonst
// schluckt die Buch-Route sie — und `/scenes/:book_id/stale` vor
// `/scenes/:book_id/:id`, sonst matcht 'stale' als `:id`.
const express = require('express');
const { db } = require('../../db/schema');
const { mergeScenes } = require('../../db/entity-merge');
const { toIntId } = require('../../lib/validate');
const { listScenesWithRefs } = require('../../db/scene-catalog');
const { sessionEmail } = require('../../lib/acl');
const searchIndex = require('../../lib/search');
const logger = require('../../logger');

const jsonBody = express.json();

function register(router) {
  // Szenen eines Buchs laden (vor /:book_id definiert um Konflikte zu vermeiden)
  router.get('/scenes/:book_id', (req, res) => {
    const bookId = req.bookId;
    const userEmail = sessionEmail(req);

    const { rows, sfRows, slRows } = listScenesWithRefs(bookId, userEmail);
    const sfMap = {};
    for (const sf of sfRows) (sfMap[sf.scene_id] ??= []).push(sf.fig_id);

    const slMap = {};
    for (const sl of slRows) (slMap[sl.scene_id] ??= []).push(sl.loc_id);

    const szenen = rows.map(s => ({
      id:         s.id,
      stale:      !!s.stale,
      kapitel:    s.kapitel,
      seite:      s.seite,
      titel:      s.titel,
      wertung:    s.wertung,
      kommentar:  s.kommentar,
      chapter_id: s.chapter_id,
      page_id:    s.page_id,
      fig_ids:    sfMap[s.id] || [],
      ort_ids:    slMap[s.id] || [],
    }));

    // Jüngster Stand über alle Szenen (wie der Figuren-Katalog), nicht der der
    // ersten nach sort_order.
    const updated_at = rows.reduce((max, r) => (r.updated_at && (!max || r.updated_at > max) ? r.updated_at : max), null);
    res.json({ szenen, updated_at });
  });

  // Zwei Szenen zusammenführen (Pendant zum Figuren-Merge). `source_id`/`target_id`
  // sind INTEGER `figure_scenes.id` — Szenen führen ihre PK öffentlich.
  router.post('/scenes/:book_id/merge', jsonBody, (req, res) => {
    const bookId = req.bookId;
    const srcId = toIntId(req.body?.source_id);
    const tgtId = toIntId(req.body?.target_id);
    if (!srcId || !tgtId) return res.status(400).json({ error_code: 'INVALID_ID' });
    if (srcId === tgtId) return res.status(409).json({ error_code: 'SAME_ENTITY' });
    const userEmail = sessionEmail(req);
    const get = db.prepare('SELECT id FROM figure_scenes WHERE id = ? AND book_id = ? AND user_email IS ?');
    if (!get.get(srcId, bookId, userEmail)) return res.status(404).json({ error_code: 'NOT_FOUND', side: 'source' });
    if (!get.get(tgtId, bookId, userEmail)) return res.status(404).json({ error_code: 'NOT_FOUND', side: 'target' });

    const result = mergeScenes(bookId, userEmail, srcId, tgtId);
    // semantic_chunks.scene_id hängt per ON DELETE CASCADE an figure_scenes.
    searchIndex.remove('scene', srcId);
    searchIndex.upsertScene(tgtId);
    logger.info(`Szenen-Merge: «${result.sourceName}» → «${result.targetName}» (Buch ${bookId}).`);
    res.json({ ok: true, ...result });
  });

  // Bulk-Cleanup: alle STALE Szenen eines Buchs auf einmal löschen (Danger-Zone). Pendant
  // zum Einzel-Delete '/scenes/:book_id/:id'. Der Reconcile markiert nicht mehr im Text
  // vorkommende Szenen als stale=1 statt sie zu löschen (FK-Refs überleben); dieser Endpunkt
  // räumt die aufgelaufenen Altlasten. Nur stale wird angefasst. CASCADE räumt die Bridges mit.
  // Muss VOR '/scenes/:book_id/:id' stehen, sonst matcht 'stale' als :id.
  router.delete('/scenes/:book_id/stale', (req, res) => {
    const ids = db.prepare(
      'SELECT id FROM figure_scenes WHERE book_id = ? AND user_email IS ? AND stale = 1'
    ).all(req.bookId, sessionEmail(req)).map(r => r.id);
    db.transaction(() => {
      const del = db.prepare('DELETE FROM figure_scenes WHERE id = ?');
      for (const id of ids) del.run(id);
    })();
    for (const id of ids) searchIndex.remove('scene', id);
    res.json({ ok: true, deleted: { scenes: ids.length } });
  });

  // Einzelne STALE-Szene endgültig löschen (GUI-Button auf "nicht mehr im Text"-Zeilen).
  // Nur stale erlaubt. CASCADE räumt scene_figures/scene_locations +
  // research_item_links mit.
  router.delete('/scenes/:book_id/:id', (req, res) => {
    const id = toIntId(req.params.id);
    if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
    const row = db.prepare(
      'SELECT stale FROM figure_scenes WHERE id = ? AND book_id = ? AND user_email IS ?'
    ).get(id, req.bookId, sessionEmail(req));
    if (!row) return res.status(404).json({ error_code: 'NOT_FOUND' });
    if (!row.stale) return res.status(409).json({ error_code: 'NOT_STALE' });
    db.prepare('DELETE FROM figure_scenes WHERE id = ?').run(id);
    searchIndex.remove('scene', id);
    res.json({ ok: true });
  });
}

module.exports = { register };
