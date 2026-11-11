// Verlorene x-show-Wechsel (public/js/app/boot/x-show-guard.js), gegen die
// ECHTE App: Alpine wendet x-show per requestAnimationFrame an. Kippt ein Flag
// innerhalb eines Frames false → true → false, blieb das Element sichtbar,
// obwohl das Flag false sagt — so stand der Notebook-Editor leer offen neben
// der eben geöffneten Motiv-Werkstatt. Jede Alpine-Flush-Runde wird hier mit
// zwei Microtasks abgewartet; ein Frame vergeht dazwischen nicht.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

async function flipWithinFrame(page, flag, seq) {
  return page.evaluate(async ({ flag, seq }) => {
    const a = window.__app;
    const flush = async () => { await new Promise(r => queueMicrotask(r)); await new Promise(r => queueMicrotask(r)); };
    for (const v of seq) { a[flag] = v; await flush(); }
    await new Promise(r => setTimeout(r, 300));
    return a[flag];
  }, { flag, seq });
}

test('x-show: Kippen innerhalb eines Frames endet im Zustand des Flags', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
  const editor = page.locator('#editor-card');
  await expect(editor).toBeVisible();

  // Aus: false → true → false (der Prod-Fall).
  expect(await flipWithinFrame(page, 'showEditorCard', [false, true, false])).toBe(false);
  await expect(editor).toBeHidden();

  // Gegenrichtung: true → false → true darf nicht versteckt enden.
  expect(await flipWithinFrame(page, 'showEditorCard', [true, false, true])).toBe(true);
  await expect(editor).toBeVisible();

  // Zweite Karte, damit der Schutz nicht am Editor hängt.
  await page.evaluate(() => window.__app.toggleMotivCard());
  const motiv = page.locator('.card--motiv');
  await expect(motiv).toBeVisible();
  expect(await flipWithinFrame(page, 'showMotivCard', [false, true, false])).toBe(false);
  await expect(motiv).toBeHidden();
});

// Scheduler-Requeue (Patch im Vendor-Alpine, docs/architektur.md#alpine-scheduler-patch):
// Läuft der x-show-Effekt in einem Flush mit `true` und setzt ein SPÄTERER Effekt
// desselben Flushs das Flag auf `false`, reihte Alpine den x-show-Effekt nicht
// neu ein (`B.includes` fand den schon gelaufenen Job) — x-show ruft dann gar
// keinen Toggle mehr, der Guard oben sieht nichts. Prod-Befund: showEditorCard
// false, currentPage null, #editor-card display:block mit `_x_isShown: true`.
test('x-show: Flag-Wechsel aus einem späteren Effekt desselben Flushs geht nicht verloren', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
  const editor = page.locator('#editor-card');
  await expect(editor).toBeVisible();
  await page.evaluate(() => { window.__app.showEditorCard = false; });
  await expect(editor).toBeHidden();

  const flag = await page.evaluate(async () => {
    const a = window.__app;
    const trip = window.Alpine.reactive({ armed: false });
    window.Alpine.effect(() => {
      if (trip.armed && a.showEditorCard) { trip.armed = false; a.showEditorCard = false; }
    });
    // Reihenfolge zählt: zuerst das Flag (reiht den x-show-Effekt ein), dann
    // scharf schalten (reiht den Stolper-Effekt DAHINTER ein) — er läuft im
    // selben Flush nach x-show und setzt das Flag zurück.
    a.showEditorCard = true;
    trip.armed = true;
    await new Promise(r => setTimeout(r, 300));
    return a.showEditorCard;
  });
  expect(flag).toBe(false);
  await expect(editor).toBeHidden();
});

// Der Deckel gegen Effekt-Ping-Pong: zwei Effekte, die sich gegenseitig
// anstossen, dürfen den Tab nicht einfrieren (der Flush bricht am Deckel ab).
test('Alpine-Scheduler: gegenseitig auslösende Effekte hängen den Tab nicht auf', async ({ page }) => {
  await bootApp(page);
  const done = await page.evaluate(async () => {
    const s = window.Alpine.reactive({ a: 0, b: 0, on: false });
    window.Alpine.effect(() => { if (s.on) s.b = s.a + 1; });
    window.Alpine.effect(() => { if (s.on) s.a = s.b + 1; });
    s.on = true;
    await new Promise(r => setTimeout(r, 300));
    return s.a > 0;
  });
  expect(done).toBe(true);
});
