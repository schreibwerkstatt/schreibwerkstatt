// Nutzungs-Events (docs/usage-events.md): Katalog-Zuschnitt, Schreibweg,
// Auswertung «Verhalten» und der Drift-Guard «jeder Aufrufer nennt ein Event
// aus dem Katalog mit passender Herkunft».
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

useTmpDb('usage-events');
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const { USAGE_EVENTS, sanitizeMeta, isEvent, recordUsageEvent } = require('../../lib/usage-events');
const { behaviorReport } = require('../../db/usage-events');

const RANGE = { fromIso: '2000-01-01', toIso: '2999-01-01' };

test('sanitizeMeta: nur Felder der Spec, nur kategoriale Werte', () => {
  assert.deepEqual(
    sanitizeMeta('chat.proposal', { chat: 'plot', action: 'applied', kind: 'beat_update', count: 2, text: 'Manuskript' }),
    { chat: 'plot', action: 'applied', kind: 'beat_update', count: 2 },
  );
  // Enum ausserhalb, Slug mit Leerzeichen (= Freitext), negative/gebrochene Zahl.
  assert.equal(sanitizeMeta('chat.proposal', { chat: 'other', kind: 'ein ganzer Satz', count: -1 }), null);
  assert.equal(sanitizeMeta('editor.close', { editor: 'focus', durationSec: 1.5 })?.durationSec, undefined);
  assert.equal(sanitizeMeta('nope', { a: 1 }), null);
});

test('isEvent: Client darf keine Server-Events schreiben', () => {
  assert.equal(isEvent('editor.open', 'client'), true);
  assert.equal(isEvent('auth.login', 'client'), false);
  assert.equal(isEvent('card.open', 'client'), false);
  assert.equal(isEvent('auth.login', 'server'), true);
  assert.equal(isEvent('unbekannt'), false);
});

test('recordUsageEvent: schreibt, wirft nie, verwirft Unbekanntes', () => {
  appUsers.createUser({ email: 'u1@ex.com' });
  assert.equal(recordUsageEvent({ userEmail: 'u1@ex.com', event: 'auth.login', meta: { method: 'local' } }), true);
  assert.equal(recordUsageEvent({ userEmail: 'u1@ex.com', event: 'gibts.nicht' }), false);
  assert.equal(recordUsageEvent({ userEmail: null, event: 'auth.login' }), false);
  // FK-Verletzung (Konto existiert nicht) endet als false, nicht als Exception.
  assert.equal(recordUsageEvent({ userEmail: 'ghost@ex.com', event: 'auth.login' }), false);
  const row = db.prepare(`SELECT * FROM usage_events WHERE user_email = 'u1@ex.com'`).get();
  assert.equal(row.event, 'auth.login');
  assert.deepEqual(JSON.parse(row.meta_json), { method: 'local' });
  assert.match(row.created_at, /Z$/);
  assert.ok(row.app_version);
});

test('behaviorReport: Vorschlaege, Jobs, Editoren, Funktionen, Admins aussen vor', () => {
  appUsers.createUser({ email: 'w@ex.com' });
  appUsers.createUser({ email: 'boss@ex.com', globalRole: 'admin' });
  const rec = (userEmail, event, meta, source = null) => recordUsageEvent({ userEmail, event, meta, source });
  rec('w@ex.com', 'chat.proposal', { chat: 'page', action: 'applied', kind: 'korrektur', count: 3 });
  rec('w@ex.com', 'chat.proposal', { chat: 'page', action: 'discarded', kind: 'korrektur' });
  rec('w@ex.com', 'job.queued', { type: 'check' });
  rec('w@ex.com', 'job.finished', { type: 'check', status: 'done', durationSec: 40 });
  rec('w@ex.com', 'job.finished', { type: 'check', status: 'error', durationSec: 5 });
  rec('w@ex.com', 'editor.open', { editor: 'focus' });
  rec('w@ex.com', 'editor.close', { editor: 'focus', durationSec: 600 });
  rec('w@ex.com', 'card.open', { feature: 'plot' }, 'palette');
  rec('boss@ex.com', 'card.open', { feature: 'plot' }, 'tile');
  rec('w@ex.com', 'content.created', { kind: 'idea' });
  rec('w@ex.com', 'content.created', { kind: 'idea' });
  rec('w@ex.com', 'content.created', { kind: 'source' });
  rec('w@ex.com', 'share.link.created', { kind: 'book' });
  rec('w@ex.com', 'comment.action', { action: 'reply' });
  rec('w@ex.com', 'job.queued', { type: 'book-chat' });

  const r = behaviorReport(RANGE);
  const p = r.proposals.find(x => x.chat === 'page' && x.kind === 'korrektur');
  assert.equal(p.applied, 3);
  assert.equal(p.discarded, 1);
  const j = r.jobs.find(x => x.type === 'check');
  assert.deepEqual([j.queued, j.done, j.error, j.medianSec], [1, 1, 1, 40]);
  const ed = r.editors.find(x => x.editor === 'focus');
  assert.deepEqual([ed.opens, ed.sessions, ed.medianSec], [1, 1, 600]);
  assert.equal(r.hours.reduce((a, b) => a + b, 0), 1);
  const plot = r.features.find(f => f.feature === 'plot');
  assert.equal(plot.opens, 1, 'Admin-Oeffnung zaehlt ohne includeAdmins nicht');
  assert.deepEqual(plot.sources, { palette: 1 });
  assert.equal(behaviorReport({ ...RANGE, includeAdmins: true }).features.find(f => f.feature === 'plot').opens, 2);
  assert.ok(!r.cohorts.some(c => c.email === 'boss@ex.com'));

  // Angelegt: je Art eine Zeile mit Anzahl und Personen.
  const idea = r.creation.find(c => c.kind === 'idea');
  assert.deepEqual([idea.count, idea.users], [2, 1]);
  assert.equal(r.creation.find(c => c.kind === 'source').count, 1);
  // Geteilt: Share-Link je Umfang, Kommentar-Aktion je Art.
  assert.equal(r.sharing.find(s => s.key === 'link.book').count, 1);
  assert.equal(r.sharing.find(s => s.key === 'reply').count, 1);
  // Chat-Runden: der Job zaehlt als Runde, die Vorschlaege als Gegenseite.
  const turn = r.chatTurns.find(c => c.chat === 'book');
  assert.deepEqual([turn.turns, turn.proposals], [1, 0]);
  assert.equal(r.chatTurns.find(c => c.chat === 'page').turns, 0);
  // Lesen: kumuliert aus user_page_usage, unabhaengig vom Zeitraum.
  assert.equal(r.reading.perUser.length, 0, 'ohne Seiten-Oeffnungen keine Leser');
  assert.deepEqual(r.reading.total, { pages: 0, opens: 0 });
});

