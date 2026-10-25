// Tripwire: die Tool-Module unter routes/jobs/chat-tools/ führen kein SQL
// aus. Jede Abfrage — auf `pages`/`chapters`/`books` (CLAUDE.md
// „Content-Store-Facade als einziger Eintrittspunkt für Buchinhalte") ebenso wie
// auf figures, locations, page_stats, continuity_*, zeitstrahl_* usw. — liegt in
// db/book-chat/<bereich>.js (bzw. einem anderen db/-Modul), das Tool ruft nur
// die Funktion auf. Gesperrt sind darum der DB-Handle selbst (`db` aus
// db/connection oder db/schema), jeder `db.prepare`/`db.exec`-Aufruf und
// SQL-Literale. Andere Helfer aus db/schema (getBookSettings …) und
// db/-Module bleiben erlaubt.
//
// Geprüft wird der ganze Dateitext ohne Kommentarzeilen, damit auch ein über
// zwei Zeilen umbrochenes `FROM\n  pages` auffällt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const TOOLS_DIR = join(REPO_ROOT, 'routes', 'jobs', 'chat-tools');
const CONTENT_SQL = /\b(FROM|JOIN|UPDATE|INTO)\s+(pages|chapters|books)\b/gi;
// SQL-Ausführung, DB-Handle-Import und SQL-Literale. Schlüsselwörter nur gross
// geschrieben, damit deutscher/englischer Fliesstext („Update from …") nicht trifft.
const DB_ACCESS = [
  /\bdb\s*\.\s*(prepare|exec|transaction|pragma)\b/g,
  /require\(\s*['"][^'"]*db\/connection['"]\s*\)/g,
  /\{[^}]*\bdb\b[^}]*\}\s*=\s*require\(\s*['"][^'"]*db\/schema['"]\s*\)/g,
  /\bSELECT\b[\s\S]{0,400}?\bFROM\b|\bINSERT\s+(OR\s+\w+\s+)?INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b/g,
];

function codeText(file) {
  return readFileSync(file, 'utf8').split('\n')
    .map(line => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line))
    .join('\n');
}

function scan(patterns) {
  const files = readdirSync(TOOLS_DIR).filter(f => f.endsWith('.js'));
  assert.ok(files.length > 0, 'keine Tool-Module gefunden — Pfad geändert?');
  const hits = [];
  for (const f of files) {
    const text = codeText(join(TOOLS_DIR, f));
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        const line = text.slice(0, m.index).split('\n').length;
        hits.push(`routes/jobs/chat-tools/${f}:${line}: ${m[0].replace(/\s+/g, ' ').slice(0, 80)}`);
      }
    }
  }
  return hits;
}

test('routes/jobs/chat-tools/*.js enthält kein SQL auf pages/chapters/books', () => {
  const hits = scan([CONTENT_SQL]);
  assert.deepEqual(hits, [], `Abfrage nach db/book-chat/<bereich>.js verschieben:\n${hits.join('\n')}`);
});

test('routes/jobs/chat-tools/*.js führt überhaupt kein SQL aus', () => {
  const hits = scan(DB_ACCESS);
  assert.deepEqual(hits, [], `Abfrage nach db/book-chat/<bereich>.js verschieben, im Tool nur die Funktion aufrufen:\n${hits.join('\n')}`);
});

test('Tripwire-Muster greift auch über Zeilenumbrüche', () => {
  const sample = 'db.prepare(`SELECT 1\n  FROM\n    pages p WHERE p.page_id = ?`)';
  assert.equal([...sample.matchAll(CONTENT_SQL)].length, 1);
  assert.equal([...'LEFT JOIN chapters c ON 1'.matchAll(CONTENT_SQL)].length, 1);
  assert.equal([...'FROM page_stats ps'.matchAll(CONTENT_SQL)].length, 0);
});

test('DB-Zugriffs-Muster greifen, ohne erlaubte Imports oder Fliesstext zu treffen', () => {
  const count = src => DB_ACCESS.reduce((n, re) => n + [...src.matchAll(re)].length, 0);
  assert.equal(count("const { db } = require('../../../db/schema');"), 1);
  assert.equal(count("const { db, getBookName } = require('../../../db/schema');"), 1);
  assert.equal(count("const { db } = require('../../../db/connection');"), 1);
  assert.equal(count('db.prepare(`x`)'), 1);
  assert.equal(count("db.exec('x')"), 1);
  assert.equal(count('const sql = `SELECT id\n  FROM figures WHERE id = ?`;'), 1);
  assert.equal(count("'INSERT OR IGNORE INTO t (a) VALUES (?)'"), 1);
  assert.equal(count("'UPDATE figures SET name = ?'"), 1);
  assert.equal(count("'DELETE FROM figures'"), 1);
  assert.equal(count("const { getBookSettings, getBookName } = require('../../../db/schema');"), 0);
  assert.equal(count("const { listActs } = require('../../../db/plot');"), 0);
  assert.equal(count("return { hint: 'Update from Sync, select a page' };"), 0);
});
