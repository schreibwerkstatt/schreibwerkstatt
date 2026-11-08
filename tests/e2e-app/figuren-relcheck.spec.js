// Beziehungsprüfung in der Figuren-Karte gegen die ECHTE App
// (playwright.app.config.js, book/figuren-relcheck.js).
//
// Testgegenstand ist der echte Template-Baum: das Fragment figuren-relcheck.html
// mit der geteilten Konfliktliste (verschachteltes x-data mit Getter auf den
// Karten-State) und die Markierung der Kante im Figuren-Detail. Zwei Väter mit
// kopierter Beschreibung müssen als Hinweis erscheinen; nach dem Löschen der
// falschen Kante (Katalog-PUT) lädt die Karte die Prüfung selbst neu.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const CARD = '.card--figuren';
const RUN = String(Date.now()).slice(-6);
const KIND = `RC-Stefan ${RUN}`;
const VATER = `RC-Peter ${RUN}`;
const BRUDER = `RC-Adrian ${RUN}`;
const DESC = `Ein distanzierter Vater ${RUN}, der ihm bei der Stellensuche hilft.`;

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

const ids = { kind: `fig_rc_k_${RUN}`, vater: `fig_rc_v_${RUN}`, bruder: `fig_rc_b_${RUN}` };

async function putFiguren(page, bookId, figuren) {
  await page.evaluate(async ({ bookId, figuren }) => {
    const r = await fetch(`/figures/${bookId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figuren }),
    });
    if (!r.ok) throw new Error(`PUT /figures fehlgeschlagen: ${r.status}`);
  }, { bookId, figuren });
}

const seeded = (withWrongEdge) => [
  { id: ids.kind, name: KIND, typ: 'hauptfigur', geschlecht: 'männlich', kapitel: [], eigenschaften: [],
    beziehungen: [
      { figur_id: ids.vater, typ: 'elternteil', beschreibung: DESC },
      ...(withWrongEdge ? [{ figur_id: ids.bruder, typ: 'elternteil', beschreibung: DESC }] : []),
    ] },
  { id: ids.vater, name: VATER, typ: 'nebenfigur', geschlecht: 'männlich', beziehungen: [], kapitel: [], eigenschaften: [] },
  { id: ids.bruder, name: BRUDER, typ: 'nebenfigur', geschlecht: 'männlich', beziehungen: [], kapitel: [], eigenschaften: [] },
];

test('figuren-relcheck: zwei Väter → Hinweis, Liste, markierte Kante; nach Korrektur weg', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const before = await page.evaluate(async (id) => (await (await fetch(`/figures/${id}`)).json())?.figuren || [], bookId);
  restore = { bookId, before };
  await putFiguren(page, bookId, [...before, ...seeded(true)]);

  await page.evaluate(() => window.__app.toggleFiguresCard());
  const card = page.locator(CARD);
  await expect(card).toBeVisible();
  const relcheck = card.locator('.figuren-relcheck');
  await expect(relcheck).toBeVisible();

  // Aufklappen: die geteilte Liste nennt die Regel und die drei Figuren.
  await relcheck.locator('.collapsible-toggle').click();
  const item = relcheck.locator('.relcheck-item', { hasText: 'Mehr als ein Vater oder eine Mutter' })
    .filter({ has: page.locator('.entity-ref', { hasText: BRUDER }) });
  await expect(item).toBeVisible();
  await expect(item.locator('.entity-ref', { hasText: KIND })).toBeVisible();

  // Figuren-Detail: die Kante zum Bruder trägt die Regel als Badge.
  const list = card.locator('.figur-list-section');
  await list.locator('.filter-search-input').fill(KIND);
  await list.locator('[data-figid]', { hasText: KIND }).click();
  const edge = card.locator('.figur-beziehung-item').filter({ has: page.locator('.entity-ref', { hasText: BRUDER }) });
  await expect(edge.locator('.tok-badge', { hasText: 'Mehr als ein Vater oder eine Mutter' })).toBeVisible();

  // Korrektur: falsche Kante weg → Katalog lädt neu, die Prüfung mit.
  const now = await page.evaluate(async (id) => (await (await fetch(`/figures/${id}`)).json()).figuren, bookId);
  const kind = now.find(f => f.id === ids.kind);
  kind.beziehungen = kind.beziehungen.filter(b => b.figur_id !== ids.bruder);
  await putFiguren(page, bookId, now);
  await page.evaluate((id) => window.__app.loadFiguren(id), bookId);
  await expect(relcheck.locator('.relcheck-item').filter({ has: page.locator('.entity-ref', { hasText: BRUDER }) })).toHaveCount(0);
});

test('figuren-relcheck: verrutschte Kante umhängen, gemeldete Kante entfernen (Knöpfe an der Kante)', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const before = await page.evaluate(async (id) => (await (await fetch(`/figures/${id}`)).json())?.figuren || [], bookId);
  restore = { bookId, before };
  // Prod-Fall «Er kennt Sarahs Mutter …» auf der Kante zu Peter: der Text nennt den
  // Bruder, zu dem das Kind keine Kante hat (foreignTarget) → Umhängen-Knopf.
  const figs = seeded(false);
  figs[0].beziehungen = [{ figur_id: ids.vater, typ: 'bekannt', beschreibung: `Er kennt ${BRUDER} aus dem Wahlbüro.` }];
  await putFiguren(page, bookId, [...before, ...figs]);

  await page.evaluate(() => window.__app.toggleFiguresCard());
  const card = page.locator(CARD);
  await expect(card).toBeVisible();
  const list = card.locator('.figur-list-section');
  await list.locator('.filter-search-input').fill(KIND);
  await list.locator('[data-figid]', { hasText: KIND }).click();

  const edgeTo = (name) => card.locator('.figur-beziehung-item').filter({ has: page.locator('.entity-ref', { hasText: name }) });
  const retarget = edgeTo(VATER).locator('.figur-bz-actions button', { hasText: BRUDER });
  await expect(retarget).toBeVisible();
  await retarget.click();
  await expect(edgeTo(BRUDER)).toHaveCount(1);
  await expect(edgeTo(VATER)).toHaveCount(0);
  const after = await page.evaluate(async (id) => (await (await fetch(`/figures/${id}`)).json()).figuren, bookId);
  expect(after.find(f => f.id === ids.kind).beziehungen.map(b => b.figur_id)).toEqual([ids.bruder]);

  // Zwei Väter: «Entfernen» an der falschen Kante, mit Rückfrage.
  await putFiguren(page, bookId, [...before, ...seeded(true)]);
  await page.evaluate((id) => window.__app.loadFiguren(id), bookId);
  await card.locator('.figuren-relcheck').waitFor();
  const remove = edgeTo(BRUDER).locator('.figur-bz-actions button', { hasText: 'Entfernen' });
  await expect(remove).toBeVisible();
  await remove.click();
  await page.locator('#app-confirm-dialog .confirm-dialog-btn--danger').click();
  await expect(edgeTo(BRUDER)).toHaveCount(0);
  await expect(edgeTo(VATER)).toHaveCount(1);
});
