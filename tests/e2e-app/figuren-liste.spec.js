// Reiter «Liste» der Figuren-Karte gegen die ECHTE App (playwright.app.config.js).
//
// Testgegenstand ist das Zusammenspiel von Reitern, Liste und Graph im echten
// Template: die Liste ist der Einstiegsreiter und steht NUR dort (unter Graph,
// Präsenz, Alter, Lebenslauf nicht), die Suche trifft mehr als den Namen, und
// ein Klick auf einen Graph-Knoten springt auf den Listen-Reiter und klappt die
// Figur dort sichtbar auf.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const CARD = '.card--figuren';
const RUN = String(Date.now()).slice(-6);
const A_NAME = `Liste-Anna ${RUN}`;
const B_NAME = `Liste-Bert ${RUN}`;

// Bestand des geteilten Wegwerf-Buchs nach JEDEM Lauf zurueckschreiben.
let restore = null;
test.afterEach(async ({ page }) => {
  if (!restore) return;
  const { bookId, before } = restore;
  restore = null;
  await page.evaluate(async ({ id, before }) => {
    await fetch(`/figures/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figuren: before }),
    });
  }, { id: bookId, before });
});

async function seedFiguren(page, bookId) {
  return page.evaluate(async ({ bookId, aName, bName, run }) => {
    const cur = await (await fetch(`/figures/${bookId}`)).json();
    const existing = cur?.figuren || [];
    const a = { id: `fig_liste_a_${run}`, name: aName, typ: 'hauptfigur', beruf: `Hebamme${run}`, beziehungen: [], kapitel: [], eigenschaften: [] };
    const b = { id: `fig_liste_b_${run}`, name: bName, typ: 'randfigur', beziehungen: [], kapitel: [], eigenschaften: [] };
    const r = await fetch(`/figures/${bookId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figuren: [...existing, a, b] }),
    });
    if (!r.ok) throw new Error(`PUT /figures fehlgeschlagen: ${r.status}`);
    return { before: existing };
  }, { bookId, aName: A_NAME, bName: B_NAME, run: RUN });
}

const cardData = (page, expr) => page.evaluate(
  (expr) => new Function('c', `return ${expr}`)(window.Alpine.$data(document.querySelector('.card--figuren'))), expr);

test('figurenliste: Einstiegsreiter, nur dort sichtbar, breite Suche, Graph-Klick springt zurück', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const seeded = await seedFiguren(page, bookId);
  restore = { bookId, before: seeded.before };

  await page.evaluate(() => window.__app.toggleFiguresCard());
  const card = page.locator(CARD);
  await expect(card).toBeVisible();
  const list = card.locator('.figur-list-section');

  // Einstieg: Reiter «Liste» aktiv, Liste sichtbar, kein Graph-Canvas.
  await expect(card.locator('.tabs-btn--active')).toHaveText('Liste');
  await expect(list).toBeVisible();
  await expect(card.locator('.figuren-graph-wrap')).toBeHidden();

  // Breite Suche: der Beruf allein findet die Figur.
  await list.locator('.filter-search-input').fill(`hebamme${RUN}`);
  await expect(list.locator('.figur-item')).toHaveCount(1);
  await expect(list.locator('.figur-item .figur-name')).toHaveText(A_NAME);
  await list.locator('.filter-search-input').fill('');

  // Andere Reiter: keine Liste darunter.
  for (const tab of ['Figurengraph', 'Präsenz', 'Alter']) {
    await card.locator('.tabs-btn', { hasText: tab }).click();
    await expect(list).toBeHidden();
  }

  // Graph-Knoten-Klick: zurück auf «Liste», Figur aufgeklappt und sichtbar.
  await card.locator('.tabs-btn', { hasText: 'Figurengraph' }).click();
  await page.waitForFunction(
    () => !!window.Alpine.$data(document.querySelector('.card--figuren'))._figurenNetwork,
    null, { timeout: 15000 },
  );
  const bId = await page.evaluate((name) =>
    window.Alpine.store('catalog').figuren.find(f => f.name === name)?.id, B_NAME);
  expect(bId).toBeTruthy();
  await page.evaluate((id) => {
    const c = window.Alpine.$data(document.querySelector('.card--figuren'));
    c._figurenNetwork.body.emitter.emit('click', { nodes: [id], edges: [], pointer: { canvas: { x: 0, y: 9999 } } });
  }, bId);

  await expect.poll(() => cardData(page, 'c.figurenGraphModus')).toBe('liste');
  await expect(list).toBeVisible();
  const row = list.locator(`.figur-item[data-figid="${bId}"]`);
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect(row).toBeInViewport();
});
