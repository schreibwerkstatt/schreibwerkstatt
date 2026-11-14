// Undo/Redo der Plot-Werkstatt gegen die ECHTE App (Server + SQLite + Alpine).
//
// Warum hier und nicht als Fixture-Harness: die Historie ist nur dann etwas wert,
// wenn der Server den zurückgedrehten Stand wirklich übernimmt — jeder Applier ist
// ein echter PATCH/DELETE/PUT. Genau das prüft diese Ebene (Reload beweist die
// Persistenz), ein Mock-Server würde die Zusage nur nachspielen.
//
// Nicht abgedeckt: der Drag-&-Drop-Pfad (`beat-place`) — SortableJS mit
// forceFallback-Ghost ist im Headless-Chromium nicht verlässlich fahrbar. Dessen
// Kern (`_hApplyPlacements`: nur abweichende Beats, Quell- + Ziel-Zelle
// persistieren) liegt in tests/unit/plot-history.test.mjs.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard.js');
const { bootApp, selectSeededBook } = require('./_helpers/app.js');

// Flaches Board und Grid liegen beide im DOM (je x-show) — das Seed-Buch hat keine
// Stränge, also ist das flache Board das sichtbare. Alle Board-Locator dorthin
// skopieren, sonst matcht jeder Selektor doppelt (strict-mode violation).
const BOARD = '#partial-plot-board-flat';

const ACT_NAME = 'Undo-Test-Akt';
const ACT_RENAMED = 'Umbenannter Akt';
const BEAT_TITEL = 'Undo-Test-Bogen';

// Plot-Karte oeffnen und auf das Board warten.
async function openPlot(page) {
  await page.evaluate(() => window.__app.togglePlotCard());
  await expect(page.locator('.card--plot')).toBeVisible();
  await page.waitForFunction(() => !document.querySelector('.card--plot')
    ?.textContent?.includes('…lade'), null, { timeout: 10000 }).catch(() => {});
}

// Akt anlegen — der Einstieg unterscheidet sich je nachdem, ob das Board leer ist
// (Empty-State-Button) oder schon Spalten hat (Add-Spalte am Ende).
async function addAct(page, name) {
  const input = page.locator(`${BOARD} .plot-new-act-input`);
  if (!(await input.isVisible())) {
    const emptyBtn = page.locator('.card--plot .card-empty .card-empty-cta');
    if (await emptyBtn.isVisible()) await emptyBtn.click();
    else await page.locator(`${BOARD} .plot-add-act-btn`).first().click();
  }
  await input.fill(name);
  await input.press('Enter');
  await expect(page.locator(`${BOARD} .plot-column-title`, { hasText: name })).toBeVisible();
}

// Reste eines abgebrochenen Vorversuchs entfernen: die Spec legt echte Akte in der
// geteilten DB an, und ein Retry nach einem Abbruch mitten im Lauf fände den alten
// Akt noch vor — das Undo des neuen liesse dann eine gleichnamige Spalte stehen.
async function removeLeftoverActs(page) {
  await page.evaluate(async (names) => {
    const bookId = window.Alpine.store('nav').selectedBookId;
    const { acts } = await (await fetch(`/plot?book_id=${bookId}`)).json();
    for (const a of acts.filter((x) => names.includes(x.name))) {
      await fetch(`/plot/acts/${a.id}`, { method: 'DELETE' });
    }
  }, [ACT_NAME, ACT_RENAMED]);
}

const undoBtn = (page) => page.locator('.card--plot .card-actions button').first();
const redoBtn = (page) => page.locator('.card--plot .card-actions button').nth(1);
const actTitle = (page, name) => page.locator(`${BOARD} .plot-column-title`, { hasText: name });

