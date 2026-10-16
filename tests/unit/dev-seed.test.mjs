// lib/dev-seed.js — Devmode-Seed bei LOCAL_DEV_MODE und leerer books-Tabelle.
// IDs >= 1_000_001 (sqlite_sequence-Wasserzeichen).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);

function _isolatedDb() {
  const dir = mkdtempSync(join(tmpdir(), 'dev-seed-test-'));
  const dbFile = join(dir, 'test.db');
  process.env.DB_PATH = dbFile;
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'dev-seed-test-secret';
  for (const key of Object.keys(require_.cache)) {
    if (key.includes('/db/') || key.includes('/lib/dev-seed') || key.includes('/lib/app-settings')) {
      delete require_.cache[key];
    }
  }
  require_('../../db/connection');
  const { runMigrations } = require_('../../db/migrations');
  runMigrations();
  return {
    dir,
    devSeed: require_('../../lib/dev-seed'),
    db: require_('../../db/connection').db,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

test('Devmode-Seed: kein Seed ohne LOCAL_DEV_MODE', () => {
  const ctx = _isolatedDb();
  try {
    delete process.env.LOCAL_DEV_MODE;
    const r = ctx.devSeed.runDevSeedIfNeeded();
    assert.equal(r, null);
    const count = ctx.db.prepare('SELECT COUNT(*) AS c FROM books').get().c;
    assert.equal(count, 0);
  } finally { ctx.cleanup(); }
});

test('Devmode-Seed: kein Seed bei LOCAL_DEV_SEED=false', () => {
  const ctx = _isolatedDb();
  try {
    process.env.LOCAL_DEV_MODE = 'true';
    process.env.LOCAL_DEV_SEED = 'false';
    const r = ctx.devSeed.runDevSeedIfNeeded();
    assert.equal(r, null);
    const count = ctx.db.prepare('SELECT COUNT(*) AS c FROM books').get().c;
    assert.equal(count, 0);
  } finally {
    delete process.env.LOCAL_DEV_SEED;
    delete process.env.LOCAL_DEV_MODE;
    ctx.cleanup();
  }
});

test('Devmode-Seed: vollstaendiger Seed bei allen Guards + leerer DB', () => {
  const ctx = _isolatedDb();
  try {
    process.env.LOCAL_DEV_MODE = 'true';
    const r = ctx.devSeed.runDevSeedIfNeeded();
    assert.ok(r);
    assert.ok(r.bookId >= 1_000_001, `bookId ${r.bookId} muss >= 1_000_001 sein`);
    assert.equal(r.chapters, 2);
    assert.equal(r.pages, 5);

    const book = ctx.db.prepare('SELECT name, owner_email FROM books WHERE book_id = ?').get(r.bookId);
    assert.equal(book.name, 'Devmode-Testbuch');
    assert.equal(book.owner_email, 'dev@local');

    const chapterCount = ctx.db.prepare('SELECT COUNT(*) AS c FROM chapters WHERE book_id = ?').get(r.bookId).c;
    assert.equal(chapterCount, 2);

    const pages = ctx.db.prepare('SELECT page_id, page_name, body_html FROM pages WHERE book_id = ? ORDER BY position').all(r.bookId);
    assert.equal(pages.length, 5);
    for (const p of pages) {
      assert.ok(p.page_id >= 1_000_001);
      assert.ok(p.body_html && p.body_html.length > 100, 'jede Page hat echten Prosa-Body');
    }
  } finally {
    delete process.env.LOCAL_DEV_MODE;
    ctx.cleanup();
  }
});

test('Devmode-Seed: Tagebuch mit buchtyp, Jahr-Kapiteln und Einträgen bis heute', () => {
  const ctx = _isolatedDb();
  try {
    process.env.LOCAL_DEV_MODE = 'true';
    const r = ctx.devSeed.runDevSeedIfNeeded();
    assert.ok(r.diaryBookId);
    const s = ctx.db.prepare('SELECT buchtyp FROM book_settings WHERE book_id = ?').get(r.diaryBookId);
    assert.equal(s.buchtyp, 'tagebuch');
    const pages = ctx.db.prepare('SELECT p.page_name, c.chapter_name FROM pages p JOIN chapters c ON c.chapter_id = p.chapter_id WHERE p.book_id = ? ORDER BY p.position').all(r.diaryBookId);
    assert.equal(pages.length, r.diaryEntries);
    assert.ok(pages.length >= 8);
    for (const p of pages) {
      assert.match(p.page_name, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(p.chapter_name, p.page_name.slice(0, 4), 'Eintrag im Jahr-Kapitel');
    }
    assert.deepEqual(pages.map(p => p.page_name), [...pages.map(p => p.page_name)].sort(), 'chronologisch');
    assert.equal(ctx.db.pragma('foreign_key_check').length, 0);
  } finally {
    delete process.env.LOCAL_DEV_MODE;
    ctx.cleanup();
  }
});

test('Devmode-Seed: Share-Links + Kommentare (verankert, allgemein, Reply, resolved, changed)', () => {
  const ctx = _isolatedDb();
  try {
    process.env.LOCAL_DEV_MODE = 'true';
    const r = ctx.devSeed.runDevSeedIfNeeded();
    assert.ok(r);
    assert.equal(r.links, 3);
    assert.ok(r.comments >= 8, `erwartet >=8 Kommentare, war ${r.comments}`);

    // Owner muss als app_user existieren (FK-Ziel) + FK-Integritaet sauber.
    assert.ok(ctx.db.prepare('SELECT 1 FROM app_users WHERE email = ?').get('dev@local'));
    assert.equal(ctx.db.pragma('foreign_key_check').length, 0);

    const links = ctx.db.prepare('SELECT kind FROM share_links WHERE book_id = ? ORDER BY kind').all(r.bookId);
    assert.deepEqual(links.map((l) => l.kind), ['book', 'chapter', 'page']);

    const comments = ctx.db.prepare(`
      SELECT id, parent_id, reader_name, author_email, anchor_bid, anchor_quote, anchor_start, anchor_end, resolved_at
        FROM share_comments ORDER BY id
    `).all();
    assert.equal(comments.length, r.comments);

    // Mindestens je ein verankerter, allgemeiner, Owner-Reply-, resolved- und changed-Kommentar.
    const anchored = comments.filter((c) => c.anchor_bid && c.anchor_start != null);
    const general = comments.filter((c) => !c.anchor_bid && !c.parent_id);
    const ownerReply = comments.filter((c) => c.parent_id && c.author_email === 'dev@local');
    const resolved = comments.filter((c) => c.resolved_at);
    const changed = comments.filter((c) => c.anchor_bid && c.anchor_start == null);
    assert.ok(anchored.length >= 3, 'verankerte Kommentare');
    assert.ok(general.length >= 1, 'allgemeine Kommentare');
    assert.ok(ownerReply.length >= 1, 'Owner-Reply');
    assert.ok(resolved.length >= 1, 'resolved');
    assert.equal(changed.length, 1, 'genau ein „Stelle geändert"-Fall');

    // Anker-Offsets müssen den Block-Text exakt treffen (sonst kein Highlight).
    const bidText = {};
    for (const p of ctx.db.prepare('SELECT body_html FROM pages WHERE book_id = ?').all(r.bookId)) {
      const re = /<p data-bid="([0-9a-f]+)">([\s\S]*?)<\/p>/g; let m;
      while ((m = re.exec(p.body_html))) bidText[m[1]] = m[2];
    }
    for (const c of anchored) {
      assert.equal(bidText[c.anchor_bid].slice(c.anchor_start, c.anchor_end), c.anchor_quote,
        `Anker-Offset trifft Quote nicht: ${JSON.stringify(c.anchor_quote)}`);
    }
    // changed-Quote darf gerade NICHT im Block stehen (sonst kein Diff-Pfad).
    assert.ok(!bidText[changed[0].anchor_bid].includes(changed[0].anchor_quote));
  } finally {
    delete process.env.LOCAL_DEV_MODE;
    ctx.cleanup();
  }
});

test('Devmode-Seed: idempotent (zweiter Call no-op)', () => {
  const ctx = _isolatedDb();
  try {
    process.env.LOCAL_DEV_MODE = 'true';
    const r1 = ctx.devSeed.runDevSeedIfNeeded();
    assert.ok(r1);
    const r2 = ctx.devSeed.runDevSeedIfNeeded();
    assert.equal(r2, null);
    const bookCount = ctx.db.prepare('SELECT COUNT(*) AS c FROM books').get().c;
    assert.equal(bookCount, 2, 'Testbuch + Tagebuch, keine weiteren nach Re-Call');
  } finally {
    delete process.env.LOCAL_DEV_MODE;
    ctx.cleanup();
  }
});