test('Konto-Loeschung nimmt die Events mit', () => {
  appUsers.createUser({ email: 'gone@ex.com' });
  recordUsageEvent({ userEmail: 'gone@ex.com', event: 'auth.login', meta: { method: 'local' } });
  db.prepare(`DELETE FROM app_users WHERE email = 'gone@ex.com'`).run();
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM usage_events WHERE user_email = 'gone@ex.com'`).get().n, 0);
});

// ── Drift-Guard: Aufrufer ↔ Katalog ─────────────────────────────────────────

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!['vendor', 'node_modules', 'i18n'].includes(name)) yield* walk(p); }
    else if (name.endsWith('.js')) yield p;
  }
}

function calls(dirs, re) {
  const out = [];
  for (const d of dirs) for (const f of walk(join(ROOT, d))) {
    for (const m of readFileSync(f, 'utf8').matchAll(re)) out.push({ file: f.slice(ROOT.length + 1), name: m[1] });
  }
  return out;
}

test('jeder trackUsageEvent-Aufruf im Frontend nennt ein Client-Event', () => {
  const found = calls(['public/js'], /\btrackUsageEvent\(\s*'([\w.]+)'/g);
  assert.ok(found.length >= 5, `zu wenige Aufrufer gefunden (${found.length}) — Regex veraltet?`);
  const bad = found.filter(c => !isEvent(c.name, 'client'));
  assert.deepEqual(bad, [], 'Event fehlt im Katalog (lib/usage-events.js) oder hat origin server');
  // Jedes Client-Event hat einen Aufrufer; chat.proposal laeuft ueber trackChatProposal.
  const used = new Set([...found.map(c => c.name), 'chat.proposal']);
  const dead = Object.entries(USAGE_EVENTS).filter(([k, d]) => d.origin === 'client' && !used.has(k)).map(([k]) => k);
  assert.deepEqual(dead, []);
});

test('jeder trackChatProposal-Aufruf nennt eine Chat-Art aus dem Katalog', () => {
  const kinds = USAGE_EVENTS['chat.proposal'].meta.chat.values;
  const found = calls(['public/js'], /\btrackChatProposal\(\s*'(\w+)'/g);
  assert.deepEqual(found.filter(c => !kinds.includes(c.name)), []);
  // Alle fuenf Chats sind instrumentiert (Abschnitts- und Buch-Chat ueber _chatKind / Wirt).
  for (const k of ['research', 'plot', 'ideen', 'page']) {
    assert.ok(found.some(c => c.name === k), `Chat ${k} ohne Vorschlags-Event`);
  }
});

test('jeder recordUsageEvent-Aufruf im Server nennt ein Server-Event', () => {
  const found = calls(['lib', 'routes'], /recordUsageEvent\(\{[^}]*?event:\s*'([\w.]+)'/g);
  assert.ok(found.length >= 8, `zu wenige Aufrufer gefunden (${found.length}) — Regex veraltet?`);
  assert.deepEqual(found.filter(c => !isEvent(c.name, 'server')), []);
  // Jedes Server-Event hat mindestens einen Aufrufer (sonst ist der Katalog-Eintrag tot).
  const used = new Set(found.map(c => c.name));
  const dead = Object.entries(USAGE_EVENTS).filter(([k, d]) => d.origin === 'server' && !used.has(k)).map(([k]) => k);
  assert.deepEqual(dead, []);
});
