// setupCardLifecycle: `card:refresh` mit `source: 'wake'` (Tab-Rückkehr) läuft
// still — `cfg.wake` statt des Re-Klick-Hooks, kein `cardLoading`, `'skip'`
// lädt gar nicht. Der Re-Klick (ohne source) bleibt beim sichtbaren Hook.
import test from 'node:test';
import assert from 'node:assert/strict';

const target = new EventTarget();
globalThis.window = {
  addEventListener: target.addEventListener.bind(target),
  removeEventListener: target.removeEventListener.bind(target),
  dispatchEvent: target.dispatchEvent.bind(target),
  __app: {},
};
globalThis.Alpine = { store: (n) => (n === 'nav' ? { selectedBookId: '1' } : {}) };

const { setupCardLifecycle, isWakeRefresh } = await import('../../public/js/cards/card-lifecycle.js');
const { EVT } = await import('../../public/js/events.js');
const { sameData } = await import('../../public/js/utils/same-data.js');

const refresh = (source) => window.dispatchEvent(new CustomEvent(EVT.CARD_REFRESH, { detail: { name: 'x', ...(source ? { source } : {}) } }));
const mkCtx = () => ({ $watch() {} });

test('Wake ruft cfg.wake, ohne cardLoading', () => {
  const ctx = mkCtx();
  const calls = [];
  let loadingDuringWake = null;
  const lc = setupCardLifecycle(ctx, {
    name: 'x',
    onCardRefresh: () => calls.push('refresh'),
    wake: (e, c) => { calls.push('wake'); loadingDuringWake = c.cardLoading; },
  });
  refresh('wake');
  assert.deepEqual(calls, ['wake']);
  assert.equal(loadingDuringWake, false);
  refresh();
  assert.deepEqual(calls, ['wake', 'refresh'], 'Re-Klick nimmt weiter den sichtbaren Hook');
  lc.destroy();
});

test("wake: 'skip' lädt nicht", () => {
  const calls = [];
  const lc = setupCardLifecycle(mkCtx(), { name: 'x', load: () => calls.push('load'), wake: 'skip' });
  refresh('wake');
  assert.deepEqual(calls, []);
  refresh();
  assert.deepEqual(calls, ['load']);
  lc.destroy();
});

test('ohne cfg.wake: Re-Klick-Hook, aber ohne cardLoading', () => {
  const ctx = mkCtx();
  let loading = null;
  const lc = setupCardLifecycle(ctx, { name: 'x', load: () => { loading = ctx.cardLoading; } });
  refresh('wake');
  assert.equal(loading, false);
  refresh();
  assert.equal(loading, true, 'Re-Klick zeigt das Lade-Skelett weiter');
  lc.destroy();
});

test('isWakeRefresh + sameData', () => {
  assert.equal(isWakeRefresh({ detail: { source: 'wake' } }), true);
  assert.equal(isWakeRefresh({ detail: { name: 'x' } }), false);
  assert.equal(sameData([{ a: 1 }], [{ a: 1 }]), true);
  assert.equal(sameData([{ a: 1 }], [{ a: 2 }]), false);
});

test('Wake-Dispatch nutzt refreshName (Figuren-Karte hört auf "figuren")', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../public/js/app/app-view/bookscope.js', import.meta.url), 'utf8');
  assert.match(src, /name: c\.refreshName \|\| c\.key, source: 'wake'/);
});
