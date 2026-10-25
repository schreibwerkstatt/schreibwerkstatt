// Bucheditor gegen die ECHTE App (siehe playwright.app.config.js): Verhalten,
// nicht nur „Karte öffnet ohne Fehler" (das deckt smoke.spec.js ab).
//
// Warum diese Schicht: der Bucheditor hat keinen Fixture-Harness, und seine
// heiklen Pfade laufen über echtes contenteditable + echten Save gegen das
// Backend. Zwei Klassen von Fehlern fallen NUR hier auf:
//   - Alpine-Scope: `this.$el` zeigt in einer aus `@click` gerufenen Methode
//     auf das auslösende Element, nicht auf die Karten-Wurzel — ein Lookup mit
//     dem falschen Wurzel-Element findet nichts und der Block bekommt keinen
//     Fokus (Tippen läuft ins Leere, ohne dass irgendwo ein Fehler entsteht).
//   - Save-Kette: dirty → Queue → PUT → persistiert. Unit-Tests sehen davon
//     nur `applySaveOutcome`.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');

test.describe.configure({ mode: 'serial' });

const card = (page) => page.locator('.card--bookeditor');

// Karten-State lesen (dirtyCount/savingCount sind abgeleitete Getter).
const state = (page) => page.evaluate(() => {
  const d = window.Alpine.$data(document.querySelector('.card--bookeditor'));
  return { dirty: d.dirtyCount, saving: d.savingCount, blocks: d.blocks.length, active: d.activePageId };
});

async function openBookEditor(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__app && Array.isArray(window.Alpine.store('nav').books) && window.Alpine.store('nav').books.length > 0,
    null, { timeout: 30000 },
  );
  const bookId = await page.evaluate(() => window.Alpine.store('nav').books[0].id);
  await page.evaluate((id) => { location.hash = '#book/' + id; }, bookId);
  await page.waitForFunction(
    (id) => String(window.Alpine.store('nav').selectedBookId) === String(id)
            && Array.isArray(window.Alpine.store('nav').pages) && window.Alpine.store('nav').pages.length > 0,
    bookId, { timeout: 20000 },
  );
  await page.evaluate(() => window.__app.toggleBookEditorCard());
  await expect(card(page).locator('.book-editor-page-body').first()).toBeVisible({ timeout: 15000 });
}

test('Klick aktiviert den Block, Tippen macht dirty, Save-All persistiert', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await openBookEditor(page);
  expect((await state(page)).dirty).toBe(0);

  const body = card(page).locator('.book-editor-page-body').first();
  await body.click();
  await expect(body).toHaveAttribute('contenteditable', 'true');
  // Der Fokus kommt erst im $nextTick nach dem contenteditable-Flip (der Block
  // ist beim Mousedown noch nicht editierbar, der Browser fokussiert also
  // nicht selbst). Abwarten statt blind tippen — sonst landen die Tasten im
  // Nichts, und genau das wäre der Bug, den dieser Test fangen soll.
  await expect.poll(
    () => page.evaluate(() => document.activeElement?.classList?.contains('book-editor-page-body') === true),
    { timeout: 5000 },
  ).toBe(true);
  await page.keyboard.type('PROBE ');

  expect((await state(page)).dirty, 'dirtyCount leitet sich aus den Blöcken ab').toBe(1);
  await expect(card(page).locator('.book-editor-page-status').first()).toHaveText(/.+/);

  await page.evaluate(() => window.Alpine.$data(document.querySelector('.card--bookeditor')).saveAllDirty());
  await expect.poll(async () => (await state(page)).dirty, { timeout: 15000 }).toBe(0);

  // Wirklich geschrieben? Neu laden und im Stream nachsehen.
  await openBookEditor(page);
  await expect(card(page).locator('.book-editor-page-body').first()).toContainText('PROBE');
  guard.assertClean('Bucheditor: Tippen + Save-All');
});

