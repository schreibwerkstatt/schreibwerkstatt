// Soziogramm gegen die ECHTE App (vis-network, volles CSS, echte Toolbar):
// «ohne Angabe» als eigenes Band unter den Schichten, Nähe als waagrechter
// Abstand, Schalter + Nähe-Knopf in der Toolbar, Nähe im Figuren-Detail.
// Die Layout-Rechnung selbst ist in tests/unit/soziogramm-layout.test.mjs
// getestet; hier geht es um das Zusammenspiel mit Karte, Partial und Katalog-PUT.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp } = require('./_helpers/app');

const CARD = '.card--figuren';
const fig = (id, sozialschicht, beziehungen = []) => ({
  id, name: id, typ: 'nebenfigur', sozialschicht, kapitel: [], eigenschaften: [], beziehungen,
});
const FIGUREN = [
  fig('sz_a1', 'mittelschicht', [{ figur_id: 'sz_a2', typ: 'freund', naehe: 2, beschreibung: 'Innig.' }]),
  fig('sz_a2', 'mittelschicht'),
  fig('sz_b1', 'mittelschicht', [{ figur_id: 'sz_b2', typ: 'freund', naehe: -2 }]),
  fig('sz_b2', 'mittelschicht'),
  fig('sz_c1', 'arbeiterschicht', [{ figur_id: 'sz_c2', typ: 'kollege' }]),
  fig('sz_c2', null),
];

test('soziogramm: eigenes Band ohne Schicht, Nähe als Abstand, Toolbar', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await bootApp(page);
  const bookId = await page.evaluate(() => window.Alpine.store('nav').books[0].id);
  const before = await page.evaluate(async ({ id, add }) => {
    const existing = (await (await fetch(`/figures/${id}`)).json())?.figuren || [];
    await fetch(`/figures/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figuren: [...existing, ...add] }),
    });
    return existing;
  }, { id: bookId, add: FIGUREN });

  try {
    await page.evaluate((id) => { location.hash = `#book/${id}/figuren/soziogramm`; }, bookId);
    await expect(page.locator(`${CARD} #figuren-graph canvas`)).toBeVisible();
    const pos = await page.evaluate((sel) => window.Alpine.$data(document.querySelector(sel))._figurenNetwork?.getPositions(), CARD);
    expect(pos).toBeTruthy();

    // «ohne Angabe» unter der untersten echten Schicht, nicht auf Höhe der Mittelschicht.
    expect(pos.sz_c2.y).toBeGreaterThan(pos.sz_c1.y);
    expect(pos.sz_c2.y).toBeGreaterThan(pos.sz_a1.y);
    // Innig liegt enger als feindselig.
    expect(Math.abs(pos.sz_a1.x - pos.sz_a2.x)).toBeLessThan(Math.abs(pos.sz_b1.x - pos.sz_b2.x));

    // Toolbar: Schalter + Nähe-Knopf mit Zahl der offenen Beziehungen (nur sz_c1→sz_c2,
    // sofern das Testbuch sonst keine offenen hat — darum nur auf «offen» prüfen).
    const sozio = page.locator(`${CARD} .figuren-graph-sozio`);
    await expect(sozio).toBeVisible();
    await expect(sozio.locator('.toggle-switch')).toHaveCount(2);
    await expect(sozio.locator('button.btn-compact')).toContainText(/offen|open/);

    // Begegnungen einschalten: lädt den Szenen-Katalog, zeichnet neu, kein Fehler.
    await sozio.locator('.toggle-switch__btn').nth(1).click();
    await expect.poll(() => page.evaluate((sel) => window.Alpine.$data(document.querySelector(sel)).soziogrammBegegnungen, CARD)).toBe(true);
    await expect(page.locator(`${CARD} #figuren-graph canvas`)).toBeVisible();

    // Nähe im Figuren-Detail neben der Beziehung.
    await page.evaluate((id) => window.__app.openFigurById(id), 'sz_a1');
    await expect(page.locator(`${CARD} .figur-bz-naehe.figur-bz-naehe--nah`).first()).toHaveText(/innig|intimate/);

    expect(errors).toEqual([]);
  } finally {
    await page.evaluate(async ({ id, before }) => {
      await fetch(`/figures/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ figuren: before }),
      });
    }, { id: bookId, before });
  }
});
