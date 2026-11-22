// Onboarding-Karte: reine Fortschritts-Logik (doneCount/progressPct/allDone) +
// Registry-Wiring. Die DB-/Alpine-abhaengigen Pfade (loadOnboarding, importDemo,
// Backend-Ableitung) deckt der Smoke-Test bzw. registry-sync ab.
import test from 'node:test';
import assert from 'node:assert/strict';

// Alpine-Stub: registerOnboardingCard ruft window.Alpine.data(name, factory).
// Wir fangen die Factory ab und instanziieren das Karten-Objekt roh, ohne init()
// (init braucht setupCardLifecycle + Stores).
let factory = null;
globalThis.window = {
  Alpine: { data: (_name, f) => { factory = f; } },
  __app: { t: (k) => k },
};

const { registerOnboardingCard } = await import('../../public/js/cards/onboarding-card.js');
registerOnboardingCard();

test('registerOnboardingCard registriert eine Factory', () => {
  assert.equal(typeof factory, 'function');
});

test('Default: alle Schritte offen, 0/4, nichts erledigt', () => {
  const c = factory();
  assert.deepEqual(c.stepKeys, ['book', 'page', 'lektorat', 'share']);
  assert.equal(c.doneCount(), 0);
  assert.equal(c.totalCount(), 4);
  assert.equal(c.allDone(), false);
  assert.equal(c.progressPct(), 0);
});

test('Teil-Fortschritt: 2/4 → 50 %, nicht allDone', () => {
  const c = factory();
  c.steps = { book: true, page: true, lektorat: false, share: false };
  assert.equal(c.doneCount(), 2);
  assert.equal(c.progressPct(), 50);
  assert.equal(c.allDone(), false);
});

test('Alle Schritte erledigt → allDone + 100 %', () => {
  const c = factory();
  c.steps = { book: true, page: true, lektorat: true, share: true };
  assert.equal(c.doneCount(), 4);
  assert.equal(c.progressPct(), 100);
  assert.equal(c.allDone(), true);
});

test('doStep ohne gewaehltes Buch faellt fuer alle Schritte auf openCreateBook', () => {
  const c = factory();
  const calls = [];
  globalThis.window.__app = {
    t: (k) => k,
    $store: { nav: { selectedBookId: null } },
    openCreateBook: () => calls.push('create'),
    toggleBookOverviewCard: () => calls.push('overview'),
    startFirstLektorat: () => calls.push('lektorat'),
    toggleShareLinksCard: () => calls.push('share'),
  };
  for (const k of ['book', 'page', 'lektorat', 'share']) c.doStep(k);
  assert.deepEqual(calls, ['create', 'create', 'create', 'create']);
});

test('doStep mit Buch routet je Schritt in die passende Funktion', () => {
  const c = factory();
  const calls = [];
  globalThis.window.__app = {
    t: (k) => k,
    $store: { nav: { selectedBookId: 42 } },
    openCreateBook: () => calls.push('create'),
    toggleBookOverviewCard: () => calls.push('overview'),
    startFirstLektorat: () => calls.push('lektorat'),
    toggleShareLinksCard: () => calls.push('share'),
  };
  c.doStep('book');
  c.doStep('page');
  c.doStep('lektorat');
  c.doStep('share');
  assert.deepEqual(calls, ['create', 'overview', 'lektorat', 'share']);
});