test('Ohne caretRangeFromPoint setzt der Fallback den Caret (Tippen läuft nicht ins Leere)', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  // Deterministisch den Fallback-Pfad erzwingen: ohne die API (bzw. bei einem
  // Klick, der kein Textnode trifft) muss der Caret trotzdem im Block landen —
  // sonst ist der Block zwar fokussiert, aber jede Eingabe verpufft.
  await page.addInitScript(() => { delete Document.prototype.caretRangeFromPoint; });
  await openBookEditor(page);

  const body = card(page).locator('.book-editor-page-body').first();
  await body.click();
  await expect(body).toHaveAttribute('contenteditable', 'true');
  // Auf den FOKUS warten, nicht auf „irgendeine Selektion im Block": der Browser
  // setzt beim Mousedown selbst eine Selektion in den (noch nicht editierbaren)
  // Block — die ist bereits da, bevor `activateBlock` im $nextTick fokussiert und
  // den Fallback-Caret setzt. Wer darauf gated, tippt ins Leere und misst nichts.
  // `el.focus()` läuft synchron vor `_placeCaret` im selben $nextTick: sobald der
  // Block das aktive Element ist, steht auch der Fallback-Caret.
  await expect.poll(
    () => page.evaluate(() => {
      const el = document.querySelector('.book-editor-page-body');
      if (document.activeElement !== el) return false;
      const s = document.getSelection();
      return !!(s && s.anchorNode && el.contains(s.anchorNode));
    }),
    { timeout: 5000 },
  ).toBe(true);

  await page.keyboard.type('X');
  expect((await state(page)).dirty).toBe(1);
  // Der Fallback setzt den Caret an den Blockanfang — das Zeichen muss dort
  // stehen, nicht an der Klickstelle. Sonst hätte auch die Browser-Selektion
  // gereicht und der Fallback-Pfad wäre ungeprüft.
  expect(await page.evaluate(
    () => document.querySelector('.book-editor-page-body').textContent.startsWith('X'),
  )).toBe(true);
  guard.assertClean('Bucheditor: Caret-Fallback');
});

test('Find/Replace läuft über den ganzen Stream', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await openBookEditor(page);

  await page.evaluate(() => window.Alpine.$data(document.querySelector('.card--bookeditor')).openFind());
  await card(page).locator('.book-editor-find-input').first().fill('der');
  await expect.poll(
    async () => page.evaluate(() => window.Alpine.$data(document.querySelector('.card--bookeditor')).findMatches.length),
    { timeout: 5000 },
  ).toBeGreaterThan(0);

  await card(page).locator('.book-editor-find-input--replace').fill('DEEER');
  // .book-editor-find-btn--text: [0] = Ersetzen, [1] = Alle ersetzen (locale-frei).
  await card(page).locator('.book-editor-find-btn--text').nth(1).click();
  await expect.poll(async () => (await state(page)).dirty, { timeout: 5000 }).toBeGreaterThan(0);
  await expect(card(page).locator('.book-editor-page-body').first()).toContainText('DEEER');
  guard.assertClean('Bucheditor: Find/Replace');
});

test('Outline-Chevron klappt ein Kapitel ein', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await openBookEditor(page);

  const chapter = card(page).locator('.book-editor-outline-chapter').first();
  await expect(chapter.locator('.history-chevron')).toHaveClass(/open/);
  const before = await card(page).locator('.book-editor-outline-page').count();
  await chapter.click();
  await expect(chapter.locator('.history-chevron')).not.toHaveClass(/open/);
  expect(await card(page).locator('.book-editor-outline-page').count()).toBeLessThan(before);
  guard.assertClean('Bucheditor: Outline');
});

// Nachrichtenverlauf: die Blasen-Regeln kommen aus der SSoT
// (components/manuscript-content.css). Die Stream-Absatzregeln des Bucheditors
// (book-editor.css, gleicher Layer, später geladen) dürfen sie nicht
// überschreiben — `p:first-child`/`p:last-child` waren gleich spezifisch und
// gaben der ersten und letzten Blase Rand. Nur Anzeige, kein Save.
test('Nachrichtenverlauf: Blasen ohne Stream-Absatzrand', async ({ page }) => {
  await openBookEditor(page);
  const m = await page.evaluate(() => {
    const body = document.querySelector('.card--bookeditor .book-editor-page-body');
    const thread = document.createElement('div');
    thread.className = 'msg-thread';
    thread.innerHTML = '<p class="msg-in">Hallo</p><p class="msg-out">Hi</p><p class="msg-in">Wo bist du?</p>';
    body.appendChild(thread);
    const rows = [...thread.children];
    const out = {
      margins: rows.map(p => [getComputedStyle(p).marginTop, getComputedStyle(p).marginBottom]),
      outRight: rows[1].getBoundingClientRect().right > rows[0].getBoundingClientRect().right,
    };
    thread.remove();
    return out;
  });
  for (const [top, bottom] of m.margins) {
    expect(top).toBe('0px');
    expect(bottom).toBe('0px');
  }
  expect(m.outRight).toBe(true);
});

