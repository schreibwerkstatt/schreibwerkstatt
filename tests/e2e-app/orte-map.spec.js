// Schauplatz-Karte, Ansicht «Geografische Karte» (Leaflet) gegen die ECHTE App —
// docs/geocode.md. Hängt an der Pixel-Geometrie der gebooteten Karte (Einpassen,
// Pin-Raster, iconAnchor), darum nicht im Fixture-Harness.
//
// Abgesichert:
//   * Buch ohne verorteten Ort startet auf dem Schauplatz-Land, nicht der Welt.
//   * Rote Pins (ohne Koordinaten) bleiben nach einem Neu-Einpassen im Bild.
//   * Erbende Unterort-Pins halten ihren Pixel-Versatz beim Zoomen.
//   * Klick auf einen Ortsnamen öffnet dessen Popup.
//   * «Georeferenz löschen» ist rückgängig machbar (Serverstand).
//   * Manuelles Platzieren: «Platzieren» + Karten-Klick setzt den Ort, Esc bricht
//     ab, Mausrad-Zoom danach hält den Pin an seiner Bildschirmstelle, Cmd/Ctrl+Z
//     macht rückgängig, die Ortssuche verschiebt den Ausschnitt.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const CARD = '.card--orte';
const RUN = 'map' + String(Date.now()).slice(-6);
// 1×1 transparentes PNG — Tiles kommen nicht aus dem Netz.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const mapScope = (page, fn, arg) => page.evaluate(({ src, arg }) => {
  const s = window.Alpine.$data(document.querySelector('.card--orte .ort-map'));
  // eslint-disable-next-line no-new-func
  return new Function('s', 'arg', `return (${src})(s, arg);`)(s, arg);
}, { src: fn.toString(), arg });

function inside(box, outer) {
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  return cx >= outer.x && cx <= outer.x + outer.width && cy >= outer.y && cy <= outer.y + outer.height;
}

