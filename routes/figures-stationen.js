'use strict';
// Berufsweg und Hobbys der Figuren (docs/figur-lebenslauf.md, «Berufsweg und Hobbys»):
//   GET    /figures/:book_id/stationen                               (viewer)  beide Listen, nach fig_id
//   POST   /figures/:book_id/stationen/:kind/:fig_id                 (editor)  Autor legt an
//   PUT    /figures/:book_id/stationen/:kind/:fig_id/:id             (editor)  Autor ändert
//   DELETE /figures/:book_id/stationen/:kind/:fig_id/:id             (editor)  löschen bzw. Vorschlag verwerfen
//   POST   /figures/:book_id/stationen/:kind/:fig_id/:id/uebernehmen (editor)  KI-Vorschlag übernehmen
//
// `kind` = berufe | hobbys. EIGENER ROUTER neben routes/figures.js (Muster
// figures-schulweg.js): gehört nicht in den heissen Katalog-Fetch. Schlüssel nach
// aussen ist die Katalog-Kennung `fig_id`; gespeichert wird an `figures.id`.
// Validierung über die Rechenschicht public/js/book/figure-stationen.js (ESM-Bridge),
// dieselbe Normalisierung wie im Browser-Formular.

const express = require('express');
const { aclParamGuard, sessionEmail } = require('../lib/acl');
const { bookParamHandler } = require('../lib/log-context');
const { figureStationen } = require('../lib/esm-bridge');
const { findFigureForSchoolPath } = require('../db/figure-school-paths');
const {
  STATION_KINDS, listStationen, getStation, createStation, updateStation, deleteStation, acceptStation,
} = require('../db/figure-stationen');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

router.param('book_id', bookParamHandler);

function _out(s) {
  if (!s) return null;
  const { fig_id, ...rest } = s;
  return rest;
}

function _group(list) {
  const out = {};
  for (const s of list) (out[s.fig_id] ||= []).push(_out(s));
  return out;
}

router.get('/:book_id/stationen', aclParamGuard('viewer'), (req, res) => {
  const email = sessionEmail(req);
  res.json({
    berufe: _group(listStationen('berufe', req.bookId, email)),
    hobbys: _group(listStationen('hobbys', req.bookId, email)),
  });
});

/** Art + Figur (+ Zeilen-ID) auflösen; antwortet selbst und liefert null bei Fehler. */
function _scope(req, res, { withId = false } = {}) {
  const kind = req.params.kind;
  if (!STATION_KINDS.includes(kind)) {
    res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'kind', allowed: STATION_KINDS.join(', ') } });
    return null;
  }
  const fig = findFigureForSchoolPath(req.bookId, req.params.fig_id, sessionEmail(req));
  if (!fig) { res.status(404).json({ error_code: 'FIGURE_NOT_FOUND' }); return null; }
  let id = null;
  if (withId) {
    id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error_code: 'INVALID_ID' }); return null; }
  }
  return { kind, fig, id };
}

async function _fields(res, kind, body) {
  const { normalizeStation } = await figureStationen();
  const r = normalizeStation(kind, body || {});
  if (r.fehler) {
    res.status(400).json({ error_code: 'STATION_INVALID', params: { field: r.fehler } });
    return null;
  }
  return r.fields;
}

router.post('/:book_id/stationen/:kind/:fig_id', aclParamGuard('editor'), jsonBody, async (req, res) => {
  const scope = _scope(req, res);
  if (!scope) return;
  const fields = await _fields(res, scope.kind, req.body);
  if (!fields) return;
  const saved = createStation(scope.kind, scope.fig.id, fields, { status: 'aktiv', source: 'autor' });
  logger.info(`[stationen] angelegt kind=${scope.kind} figur=${scope.fig.id} id=${saved.id}`);
  res.json({ ok: true, station: _out(saved) });
});

router.put('/:book_id/stationen/:kind/:fig_id/:id', aclParamGuard('editor'), jsonBody, async (req, res) => {
  const scope = _scope(req, res, { withId: true });
  if (!scope) return;
  const fields = await _fields(res, scope.kind, req.body);
  if (!fields) return;
  const saved = updateStation(scope.kind, scope.id, scope.fig.id, fields);
  if (!saved) return res.status(404).json({ error_code: 'STATION_NOT_FOUND' });
  res.json({ ok: true, station: _out(saved) });
});

router.delete('/:book_id/stationen/:kind/:fig_id/:id', aclParamGuard('editor'), (req, res) => {
  const scope = _scope(req, res, { withId: true });
  if (!scope) return;
  if (!deleteStation(scope.kind, scope.id, scope.fig.id)) return res.status(404).json({ error_code: 'STATION_NOT_FOUND' });
  res.json({ ok: true });
});

router.post('/:book_id/stationen/:kind/:fig_id/:id/uebernehmen', aclParamGuard('editor'), (req, res) => {
  const scope = _scope(req, res, { withId: true });
  if (!scope) return;
  const cur = getStation(scope.kind, scope.id, scope.fig.id);
  if (!cur || cur.status !== 'vorschlag') return res.status(404).json({ error_code: 'STATION_NOT_FOUND' });
  const saved = acceptStation(scope.kind, scope.id, scope.fig.id);
  logger.info(`[stationen] Vorschlag übernommen kind=${scope.kind} figur=${scope.fig.id} id=${scope.id}`);
  res.json({ ok: true, station: _out(saved) });
});

module.exports = router;
