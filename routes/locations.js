'use strict';
// Schauplatz-Katalog (docs/schauplaetze.md). Die Analyse schreibt über
// db/locations-write.js#saveOrteToDb (Komplett-Job); diese Routen sind der Lesepfad
// und die manuelle Pflege durch den Autor. Ein Full-Replace des Katalogs gibt es
// bewusst nicht — jeder Edit adressiert genau einen Ort.
const express = require('express');
const { patchOrtCoords } = require('../db/schema');
const { listLocationsForBook } = require('../db/locations-read');
const {
  createLocation, updateLocation, deleteLocation, deleteStaleLocations, locationPk, LocationEditError,
} = require('../db/locations-edit');
const { mergeLocations } = require('../db/entity-merge');
const logger = require('../logger');
const { aclParamGuard, sessionEmail } = require('../lib/acl');
const { bookParamHandler } = require('../lib/log-context');
const searchIndex = require('../lib/search');

const router = express.Router();
router.param('book_id', aclParamGuard('editor'));
router.param('book_id', bookParamHandler);
const jsonBody = express.json();

// Fachfehler der Pflege-Funktionen als JSON-Antwort; alles andere wirft weiter
// (→ 500 im finalen Fehler-Handler).
function sendEditError(res, e) {
  if (!(e instanceof LocationEditError)) throw e;
  return res.status(e.status).json({ error_code: e.code });
}

// Schauplätze eines Buchs laden
router.get('/:book_id', (req, res) => {
  res.json(listLocationsForBook(req.bookId, sessionEmail(req)));
});

// Schauplatz manuell anlegen. Body: { name, typ?, beschreibung?, stimmung?, land?, parent? }
router.post('/:book_id', jsonBody, (req, res) => {
  try {
    const { id, locId } = createLocation(req.bookId, sessionEmail(req), req.body || {});
    searchIndex.upsertLocation(id);
    res.json({ ok: true, id: locId });
  } catch (e) { sendEditError(res, e); }
});

// Nur Koordinaten einzelner Schauplätze patchen (Marker-Drag, Undo/Redo,
// Georeferenz löschen). Berührt FTS nicht (Index hängt an Name/Beschreibung).
// Body: { patches: [{ id, lat, lng }] }. Muss VOR '/:book_id/:id' stehen.
router.patch('/:book_id/coords', jsonBody, (req, res) => {
  const patches = Array.isArray(req.body?.patches) ? req.body.patches : [];
  const updated = patchOrtCoords(req.bookId, patches, sessionEmail(req));
  res.json({ ok: true, updated });
});

// Stammdaten eines Schauplatzes korrigieren (setzt manually_edited — die nächste
// Komplettanalyse überschreibt die Felder dann nicht). Body: beliebige Teilmenge von
// { name, typ, beschreibung, stimmung, land, parent }; parent = loc_id oder null.
router.patch('/:book_id/:id', jsonBody, (req, res) => {
  try {
    const r = updateLocation(req.bookId, sessionEmail(req), req.params.id, req.body || {});
    if (r.changed) searchIndex.upsertLocation(r.id);
    res.json({ ok: true, changed: r.changed });
  } catch (e) { sendEditError(res, e); }
});

// Zwei Schauplätze zusammenführen: Referenzen der Quelle wandern aufs Ziel, die
// Quelle wird gelöscht (Merge-Kern db/entity-merge.js). `source`/`target` sind loc_ids.
router.post('/:book_id/merge', jsonBody, (req, res) => {
  const bookId = req.bookId;
  const src = String(req.body?.source || '').trim();
  const tgt = String(req.body?.target || '').trim();
  if (!src || !tgt) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (src === tgt) return res.status(409).json({ error_code: 'SAME_ENTITY' });
  const userEmail = sessionEmail(req);
  const sId = locationPk(bookId, userEmail, src);
  const tId = locationPk(bookId, userEmail, tgt);
  if (!sId) return res.status(404).json({ error_code: 'NOT_FOUND', side: 'source' });
  if (!tId) return res.status(404).json({ error_code: 'NOT_FOUND', side: 'target' });

  const result = mergeLocations(bookId, userEmail, sId, tId);
  searchIndex.remove('location', sId);
  searchIndex.upsertLocation(tId);
  logger.info(`Schauplatz-Merge: «${result.sourceName}» → «${result.targetName}» (Buch ${bookId}).`);
  res.json({ ok: true, ...result });
});

// Bulk-Cleanup: alle STALE Schauplätze eines Buchs löschen (Danger-Zone).
// Muss VOR '/:book_id/:id' stehen, sonst matcht 'stale' als :id.
router.delete('/:book_id/stale', (req, res) => {
  const ids = deleteStaleLocations(req.bookId, sessionEmail(req));
  for (const id of ids) searchIndex.remove('location', id);
  res.json({ ok: true, deleted: { locations: ids.length } });
});

// Einzelnen Schauplatz löschen — nur verwaiste («nicht mehr im Text») und vom Autor
// angelegte (409 NOT_DELETABLE sonst). `:id` ist die öffentliche loc_id.
router.delete('/:book_id/:id', (req, res) => {
  try {
    const id = deleteLocation(req.bookId, sessionEmail(req), req.params.id);
    searchIndex.remove('location', id);
    res.json({ ok: true });
  } catch (e) { sendEditError(res, e); }
});

module.exports = router;
