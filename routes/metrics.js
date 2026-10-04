'use strict';
// Metrics-Endpunkte fuer externe Scraper, Bearer-Token-Auth via lib/bearer-auth
// (Scope `metrics:read`). Cache-Control: no-store — jeder Abruf liest Live-State.
//   GET /metrics       Prometheus-Text 0.0.4 (Prometheus, Grafana, HA-YAML)
//   GET /metrics.json  selbstbeschreibendes JSON (Home-Assistant-Integration)
// Pro-User-Kennzahlen liefern beide nur, wenn der Token zusaetzlich den Scope
// `metrics:users` traegt. Der Router wird mit vollen Pfaden an der Wurzel
// montiert (server.js), damit `/metrics.json` neben `/metrics` liegen kann.

const express = require('express');
const { requireBearer, tokenHasScope } = require('../lib/bearer-auth');
const { collectMetrics, collectMetricsJson } = require('../lib/metrics-collector');
const logger = require('../logger');

const router = express.Router();

const _includeUsers = (req) => tokenHasScope(req.apiToken?.scopes, 'metrics:users');

router.get('/metrics', requireBearer('metrics:read'), (req, res) => {
  try {
    const body = collectMetrics({ includeUsers: _includeUsers(req) });
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(body);
  } catch (e) {
    logger.error(`/metrics collect failed: ${e.message}`);
    res.status(500).type('text/plain').send('# metrics collection failed\n');
  }
});

router.get('/metrics.json', requireBearer('metrics:read'), (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(collectMetricsJson({ includeUsers: _includeUsers(req) }));
  } catch (e) {
    logger.error(`/metrics.json collect failed: ${e.message}`);
    res.status(500).json({ error_code: 'METRICS_COLLECT_FAILED' });
  }
});

module.exports = router;
