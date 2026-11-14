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
  rec('w@ex.com', 'job.finished', { type: 'book-chat', status: 'done', durationSec: 9, proposals: 0 });
  rec('w@ex.com', 'job.queued', { type: 'chat' });
  rec('w@ex.com', 'job.queued', { type: 'chat' });
  rec('w@ex.com', 'job.queued', { type: 'chat' });
  rec('w@ex.com', 'job.finished', { type: 'chat', status: 'done', durationSec: 9, proposals: 5 });
  rec('w@ex.com', 'job.finished', { type: 'chat', status: 'done', durationSec: 9, proposals: 0 });
  rec('w@ex.com', 'job.finished', { type: 'chat', status: 'error', durationSec: 9 });

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
  // Chat-Runden: der Job zaehlt als Runde; mit/ohne Vorschlag zaehlen fertige
  // Runden nach ihrer Vorschlagszahl, nicht die einzelnen Vorschlaege.
  const turn = r.chatTurns.find(c => c.chat === 'book');
  assert.deepEqual([turn.turns, turn.withProposal, turn.withoutProposal], [1, 0, 1]);
  const page = r.chatTurns.find(c => c.chat === 'page');
  assert.deepEqual([page.turns, page.withProposal, page.withoutProposal], [3, 1, 1]);
  assert.equal(r.chatTurns.find(c => c.chat === 'plot').turns, 0);
  // Lesen: kumuliert aus user_page_usage, unabhaengig vom Zeitraum.
  assert.equal(r.reading.perUser.length, 0, 'ohne Seiten-Oeffnungen keine Leser');
  assert.deepEqual(r.reading.total, { pages: 0, opens: 0 });
});

test('behaviorReport: Revisionen — Viewer-Sitzungen, Wiederherstellen nach Alter, Anheften', () => {
  appUsers.createUser({ email: 'rev@ex.com' });
  appUsers.createUser({ email: 'rev2@ex.com' });
  const rec = (userEmail, event, meta) => recordUsageEvent({ userEmail, event, meta });
  const before = Object.fromEntries(behaviorReport(RANGE).revisions.map(r => [r.key, r.count]));
  rec('rev@ex.com', 'revision.view', { diff: 'yes', current: 'yes', steps: 3 });
  rec('rev@ex.com', 'revision.view', { diff: 'no', current: 'no', steps: 0 });
  rec('rev2@ex.com', 'revision.view', { diff: 'yes', current: 'no', steps: 2 });
  rec('rev@ex.com', 'revision.restore', { ageBucket: 'hour' });
  rec('rev2@ex.com', 'revision.restore', { ageBucket: 'older' });
  rec('rev@ex.com', 'revision.pin', { action: 'pin', named: 'no' });
  rec('rev@ex.com', 'revision.pin', { action: 'rename', named: 'yes' });
  rec('rev2@ex.com', 'revision.pin', { action: 'pin', named: 'yes' });
  rec('rev2@ex.com', 'revision.pin', { action: 'unpin', named: 'no' });

  const rows = behaviorReport(RANGE).revisions;
  const d = (key) => {
    const r = rows.find(x => x.key === key);
    return [r.count - (before[key] || 0), r.users];
  };
  assert.deepEqual(d('view'), [3, 2]);
  assert.deepEqual(d('view.diff'), [2, 2]);
  assert.deepEqual(d('view.current'), [1, 1]);
  assert.deepEqual(d('view.steps'), [5, 2], 'Schritte summiert, Personen nur mit Schritten');
  assert.deepEqual(d('restore.hour'), [1, 1]);
  assert.deepEqual(d('restore.older'), [1, 1]);
  assert.deepEqual(d('restore.week'), [0, 0], 'Nullzeile bleibt stehen');
  assert.deepEqual(d('pin'), [2, 2]);
  assert.deepEqual(d('pin.named'), [1, 1]);
  assert.deepEqual(d('rename'), [1, 1]);
  assert.deepEqual(d('unpin'), [1, 1]);
  // Freitext und fremde Werte fallen weg.
  assert.equal(sanitizeMeta('revision.pin', { action: 'pin', named: 'yes', label: 'Geheimer Titel' }).label, undefined);
  assert.equal(sanitizeMeta('revision.restore', { ageBucket: 'decade' }), null);
});

