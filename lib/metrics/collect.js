'use strict';
// Sammelt alle Kennzahlen als Samples ({ name → [{ labels, value }] }).
// Formatunabhaengig: lib/metrics/format.js macht daraus Prometheus-Text oder
// JSON. Gauges spiegeln Live-Zustand, Counter sind kumuliert seit DB-Init.
// Tokens + Kosten kommen aus dem Kosten-Ledger (ai_cost_ledger) mit zur
// Call-Zeit eingefrorener usd — monoton, auch wenn der 30-Tage-Prune job_runs leert.
//
// Pro-User-Kennzahlen nur mit `includeUsers` (Scope `metrics:users`). Auch dann
// keine Buchtitel und keine Inhalte — dieselbe Grenze wie die Admin-Usage-Ansicht.

const q = require('../../db/metrics-queries');
const { allMergeCounters } = require('../../db/merge-telemetry');
const { jobs: jobsMap, jobQueue } = require('../../routes/jobs/shared/state');
const { getVersion } = require('../version');
const { localIsoDate, localDayStartIso, localMonthStartIso } = require('../local-date');
const dbBackup = require('../db-backup');
const billing = require('../anthropic-billing');
const { METRIC_DEFS } = require('./defs');

function makeSink() {
  const samples = new Map();
  function add(name, value, labels = {}) {
    if (!METRIC_DEFS[name]) throw new Error(`metrics: unbekannte Kennzahl ${name} (lib/metrics/defs.js)`);
    const n = Number(value);
    const list = samples.get(name) || [];
    list.push({ labels, value: Number.isFinite(n) ? n : 0 });
    samples.set(name, list);
  }
  return { samples, add };
}

function _server(add) {
  add('sw_build_info', 1, { version: getVersion() });
  add('sw_process_uptime_seconds', Math.round(process.uptime()));
  const mem = process.memoryUsage();
  add('sw_process_resident_memory_bytes', mem.rss);
  add('sw_process_heap_used_bytes', mem.heapUsed);
  const info = dbBackup.backupInfo();
  add('sw_db_size_bytes', info.bytes);
  add('sw_db_schema_version', info.schemaVersion);
  add('sw_js_errors_24h', q.jsErrorsSince(new Date(Date.now() - 86400_000).toISOString()));
  add('sw_registration_requests_pending', q.pendingRegistrations());
  for (const r of q.activeDevices(new Date().toISOString())) {
    add('sw_devices', r.n, { platform: r.platform, client_version: r.client_version });
  }
}

function _users(add) {
  const byStatus = new Map(['active', 'invited', 'suspended', 'deleted'].map(s => [s, 0]));
  for (const r of q.usersByStatus()) byStatus.set(r.status, r.n);
  for (const [status, n] of byStatus) add('sw_users', n, { status });
  const now = Date.now();
  add('sw_active_users_24h', q.usersSeenSince(new Date(now - 86400_000).toISOString()));
  add('sw_active_users_7d', q.usersSeenSince(new Date(now - 7 * 86400_000).toISOString()));
}

function _content(add) {
  add('sw_books', q.countBooks());
  add('sw_books_written', q.booksWritten());
  add('sw_pages', q.countPages());
  add('sw_chapters', q.countChapters());
  const chars = q.sumChars();
  add('sw_chars', chars);
  add('sw_words', q.sumWords());
  add('sw_normseiten', Math.round(chars / 1800));
}

function _writing(add, today, wordsToday) {
  add('sw_writing_seconds_today', q.secondsOn('writing_time', today));
  add('sw_lektorat_seconds_today', q.secondsOn('lektorat_time', today));
  add('sw_stt_seconds_today', q.secondsOn('stt_time', today));
  add('sw_stt_chars_today', q.sttCharsOn(today));
  add('sw_words_today', wordsToday.reduce((s, r) => s + (r.delta || 0), 0));
  add('sw_chars_today', wordsToday.reduce((s, r) => s + (r.chars_delta || 0), 0));
}

function _jobs(add) {
  let running = 0, queuedStatus = 0;
  const byTypeStatus = new Map();
  for (const j of jobsMap.values()) {
    if (j.status === 'running') running++;
    if (j.status === 'queued')  queuedStatus++;
    const key = `${j.type || 'unknown'}\t${j.status || 'unknown'}`;
    byTypeStatus.set(key, (byTypeStatus.get(key) || 0) + 1);
  }
  add('sw_jobs_running', running);
  add('sw_jobs_queued', Math.max(queuedStatus, jobQueue.length));
  for (const [k, n] of byTypeStatus) {
    const [type, status] = k.split('\t');
    add('sw_jobs_in_memory', n, { type, status });
  }
  // Feste End-Status vorbelegt: eine HA-Entity soll auf 0 fallen, nicht verschwinden.
  const ended = new Map(['done', 'error', 'cancelled'].map(s => [s, 0]));
  for (const r of q.jobRunsEndedSince(new Date(Date.now() - 86400_000).toISOString())) {
    const s = r.status || 'unknown';
    ended.set(s, (ended.get(s) || 0) + r.n);
  }
  for (const [status, n] of ended) add('sw_jobs_ended_24h', n, { status });
  for (const r of q.jobRunsByTypeStatus()) {
    add('sw_jobs_finished_total', r.n, { type: r.type || 'unknown', status: r.status || 'unknown' });
  }
}

