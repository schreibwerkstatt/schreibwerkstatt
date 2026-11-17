// Phase-10 drift guard: SQUASHED_SCHEMA in db/squashed-schema.js MUST produce
// the same canonical schema as walking the legacy migration chain 1..N.
// If this test fails after editing a migration, regenerate via:
//   node tools/dump-schema.js > /tmp/out.sql
// and rebuild db/squashed-schema.js from /tmp/out.sql.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmpDir } from './_helpers/tmp-dir.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const DUMPER = join(ROOT, 'tools', 'dump-schema.js');

function dumpWith(env) {
  const tmp = makeTmpDir('squash-drift-');
  try {
    return execFileSync('node', [DUMPER], {
      env: { ...process.env, ...env, DB_PATH: join(tmp, 'fresh.db'), LOG_LEVEL: 'error' },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('SQUASHED_SCHEMA matches the legacy migration chain byte-for-byte', () => {
  const squashed = dumpWith({});
  const legacy = dumpWith({ FORCE_LEGACY_MIGRATIONS: '1' });

  assert.equal(
    squashed,
    legacy,
    'Schema drift detected — regenerate db/squashed-schema.js from a fresh migration run.',
  );
});

test('SQUASHED_SCHEMA produces FK-clean fresh install at SQUASHED_VERSION', async () => {
  const Database = (await import('better-sqlite3')).default;
  const { SQUASHED_SCHEMA, SQUASHED_VERSION } = await import('../../db/squashed-schema.js');

  const tmp = makeTmpDir('squash-fk-');
  const dbFile = join(tmp, 'fresh.db');
  const db = new Database(dbFile);
  try {
    db.pragma('foreign_keys = ON');
    db.exec(SQUASHED_SCHEMA);

    const version = db.prepare('SELECT version FROM schema_version').get().version;
    assert.equal(version, SQUASHED_VERSION, 'schema_version must equal SQUASHED_VERSION');

    const fkErrors = db.pragma('foreign_key_check');
    assert.equal(fkErrors.length, 0, `foreign_key_check returned ${fkErrors.length} violation(s)`);

    const watermarkRows = db.prepare(
      "SELECT name, seq FROM sqlite_sequence WHERE name IN ('books','chapters','pages')",
    ).all();
    const wm = Object.fromEntries(watermarkRows.map(r => [r.name, r.seq]));
    assert.equal(wm.books, 1_000_000, 'books AUTOINCREMENT watermark missing');
    assert.equal(wm.chapters, 1_000_000, 'chapters AUTOINCREMENT watermark missing');
    assert.equal(wm.pages, 1_000_000, 'pages AUTOINCREMENT watermark missing');
  } finally {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