// Verlassen speichert: geht der Fokus aus dem aktiven Block (hier: Klick auf den
// Kartentitel), läuft der Save sofort — nicht erst nach dem Autosave-Fenster
// (60 s). Der Block bleibt dabei aktiv.
test('Fokus verlässt den aktiven Block → gespeichert ohne Autosave-Wartezeit', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await openBookEditor(page);
  const body = card(page).locator('.book-editor-page-body').first();
  await body.click();
  await expect.poll(
    () => page.evaluate(() => document.activeElement?.classList?.contains('book-editor-page-body') === true),
    { timeout: 5000 },
  ).toBe(true);
  await page.keyboard.type('FOKUSRAUS ');
  expect((await state(page)).dirty).toBe(1);

  await card(page).locator('.card-title').click();
  await expect.poll(async () => (await state(page)).dirty, { timeout: 10000 }).toBe(0);
  await expect(body).toHaveAttribute('contenteditable', 'true');
  guard.assertClean('Bucheditor: Verlassen speichert');
});

// Die Suche beginnt an der Stelle, an der der User steht — nicht am Buchanfang.
test('Suche startet im aktiven Abschnitt, nicht beim ersten Treffer im Buch', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await openBookEditor(page);
  const bodies = card(page).locator('.book-editor-page-body');
  const term = 'und';
  const has = await page.evaluate((t) => [...document.querySelectorAll('.card--bookeditor .book-editor-page-body')]
    .slice(0, 2).map(el => el.textContent.toLowerCase().includes(t)), term);
  test.skip(has.length < 2 || !has[0] || !has[1], 'Testbuch braucht den Begriff in den ersten beiden Abschnitten');

  // Caret an den Anfang des zweiten Abschnitts.
  await bodies.nth(1).click({ position: { x: 4, y: 4 } });
  await expect(bodies.nth(1)).toHaveAttribute('contenteditable', 'true');
  const second = await page.evaluate(() => window.Alpine.$data(document.querySelector('.card--bookeditor')).activePageId);

  await page.evaluate(() => window.Alpine.$data(document.querySelector('.card--bookeditor')).openFind());
  await card(page).locator('.book-editor-find-input').first().fill(term);
  await expect.poll(
    () => page.evaluate(() => {
      const d = window.Alpine.$data(document.querySelector('.card--bookeditor'));
      return d.findIndex >= 0 ? d.findMatches[d.findIndex].pageId : null;
    }),
    { timeout: 5000 },
  ).toBe(second);
  guard.assertClean('Bucheditor: Suche ab Caret');
});

// Ein Filter ohne Treffer zeigt die Leiste weiter (Filterknöpfe, Leer-Hinweis).
// Sie braucht dann auch ihre Rasterspalte — sonst rutscht sie in eine neue
// Rasterzeile unter das ganze Manuskript.
test('Kommentar-Leiste mit leerem Filter bleibt neben dem Stream', async ({ page }) => {
  await openBookEditor(page);
  await page.evaluate(() => {
    const d = window.Alpine.$data(document.querySelector('.card--bookeditor'));
    d.commentRailVisible = true;
    d.commentThreads = [];
    d.commentFilterStatus = 'resolved';
  });
  const rail = card(page).locator('.book-editor-comments');
  await expect(rail).toBeVisible();
  await expect(card(page).locator('.book-editor-layout')).toHaveClass(/book-editor-layout--comments/);
  const pos = await page.evaluate(() => ({
    rail: document.querySelector('.card--bookeditor .book-editor-comments').getBoundingClientRect(),
    stream: document.querySelector('.card--bookeditor .book-editor-stream').getBoundingClientRect(),
  }));
  expect(pos.rail.left, 'Leiste rechts neben dem Stream').toBeGreaterThanOrEqual(pos.stream.right - 1);
  expect(pos.rail.top, 'nicht unter dem Manuskript').toBeLessThan(pos.stream.bottom);
});