function _ai(add, dayStart, monthStart) {
  for (const r of q.ledgerByModel()) {
    const labels = { provider: r.provider || 'unknown', model: r.model || 'unknown' };
    add('sw_tokens_in_total', r.t_in, labels);
    add('sw_tokens_out_total', r.t_out, labels);
    add('sw_cache_read_tokens_total', r.c_r, labels);
    add('sw_cache_creation_tokens_total', r.c_w, labels);
    add('sw_cost_usd_total', r.usd, labels);
  }
  add('sw_cost_usd_today', q.ledgerUsdSince(dayStart));
  add('sw_cost_usd_month', q.ledgerUsdSince(monthStart));
  for (const r of q.ledgerUsdByType()) {
    add('sw_cost_usd_by_type_total', r.n, { source: r.source || 'unknown', type: r.type || 'unknown' });
  }
  // Nur mit hinterlegtem Admin-Key; sonst fehlen beide Kennzahlen ganz statt 0
  // zu melden — „nicht konfiguriert" ist nicht „nichts abgerechnet".
  if (billing.isConfigured()) {
    const { totals } = billing.buildReport();
    add('sw_billed_usd_month', totals.billedUsd);
    add('sw_billed_diff_usd_month', totals.diffUsd ?? 0);
  }
}

function _merge(add) {
  const mc = allMergeCounters();
  add('sw_merge_silent_total', mc.silent_success || 0);
  add('sw_merge_conflict_shown_total', mc.conflict_shown || 0);
  add('sw_merge_fallback_overwrite_total', mc.fallback_overwrite || 0);
  for (const choice of ['local', 'remote', 'both']) {
    add('sw_merge_conflict_resolved_total', mc[`conflict_resolved_${choice}`] || 0, { choice });
  }
}

const _byEmail = (rows, field = 'n') => new Map(rows.map(r => [r.email, r[field]]));

function _perUser(add, today, dayStart, monthStart, wordsToday) {
  const writing  = _byEmail(q.secondsByUserOn('writing_time', today));
  const lektorat = _byEmail(q.secondsByUserOn('lektorat_time', today));
  const stt      = _byEmail(q.secondsByUserOn('stt_time', today));
  const books    = _byEmail(q.booksByOwner());
  const words    = _byEmail(q.wordsByOwner());
  const chars    = _byEmail(q.charsByOwner());
  const costDay  = _byEmail(q.ledgerUsdByUserSince(dayStart));
  const costMon  = _byEmail(q.ledgerUsdByUserSince(monthStart));
  const costAll  = _byEmail(q.ledgerUsdByUser());
  const wordsDay = new Map(), charsDay = new Map();
  for (const r of wordsToday) {
    if (!r.email) continue;
    wordsDay.set(r.email, (wordsDay.get(r.email) || 0) + (r.delta || 0));
    charsDay.set(r.email, (charsDay.get(r.email) || 0) + (r.chars_delta || 0));
  }

  for (const u of q.activeUsers()) {
    const labels = { user: u.email, user_name: u.display_name || u.email };
    const writingSec = writing.get(u.email) || 0;
    add('sw_user_writing_seconds_today', writingSec, labels);
    add('sw_user_lektorat_seconds_today', lektorat.get(u.email) || 0, labels);
    add('sw_user_stt_seconds_today', stt.get(u.email) || 0, labels);
    if (u.daily_goal_minutes > 0) {
      add('sw_user_daily_goal_percent',
        Math.round((writingSec / (u.daily_goal_minutes * 60)) * 1000) / 10, labels);
    }
    add('sw_user_words_today', wordsDay.get(u.email) || 0, labels);
    add('sw_user_chars_today', charsDay.get(u.email) || 0, labels);
    add('sw_user_books', books.get(u.email) || 0, labels);
    add('sw_user_words', words.get(u.email) || 0, labels);
    add('sw_user_chars', chars.get(u.email) || 0, labels);
    add('sw_user_cost_usd_today', costDay.get(u.email) || 0, labels);
    add('sw_user_cost_usd_month', costMon.get(u.email) || 0, labels);
    add('sw_user_cost_usd_total', costAll.get(u.email) || 0, labels);
    const seen = u.last_seen_at ? Date.parse(u.last_seen_at) : NaN;
    if (Number.isFinite(seen)) add('sw_user_last_seen_timestamp_seconds', Math.floor(seen / 1000), labels);
  }
}

/** @returns {{ samples: Map<string, {labels: object, value: number}[]>, today: string }} */
function collectSamples({ includeUsers = false, now = new Date() } = {}) {
  const { samples, add } = makeSink();
  const today = localIsoDate(now);
  const dayStart = localDayStartIso(now);
  const monthStart = localMonthStartIso(now);
  const wordsToday = q.wordsTodayByBook(today);

  _server(add);
  _users(add);
  _content(add);
  _writing(add, today, wordsToday);
  _jobs(add);
  _ai(add, dayStart, monthStart);
  _merge(add);
  if (includeUsers) _perUser(add, today, dayStart, monthStart, wordsToday);

  return { samples, today };
}

module.exports = { collectSamples };
