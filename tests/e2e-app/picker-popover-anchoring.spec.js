// Picker-Popover (public/js/picker-popover.js) gegen die ECHTE App: Buchorganizer
// „In anderes Buch" und Figur-Werkstatt „Mit Katalogfigur verknuepfen".
//
// Warum e2e-app: die Position haengt am vollen CSS (Popover-Breite aus
// `--picker-popover-w`, Hoehe aus Kopf + Combobox + Hinweis), am echten Trigger
// in der Zeile — ein Harness
// bliebe gruen, waehrend das Popover in der App vom Knopf abrueckt.
//
// Geprueft wird jeweils: Popover sitzt direkt unter (bzw. am unteren Rand direkt
// ueber) seinem Trigger, rechtsbuendig zu ihm, ganz im Viewport. Das Hochklappen
// ist der Fall, der den Mess-Pass braucht: mit der blossen Hoehen-Schaetzung
// stuende das Popover mit Luecke ueber dem Knopf.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

// Abstand Trigger ↔ Popover: popover-anchor.js GAP = 4, Toleranz fuer Subpixel.
const MAX_GAP = 6;

async function expectAnchored(page, popover, trigger, { side } = {}) {
  await expect(popover).toBeVisible();
  // Zwei Paesse (Schaetzung, dann $nextTick-Messung) — erst nach dem zweiten pruefen.
  await page.waitForTimeout(100);
  const pr = await popover.boundingBox();
  const tr = await trigger.boundingBox();
  const vp = page.viewportSize();
  const above = pr.y + pr.height <= tr.y + 1;
  if (side) expect(above ? 'above' : 'below', 'Klapprichtung').toBe(side);
  const gap = above ? tr.y - (pr.y + pr.height) : pr.y - (tr.y + tr.height);
  expect(gap, `Abstand zum Trigger (${above ? 'oben' : 'unten'})`).toBeGreaterThanOrEqual(-1);
  expect(gap, `Abstand zum Trigger (${above ? 'oben' : 'unten'})`).toBeLessThanOrEqual(MAX_GAP);
  // Rechtsbuendig zum Trigger, ausser der Viewport-Rand schiebt es nach innen.
  const clampedLeft = pr.x <= 9;
  if (!clampedLeft) expect(Math.abs((pr.x + pr.width) - (tr.x + tr.width)), 'rechtsbuendig').toBeLessThanOrEqual(2);
  expect(pr.x).toBeGreaterThanOrEqual(0);
  expect(pr.x + pr.width).toBeLessThanOrEqual(vp.width);
  expect(pr.y).toBeGreaterThanOrEqual(0);
  expect(pr.y + pr.height).toBeLessThanOrEqual(vp.height);
}

// ── Buchorganizer ────────────────────────────────────────────────────────────

async function openOrganizer(page) {
  await page.evaluate(() => window.__app.toggleBookOrganizerCard());
  await expect(page.locator('.card--organizer')).toBeVisible();
  await page.waitForFunction(() =>
    document.querySelectorAll('.card--organizer .organizer-page .organizer-book-move-trigger').length > 0);
  await page.waitForTimeout(600); // cardFadeIn: Transform waere Containing-Block fuer fixed
}

test('organizer: „In anderes Buch" haengt unter dem Zeilen-Knopf und klappt am Rand hoch', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  await openOrganizer(page);

  const triggers = page.locator('.card--organizer .organizer-page .organizer-book-move-trigger:visible');
  const popover = page.locator('.organizer-book-move');

  // Oben in der Liste: darunter.
  const first = triggers.first();
  await first.scrollIntoViewIfNeeded();
  await first.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await first.click();
  await expectAnchored(page, popover, first, { side: 'below' });
  const name = await first.evaluate((el) => {
    const li = el.closest('.organizer-page');
    return window.Alpine.$data(el)._findPage(parseInt(li.dataset.pageId, 10))?.name;
  });
  await expect(popover.locator('.picker-popover__subject')).toHaveText(name);
  // Die Warnung steht im Popover, ein zweiter Bestaetigungs-Dialog entfaellt.
  await expect(popover.locator('.picker-popover__hint')).toBeVisible();
  await expect(popover.getByRole('button', { name: 'Verschieben' })).toBeDisabled();

  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();

  // Am unteren Viewport-Rand: kein Platz darunter → darueber, ohne Luecke.
  const last = triggers.last();
  await last.evaluate((el) => el.scrollIntoView({ block: 'end' }));
  const tr = await last.boundingBox();
  expect(tr.y + tr.height + 200, 'Vorbedingung: Trigger am unteren Rand')
    .toBeGreaterThan(page.viewportSize().height);
  await last.click();
  await expectAnchored(page, popover, last, { side: 'above' });

  // Klick daneben schliesst.
  await page.mouse.click(5, 5);
  await expect(popover).toBeHidden();
});

