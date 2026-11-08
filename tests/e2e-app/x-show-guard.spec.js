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
