// Figurenkarte gegen die ECHTE App (playwright.app.config.js): Ich-Erzählstimme und
// weitere Rufnamen (figures.ist_erzaehler / weitere_namen, Migration 361).
//
// Testgegenstand: der Steckbrief zeigt beides, und die Markierung lässt sich im
// Bearbeiten-Formular per Checkbox zurücknehmen (PATCH, db/figures/patch.js) — der
// einzige Weg für den Autor, eine falsche Analyse-Markierung zu korrigieren.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const CARD = '.card--figuren';
const RUN = String(Date.now()).slice(-6);
const NAME = `Erzähl-Lilli ${RUN}`;
const FIG_ID = `fig_erz_${RUN}`;

let restore = null;
test.afterEach(async ({ page }) => {
  if (!restore) return;
  const { bookId, before } = restore;
  restore = null;
  await page.evaluate(async ({ id, before }) => {
    await fetch(`/figures/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ figuren: before }),
    });
  }, { id: bookId, before });
});

test('figurenkarte: Ich-Erzählstimme im Steckbrief, per Checkbox korrigierbar', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  // Rufnamen schreibt nur die Analyse — im Test über den Analyse-Speicherweg im Browser
  // nicht erreichbar; die Markierung setzt der PATCH wie in der Karte.
  const before = await page.evaluate(async ({ bookId, name, figId }) => {
    const cur = (await (await fetch(`/figures/${bookId}`)).json())?.figuren || [];
    const f = { id: figId, name, typ: 'hauptfigur', beziehungen: [], kapitel: [], eigenschaften: [] };
    await fetch(`/figures/${bookId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ figuren: [...cur, f] }),
    });
    const r = await fetch(`/figures/${bookId}/${figId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { ist_erzaehler: true } }),
    });
    if (!r.ok) throw new Error(`PATCH fehlgeschlagen: ${r.status}`);
    return cur;
  }, { bookId, name: NAME, figId: FIG_ID });
  restore = { bookId, before };

  await page.evaluate(() => window.__app.toggleFiguresCard());
  const card = page.locator(CARD);
  await expect(card).toBeVisible();
  await page.evaluate((id) => window.__app.loadFiguren(id), bookId);
  const row = card.locator(`[data-figid="${FIG_ID}"]`);
  await row.locator('.row-expand').click();
  await expect(row.locator('.row-expand')).toHaveAttribute('aria-expanded', 'true');

  const detail = card.locator('.figur-group').filter({ hasText: 'Ich-Erzählstimme' }).first();
  await expect(detail).toContainText('erzählt in der Ich-Form');

  await card.getByRole('button', { name: 'Steckbrief bearbeiten' }).first().click();
  const box = card.locator(`#figur-edit-${FIG_ID}-ist_erzaehler`);
  await expect(box).toBeChecked();
  await box.uncheck();
  await card.locator('.figur-edit .primary').click();

  await expect.poll(() => page.evaluate(async ({ bookId, figId }) =>
    (await (await fetch(`/figures/${bookId}`)).json()).figuren.find(f => f.id === figId)?.ist_erzaehler,
  { bookId, figId: FIG_ID })).toBe(false);
});
