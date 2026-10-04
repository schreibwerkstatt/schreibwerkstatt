#!/usr/bin/env node
'use strict';
// Ad-hoc TTL-Cleanup nach Prompt-Schema-Bumps oder zur DB-Hygiene.
// Aufruf: `npm run cache:cleanup` oder `npm run cache:cleanup -- --vacuum`.

require('dotenv').config();
const logger = require('../logger');
const { runCacheCleanup, POLICIES } = require('../lib/cache-cleanup');

const wantVacuum = process.argv.includes('--vacuum');

logger.info(`Cache-Cleanup gestartet (${POLICIES.length} Policies, vacuum=${wantVacuum})…`);
const summary = runCacheCleanup({ vacuum: wantVacuum });

for (const t of summary.tables) {
  if (t.skipped) {
    logger.info(`  ${t.table}: übersprungen (${t.skipped})`);
  } else if (t.error) {
    logger.error(`  ${t.table}: Fehler — ${t.error}`);
  } else {
    logger.info(`  ${t.table}: removed=${t.removed} ttlDays=${t.ttlDays}`);
  }
}
logger.info(`Gesamt entfernt: ${summary.totalRemoved} Row(s). Vacuum: ${summary.vacuumed ? 'ja' : 'nein'}.`);

process.exit(0);