test('behaviorReport: Verweildauer — Karten, Werkzeuge am Abschnitt, Abschnitts-Besuche', () => {
  appUsers.createUser({ email: 'dw@ex.com', displayName: 'Dora' });
  appUsers.createUser({ email: 'dw2@ex.com' });
  const rec = (userEmail, event, meta) => recordUsageEvent({ userEmail, event, meta });
  rec('dw@ex.com', 'card.open', { feature: 'stats' });
  rec('dw@ex.com', 'card.close', { feature: 'stats', durationSec: 30 });
  rec('dw@ex.com', 'card.close', { feature: 'stats', durationSec: 90 });
  rec('dw@ex.com', 'panel.open', { panel: 'ideen', editor: 'notebook' });
  rec('dw@ex.com', 'panel.close', { panel: 'ideen', editor: 'notebook', durationSec: 600 });
  rec('dw2@ex.com', 'panel.open', { panel: 'ideen', editor: 'notebook' });
  rec('dw@ex.com', 'panel.open', { panel: 'find', editor: 'book' });
  rec('dw@ex.com', 'page.view', { pageId: 7, durationSec: 100, editSec: 60, changed: 'yes' });
  rec('dw@ex.com', 'page.view', { pageId: 8, durationSec: 20, editSec: 0, changed: 'no' });
  // editSec über der Dauer wird auf die Dauer gekappt.
  rec('dw2@ex.com', 'page.view', { pageId: 9, durationSec: 10, editSec: 50, changed: 'no' });

  const r = behaviorReport(RANGE);
  const stats = r.features.find(f => f.feature === 'stats');
  assert.deepEqual([stats.opens, stats.medianSec, stats.totalSec], [1, 60, 120]);
  const ideen = r.panels.find(p => p.panel === 'ideen' && p.editor === 'notebook');
  assert.deepEqual([ideen.opens, ideen.users, ideen.medianSec, ideen.totalSec], [2, 2, 600, 600]);
  assert.equal(r.panels.find(p => p.panel === 'find').editor, 'book');
  const dora = r.pageViews.perUser.find(u => u.email === 'dw@ex.com');
  assert.deepEqual([dora.views, dora.pages, dora.readSec, dora.editSec, dora.changedShare], [2, 2, 60, 60, 0.5]);
  assert.equal(dora.displayName, 'Dora');
  assert.equal(dora.returnShare, 0, 'beide Abschnitte nur an einem Tag besucht');
  const other = r.pageViews.perUser.find(u => u.email === 'dw2@ex.com');
  assert.deepEqual([other.readSec, other.editSec], [0, 10]);

  // Rückkehr: derselbe Abschnitt an zwei Tagen.
  db.prepare(`UPDATE usage_events SET created_at = '2020-01-01T10:00:00.000Z' WHERE user_email = 'dw@ex.com' AND event = 'page.view' AND meta_json LIKE '%"pageId":8%'`).run();
  rec('dw@ex.com', 'page.view', { pageId: 8, durationSec: 5, editSec: 0, changed: 'no' });
  assert.equal(behaviorReport(RANGE).pageViews.perUser.find(u => u.email === 'dw@ex.com').returnShare, 0.5);

  // Freitext und fremde Werte fallen weg; Seiten-ID nur als Zahl.
  assert.equal(sanitizeMeta('page.view', { pageId: 'Kapitel 3', durationSec: 5 }).pageId, undefined);
  assert.equal(sanitizeMeta('panel.open', { panel: 'irgendwas' }), null);
});

test('behaviorReport: Reibung — Konflikte, Save-Fehler, Outbox, Verwerfen-Rückfrage', () => {
  appUsers.createUser({ email: 'fr@ex.com' });
  const rec = (event, meta) => recordUsageEvent({ userEmail: 'fr@ex.com', event, meta });
  const before = Object.fromEntries(behaviorReport(RANGE).friction.map(r => [r.key, r.count]));
  rec('save.conflict', { outcome: 'merged', source: 'main' });
  rec('save.conflict', { outcome: 'rejected', self: 'yes', source: 'focus' });
  rec('save.failed', { editor: 'notebook', reason: 'network' });
  rec('save.failed', { editor: 'book', reason: 'locked' });
  rec('outbox.flush', { synced: 3, conflicts: 1, dropped: 0, stuck: 2 });
  rec('discard.prompt', { editor: 'notebook', answer: 'keep' });
  rec('discard.prompt', { editor: 'focus', answer: 'discard' });

  const rows = behaviorReport(RANGE).friction;
  const d = (key) => rows.find(x => x.key === key).count - (before[key] || 0);
  assert.equal(d('conflict.merged'), 1);
  assert.equal(d('conflict.rejected'), 1);
  assert.equal(d('conflict.self'), 1);
  assert.equal(d('saveFailed.network'), 1);
  assert.equal(d('saveFailed.locked'), 1);
  assert.equal(d('saveFailed.server'), 0, 'Nullzeile bleibt stehen');
  assert.deepEqual([d('outbox.synced'), d('outbox.conflicts'), d('outbox.dropped'), d('outbox.stuck')], [3, 1, 0, 2]);
  assert.deepEqual([d('discard.keep'), d('discard.discard')], [1, 1]);
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
