// Familiengraph gegen die ECHTE App (vis-network, volles CSS): Eltern stehen
// über ihren Kindern, egal aus welcher Perspektive die Beziehung erfasst ist,
// und viele kleine Familien liegen als Raster statt als lange Reihe.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp } = require('./_helpers/app');

const CARD = '.card--figuren';
const fig = (id, beziehungen = []) => ({
  id, name: id, typ: 'nebenfigur', kapitel: [], eigenschaften: [],
  beziehungen: beziehungen.map(([typ, figur_id]) => ({ typ, figur_id })),
});

// Acht Familien à drei Personen; Eltern-Kind abwechselnd aus Kind-Sicht
// (elternteil) und Eltern-Sicht (kind) erfasst, wie es die Analyse liefert.
const FAMILIES = Array.from({ length: 8 }, (_, i) => {
  const [v, m, k] = [`fg${i}v`, `fg${i}m`, `fg${i}k`];
  return i % 2
    ? [fig(v, [['ehepartner', m]]), fig(m), fig(k, [['elternteil', v], ['elternteil', m]])]
    : [fig(v, [['kind', k]]), fig(m, [['kind', k]]), fig(k)];
}).flat();

test('familiengraph: Eltern oben, Familien im Raster', async ({ page }) => {
  await bootApp(page);
  const bookId = await page.evaluate(() => window.Alpine.store('nav').books[0].id);
  const before = await page.evaluate(async ({ id, add }) => {
    const existing = (await (await fetch(`/figures/${id}`)).json())?.figuren || [];
    await fetch(`/figures/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figuren: [...existing, ...add] }),
    });
    return existing;
  }, { id: bookId, add: FAMILIES });

  try {
    await page.evaluate((id) => { location.hash = `#book/${id}/figuren/familie`; }, bookId);
    await expect(page.locator(`${CARD} #figuren-graph canvas`)).toBeVisible();
    const pos = await page.evaluate((sel) => {
      const c = window.Alpine.$data(document.querySelector(sel));
      return c._figurenNetwork?.getPositions();
    }, CARD);
    expect(pos).toBeTruthy();

    for (let i = 0; i < 8; i++) {
      expect(pos[`fg${i}v`].y).toBeLessThan(pos[`fg${i}k`].y);
      expect(pos[`fg${i}m`].y).toBe(pos[`fg${i}v`].y);
    }
    const pts = Object.entries(pos).filter(([id]) => id.startsWith('fg')).map(([, p]) => p);
    const w = Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x));
    const h = Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y));
    expect(w / h).toBeLessThan(5);
    if (process.env.FAMILIENGRAPH_SHOT) {
      await page.locator(`${CARD} #figuren-graph`).screenshot({ path: process.env.FAMILIENGRAPH_SHOT });
    }
  } finally {
    await page.evaluate(async ({ id, before }) => {
      await fetch(`/figures/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ figuren: before }),
      });
    }, { id: bookId, before });
  }
});
