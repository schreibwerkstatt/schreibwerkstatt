// Gate für die tab-übergreifende Editier-Sperre (public/js/app/boot/busy-lock.js).
//
// WARUM: `skip-waiting` wechselt die SW-Generation für ALLE Tabs der Origin.
// Prüft der aktivierende Tab nur seinen eigenen Zustand, zieht er einem anderen
// Tab, der gerade schreibt, die Generation unter den Füssen weg (alte Module im
// Speicher, neue Partials vom SW → ReferenceError). Auf localhost ist der SW
// aus; der Fehler zeigt sich nur auf HTTPS mit zwei offenen Tabs.
//
// DIE INVARIANTEN:
//   1. Hält irgendein Tab den Lock geteilt (er editiert), aktiviert niemand.
//   2. Editiert niemand, wird aktiviert.
//   3. Hört ein Tab auf zu editieren, gibt er den Lock frei.
//   4. Ohne Web Locks entscheidet der eigene Tab allein (kein Hänger).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBusyLock, activateIfNobodyBusy, BUSY_LOCK } from '../../public/js/app/boot/busy-lock.js';
import { isBusy, registerBusySource } from '../../public/js/app/boot/update-policy.js';

// Minimaler LockManager: shared/exclusive + ifAvailable, origin-weit geteilt
// (ein Objekt = eine Origin, mehrere createBusyLock-Instanzen = mehrere Tabs).
function fakeLocks() {
  let shared = 0;
  let exclusive = false;
  return {
    get sharedCount() { return shared; },
    async request(name, opts, cb) {
      assert.equal(name, BUSY_LOCK);
      if (opts.mode === 'exclusive') {
        const free = shared === 0 && !exclusive;
        if (!free && opts.ifAvailable) return cb(null);
        exclusive = true;
        try { return await cb({ name }); } finally { exclusive = false; }
      }
      shared++;
      try { return await cb({ name }); } finally { shared--; }
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('ein editierender Tab sperrt die Aktivierung für alle', async () => {
  const locks = fakeLocks();
  let bEditing = true;
  const tabB = createBusyLock({ isBusy: () => bEditing, locks });
  tabB.sync();
  await tick();
  assert.equal(tabB.held, true);

  let activated = 0;
  const done = await activateIfNobodyBusy(() => { activated++; return true; }, { locks });
  assert.equal(done, false);
  assert.equal(activated, 0);

  bEditing = false;
  tabB.sync();
  await tick();
  assert.equal(tabB.held, false);
  assert.equal(locks.sharedCount, 0);

  const done2 = await activateIfNobodyBusy(() => { activated++; return true; }, { locks });
  assert.equal(done2, true);
  assert.equal(activated, 1);
});

test('sync ist idempotent: mehrfacher Aufruf hält genau einen Lock', async () => {
  const locks = fakeLocks();
  const tab = createBusyLock({ isBusy: () => true, locks });
  tab.sync(); tab.sync(); await tick(); tab.sync();
  await tick();
  assert.equal(locks.sharedCount, 1);
});

test('ohne Web Locks entscheidet der eigene Tab', async () => {
  const tab = createBusyLock({ isBusy: () => true, locks: null });
  tab.sync();
  assert.equal(tab.held, false);
  assert.equal(await activateIfNobodyBusy(() => true, { locks: null }), true);
});

test('isBusy: registrierte Quelle (Bucheditor) zählt, Abmelden hebt sie auf', () => {
  let dirty = true;
  const off = registerBusySource(() => dirty);
  assert.equal(isBusy({}), true);
  dirty = false;
  assert.equal(isBusy({}), false);
  dirty = true;
  off();
  assert.equal(isBusy({}), false);
});

test('isBusy: eine werfende Quelle blockiert nicht', () => {
  const off = registerBusySource(() => { throw new Error('tote Karte'); });
  assert.equal(isBusy({}), false);
  off();
});

test('Bucheditor meldet ungespeicherte Blöcke an die Update-Politik', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../public/js/cards/book-editor-card.js', import.meta.url), 'utf8');
  assert.match(src, /registerBusySource\(\(\) => this\.dirtyCount > 0 \|\| this\.savingCount > 0\)/);
});
