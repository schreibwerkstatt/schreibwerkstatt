// admin-usage DB-Queries (listUsersWithUsage, monthlyTotals,
// listFeatureUsage, listTimeUsage, getJobRuns, getChatMessages).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);

const tmpDb = useTmpDb('admin-usage');
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const adminUsage = require('../../db/admin-usage');
// Kosten-Aggregate lesen aus dem persistenten Ledger (db/cost-ledger). Die
// Seed-Helfer schreiben — wie die Produktion (endJobRun / Chat-Insert) —
// zusaetzlich ins Ledger. Detail-Listen (getJobRuns/getChatMessages) lesen
// weiter aus den Quelltabellen; die Extra-Ledger-Rows stoeren sie nicht.
const { recordJobLedger, recordChatLedgerForMessage } = require('../../db/cost-ledger');

function seedUser(email) {
  appUsers.createUser({ email });
}

function seedBook(id, name = 'B') {
  db.prepare(`INSERT OR IGNORE INTO books (book_id, name, created_at, updated_at)
              VALUES (?, ?, datetime('now'), datetime('now'))`).run(id, name);
}

function insertJobRun({ email, bookId = null, type = 'check', tokensIn = 0, tokensOut = 0, model = 'claude-sonnet-4-6', provider = 'claude', when = new Date() }) {
  const jobId = `j-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(`
    INSERT INTO job_runs (job_id, type, book_id, user_email, status, queued_at, started_at, ended_at,
                          tokens_in, tokens_out, provider, model, cache_read_in, cache_creation_in)
    VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?, ?, ?, ?, 0, 0)
  `).run(
    jobId,
    type, bookId, email, when.toISOString(), when.toISOString(), when.toISOString(),
    tokensIn, tokensOut, provider, model,
  );
  // chat-sourced Typen (z.B. 'book-chat') werden hier wie in Produktion uebersprungen.
  recordJobLedger(jobId);
}

function insertChatMsg({ email, bookId, kind = 'book', tokensIn = 0, tokensOut = 0, model = 'claude-sonnet-4-6', feedback = null }) {
  const csResult = db.prepare(`
    INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
  `).run(bookId, kind, email);
  const msg = db.prepare(`
    INSERT INTO chat_messages (session_id, role, content, tokens_in, tokens_out, provider, model, cache_read_in, cache_creation_in, feedback, created_at)
    VALUES (?, 'assistant', 'hi', ?, ?, 'claude', ?, 0, 0, ?, datetime('now'))
  `).run(csResult.lastInsertRowid, tokensIn, tokensOut, model, feedback);
  recordChatLedgerForMessage(msg.lastInsertRowid);
}

test('listUsersWithUsage: aggregiert Jobs + Chat pro User', () => {
  seedUser('a@ex.com');
  seedUser('b@ex.com');
  seedBook(5001);
  insertJobRun({ email: 'a@ex.com', bookId: 5001, tokensIn: 1_000_000, tokensOut: 0 });
  insertChatMsg({ email: 'a@ex.com', bookId: 5001, tokensIn: 0, tokensOut: 1_000_000 });
  insertJobRun({ email: 'b@ex.com', tokensIn: 100_000, tokensOut: 0 });

  const rows = adminUsage.listUsersWithUsage({});
  const a = rows.find(r => r.email === 'a@ex.com');
  const b = rows.find(r => r.email === 'b@ex.com');
  assert.ok(a);
  assert.ok(b);
  // a: 1 Mio Input (3 USD) + 1 Mio Output (15 USD) = 18 USD
  assert.equal(Math.round(a.usd * 100) / 100, 18.00);
  // b: 100k Input = 0.30 USD
  assert.equal(Math.round(b.usd * 100) / 100, 0.30);
  assert.equal(a.jobCalls, 1);
  assert.equal(a.chatCalls, 1);
});

test('listUsersWithUsage: budget + mode + overrun-Flag', () => {
  seedUser('over@ex.com');
  appUsers.setBudget('over@ex.com', { usd: 1, mode: 'hard' });
  insertJobRun({ email: 'over@ex.com', tokensIn: 1_000_000, tokensOut: 0 });
  const rows = adminUsage.listUsersWithUsage({});
  const u = rows.find(r => r.email === 'over@ex.com');
  assert.equal(u.budgetMode, 'hard');
  assert.equal(u.monthlyBudgetUsd, 1);
  assert.equal(u.overrun, true);
});

test('monthlyTotals: Top-User + byModel + byType', () => {
  seedUser('xtop@ex.com');
  seedUser('ytop@ex.com');
  insertJobRun({ email: 'xtop@ex.com', type: 'review', tokensIn: 5_000_000, tokensOut: 0 });
  insertJobRun({ email: 'xtop@ex.com', type: 'review', tokensIn: 2_000_000, tokensOut: 0, model: 'claude-opus-4-7' });
  insertJobRun({ email: 'ytop@ex.com', type: 'check',  tokensIn: 100_000, tokensOut: 0 });

  const s = adminUsage.monthlyTotals({});
  assert.ok(s.totals.usd > 0);
  // xtop hat sehr hohen Spend; muss in Top-10 sein. Order kann durch frueheren
  // Seed-State variieren — daher nur Anwesenheit pruefen.
  const xtop = s.topUsers.find(u => u.email === 'xtop@ex.com');
  assert.ok(xtop, 'xtop in topUsers');
  // 5M sonnet-4-6 ($3/Mio = $15) + 2M opus-4-7 ($5/Mio = $10) = $25
  assert.ok(xtop.usd > 20);
  const models = s.byModel.map(m => m.model);
  assert.ok(models.includes('claude-sonnet-4-6'));
  assert.ok(models.includes('claude-opus-4-7'));
  const types = s.byType.map(t => t.type);
  assert.ok(types.includes('review'));
  assert.ok(types.includes('check'));
});

test('Kein Doppelzaehlen: book-chat zaehlt einmal (chat_messages = SSoT)', () => {
  seedUser('bc@ex.com');
  seedBook(5200);
  // Production schreibt EINEN book-chat-Verbrauch in BEIDE Tabellen: job_runs
  // (Lifecycle, type='book-chat') + chat_messages (Detail). Die Aggregation darf
  // ihn nicht doppeln — der job_runs-Row ist aus dem Kosten-Aggregat ausgeschlossen.
  insertJobRun({ email: 'bc@ex.com', bookId: 5200, type: 'book-chat', tokensIn: 1_000_000, tokensOut: 0 });
  insertChatMsg({ email: 'bc@ex.com', bookId: 5200, kind: 'book', tokensIn: 1_000_000, tokensOut: 0 });

  const u = adminUsage.listUsersWithUsage({}).find(r => r.email === 'bc@ex.com');
  assert.ok(u);
  // 1 Mio Input = $3.00 — EINMAL, nicht $6.00.
  assert.equal(u.tokensIn, 1_000_000);
  assert.equal(Math.round(u.usd * 100) / 100, 3.00);
  // Chat-Call gezaehlt; der book-chat job_runs-Row fliesst NICHT ins job-Aggregat.
  assert.equal(u.chatCalls, 1);
  assert.equal(u.jobCalls, 0);
});

test('getJobRuns: User-Filter paginiert + Cost pro Row', () => {
  seedUser('p@ex.com');
  for (let i = 0; i < 5; i++) {
    insertJobRun({ email: 'p@ex.com', tokensIn: 100_000, tokensOut: 0 });
  }
  const r = adminUsage.getJobRuns({ email: 'p@ex.com', limit: 3 });
  assert.equal(r.total, 5);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0].userEmail, 'p@ex.com');
  // 100k @ 3 USD/Mio = 0.30 USD pro Row
  assert.equal(Math.round(r.rows[0].usd * 100) / 100, 0.30);
});

test('getJobRuns: ohne email liefert alle Non-Admin-User', () => {
  seedUser('all1@ex.com');
  seedUser('all2@ex.com');
  insertJobRun({ email: 'all1@ex.com', tokensIn: 50_000, tokensOut: 0 });
  insertJobRun({ email: 'all2@ex.com', tokensIn: 50_000, tokensOut: 0 });
  const r = adminUsage.getJobRuns({ limit: 500 });
  const emails = new Set(r.rows.map(x => x.userEmail));
  assert.ok(emails.has('all1@ex.com'));
  assert.ok(emails.has('all2@ex.com'));
});

test('getChatMessages: User-Filter + assistant + paginiert', () => {
  seedUser('c@ex.com');
  seedBook(5002);
  insertChatMsg({ email: 'c@ex.com', bookId: 5002, tokensIn: 200_000, tokensOut: 0 });
  insertChatMsg({ email: 'c@ex.com', bookId: 5002, tokensIn: 200_000, tokensOut: 0 });
  const r = adminUsage.getChatMessages({ email: 'c@ex.com' });
  assert.equal(r.total, 2);
  assert.equal(r.rows[0].sessionKind, 'book');
  assert.equal(r.rows[0].userEmail, 'c@ex.com');
});

test('getChatMessages: ohne email liefert alle Non-Admin-User', () => {
  seedUser('chat1@ex.com');
  seedUser('chat2@ex.com');
  seedBook(5102);
  insertChatMsg({ email: 'chat1@ex.com', bookId: 5102, tokensIn: 1000, tokensOut: 0 });
  insertChatMsg({ email: 'chat2@ex.com', bookId: 5102, tokensIn: 1000, tokensOut: 0 });
  const r = adminUsage.getChatMessages({ limit: 500 });
  const emails = new Set(r.rows.map(x => x.userEmail));
  assert.ok(emails.has('chat1@ex.com'));
  assert.ok(emails.has('chat2@ex.com'));
});

test('getChatMessages: Feedback-Filter liefert nur bewertete Antworten, ohne Text', () => {
  seedUser('fb@ex.com');
  seedBook(5202);
  insertChatMsg({ email: 'fb@ex.com', bookId: 5202, feedback: -1, model: 'm-down' });
  insertChatMsg({ email: 'fb@ex.com', bookId: 5202, feedback: 1 });
  insertChatMsg({ email: 'fb@ex.com', bookId: 5202 });
  const down = adminUsage.getChatMessages({ email: 'fb@ex.com', feedback: 'down' });
  assert.equal(down.total, 1);
  assert.equal(down.rows[0].feedback, -1);
  assert.equal(down.rows[0].model, 'm-down');
  assert.ok(!('content' in down.rows[0]), 'Privacy: kein Chat-Text');
  assert.equal(adminUsage.getChatMessages({ email: 'fb@ex.com', feedback: 'up' }).total, 1);
  assert.equal(adminUsage.getChatMessages({ email: 'fb@ex.com' }).total, 3);
  assert.equal(adminUsage.getChatMessages({ email: 'fb@ex.com', feedback: 'bogus' }).total, 3);
});

test('listFeatureUsage + featureUsageTotals', () => {
  seedUser('feat@ex.com');
  db.prepare(`INSERT INTO user_feature_usage (user_email, feature_key, last_used, use_count)
              VALUES (?, ?, ?, ?)`).run('feat@ex.com', 'overview', Date.now(), 5);
  db.prepare(`INSERT INTO user_feature_usage (user_email, feature_key, last_used, use_count)
              VALUES (?, ?, ?, ?)`).run('feat@ex.com', 'review', Date.now(), 3);
  const items = adminUsage.listFeatureUsage({});
  const totals = adminUsage.featureUsageTotals({});
  assert.ok(items.length >= 2);
  assert.ok(totals.length >= 2);
  // Top = overview (5 > 3)
  assert.equal(totals[0].featureKey, 'overview');
});

test('listTimeUsage: Schreib- + Lektorat-Sekunden gemerged', () => {
  const today = new Date().toISOString().slice(0, 10);
  seedUser('t@ex.com');
  seedBook(5050, 'time-test');
  // FK: lektorat_time.page_id → pages(page_id). Seeded.
  db.prepare(`INSERT OR IGNORE INTO pages (page_id, book_id, page_name, updated_at)
              VALUES (?, ?, ?, datetime('now'))`).run(9001, 5050, 'p1');
  db.prepare(`INSERT INTO writing_time (user_email, book_id, date, seconds)
              VALUES (?, ?, ?, ?)`).run('t@ex.com', 5050, today, 1800);
  db.prepare(`INSERT INTO lektorat_time (user_email, book_id, page_id, date, seconds)
              VALUES (?, ?, ?, ?, ?)`).run('t@ex.com', 5050, 9001, today, 900);
  const items = adminUsage.listTimeUsage({});
  const row = items.find(r => r.email === 't@ex.com' && r.bookId === 5050);
  assert.ok(row);
  assert.equal(row.writingSeconds, 1800);
  assert.equal(row.lektoratSeconds, 900);
  assert.equal(row.totalSeconds, 2700);
});

test('Privacy: listUsersWithUsage liefert KEIN books.name', () => {
  seedUser('priv@ex.com');
  seedBook(5003, 'Geheim-Buch');
  insertJobRun({ email: 'priv@ex.com', bookId: 5003, tokensIn: 100_000, tokensOut: 0 });
  const rows = adminUsage.listUsersWithUsage({});
  // Stringified Response darf keinen Buchtitel enthalten.
  assert.ok(!JSON.stringify(rows).includes('Geheim-Buch'));
});

test('userJobBreakdown: Kosten je User x Job-Typ, Chat je Session-Art', () => {
  seedUser('brk@ex.com');
  seedBook(5300);
  insertJobRun({ email: 'brk@ex.com', type: 'komplett-analyse', tokensIn: 1_000_000, tokensOut: 0 });
  insertJobRun({ email: 'brk@ex.com', type: 'komplett-analyse', tokensIn: 1_000_000, tokensOut: 0 });
  insertJobRun({ email: 'brk@ex.com', type: 'check', tokensIn: 100_000, tokensOut: 0 });
  insertChatMsg({ email: 'brk@ex.com', bookId: 5300, kind: 'book', tokensIn: 0, tokensOut: 100_000 });

  const rows = adminUsage.userJobBreakdown({}).filter(r => r.email === 'brk@ex.com');
  const komplett = rows.find(r => r.source === 'job' && r.type === 'komplett-analyse');
  assert.equal(komplett.calls, 2);
  assert.equal(Math.round(komplett.usd * 100) / 100, 6.00); // 2 x 1M Input Sonnet 4.6
  assert.equal(rows.find(r => r.type === 'check').calls, 1);
  const chat = rows.find(r => r.source === 'chat');
  assert.equal(chat.type, 'book');
  assert.equal(Math.round(chat.usd * 100) / 100, 1.50); // 100k Output
  // Summe der Aufschluesselung == User-Summe der Users-Liste.
  const total = rows.reduce((s, r) => s + r.usd, 0);
  const user = adminUsage.listUsersWithUsage({}).find(u => u.email === 'brk@ex.com');
  assert.equal(Math.round(total * 1e6), Math.round(user.usd * 1e6));
});

test('includeAdmins: Admin-Kosten nur mit Schalter in den Auswertungen', () => {
  appUsers.createUser({ email: 'boss@ex.com', globalRole: 'admin' });
  insertJobRun({ email: 'boss@ex.com', type: 'review', tokensIn: 1_000_000, tokensOut: 0 });

  assert.equal(adminUsage.listUsersWithUsage({}).some(u => u.email === 'boss@ex.com'), false);
  assert.equal(adminUsage.userJobBreakdown({}).some(r => r.email === 'boss@ex.com'), false);
  assert.equal(adminUsage.monthlyTotals({}).topUsers.some(u => u.email === 'boss@ex.com'), false);

  const boss = adminUsage.listUsersWithUsage({ includeAdmins: true }).find(u => u.email === 'boss@ex.com');
  assert.equal(Math.round(boss.usd * 100) / 100, 3.00);
  assert.ok(adminUsage.userJobBreakdown({ includeAdmins: true }).some(r => r.email === 'boss@ex.com' && r.type === 'review'));
  assert.ok(adminUsage.monthlyTotals({ includeAdmins: true }).topUsers.some(u => u.email === 'boss@ex.com'));
  assert.ok(adminUsage.getJobRuns({ includeAdmins: true }).rows.some(r => r.userEmail === 'boss@ex.com'));
  assert.equal(adminUsage.getJobRuns({}).rows.some(r => r.userEmail === 'boss@ex.com'), false);
});
