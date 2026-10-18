// Rückmeldung der Reconnect-Outbox (app-outbox.js): synchronisierte Seiten +
// neu liegengebliebene Konflikte werden gezählt und als EIN Toast gemeldet;
// schon gemeldete Konflikte nicht bei jedem Fokus-Trigger erneut.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { summarizeOutboxResults, appOutboxMethods } = await import('../../public/js/app/app-outbox.js');

test('zählt ok als synchronisiert, skip/empty bleiben stumm', () => {
  const reported = new Set();
  const r = summarizeOutboxResults(new Map([[1, 'ok'], [2, 'skip'], [3, 'empty'], [4, 'ok']]), reported);
  assert.deepEqual(r, { synced: 2, newConflicts: 0 });
});

test('Konflikt wird genau einmal gemeldet, nach Lösung wieder meldbar', () => {
  const reported = new Set();
  assert.equal(summarizeOutboxResults(new Map([[5, 'conflict']]), reported).newConflicts, 1);
  assert.equal(summarizeOutboxResults(new Map([[5, 'conflict']]), reported).newConflicts, 0);
  assert.equal(summarizeOutboxResults(new Map([[5, 'ok']]), reported).synced, 1);
  assert.equal(summarizeOutboxResults(new Map([[5, 'conflict']]), reported).newConflicts, 1);
});

function fakeRoot() {
  const toasts = [];
  return {
    toasts,
    t: (key, p) => `${key}:${p?.n}`,
    _showJobToast: (x) => toasts.push(x),
    _reportOutboxResults: appOutboxMethods._reportOutboxResults,
  };
}

test('_reportOutboxResults: ok-Toast bei Erfolg, err-Toast bei neuem Konflikt, sonst keiner', () => {
  const root = fakeRoot();
  root._reportOutboxResults(new Map([[1, 'ok'], [2, 'ok']]));
  assert.equal(root.toasts.length, 1);
  assert.equal(root.toasts[0].severity, 'ok');
  assert.equal(root.toasts[0].message, 'offline.syncDone:2');

  root._reportOutboxResults(new Map([[3, 'conflict'], [4, 'ok']]));
  assert.equal(root.toasts[1].severity, 'err');
  assert.equal(root.toasts[1].message, 'offline.syncDone:1 offline.syncConflicts:1');

  root._reportOutboxResults(new Map([[3, 'conflict'], [9, 'skip']]));
  assert.equal(root.toasts.length, 2, 'bekannter Konflikt + skip → kein weiterer Toast');
});

// ── Wiederholung, wenn der Server nicht erreichbar ist ──────────────────────
// Meldet der Browser weiter «online», kommt kein `online`-Event: ohne eigenen
// Timer lägen die Entwürfe bis zum nächsten Fokuswechsel.
const { nextOutboxBackoff, OUTBOX_RETRY_MIN_MS, OUTBOX_RETRY_MAX_MS } = await import('../../public/js/app/app-outbox.js');

test('Backoff: verdoppelt sich ab dem Minimum, gedeckelt', () => {
  assert.equal(nextOutboxBackoff(0), OUTBOX_RETRY_MIN_MS);
  assert.equal(nextOutboxBackoff(OUTBOX_RETRY_MIN_MS), OUTBOX_RETRY_MIN_MS * 2);
  assert.equal(nextOutboxBackoff(OUTBOX_RETRY_MAX_MS), OUTBOX_RETRY_MAX_MS);
});

test('_scheduleOutboxRetry: ein Timer, der den Flush erneut startet', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let flushes = 0;
  const ctx = Object.assign(Object.create(appOutboxMethods), {
    _outboxRetryTimer: null, _outboxRetryMs: 0, _flushOutbox() { flushes++; },
  });
  ctx._scheduleOutboxRetry();
  ctx._scheduleOutboxRetry();   // zweiter Fehlschlag ersetzt den Timer
  assert.equal(ctx._outboxRetryMs, OUTBOX_RETRY_MIN_MS * 2);
  t.mock.timers.tick(OUTBOX_RETRY_MIN_MS * 2);
  assert.equal(flushes, 1);
  assert.equal(ctx._outboxRetryTimer, null);
});
