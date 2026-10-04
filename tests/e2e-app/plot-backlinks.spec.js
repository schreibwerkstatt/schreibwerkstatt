// Plot-Rückverweise („Im Plot") in der Detailansicht der Orte-Karte, gegen die
// ECHTE App.
//
// WARUM DIESE SCHICHT: der Smoke öffnet die Orte-Karte, klappt aber kein Detail
// auf — die Zeile entsteht erst im String-Include innerhalb des x-for. Geprüft wird
// die Kette Ort anlegen → Beat mit Ort im Board → Karte lädt GET /plot/links →
// Detail zeigt die Beat-Referenz → Klick springt per Beat-Permalink aufs Board.
// Figuren- und Szenen-Detail binden dasselbe Fragment + dieselben Methoden ein.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const ORT = 'Rückverweis-Bahnhof';
const BEAT = 'Ankunft am Rückverweis-Bahnhof';

async function postJson(page, url, body) {
  return page.evaluate(async ({ u, b }) => {
    const res = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    return res.json();
  }, { u: url, b: body });
}

test('Orte-Detail: „Im Plot" listet den verknüpften Beat und springt aufs Board', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  const ort = await postJson(page, `/locations/${bookId}`, { name: ORT });
  expect(ort.id).toBeTruthy();
  const act = await postJson(page, '/plot/acts', { book_id: bookId, name: 'Rückverweis-Akt' });
  const beat = await postJson(page, '/plot/beats', { book_id: bookId, act_id: act.id, titel: BEAT, location_ids: [ort.id] });
  expect(beat.id).toBeTruthy();

  // Die App-Suite teilt EINEN Seed-Stand: der Akt fällt am Ende wieder weg (seine
  // Beats per CASCADE), sonst schiebt er spätere Board-Specs (plot-dnd) aus dem Bild.
  try {
    await page.evaluate(async (id) => { await window.__app.openOrtById(id); }, ort.id);
    const row = page.locator('.card--orte .plot-backlinks');
    await expect(row).toBeVisible({ timeout: 15000 });
    const ref = row.locator('.entity-ref--beat', { hasText: BEAT });
    await expect(ref).toBeVisible();

    await ref.click();
    await expect(page).toHaveURL(new RegExp(`#book/${bookId}/plot/${beat.id}$`));
    await page.waitForFunction(() => window.__app.showPlotCard === true, null, { timeout: 15000 });
  } finally {
    await page.evaluate((id) => fetch(`/plot/acts/${id}`, { method: 'DELETE' }), act.id);
  }
});
