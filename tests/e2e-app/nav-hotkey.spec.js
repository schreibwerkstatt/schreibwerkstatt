// Cmd+E gegen die ECHTE App — in beiden Zuständen, in denen der Chord die Seite
// nicht verlassen darf.
//
// Warum E2E und nicht Unit: `handleNavHotkey` ist eine Alpine-Methode am
// `<body>`-x-data, die über `@keydown.window` verdrahtet wird. Ein Unit-Test auf
// die Methode sieht nicht, ob die Verdrahtung überhaupt steht — und genau daran
// hing der Symptomkomplex: fällt der Tastendruck an den Browser durch, öffnet
// Chrome den Standard-Suchanbieter in einem neuen Tab (⌘E = „Auswahl mit der
// Standardsuche suchen"), und die App sieht schuldlos aus. Geprüft wird darum
// am echten Event, ob die Seite `defaultPrevented` gesetzt hat.
//
// Die Zusicherung endet an der Browsergrenze: `defaultPrevented === true` belegt
// das preventDefault der Seite, nicht dass Chrome den Accelerator daraufhin
// unterdrückt. Genau an dieser Grenze muss der User selbst prüfen (⌘E auf einer
// beliebigen anderen Seite) — dort entscheidet sich, ob eine Extension oder das
// Betriebssystem die Taste vorher abgreift.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';

// Recorder auf window: nach dem App-Listener registriert, liest also den
//_endzustand_ des Events (defaultPrevented ist zu diesem Zeitpunkt gesetzt).
async function recordNextKey(page, chord) {
  await page.evaluate(() => {
    window.__keyProbe = [];
    window.addEventListener('keydown', (e) => {
      window.__keyProbe.push({ key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, prevented: e.defaultPrevented });
    }, { once: false });
  });
  await page.keyboard.press(chord);
  return page.evaluate(() => window.__keyProbe.filter((e) => e.key !== 'Control' && e.key !== 'Shift' && e.key !== 'Meta'));
}

test('Cmd+E im View-Modus startet den Notebook-Editor und bleibt in der Seite', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async (i) => {
    await window.__app.selectPage(window.Alpine.store('nav').pages[i]);
  }, 0);
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  expect(await page.evaluate(() => !!window.__app.currentPage)).toBe(true);
  expect(await page.evaluate(() => window.__app.editMode)).toBe(false);

  const seen = await recordNextKey(page, 'Control+e');

  expect(seen.length).toBeGreaterThan(0);
  expect(seen[seen.length - 1].prevented).toBe(true);
  await expect(page.locator(EDIT_SEL)).toBeVisible({ timeout: 15000 });
  expect(await page.evaluate(() => window.__app.editMode)).toBe(true);
});

test('Cmd+E ohne geöffneten Abschnitt: kein Tab des Suchanbieters', async ({ page }) => {
  await bootApp(page);
  // Buchübersicht ohne ausgewählten Abschnitt → `currentPage` ist null, die
  // Aktion also nicht ausführbar. Genau hier lief der Chord previously an
  // Chrome durch, weil der Zustands-Guard vor dem preventDefault stand.
  await selectSeededBook(page);
  expect(await page.evaluate(() => !!window.__app.currentPage)).toBe(false);

  const seen = await recordNextKey(page, 'Control+e');

  expect(seen.length).toBeGreaterThan(0);
  expect(seen[seen.length - 1].prevented).toBe(true);
  expect(await page.evaluate(() => window.__app.editMode)).toBe(false);
});

test('Cmd+Shift+E bleibt der Focus-Toggle (nicht vom Nav-Handler geschluckt)', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async (i) => {
    await window.__app.selectPage(window.Alpine.store('nav').pages[i]);
  }, 0);
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });

  await recordNextKey(page, 'Control+Shift+E');

  // handleFocusHotkey preventDefault'ed (Chord gehört der App) — entscheidend
  // ist aber der Zustand: Fokusmodus, nicht Notebook-Edit.
  await page.waitForFunction(() => window.__app.focusActive === true, null, { timeout: 15000 });
  // Fokusmodus speichert beim Verlassen — Testende räumt auf.
  await page.evaluate(() => window.__app.exitFocusMode());
  await page.waitForFunction(() => window.__app.focusActive === false, null, { timeout: 15000 });
});