test('organizer: Abschnitt per Picker in ein anderes Buch verschieben', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const made = await page.evaluate(async (id) => {
    const target = window.Alpine.store('nav').books.find(b => b.id !== id && !b.archived);
    const p = await fetch('/content/pages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: id, name: 'Picker-Umzug' }),
    }).then(r => r.json());
    await window.__app.loadPages({ source: 'job' });
    return { pageId: p.id ?? p.page_id, targetId: target.id, targetName: target.name };
  }, bookId);

  try {
    await openOrganizer(page);
    const row = page.locator(`.card--organizer .organizer-page[data-page-id="${made.pageId}"]`);
    await expect(row).toBeVisible();
    const trigger = row.locator('.organizer-book-move-trigger');
    await trigger.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await trigger.click();

    const popover = page.locator('.organizer-book-move');
    await expectAnchored(page, popover, trigger);
    await expect(popover.locator('.picker-popover__subject')).toHaveText('Picker-Umzug');

    await popover.locator('.combobox-trigger').click();
    // Die geoeffnete Optionsliste darf den Picker nicht schliessen (kein Scroll-/Outside-Close).
    await popover.locator('.combobox-option', { hasText: made.targetName }).click();
    await expect(popover).toBeVisible();
    await popover.getByRole('button', { name: 'Verschieben' }).click();

    await expect(popover).toBeHidden();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(row).toHaveCount(0);
    const moved = await page.evaluate((pid) => fetch(`/content/pages/${pid}`).then(r => r.json()), made.pageId);
    expect(moved.book_id).toBe(made.targetId);
  } finally {
    await page.evaluate((pid) => fetch(`/content/pages/${pid}`, { method: 'DELETE' }), made.pageId);
  }
});

// Zeilen-Comboboxen sind lazy: ihr Platzhalter-Trigger faellt beim Klick aus dem
// DOM, Alpines `@click.outside` ignoriert ihn — der Picker muss trotzdem
// schliessen, und sein liegengebliebener Abbruch darf das naechste Oeffnen
// desselben Pickers nicht sofort wieder zuklappen.
test('organizer: Picker oeffnet nach Zeilen-Comboboxen auch beim zweiten Durchgang', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  await openOrganizer(page);

  const row = page.locator('.card--organizer .organizer-page').first();
  const popover = page.locator('.organizer-book-move');
  const rowCombos = row.locator('.organizer-redaktion-combo .combobox-trigger, '
    + '.organizer-move-combo:not(:has(.organizer-book-move-trigger)) .combobox-trigger');

  for (let round = 0; round < 2; round++) {
    const n = await rowCombos.count();
    for (let i = 0; i < n; i++) {
      await rowCombos.nth(i).click();
      await expect(popover, `Runde ${round + 1}: Zeilen-Combobox schliesst den Picker`).toBeHidden();
    }
    await row.locator('.organizer-book-move-trigger').click();
    await expect(popover, `Runde ${round + 1}`).toBeVisible();
    await popover.locator('.combobox-trigger').click();
    await expect(popover.locator('.combobox-option:visible').first()).toBeVisible();
  }
});

// ── Figur-Werkstatt ─────────────────────────────────────────────────────────

async function openWerkstattDraft(page, name) {
  const bookId = await selectSeededBook(page);
  const draft = await page.evaluate(async ({ bookId, name }) => {
    const r = await fetch(`/draft-figures/${bookId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    return r.json();
  }, { bookId, name });
  await page.evaluate(() => window.__app.toggleFigurWerkstattCard());
  await expect(page.locator('.card--werkstatt')).toBeVisible();
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent('figur-werkstatt:select', { detail: { draftId: id } })), draft.id);
  await expect(page.locator('.card--werkstatt .werkstatt-detail-name')).toHaveText(name);
  await page.waitForTimeout(600); // cardFadeIn
  return draft;
}

async function openLinkPicker(page) {
  const menuBtn = page.locator('.card--werkstatt .werkstatt-detail .action-overflow > button');
  await menuBtn.click();
  // Langsame Kandidaten-Antwort: der Picker geht vorher auf (Ladezustand) und
  // muss nach dem Laden — andere Hoehe — neu verankert werden.
  await page.route('**/link-candidates', async (route) => {
    await new Promise(r => setTimeout(r, 400));
    await route.continue();
  });
  await page.getByRole('menuitem', { name: 'Mit Katalogfigur verknüpfen' }).click();
  return menuBtn;
}

test('werkstatt: Verknuepfen-Picker haengt am Menue-Knopf, auch nach dem Nachladen', async ({ page }) => {
  await bootApp(page);
  const name = `Picker-Probe ${String(Date.now()).slice(-6)}`;
  const draft = await openWerkstattDraft(page, name);
  try {
    const menuBtn = await openLinkPicker(page);
    const popover = page.locator('.werkstatt-link-picker');
    await expect(popover.getByText('Wird geladen', { exact: false })).toBeVisible();
    await expectAnchored(page, popover, menuBtn, { side: 'below' });
    await expect(popover.locator('.picker-popover__subject')).toHaveText(name);

    // Nach dem Laden: Combobox oder Leer-Hinweis, neu gemessen.
    await expect(popover.getByText('Wird geladen', { exact: false })).toBeHidden();
    await expectAnchored(page, popover, menuBtn, { side: 'below' });
    // Das Inline-Panel im Detail gibt es nicht mehr.
    await expect(page.locator('.card--werkstatt .werkstatt-detail .werkstatt-create-inline:visible')).toHaveCount(0);

    await popover.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(popover).toBeHidden();
  } finally {
    await page.evaluate((id) => fetch(`/draft-figures/${id}`, { method: 'DELETE' }), draft.id);
  }
});
