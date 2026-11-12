// Kartenwechsel-Indikator (public/js/app/view-switch.js): Verzögerung, Token-
// Reihenfolge, Deckel, Paint-Yield ohne rAF. Die Geometrie/Optik im echten
// Template-Baum prüft tests/e2e-app/view-switch-indicator.spec.js.
import test from 'node:test';
import assert from 'node:assert/strict';

const shell = { viewSwitching: false };
globalThis.Alpine = { store: (name) => (name === 'shell' ? shell : null) };

const {
  beginViewSwitch, endViewSwitch, startViewSwitch, yieldToPaint, isPartialMounted,
  SHOW_DELAY_MS, _resetViewSwitchForTests,
} = await import('../../public/js/app/view-switch.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test.beforeEach(() => _resetViewSwitchForTests());

test('warmer Wechsel: Indikator erst nach der Verzögerung', async () => {
  const t = beginViewSwitch();
  assert.equal(shell.viewSwitching, false);
  await sleep(SHOW_DELAY_MS + 30);
  assert.equal(shell.viewSwitching, true);
  endViewSwitch(t);
  assert.equal(shell.viewSwitching, false);
});

test('schneller Wechsel: Indikator erscheint nie', async () => {
  const t = beginViewSwitch();
  await sleep(20);
  endViewSwitch(t);
  await sleep(SHOW_DELAY_MS + 30);
  assert.equal(shell.viewSwitching, false);
});

test('kalter Wechsel: Indikator sofort', () => {
  const t = beginViewSwitch({ immediate: true });
  assert.equal(shell.viewSwitching, true);
  endViewSwitch(t);
  assert.equal(shell.viewSwitching, false);
});

test('überholter Wechsel löscht den Indikator des neuen nicht', () => {
  const alt = beginViewSwitch({ immediate: true });
  const neu = beginViewSwitch({ immediate: true });
  endViewSwitch(alt);
  assert.equal(shell.viewSwitching, true, 'alter Token darf nicht beenden');
  endViewSwitch(neu);
  assert.equal(shell.viewSwitching, false);
});

test('überholter Wechsel: sein verzögerter Timer zeigt nichts mehr an', async () => {
  const alt = beginViewSwitch();
  const neu = beginViewSwitch({ immediate: true });
  endViewSwitch(neu);
  await sleep(SHOW_DELAY_MS + 30);
  assert.equal(shell.viewSwitching, false);
  endViewSwitch(alt);
  assert.equal(shell.viewSwitching, false);
});

test('Doppel-Ende (Transition-Callback + finally) und null-Token sind No-ops', () => {
  const t = beginViewSwitch({ immediate: true });
  endViewSwitch(t);
  endViewSwitch(t);
  endViewSwitch(null);
  assert.equal(shell.viewSwitching, false);
});

test('Deckel: hängender Wechsel geht nach MAX_MS aus', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { MAX_MS } = await import('../../public/js/app/view-switch.js');
  beginViewSwitch({ immediate: true });
  assert.equal(shell.viewSwitching, true);
  t.mock.timers.tick(MAX_MS + 1);
  assert.equal(shell.viewSwitching, false);
  t.mock.timers.reset();
});

test('yieldToPaint löst ohne requestAnimationFrame per Timer auf', async () => {
  assert.equal(typeof globalThis.requestAnimationFrame, 'undefined');
  const t0 = Date.now();
  await yieldToPaint();
  assert.ok(Date.now() - t0 < 1000);
});

test('ohne DOM gilt jedes Partial als warm (kein Paint-Yield, kein Sofort-Indikator)', async () => {
  assert.equal(isPartialMounted('recherche'), true);
  const t = await startViewSwitch(['recherche']);
  assert.equal(shell.viewSwitching, false);
  endViewSwitch(t);
});

test('ohne Alpine-Store kein Fehler', () => {
  const saved = globalThis.Alpine;
  globalThis.Alpine = undefined;
  try {
    const t = beginViewSwitch({ immediate: true });
    endViewSwitch(t);
  } finally { globalThis.Alpine = saved; }
});
