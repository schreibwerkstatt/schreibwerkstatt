'use strict';
// Facade der regelbasierten Figuren-Helper der Komplettanalyse-Phase 2.
//   figuren-merge/dedup.js       – Pre-Merge über die Chunks + zweistufiger Merge
//   figuren-merge/beziehungen.js – Zielnamen anreichern/neu binden, Beschreibungs-Prüfung, A2-Faltung
//   figuren-merge/nachlauf.js    – Sozialschicht-Votum, Backfill, ID-Eindeutigkeit, Alias-Cluster

const { normName: _normalizeName } = require('../../../lib/name-normalize');

module.exports = {
  ...require('./figuren-merge/dedup'),
  ...require('./figuren-merge/beziehungen'),
  ...require('./figuren-merge/nachlauf'),
  _normalizeName,
};
