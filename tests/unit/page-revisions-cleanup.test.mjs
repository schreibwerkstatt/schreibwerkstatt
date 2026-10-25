// page_revisions Retention via cache-cleanup-Policy `tiered`.
// Floor aus app.page_revision_limit (jueng­ste N pro Seite garantiert behalten);
// Bucket-Schema (Tag/Woche/Monat/Jahr) ist hardcoded in pruneTiered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);

function _bootstrap() {
  const dir = mkdtempSync(join(tmpdir(), 'page-revisions-cleanup-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
  for (const key of Object.keys(require_.cache)) {
    if (key.includes('/db/') || key.includes('/lib/')) delete require_.cache[key];
  }
  require_('../../db/connection');
  require_('../../db/migrations').runMigrations();
  return {
    dir,
    db: require_('../../db/connection').db,
    appSettings: require_('../../lib/app-settings'),
    pageRevisions: require_('../../db/page-revisions'),
    cleanup: require_('../../lib/cache-cleanup'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

function _seedBookAndPage(ctx) {
  const now = new Date().toISOString();
  const bookId = ctx.db.prepare(`
    INSERT INTO books (name, slug, owner_email, created_at, updated_at)
    VALUES ('Test', 'test', 'a@b', ?, ?)
  `).run(now, now).lastInsertRowid;
  const pageId = ctx.db.prepare(`
    INSERT INTO pages (book_id, page_name, body_html, updated_at, local_updated_at)
    VALUES (?, 'P', '<p>x</p>', ?, ?)
  `).run(bookId, now, now).lastInsertRowid;
  return { bookId, pageId };
}

function _seedRevisions(ctx, pageId, bookId, count) {
  for (let i = 0; i < count; i++) {
    ctx.pageRevisions.insert({
      pageId, bookId,
      bodyHtml: `<p>rev ${i}</p>`,
      source: 'main',
    });
  }
}

// Backdating fuer Tiered-Tests: schreibt created_at relativ zu einem Anker
// (Default = jetzt). Anker-Override macht UTC-Date-Bucketing deterministisch
// — sonst wandern Tag-Grenzen je nach CI-Uhrzeit zwischen Test-daysAgo-Werte.
function _seedBackdated(ctx, pageId, bookId, bodyHtml, daysAgo, anchorMs = Date.now()) {
  const created = new Date(anchorMs - daysAgo * 86400_000).toISOString();
  return ctx.db.prepare(`
    INSERT INTO page_revisions
      (page_id, book_id, body_html, chars, words, tok, source, created_at)
    VALUES (?, ?, ?, ?, 1, 1, 'main', ?)
  `).run(pageId, bookId, bodyHtml, bodyHtml.length, created).lastInsertRowid;
}

test('tiered policy: alle Revs <1 Tag → raw-Bucket, nichts geloescht', () => {
  const ctx = _bootstrap();
  try {
    const { bookId, pageId } = _seedBookAndPage(ctx);
    ctx.appSettings.set('app.page_revision_limit', 3, { updatedBy: 'test' });
    _seedRevisions(ctx, pageId, bookId, 10);
    assert.equal(ctx.pageRevisions.countForPage(pageId), 10);

    const summary = ctx.cleanup.runCacheCleanup();
    const entry = summary.tables.find(t => t.table === 'page_revisions');
    assert.ok(entry, 'page_revisions in summary');
    assert.equal(entry.kind, 'tiered');
    assert.equal(entry.setting, 'app.page_revision_limit');
    // raw-Bucket schuetzt alle juengsten 24h.
    assert.equal(entry.removed, 0);
    assert.equal(ctx.pageRevisions.countForPage(pageId), 10);
  } finally { ctx.teardown(); }
});

test('tiered policy: GFS-Buckets reduzieren backdated Revisions auf 1 pro Bucket', () => {
  const ctx = _bootstrap();
  try {
    const { bookId, pageId } = _seedBookAndPage(ctx);
    ctx.appSettings.set('app.page_revision_limit', 1, { updatedBy: 'test' });

    // Anker = fixierter UTC-Mittag, damit Tag-Grenzen unabhaengig von der CI-
    // Uhrzeit deterministisch zwischen den daysAgo-Werten verlaufen.
    const anchor = '2026-05-25T12:00:00.000Z';
    const anchorMs = Date.parse(anchor);

    // 3 Revs alle innerhalb eines UTC-Kalendertags (Tag-2-Bucket) → 1 behalten.
    _seedBackdated(ctx, pageId, bookId, '<p>d2a</p>', 2.4, anchorMs);
    _seedBackdated(ctx, pageId, bookId, '<p>d2b</p>', 2.2, anchorMs);
    _seedBackdated(ctx, pageId, bookId, '<p>d2c</p>', 2.0, anchorMs);
    // 2 Revs in derselben ISO-Woche → 1 behalten. Anker ist Mo 2026-05-25;
    // 13d/14d zurueck = Di 05-12 / Mo 05-11 (beide %W=19). 15d zurueck waere So 05-10 (%W=18, Bucket-Split).
    _seedBackdated(ctx, pageId, bookId, '<p>w14</p>', 14, anchorMs);
    _seedBackdated(ctx, pageId, bookId, '<p>w13</p>', 13, anchorMs);
    // 2 Revs im selben Monat → 1 behalten.
    _seedBackdated(ctx, pageId, bookId, '<p>m100</p>', 101, anchorMs);
    _seedBackdated(ctx, pageId, bookId, '<p>m101</p>', 100, anchorMs);

    assert.equal(ctx.pageRevisions.countForPage(pageId), 7);

    ctx.cleanup.runCacheCleanup({ now: anchor });
    // Buckets: Tag (d2a aelteste), Woche (w14 aelteste), Monat (m100 aelteste) = 3.
    // Floor 1 → juengste = d2c (kein Bucket-Pick, also +1). Total 4.
    assert.equal(ctx.pageRevisions.countForPage(pageId), 4);
  } finally { ctx.teardown(); }
});

test('tiered policy: pruning ist pro page_id getrennt', () => {
  const ctx = _bootstrap();
  try {
    const { bookId, pageId: p1 } = _seedBookAndPage(ctx);
    const now = new Date().toISOString();
    const p2 = ctx.db.prepare(`
      INSERT INTO pages (book_id, page_name, body_html, updated_at, local_updated_at)
      VALUES (?, 'P2', '<p>y</p>', ?, ?)
    `).run(bookId, now, now).lastInsertRowid;

    ctx.appSettings.set('app.page_revision_limit', 1, { updatedBy: 'test' });
    // Anker fixiert das UTC-Datum des Tag-Buckets — sonst splittet 5.0/5.1/5.2
    // je nach CI-Uhrzeit auf 2 Tage und verfaelscht die Bucket-Anzahl.
    const anchor = '2026-05-25T12:00:00.000Z';
    const anchorMs = Date.parse(anchor);
    // Beide Seiten: 3 Revs am selben Tag, alle backdated 5d → derselbe Tag-Bucket.
    for (let i = 0; i < 3; i++) {
      _seedBackdated(ctx, p1, bookId, `<p>p1_${i}</p>`, 5 + i * 0.1, anchorMs);
      _seedBackdated(ctx, p2, bookId, `<p>p2_${i}</p>`, 5 + i * 0.1, anchorMs);
    }

    ctx.cleanup.runCacheCleanup({ now: anchor });
    // Pro Seite: 1 Bucket-Pick (aelteste) + Floor 1 (juengste). Aelteste ≠ juengste → 2 pro Seite.
    assert.equal(ctx.pageRevisions.countForPage(p1), 2);
    assert.equal(ctx.pageRevisions.countForPage(p2), 2);
  } finally { ctx.teardown(); }
});

test('tiered policy: kein Throw bei leerer Tabelle', () => {
  const ctx = _bootstrap();
  try {
    ctx.appSettings.set('app.page_revision_limit', 5, { updatedBy: 'test' });
    const summary = ctx.cleanup.runCacheCleanup();
    const entry = summary.tables.find(t => t.table === 'page_revisions');
    assert.equal(entry.removed, 0);
  } finally { ctx.teardown(); }
});

test('tiered policy: invalides Setting → error in summary, kein Crash', () => {
  // Simuliert korrupten DB-Zustand: -1 lebt in app_settings (z.B. aus Pre-Validator-
  // Zeit oder direktem DB-Tampering). Cleanup muss defensiv erren, nicht crashen.
  // Schreibt direkt via SQL, da appSettings.set() jetzt validiert.
  const ctx = _bootstrap();
  try {
    const { bookId, pageId } = _seedBookAndPage(ctx);
    _seedRevisions(ctx, pageId, bookId, 3);
    ctx.db.prepare(`
      INSERT INTO app_settings (key, value_json, encrypted, updated_at, updated_by)
      VALUES ('app.page_revision_limit', '-1', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'test-tamper')
      ON CONFLICT(key) DO UPDATE SET value_json = '-1'
    `).run();
    ctx.appSettings.clearCache();
    const summary = ctx.cleanup.runCacheCleanup();
    const entry = summary.tables.find(t => t.table === 'page_revisions');
    assert.ok(entry.error, 'error in summary entry');
    assert.equal(ctx.pageRevisions.countForPage(pageId), 3, 'nichts geloescht bei Fehler');
  } finally { ctx.teardown(); }
});
