// Faktencheck, Recherche-Erstbeleg: archivierte/verworfene Fundstücke fallen
// heraus, BEVOR auf drei Belege geschnitten wird — die Suche zieht mehr Treffer,
// damit verworfene Stücke gültige Belege nicht verdrängen.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('faktencheck-research-evidence');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';

require('../../db/migrations').runMigrations();
const { db } = require('../../db/connection');
const retrieval = require('../../lib/semantic-retrieval');
const { _researchEvidence } = require('../../routes/jobs/komplett/job-faktencheck');

const BOOK = 9601;
const now = new Date().toISOString();
db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(BOOK, 'B', now, now);
db.prepare('INSERT INTO app_users (email) VALUES (?)').run('a@x.ch');
const ins = db.prepare(`INSERT INTO research_items (book_id, user_email, kind, title, archived, status)
                        VALUES (?, 'a@x.ch', 'note', ?, ?, ?)`);
const ids = [
  ins.run(BOOK, 'archiviert', 1, 'offen').lastInsertRowid,
  ins.run(BOOK, 'verworfen', 0, 'verworfen').lastInsertRowid,
  ins.run(BOOK, 'archiviert2', 1, 'offen').lastInsertRowid,
  ins.run(BOOK, 'gut1', 0, 'offen').lastInsertRowid,
  ins.run(BOOK, 'gut2', 0, 'offen').lastInsertRowid,
  ins.run(BOOK, 'gut3', 0, 'offen').lastInsertRowid,
  ins.run(BOOK, 'gut4', 0, 'offen').lastInsertRowid,
];

test('_researchEvidence: filtert vor dem Schnitt, liefert höchstens drei gültige Belege', async () => {
  const orig = retrieval.semanticQuery;
  let asked = null;
  retrieval.semanticQuery = async (_b, _q, opts) => {
    asked = opts.topK;
    return ids.slice(0, opts.topK).map(id => ({ kind: 'research', entity_id: id, text: `Text ${id}`, semScore: 0.9, score: 0.9 }));
  };
  try {
    const out = await _researchEvidence(BOOK, { subjekt: 'X', fakt: 'Y' }, undefined);
    assert.ok(asked > 3, 'zieht mehr als drei Treffer');
    assert.deepEqual(out.map(o => o.titel), ['gut1', 'gut2', 'gut3']);
  } finally { retrieval.semanticQuery = orig; }
});
