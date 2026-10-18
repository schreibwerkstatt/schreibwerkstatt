'use strict';
// GET /admin/logs/search: der Cursor `before` hat Sekunden-Aufloesung. Mit
// `skip` (Anzahl schon geladener passender Eintraege genau dieser Sekunde)
// gehen beim Nachladen keine Zeilen derselben Sekunde verloren.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-logs-'));
process.env.LOG_DIR = dir;

// requireAdmin braucht DB + Session — fuer den Cursor-Test irrelevant.
const mwPath = require.resolve('../../lib/admin-mw');
require.cache[mwPath] = { id: mwPath, filename: mwPath, loaded: true, exports: { requireAdmin: (_req, _res, next) => next() } };

const express = require('express');
const router = require('../../routes/admin-logs');
const { LOG_FILE } = require('../../lib/log-file');

const lines = [];
for (let i = 0; i < 6; i++) lines.push(`2026-10-18 10:00:00 [INFO] [app|-|-] same-second ${i}`);
lines.push('2026-10-18 10:00:01 [INFO] [app|-|-] later 0');
lines.push('2026-10-18 10:00:01 [INFO] [app|-|-] later 1');
fs.writeFileSync(LOG_FILE, lines.join('\n') + '\n');

async function search(qs) {
  const app = express();
  app.use('/admin/logs', router);
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/admin/logs/search?${qs}`);
    return await res.json();
  } finally {
    server.close();
  }
}

test('Nachladen ueber mehrere Seiten liefert jede Zeile genau einmal', async () => {
  const seen = [];
  let before = '';
  for (let round = 0; round < 10; round++) {
    const skip = seen.filter(e => e.ts === before).length;
    const data = await search(`limit=3${before ? `&before=${encodeURIComponent(before)}&skip=${skip}` : ''}`);
    seen.push(...data.entries);
    if (!data.hasMore || !data.entries.length) break;
    before = data.entries[data.entries.length - 1].ts;
  }
  assert.deepEqual(seen.map(e => e.msg), [
    'later 1', 'later 0',
    'same-second 5', 'same-second 4', 'same-second 3', 'same-second 2', 'same-second 1', 'same-second 0',
  ]);
});
