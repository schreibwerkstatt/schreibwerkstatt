// Drift guard: docs/erd.md MUST stay in sync with the squashed schema.
// Stand-Zeile (Schema-Version + Tabellen-Anzahl) und Mermaid-Block-Definitionen
// werden gegen einen Live-Dump aus SQUASHED_SCHEMA verglichen. FTS5-Shadow-
// Tables (_data/_idx/_content/_docsize/_config) und schema_version sind aus
// der ERD-Zaehlung ausgenommen.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmpDir } from './_helpers/tmp-dir.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const ERD = join(ROOT, 'docs', 'erd.md');

function parseStandLine(md) {
  const v = md.match(/Schema-Version\s+(\d+)/);
  const t = md.match(/(\d+)\s+Tabellen/);
  return {
    version: v ? Number(v[1]) : null,
    tableCount: t ? Number(t[1]) : null,
  };
}

function parseMermaidTables(md) {
  const out = new Set();
  for (const m of md.matchAll(/```mermaid\n([\s\S]*?)```/g)) {
    const body = m[1];
    if (!/erDiagram/.test(body)) continue;
    for (const b of body.matchAll(/^[ \t]+([a-zA-Z_]\w*)\s*\{/gm)) {
      out.add(b[1]);
    }
  }
  return out;
}

function listSchemaTables(db) {
  const all = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_version'"
  ).all();
  const ftsRoots = all
    .filter(r => /USING\s+fts5/i.test(r.sql || ''))
    .map(r => r.name);
  const SHADOW_SUFFIXES = ['_data', '_idx', '_content', '_docsize', '_config'];
  const isShadow = (name) => ftsRoots.some(root =>
    SHADOW_SUFFIXES.some(s => name === `${root}${s}`)
  );
  return all
    .map(r => r.name)
    .filter(name => !isShadow(name))
    .sort();
}

test('docs/erd.md stand-line + Mermaid-Bloecke matchen Squashed-Schema', async () => {
  const Database = (await import('better-sqlite3')).default;
  const { SQUASHED_SCHEMA, SQUASHED_VERSION } = await import('../../db/squashed-schema.js');

  const tmp = makeTmpDir('erd-drift-');
  const dbFile = join(tmp, 'fresh.db');
  const db = new Database(dbFile);
  try {
    db.pragma('foreign_keys = ON');
    db.exec(SQUASHED_SCHEMA);

    const md = readFileSync(ERD, 'utf8');
    const stand = parseStandLine(md);
    const live = listSchemaTables(db);
    const declared = parseMermaidTables(md);

    assert.equal(
      stand.version,
      SQUASHED_VERSION,
      `ERD Stand-Zeile Schema-Version=${stand.version} != SQUASHED_VERSION ${SQUASHED_VERSION}`
    );
    assert.equal(
      stand.tableCount,
      live.length,
      `ERD Stand-Zeile sagt ${stand.tableCount} Tabellen, sqlite_master hat ${live.length} (nach FTS5-Shadow- + schema_version-Filter)`
    );

    const liveSet = new Set(live);
    const missingInErd = live.filter(t => !declared.has(t));
    const missingInDb = [...declared].filter(t => !liveSet.has(t)).sort();

    assert.deepEqual(
      { missingInErd, missingInDb },
      { missingInErd: [], missingInDb: [] },
      `ERD drift — pflege docs/erd.md:
  Im DB-Schema, aber nicht als Mermaid-Block in erd.md: ${JSON.stringify(missingInErd)}
  In erd.md als Mermaid-Block, aber nicht im DB-Schema:  ${JSON.stringify(missingInDb)}`
    );
  } finally {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
