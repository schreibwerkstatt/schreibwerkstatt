// Berufsweg und Hobbys (docs/figur-lebenslauf.md «Berufsweg und Hobbys») gegen die
// ECHTE App (playwright.app.config.js): Steckbrief-Fragment mit verschachteltem
// `@include` (Formular zweimal eingebunden), Anlegen über das Formular gegen die
// echte Route, Anzeige mit Zeitraum, Löschen über appConfirm — und die Station
// als Eintrag mit eigenem Badge in der Lebenslauf-Matrix.
//
// Die Vorschlags-Mechanik (Job, Übernehmen/Verwerfen) prüft die Integration
// (tests/integration/stationen-*.test.js); hier geht es um den Template-Baum.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const CARD = '.card--figuren';
const RUN = String(Date.now()).slice(-6);
const NAME = `Station-Sina ${RUN}`;

let restore = null;
test.afterEach(async ({ page }) => {
  if (!restore) return;
  const { bookId, before } = restore;
  restore = null;
  // Figur weg → ihre Stationen per CASCADE mit.
  await page.evaluate(async ({ id, before }) => {
    await fetch(`/figures/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figuren: before }),
    });
  }, { id: bookId, before });
});

test('steckbrief: Berufsstation anlegen, im Lebenslauf sehen, löschen', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const seeded = await page.evaluate(async ({ bookId, name }) => {
    const cur = await (await fetch(`/figures/${bookId}`)).json();
    const existing = cur?.figuren || [];
    const f = { id: `fig_station_${Date.now()}`, name, typ: 'hauptfigur', geburtstag: '1980', beziehungen: [], kapitel: [], eigenschaften: [] };
    const r = await fetch(`/figures/${bookId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figuren: [...existing, f] }),
    });
    if (!r.ok) throw new Error(`PUT /figures fehlgeschlagen: ${r.status}`);
    return { id: f.id, before: existing };
  }, { bookId, name: NAME });
  restore = { bookId, before: seeded.before };

  await page.evaluate(() => window.__app.toggleFiguresCard());
  const card = page.locator(CARD);
  await expect(card).toBeVisible();
  const list = card.locator('.figur-list-section');
  await list.locator('.filter-search-input').fill(NAME);
  await list.locator('.figur-item', { hasText: NAME }).click();

  const beruf = card.locator('.figur-stationen').filter({ has: page.locator('.figur-group-title', { hasText: 'Berufsweg' }) });
  await expect(beruf).toBeVisible();
  await expect(beruf.locator('.muted-msg')).toHaveText('Noch keine Ausbildung oder Berufsstation erfasst.');
  await expect(card.locator('.figur-stationen', { hasText: 'Hobbys' })).toBeVisible();

  // Anlegen: Pflichtfeld leer → Fehler am Formular, kein Request.
  await beruf.getByRole('button', { name: 'Station hinzufügen' }).click();
  const form = beruf.locator('.figur-station-form');
  await expect(form).toHaveCount(1);
  await form.locator('button.primary').click();
  await expect(beruf.locator('.card-form-error')).toHaveText('Bitte eine Tätigkeit angeben.');

  await form.locator('input[type="text"]').first().fill('Schreinerin');
  const nums = form.locator('input.form-num');
  await nums.nth(0).fill('1996');
  await nums.nth(0).blur();
  await nums.nth(2).fill('2004');
  await nums.nth(2).blur();
  await form.locator('button.primary').click();
  await expect(form).toHaveCount(0);
  const row = beruf.locator('.figur-station');
  await expect(row.locator('.figur-station-titel')).toHaveText('Schreinerin');
  await expect(row.locator('.figur-station-meta')).toHaveText('1996–2004');

  // Lebenslauf: Beginn (16 J.) und Ende (24 J.) als Einträge mit Stations-Badge.
  await card.locator('.tabs-btn', { hasText: 'Lebenslauf' }).click();
  const chip = card.locator('.figur-cv-chip', { hasText: NAME });
  await expect(chip).toBeVisible();
  // Die Vorbelegung (figurenLebenslaufEnsureAuswahl) läuft erst nach dem Laden der
  // Alters-Daten und wählt mindestens eine Kandidatin — ist diese Figur die einzige,
  // genau sie. Erst danach den Zustand lesen, sonst wählt der Klick sie wieder ab.
  await expect(card.locator('.figur-cv-chip[aria-pressed="true"]').first()).toBeVisible();
  if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  const table = card.locator('.figur-cv-table');
  const badges = table.locator('.figur-cv-station--berufe');
  await expect(badges).toHaveText(['Beruf: Beginn', 'Beruf: Ende']);
  await expect(table.locator('.figur-cv-event', { has: page.locator('.figur-cv-station--berufe') }).first())
    .toContainText('Schreinerin');

  // Zurück in die Liste (die Figur bleibt aufgeklappt), löschen über die App-Rückfrage.
  await card.locator('.tabs-btn', { hasText: 'Liste' }).click();
  await expect(beruf.locator('.figur-station-titel')).toHaveText('Schreinerin');
  await beruf.locator('.figur-station').getByRole('button', { name: 'Löschen' }).click();
  await page.locator('#app-confirm-dialog .confirm-dialog-btn--danger').click();
  await expect(beruf.locator('.figur-station')).toHaveCount(0);
});
