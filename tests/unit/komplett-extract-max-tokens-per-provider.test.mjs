// Komplettanalyse: der Extraktions-Deckel lokaler Modelle gehört dem Provider.
// `ai.ollama.komplett.extract_max_tokens` und `ai.openai-compat.komplett.extract_max_tokens`
// deckeln je ihren Provider (phases/tokens.js#komplettMaxTokens); die Cloud-Klasse bleibt
// auf dem Provider-Ceiling. Migration 0368 verteilt den Altwert `ai.komplett.extract_max_tokens`
// auf beide Provider-Keys (ein dort gesetzter Wert gewinnt), der Alt-Key fällt weg.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpDir } from './_helpers/tmp-dir.js';

const require_ = createRequire(import.meta.url);

function _bootstrap() {
  const dir = makeTmpDir('komplett-extract-');
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
  for (const key of Object.keys(require_.cache)) {
    if (key.includes('/db/') || key.includes('/lib/') || key.includes('/routes/')) delete require_.cache[key];
  }
  require_('../../db/connection');
  require_('../../db/migrations').runMigrations();
  return {
    appSettings: require_('../../lib/app-settings'),
    tokens: require_('../../routes/jobs/komplett/phases/tokens'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

test('komplettMaxTokens: jeder lokale Provider liest seinen eigenen Deckel', () => {
  const ctx = _bootstrap();
  try {
    ctx.appSettings.set('ai.ollama.max_tokens_out', 64000, 'test');
    ctx.appSettings.set('ai.openai-compat.max_tokens_out', 64000, 'test');
    ctx.appSettings.set('ai.ollama.komplett.extract_max_tokens', 12000, 'test');
    ctx.appSettings.set('ai.openai-compat.komplett.extract_max_tokens', 24000, 'test');
    assert.equal(ctx.tokens.komplettMaxTokens('ollama'), 12000);
    assert.equal(ctx.tokens.komplettMaxTokens('openai-compat'), 24000);
  } finally { ctx.teardown(); }
});

test('komplettMaxTokens: Provider-Deckel bleibt aufs Provider-Ceiling begrenzt', () => {
  const ctx = _bootstrap();
  try {
    ctx.appSettings.set('ai.ollama.max_tokens_out', 8000, 'test');
    ctx.appSettings.set('ai.ollama.komplett.extract_max_tokens', 32000, 'test');
    assert.equal(ctx.tokens.komplettMaxTokens('ollama'), 8000);
  } finally { ctx.teardown(); }
});

// ── Migration 0368 ───────────────────────────────────────────────────────────

const Database = require_('better-sqlite3');
const { SQUASHED_SCHEMA } = require_('../../db/squashed-schema');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SQUASHED_SCHEMA);
  return db;
}
const put = (db, key, v) => db.prepare(
  `INSERT INTO app_settings (key, value_json, updated_at, updated_by) VALUES (?, ?, '2026-11-01T00:00:00.000Z', 'admin@x')`
).run(key, JSON.stringify(v));
const val = (db, key) => {
  const r = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key);
  return r ? JSON.parse(r.value_json) : undefined;
};
const migration = () => require_('../../db/migrations/0368-komplett-extract-max-tokens-per-provider');

test('Migration 0368: Altwert geht an beide Provider-Keys, Alt-Key fällt weg', () => {
  const db = freshDb();
  put(db, 'ai.komplett.extract_max_tokens', 20000);
  migration().up(db);
  assert.equal(val(db, 'ai.ollama.komplett.extract_max_tokens'), 20000);
  assert.equal(val(db, 'ai.openai-compat.komplett.extract_max_tokens'), 20000);
  assert.equal(val(db, 'ai.komplett.extract_max_tokens'), undefined);
});

test('Migration 0368: gesetzter Provider-Key gewinnt gegen den Altwert', () => {
  const db = freshDb();
  put(db, 'ai.komplett.extract_max_tokens', 20000);
  put(db, 'ai.ollama.komplett.extract_max_tokens', 9000);
  migration().up(db);
  assert.equal(val(db, 'ai.ollama.komplett.extract_max_tokens'), 9000);
  assert.equal(val(db, 'ai.openai-compat.komplett.extract_max_tokens'), 20000);
});

test('Migration 0368: ohne Altwert legt sie nichts an', () => {
  const db = freshDb();
  migration().up(db);
  assert.equal(val(db, 'ai.ollama.komplett.extract_max_tokens'), undefined);
  assert.equal(val(db, 'ai.openai-compat.komplett.extract_max_tokens'), undefined);
});
