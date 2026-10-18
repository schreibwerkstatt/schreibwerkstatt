#!/usr/bin/env node
'use strict';
// Erzeugt contract/openapi.json aus contract/spec/ (Client-Vertrag, siehe
// contract/README.md). Die Datei ist eingecheckt, weil die Client-Repos sie
// lesen; tests/unit/contract-spec.test.js macht CI rot, wenn sie veraltet.
//
//   node scripts/contract-build.js          # schreiben
//   node scripts/contract-build.js --check  # nur prüfen (Exit 1 bei Drift)
//
// Die Fixtures daneben (contract/fixtures/) erzeugt der Integrationstest:
//   CONTRACT_UPDATE=1 node --test tests/integration/client-contract.test.js

const fs = require('node:fs');
const path = require('node:path');
const { buildSpec } = require('../contract/spec');

const OUT = path.join(__dirname, '..', 'contract', 'openapi.json');

function render() {
  return `${JSON.stringify(buildSpec(), null, 2)}\n`;
}

if (require.main === module) {
  const next = render();
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (process.argv.includes('--check')) {
    if (cur !== next) { console.error('contract/openapi.json veraltet — npm run contract:build'); process.exit(1); }
    console.log('contract/openapi.json aktuell.');
  } else if (cur !== next) {
    fs.writeFileSync(OUT, next);
    console.log('contract/openapi.json geschrieben.');
  } else {
    console.log('contract/openapi.json unverändert.');
  }
}

module.exports = { render, OUT };
