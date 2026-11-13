// setupCardLifecycle: eine offene Buchkarte ohne `load` (nur `onShow`) lädt
// nach book:changed über onShow nach — sonst bliebe sie nach dem Reset leer
// (Job-Sprung in ein anderes Buch, Zurück/Vorwärts). Buchunabhängige Karten
// (showNeedsBookId: false) bleiben unberührt.
import test from 'node:test';
import assert from 'node:assert/strict';

const target = new EventTarget();
globalThis.window = {
  addEventListener: target.addEventListener.bind(target),
  removeEventListener: target.removeEventListener.bind(target),
  dispatchEvent: target.dispatchEvent.bind(target),
  __app: { showXCard: true },
};
globalThis.Alpine = { store: (n) => (n === 'nav' ? { selectedBookId: '2' } : {}) };

const { setupCardLifecycle } = await import('../../public/js/cards/card-lifecycle.js');
const { EVT } = await import('../../public/js/events.js');

const tick = () => new Promise(r => setTimeout(r, 0));

test('book:changed ruft onShow einer offenen Buchkarte ohne load', async () => {
  let shows = 0;
  const lc = setupCardLifecycle({ $watch() {} }, { name: 'x', showFlag: 'showXCard', onShow: () => { shows++; } });
  window.dispatchEvent(new CustomEvent(EVT.BOOK_CHANGED));
  await tick();
  assert.equal(shows, 1);
  lc.destroy();
});

test('book:changed lässt buchunabhängige Karten (showNeedsBookId: false) in Ruhe', async () => {
  let shows = 0;
  const lc = setupCardLifecycle({ $watch() {} }, { name: 'y', showFlag: 'showXCard', showNeedsBookId: false, onShow: () => { shows++; } });
  window.dispatchEvent(new CustomEvent(EVT.BOOK_CHANGED));
  await tick();
  assert.equal(shows, 0);
  lc.destroy();
});
