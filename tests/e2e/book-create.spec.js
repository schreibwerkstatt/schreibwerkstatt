const { test, expect } = require('./_helpers/fixtures');

// Verifiziert das Buch-erstellen-Modal (index.html) gegen die echte Alpine-
// Runtime + die echte combobox-Komponente: Buchtyp ist Pflicht, Kategorie nur
// wenn der globale Pool nicht leer ist, und beim gültigen Submit werden Buchtyp
// + Kategorie am frisch angelegten Buch persistiert (createBook → /booksettings
// → /books/:id/category). Backend-Endpunkte via page.route gemockt.

const URL = 'http://localhost:8765/tests/fixtures/book-create-harness.html';

// Registriert alle vom Modal genutzten Endpunkte. `categories` steuert den Pool;
// `calls` sammelt die beobachteten Requests zur Assertion.
async function mockBackend(page, { categories }) {
  const calls = { createBook: 0, booksettings: null, category: null };

  await page.route('**/local/categories', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ categories }) }));

  await page.route('**/content/books', (route) => {
    calls.createBook++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 999, name: 'X', role: 'owner' }) });
  });

  await page.route('**/booksettings/999', (route) => {
    calls.booksettings = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.route('**/books/999/category', (route) => {
    calls.category = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  return calls;
}

// Wählt eine Combobox-Option per echtem Klick (Trigger öffnen → Option klicken).
async function selectCombo(page, fieldId, label) {
  await page.locator(`#${fieldId} .combobox-trigger`).click();
  await page.locator(`#${fieldId} .combobox-option__label`, { hasText: label }).click();
}

test('Pflichtfelder: Buchtyp + Kategorie blockieren Submit, gültig persistiert alles', async ({ page }) => {
  const calls = await mockBackend(page, { categories: [{ id: 1, name: 'Belletristik' }, { id: 2, name: 'Sachbuch' }] });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Alpine && window.__harnessReady);

  await page.locator('#open-btn').click();
  await expect(page.locator('#book-create-dialog')).toBeVisible();

  // Pool nicht leer → Kategorie-Feld sichtbar.
  await expect(page.locator('#field-category')).toBeVisible();

  // Leerer Name → Submit-Button disabled (Name-Pflicht greift schon im :disabled).
  await expect(page.locator('#submit-btn')).toBeDisabled();

  // Buchtyp ist ohne Profil-Standard mit Roman vorbelegt — keine leere Pflichtauswahl.
  await expect(page.locator('#field-buchtyp .combobox-value')).toHaveText('Roman');

  // Name füllen → Submit aktiv.
  await page.locator('.book-create-input').fill('Mein Roman');
  await expect(page.locator('#submit-btn')).toBeEnabled();

  // Anderen Buchtyp wählen → Label propagiert; es fehlt nur noch die Kategorie.
  await selectCombo(page, 'field-buchtyp', 'Krimi / Thriller');
  await expect(page.locator('#field-buchtyp .combobox-value')).toHaveText('Krimi / Thriller');
  await page.locator('#submit-btn').click();
  await expect(page.locator('#create-error')).toHaveText('Bitte eine Kategorie wählen.');
  expect(calls.createBook).toBe(0);

  // Kategorie wählen → Submit ist jetzt gültig.
  await selectCombo(page, 'field-category', 'Sachbuch');
  await page.locator('#submit-btn').click();

  // Buch angelegt + Buchtyp/Kategorie am Buch 999 persistiert, Modal zu.
  await expect(page.locator('#book-create-dialog')).toBeHidden();
  expect(calls.createBook).toBe(1);
  expect(calls.booksettings).toMatchObject({ buchtyp: 'krimi', language: 'de', region: 'CH' });
  expect(calls.category).toMatchObject({ category_id: 2 });
  // Ins neue Buch (Übersicht), nicht in die Settings-Karte.
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#book/999');
  expect(await page.evaluate(() => window.__calls.openedSettings)).toBeUndefined();
});

test('Leerer Kategorie-Pool: Kategorie-Feld verborgen, Submit ohne Kategorie gültig', async ({ page }) => {
  const calls = await mockBackend(page, { categories: [] });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Alpine && window.__harnessReady);

  await page.locator('#open-btn').click();
  await expect(page.locator('#book-create-dialog')).toBeVisible();

  // Leerer Pool → Kategorie-Feld nicht sichtbar.
  await expect(page.locator('#field-category')).toBeHidden();

  await page.locator('.book-create-input').fill('Ohne Kategorie');
  await selectCombo(page, 'field-buchtyp', 'Sachbuch');
  await page.locator('#submit-btn').click();

  // Gültig ohne Kategorie: Buch + Buchtyp persistiert, KEIN category-PUT.
  await expect(page.locator('#book-create-dialog')).toBeHidden();
  expect(calls.createBook).toBe(1);
  expect(calls.booksettings).toMatchObject({ buchtyp: 'sachbuch' });
  expect(calls.category).toBeNull();
});
