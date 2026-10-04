'use strict';
// Facade des Metrics-Collectors (lib/metrics/): Katalog in defs.js, Erhebung
// in collect.js, Ausgabeformate in format.js.

const { collectSamples } = require('./metrics/collect');
const { toPrometheus, toJson } = require('./metrics/format');

/** Prometheus-Text 0.0.4 fuer /metrics. */
function collectMetrics({ includeUsers = false } = {}) {
  return toPrometheus(collectSamples({ includeUsers }).samples);
}

/** Selbstbeschreibendes JSON fuer /metrics.json (Home-Assistant-Integration). */
function collectMetricsJson({ includeUsers = false } = {}) {
  const { samples, today } = collectSamples({ includeUsers });
  return toJson(samples, { today, includeUsers });
}

module.exports = { collectMetrics, collectMetricsJson };