test('Undo/Redo: Akt anlegen, umbenennen, Bogen anlegen — serverseitig zurückgedreht', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  await removeLeftoverActs(page);
  await openPlot(page);

  // Leerer Stack → beide Buttons deaktiviert.
  await expect(undoBtn(page)).toBeDisabled();
  await expect(redoBtn(page)).toBeDisabled();

  // ── create-act: Undo löscht den frisch angelegten Akt ──────────────────────
  await addAct(page, ACT_NAME);
  await expect(undoBtn(page)).toBeEnabled();
  await undoBtn(page).click();
  await expect(actTitle(page, ACT_NAME)).toHaveCount(0);
  // Nach dem Undo eines Create ist der Redo-Stack invalidiert (neue ID beim
  // Wiederanlegen) — der Button bleibt aus.
  await expect(redoBtn(page)).toBeDisabled();

  // ── act-fields: Umbenennen zurückdrehen und wiederherstellen ───────────────
  await addAct(page, ACT_NAME);
  // Spalten-Locator OHNE hasText: im Bearbeiten-Modus ersetzt das x-if den Titel-
  // Span durch ein Input, die Spalte enthaelt den Namen dann nicht mehr als Text —
  // ein hasText-Filter loest danach ins Leere auf. Das Board hat hier genau eine Spalte.
  const column = page.locator(`${BOARD} .plot-column`).first();
  await column.locator('.plot-column-title').click(); // Klick auf den Namen = umbenennen
  const titleInput = column.locator('.plot-column-title-input');
  await titleInput.fill(ACT_RENAMED);
  await titleInput.press('Enter');
  await expect(actTitle(page, ACT_RENAMED)).toBeVisible();

  await undoBtn(page).click();
  await expect(actTitle(page, ACT_NAME)).toBeVisible();
  await expect(redoBtn(page)).toBeEnabled();
  await redoBtn(page).click();
  await expect(actTitle(page, ACT_RENAMED)).toBeVisible();
  // Rückweg muss wieder undo-bar sein (Guard gegen den Re-Entry-Guard).
  await expect(undoBtn(page)).toBeEnabled();
  await undoBtn(page).click();
  await expect(actTitle(page, ACT_NAME)).toBeVisible();

  // ── create-beat: Undo löscht den Bogen, der Akt bleibt ─────────────────────
  const col = page.locator(`${BOARD} .plot-column`).first();
  await col.locator('.plot-add-beat-btn').click();
  const beatInput = col.locator('.plot-add-beat-input');
  await beatInput.fill(BEAT_TITEL);
  await beatInput.press('Enter');
  await expect(page.locator(`${BOARD} .plot-beat-title`, { hasText: BEAT_TITEL })).toBeVisible();

  await undoBtn(page).click();
  await expect(page.locator(`${BOARD} .plot-beat-title`, { hasText: BEAT_TITEL })).toHaveCount(0);
  await expect(actTitle(page, ACT_NAME)).toBeVisible();

  // ── Persistenz: Reload zeigt den zurückgedrehten Stand (Akt ohne Bogen) ────
  await bootApp(page); // frischer Load (wartet auf window.__app + geladene Bücher)
  await selectSeededBook(page);
  await openPlot(page);
  await expect(actTitle(page, ACT_NAME)).toBeVisible();
  await expect(page.locator(`${BOARD} .plot-beat-title`, { hasText: BEAT_TITEL })).toHaveCount(0);
  await expect(actTitle(page, ACT_RENAMED)).toHaveCount(0);
  // Board-Reload leert die Historie (fremde Änderungen könnten Records entwerten).
  await expect(undoBtn(page)).toBeDisabled();

  expect(guard.unmatched().map((f) => `[${f.channel}] ${f.text}`)).toEqual([]);
});

// Beat-Löschen leert die Historie nicht mehr: Undo legt den Beat aus dem
// Snapshot neu an (Felder + Platz), Redo löscht ihn wieder (book/plot/beat-restore.js).
test('Undo/Redo: Beat löschen und wiederherstellen — serverseitig', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  await removeLeftoverActs(page);
  await openPlot(page);
  await addAct(page, ACT_NAME);
  try {
    const r = await page.evaluate(async () => {
      const card = window.Alpine.$data(document.querySelector('.card--plot'));
      const bookId = window.Alpine.store('nav').selectedBookId;
      const act = card.acts.find(a => a.name === 'Undo-Test-Akt');
      card.newBeatTitel = 'Lösch-Beat';
      await card._createBeatInline({ actId: act.id, threadId: null, keepAdding: false, cancel() {}, refocus() {}, close() {} });
      const beat = card.beats.find(b => b.titel === 'Lösch-Beat');
      window.__app.appConfirm = async () => true;
      await card.deleteBeat(beat);
      const serverTitles = async () => ((await (await fetch(`/plot?book_id=${bookId}`)).json()).beats || []).map(b => b.titel);
      const afterDelete = (await serverTitles()).includes('Lösch-Beat');
      await card.historyUndo();
      const afterUndo = (await serverTitles()).includes('Lösch-Beat');
      const restored = card.beats.find(b => b.titel === 'Lösch-Beat');
      await card.historyRedo();
      const afterRedo = (await serverTitles()).includes('Lösch-Beat');
      return { afterDelete, afterUndo, sameAct: restored?.act_id === act.id, afterRedo };
    });
    expect(r).toEqual({ afterDelete: false, afterUndo: true, sameAct: true, afterRedo: false });
  } finally {
    await removeLeftoverActs(page);
  }
  guard.assertClean('Plot Beat-Löschen Undo');
});

// Farbwähler (color-picker.html + colorPicker): Swatch öffnet, Wahl schreibt die
// Akt-Farbe, Esc schliesst nur das Popover.
test('Farbwähler: Akt-Farbe per Swatch setzen', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  await removeLeftoverActs(page);
  await openPlot(page);
  await addAct(page, ACT_NAME);
  try {
    const col = page.locator(`${BOARD} .plot-column`, { has: page.locator('.plot-column-title', { hasText: ACT_NAME }) });
    await col.locator('.color-picker__swatch').click();
    const pop = col.locator('.color-picker__popover');
    await expect(pop).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(pop).toBeHidden();
    await col.locator('.color-picker__swatch').click();
    await pop.locator('.color-picker__opt:not(.color-picker__opt--none)').first().click();
    await expect(pop).toBeHidden();
    await expect.poll(() => page.evaluate(async () => {
      const bookId = window.Alpine.store('nav').selectedBookId;
      const { acts } = await (await fetch(`/plot?book_id=${bookId}`)).json();
      return acts.find(a => a.name === 'Undo-Test-Akt')?.farbe || null;
    })).not.toBeNull();
  } finally {
    await removeLeftoverActs(page);
  }
  guard.assertClean('Plot Farbwähler');
});
