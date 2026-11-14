const { test, expect } = require('./_helpers/fixtures');

// Verwandt-Tab der Referenz-Karte (Notebook-Editor-Begleitpanel), Semantik-Suche.
// Kern-Regression: Der Klick auf den Suchen-Button stiehlt den Fokus aus dem
// contenteditable und kollabiert die Live-Selection. Der Absatz-Modus muss
// darum den laufend via `selectionchange` gepufferten Text nutzen, nicht die
// Selection zum Klick-Zeitpunkt. Zusaetzlich: Basis-Wechsel setzt Ergebnisse
// zurueck, und der Suchstart leert alte Treffer (nur Ladeindikator bleibt).
const HARNESS_URL = '/tests/fixtures/reference-verwandt-harness.html';

async function setup(page, semanticRequests) {
  await page.route('**/research*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/search/semantic*', (route) => {
    const params = new URL(route.request().url()).searchParams;
    semanticRequests.push(Object.fromEntries(params.entries()));
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hits: [
        { entity_id: 42, kind: 'page', title: 'Treffer A', score: 0.9, snippet: '' },
        { entity_id: 43, kind: 'page', title: 'Treffer B', score: 0.8, snippet: '' },
      ] }),
    });
  });
  await page.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Alpine && window.harnessReady);
}

// Selektiert den Textinhalt eines Absatzes im contenteditable → feuert
// selectionchange (die Karte puffert den Text).
async function selectParagraph(page, id) {
  await page.evaluate((pid) => {
    const editor = document.querySelector('.page-content-view');
    editor.focus();  // ohne Fokus feuert kein blur beim Button-Klick
    const el = document.getElementById(pid);
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }, id);
}

test('Absatz-Modus: gepufferte Auswahl ueberlebt den Fokus-Steal des Buttons', async ({ page }) => {
  const reqs = [];
  await setup(page, reqs);

  // In den Absatz-Modus (setzt Ergebnisse der Auto-Seiten-Suche zurueck).
  await page.locator('[data-test="basis-absatz"]').click();

  // Auswahl im Editor treffen, dann Suchen klicken (Fokus geht auf den Button).
  await selectParagraph(page, 'para2');
  await page.locator('[data-test="search"]').click();

  // Treffer erscheinen → die Suche lief (kein "keine Auswahl").
  await expect(page.locator('[data-test="hit-42"]')).toBeVisible();
  await expect(page.locator('[data-test="error"]')).toHaveText('');

  // Der q-Param enthaelt den ausgewaehlten Absatztext, nicht die (verlorene)
  // Live-Selection zum Klick-Zeitpunkt.
  const absatzReq = reqs.find((r) => r.q);
  expect(absatzReq).toBeTruthy();
  expect(absatzReq.q).toContain('zweiter Absatz');
  expect(absatzReq.q).toContain('Bergen im Norden');
});

test('Absatz-Modus ohne Auswahl: klare Fehlermeldung statt stiller Fehlschlag', async ({ page }) => {
  const reqs = [];
  await setup(page, reqs);

  await page.locator('[data-test="basis-absatz"]').click();
  // Auswahl bewusst ausserhalb des Editors kollabieren.
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.locator('[data-test="search"]').click();

  await expect(page.locator('[data-test="error"]')).toHaveText('reference.verwandt.noSelection');
  expect(reqs.some((r) => r.q)).toBe(false);
});

test('Basis-Wechsel setzt Ergebnisse zurueck', async ({ page }) => {
  const reqs = [];
  await setup(page, reqs);

  // Auto-Suche im Seiten-Modus liefert Treffer.
  await expect(page.locator('[data-test="hit-42"]')).toBeVisible();

  // Wechsel auf Absatz leert die Seiten-Treffer sofort (keine Live-Suche).
  await page.locator('[data-test="basis-absatz"]').click();
  await expect(page.locator('[data-test="count"]')).toHaveText('0');
  await expect(page.locator('[data-test="hit-42"]')).toHaveCount(0);
});
