'use strict';
// Metrics-Collector (lib/metrics/): Katalog-Vollstaendigkeit (Beschreibung,
// HA-Klassen, i18n-Namen) und beide Ausgaben — Prometheus-Text und das JSON
// fuer die Home-Assistant-Integration (Client-Vertrag, docs/metrics-api.md#json).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('metrics-collector');
require('../../db/migrations').runMigrations();
const { db } = require('../../db/connection');

const { METRIC_DEFS } = require('../../lib/metrics/defs');
const { collectMetrics, collectMetricsJson } = require('../../lib/metrics-collector');
const { localIsoDate } = require('../../lib/local-date');

const I18N = (loc) => JSON.parse(fs.readFileSync(path.join(__dirname, '../../public/js/i18n', `${loc}.json`), 'utf8'));
const GROUPS = new Set(['server', 'users', 'content', 'writing', 'jobs', 'ai', 'merge', 'user']);
const STATE_CLASSES = new Set(['measurement', 'total', 'total_increasing']);

test('Katalog: jede Kennzahl vollstaendig beschrieben', () => {
  for (const [name, d] of Object.entries(METRIC_DEFS)) {
    assert.match(name, /^sw_[a-z0-9_]+$/, name);
    assert.ok(['gauge', 'counter'].includes(d.type), `${name}: type`);
    assert.ok(d.help && !d.help.includes('\n'), `${name}: help`);
    assert.ok(GROUPS.has(d.group), `${name}: group`);
    if (d.type === 'counter') assert.match(name, /_total$/, `${name}: Counter endet auf _total`);
    if (d.stateClass) assert.ok(STATE_CLASSES.has(d.stateClass), `${name}: stateClass`);
    // HA erlaubt fuer monetary ausschliesslich state_class total.
    if (d.deviceClass === 'monetary') assert.strictEqual(d.stateClass, 'total', name);
    if (d.reset) assert.ok(['day', 'month'].includes(d.reset), `${name}: reset`);
    assert.strictEqual(!!d.perUser, d.group === 'user', `${name}: perUser genau in group 'user'`);
  }
});

test('Katalog: Anzeigename in beiden Locales', () => {
  const de = I18N('de'), en = I18N('en');
  for (const name of Object.keys(METRIC_DEFS)) {
    assert.ok(de[`metrics.name.${name}`], `de: metrics.name.${name}`);
    assert.ok(en[`metrics.name.${name}`], `en: metrics.name.${name}`);
  }
});

function seed() {
  const today = localIsoDate(new Date());
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO app_users (email, display_name, status, global_role, daily_goal_minutes, last_seen_at, created_at)
              VALUES (?,?,?,?,?,?,?)`).run('a@x.test', 'Anna', 'active', 'user', 30, now, now);
  db.prepare(`INSERT INTO app_users (email, display_name, status, global_role, created_at)
              VALUES (?,?,?,?,?)`).run('b@x.test', 'Ben', 'suspended', 'user', now);
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?,?,?,?,?)')
    .run(1, 'Geheimer Titel', now, now, 'a@x.test');
  db.prepare('INSERT INTO pages (page_id, book_id, page_name) VALUES (?,?,?)').run(10, 1, 'S1');
  db.prepare('INSERT INTO page_stats (page_id, book_id, words, chars) VALUES (?,?,?,?)').run(10, 1, 1200, 7200);
  db.prepare('INSERT INTO book_stats_history (book_id, recorded_at, page_count, words, chars, tok) VALUES (?,?,?,?,?,?)')
    .run(1, '2000-01-01', 1, 1000, 6000, 0);
  db.prepare('INSERT INTO writing_time (user_email, book_id, date, seconds) VALUES (?,?,?,?)').run('a@x.test', 1, today, 900);
  db.prepare(`INSERT INTO ai_cost_ledger (ts, user_email, source, type, provider, model, tokens_in, tokens_out, usd, source_ref)
              VALUES (?,?,?,?,?,?,?,?,?,?)`).run(now, 'a@x.test', 'job', 'lektorat', 'claude', 'claude-x', 100, 50, 0.25, 'r1');
  db.prepare(`INSERT INTO ai_cost_ledger (ts, user_email, source, type, provider, model, tokens_in, tokens_out, usd, source_ref)
              VALUES (?,?,?,?,?,?,?,?,?,?)`).run('2000-01-01T00:00:00.000Z', 'a@x.test', 'job', 'lektorat', 'claude', 'claude-x', 10, 5, 1, 'r0');
}
seed();

const sample = (json, name, pred = () => true) =>
  json.metrics.find(m => m.name === name)?.samples.find(s => pred(s.labels))?.value;

test('Prometheus: HELP/TYPE je Name genau einmal, ohne Pro-User-Werte', () => {
  const text = collectMetrics();
  const helps = [...text.matchAll(/^# HELP (\S+)/gm)].map(m => m[1]);
  assert.strictEqual(new Set(helps).size, helps.length, 'HELP doppelt');
  assert.match(text, /^sw_cost_usd_total\{provider="claude",model="claude-x"\} 1\.25$/m);
  assert.match(text, /^sw_users\{status="invited"\} 0$/m, 'fester Status auch bei 0');
  assert.doesNotMatch(text, /sw_user_/);
  assert.match(collectMetrics({ includeUsers: true }), /^sw_user_writing_seconds_today\{user="a@x.test",user_name="Anna"\} 900$/m);
});

test('JSON: Vertragsform, Werte und Datenschutzgrenze', () => {
  const j = collectMetricsJson({ includeUsers: true });
  assert.strictEqual(j.schema, 1);
  assert.strictEqual(j.includes_users, true);
  assert.ok(j.version && j.timezone && /^\d{4}-\d{2}-\d{2}$/.test(j.today));
  assert.match(j.instance_id, /^[0-9a-f-]{36}$/);
  assert.strictEqual(collectMetricsJson().instance_id, j.instance_id, 'instance_id stabil');
  for (const m of j.metrics) {
    for (const k of ['name', 'type', 'group', 'title', 'unit', 'device_class', 'state_class', 'reset',
                     'icon', 'diagnostic', 'enabled_default', 'entity', 'per_user', 'samples']) {
      assert.ok(k in m, `${m.name}: Feld ${k}`);
    }
    assert.ok(m.title.de && m.title.en, `${m.name}: title`);
  }
  assert.strictEqual(sample(j, 'sw_cost_usd_today'), 0.25);
  assert.strictEqual(sample(j, 'sw_words_today'), 200);
  assert.strictEqual(sample(j, 'sw_user_daily_goal_percent', l => l.user === 'a@x.test'), 50);
  assert.strictEqual(sample(j, 'sw_user_cost_usd_total', l => l.user === 'a@x.test'), 1.25);
  assert.strictEqual(sample(j, 'sw_user_words_today', l => l.user === 'a@x.test'), 200);
  assert.strictEqual(sample(j, 'sw_user_books', l => l.user === 'b@x.test'), undefined, 'gesperrte User fehlen');
  assert.doesNotMatch(JSON.stringify(j), /Geheimer Titel/, 'keine Buchtitel');

  const plain = collectMetricsJson();
  assert.strictEqual(plain.includes_users, false);
  assert.ok(!plain.metrics.some(m => m.per_user), 'ohne Scope keine Pro-User-Kennzahlen');
});