test('geo-karte: Startansicht Land, rote Pins im Bild, erbende Pins zoomfest, Popup, Löschen rückgängig', async ({ page }) => {
  await page.route(/tile\.openstreetmap\.org|\/tiles?\//, r => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  const ids = await page.evaluate(async ({ bookId, RUN }) => {
    await fetch(`/booksettings/${bookId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orte_real: true, schauplatz_land: 'ch' }),
    });
    const post = async (body) => (await (await fetch(`/locations/${bookId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json()).id;
    const stadt = await post({ name: `Stadt ${RUN}` });
    const fiktiv = await post({ name: `Fiktiv ${RUN}` });
    const zimmer = await post({ name: `Zimmer ${RUN}`, parent: stadt });
    return { stadt, fiktiv, zimmer };
  }, { bookId, RUN });

  await page.evaluate((RUN) => {
    window.Alpine.store('catalogUi').orteFilters.suche = RUN;
    window.__app.toggleOrteCard();
  }, RUN);
  const card = page.locator(CARD);
  await expect(card).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    window.Alpine.$data(document.querySelector('.card--orte')).orteRealEnabled)).toBe(true);
  await page.evaluate(() => { window.Alpine.$data(document.querySelector('.card--orte')).viewMode = 'map'; });
  const mapEl = card.locator('.ort-map');
  await expect(mapEl).toBeVisible();
  await expect(card.locator('.ort-marker-pin--unlocated')).toHaveCount(3);

  // 1) Kein Ort verortet → Startansicht Schweiz (countryView 'ch'), nicht Weltansicht.
  const start = await mapScope(page, (s) => ({ c: s._map.getCenter(), z: s._map.getZoom() }));
  expect(start.z).toBe(7);
  expect(Math.abs(start.c.lat - 46.8)).toBeLessThan(0.5);
  expect(Math.abs(start.c.lng - 8.2)).toBeLessThan(0.5);

  // 2) Stadt weit weg verorten (wie ein KI-Treffer) und neu einpassen: der rote
  //    Pin von «Fiktiv» muss danach im Kartenbild liegen, nicht beim alten Ausschnitt.
  await mapScope(page, async (s, id) => {
    await s._patchCoordsOptimistic([{ id, lat: 35.68, lng: 139.7 }]);
    await s._rerenderMarkers(true);
  }, ids.stadt);
  await expect(card.locator('.ort-marker-pin--unlocated')).toHaveCount(1);
  const mapBox = await mapEl.boundingBox();
  const redBox = await card.locator('.ort-marker-pin--unlocated').boundingBox();
  expect(inside(redBox, mapBox)).toBe(true);

  // 3) Zimmer erbt die Position der Stadt: gestrichelter Pin mit festem
  //    Pixel-Versatz — auch nach dem Herauszoomen (ohne Neuzeichnen).
  const inherited = card.locator('.ort-marker-pin--inherited');
  await expect(inherited).toHaveCount(1);
  const offsetPx = async () => mapScope(page, (s, id) => {
    const p = s._map.latLngToContainerPoint(s._markerById[id].getLatLng());
    const r = document.querySelector('.ort-marker-pin--inherited').getBoundingClientRect();
    const m = s._map.getContainer().getBoundingClientRect();
    return Math.hypot(r.left + r.width / 2 - m.left - p.x, r.top + r.height / 2 - m.top - p.y);
  }, ids.zimmer);
  const before = await offsetPx();
  expect(before).toBeGreaterThan(15);
  await mapScope(page, (s) => s._map.setZoom(3));
  expect(Math.abs((await offsetPx()) - before)).toBeLessThan(2);

  // 4) Klick auf den Namen öffnet das Popup des Pins.
  await card.locator('.ort-map-locate-row', { hasText: `Fiktiv ${RUN}` }).locator('.ort-map-locate-name').click();
  await expect(card.locator('.leaflet-popup .ort-popup__name')).toHaveText(`Fiktiv ${RUN}`);

  // 5) Georeferenz löschen → Rückgängig stellt den Serverstand wieder her.
  const serverCoords = () => page.evaluate(async ({ bookId, id }) => {
    const o = (await (await fetch(`/locations/${bookId}`)).json()).orte.find(x => x.id === id);
    return o.lat == null ? null : [o.lat, o.lng];
  }, { bookId, id: ids.stadt });
  await card.locator('.ort-map-locate-row', { hasText: `Stadt ${RUN}` }).getByRole('button', { name: /Georeferenz löschen|Clear geo-reference/ }).click();
  await expect.poll(serverCoords).toBeNull();
  await card.locator('.ort-map-actions').getByRole('button', { name: /^(Rückgängig|Undo)$/ }).click();
  await expect.poll(serverCoords).toEqual([35.68, 139.7]);

  await page.evaluate(async ({ bookId, ids }) => {
    for (const id of Object.values(ids)) await fetch(`/locations/${bookId}/${id}`, { method: 'DELETE' });
    await fetch(`/booksettings/${bookId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orte_real: false, schauplatz_land: null }),
    });
  }, { bookId, ids });
});

test('geo-karte: platzieren per Klick, Zoom-Anker, Ctrl+Z, Ortssuche', async ({ page }) => {
  await page.route(/tile\.openstreetmap\.org|\/tiles?\//, r => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.route(/\/geocode\?/, r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ candidates: [{ lat: 46.948, lng: 7.4446, displayName: 'Bundesplatz, Bern' }, { lat: 47.37, lng: 8.54, displayName: 'Bern, Zürich' }] }),
  }));
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const id = await page.evaluate(async ({ bookId, RUN }) => {
    await fetch(`/booksettings/${bookId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orte_real: true, schauplatz_land: 'ch' }),
    });
    return (await (await fetch(`/locations/${bookId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `Platz ${RUN}` }),
    })).json()).id;
  }, { bookId, RUN });
  await page.evaluate((RUN) => {
    window.Alpine.store('catalogUi').orteFilters.suche = RUN;
    window.__app.toggleOrteCard();
  }, RUN);
  const card = page.locator(CARD);
  await expect(card).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    window.Alpine.$data(document.querySelector('.card--orte')).orteRealEnabled)).toBe(true);
  await page.evaluate(() => { window.Alpine.$data(document.querySelector('.card--orte')).viewMode = 'map'; });
  const mapEl = card.locator('.ort-map');
  await expect(mapEl).toBeVisible();
  await expect(card.locator('.ort-marker-pin--unlocated')).toHaveCount(1);

  const serverCoords = () => page.evaluate(async ({ bookId, id }) => {
    const o = (await (await fetch(`/locations/${bookId}`)).json()).orte.find(x => x.id === id);
    return o.lat == null ? null : [o.lat, o.lng];
  }, { bookId, id });
  const row = card.locator('.ort-map-locate-row', { hasText: `Platz ${RUN}` });
  const placeBtn = row.getByRole('button', { name: /^(Platzieren|Place)$/ });

  // 1) Ortssuche: erster Treffer zentriert die Karte, Alternativen stehen als Knöpfe da.
  await card.locator('.ort-map-search-input').fill('Bundesplatz');
  await card.locator('.ort-map-search-input').press('Enter');
  await expect(card.locator('.ort-map-search-results .btn-compact')).toHaveCount(2);
  const c = await mapScope(page, (s) => ({ c: s._map.getCenter(), z: s._map.getZoom() }));
  expect(Math.abs(c.c.lat - 46.948)).toBeLessThan(0.01);
  expect(c.z).toBe(16);

  // 2) Platzieren, dann Esc → Modus aus, nichts gespeichert.
  await placeBtn.click();
  await expect(card.locator('.ort-map-placing-bar')).toBeVisible();
  await expect(mapEl).toHaveClass(/ort-map--placing/);
  await page.keyboard.press('Escape');
  await expect(card.locator('.ort-map-placing-bar')).toBeHidden();
  await expect(card).toBeVisible();

  // 3) Platzieren + Klick in die Karte → Ort sitzt an der Klickstelle (Server).
  await placeBtn.click();
  const box = await mapEl.boundingBox();
  const at = { x: box.width * 0.3, y: box.height * 0.4 };
  const expected = await mapScope(page, (s, p) => s._map.containerPointToLatLng([p.x, p.y]), at);
  await mapEl.click({ position: at });
  await expect(card.locator('.ort-map-placing-bar')).toBeHidden();
  await expect.poll(serverCoords).not.toBeNull();
  const got = await serverCoords();
  expect(Math.abs(got[0] - expected.lat)).toBeLessThan(5e-5); // ~3 px bei Zoom 16
  expect(Math.abs(got[1] - expected.lng)).toBeLessThan(5e-5);

  // 4) Mausrad-Zoom woanders → der platzierte Pin bleibt an seiner Bildschirmstelle.
  const pinPx = () => mapScope(page, (s, id) => s._map.latLngToContainerPoint(s._markerById[id].getLatLng()), id);
  const p0 = await pinPx();
  const z0 = await mapScope(page, (s) => s._map.getZoom());
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.8);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => mapScope(page, (s) => s._map.getZoom())).toBeLessThan(z0);
  const p1 = await pinPx();
  expect(Math.hypot(p1.x - p0.x, p1.y - p0.y)).toBeLessThan(2);

  // 5) Ctrl+Z im Kartenbereich → wieder unverortet.
  await card.locator('.ort-map-actions').getByRole('button', { name: /^(Rückgängig|Undo)$/ }).focus();
  await page.keyboard.press('Control+z');
  await expect.poll(serverCoords).toBeNull();
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(serverCoords).not.toBeNull();

  await page.evaluate(async ({ bookId, id }) => {
    await fetch(`/locations/${bookId}/${id}`, { method: 'DELETE' });
    await fetch(`/booksettings/${bookId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orte_real: false, schauplatz_land: null }),
    });
  }, { bookId, id });
});
