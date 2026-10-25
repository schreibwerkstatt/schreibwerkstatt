// Verknuepfungs-Picker der IDEEN-KARTE (neben dem Editor) gegen die echte App.
//
// Das Gegenstueck fuer das Ideen-Board steht in ideen-board.spec.js; beide
// Oberflaechen teilen sich das Fragment partials/ideen-link-picker.html und die
// Verankerung aus public/js/popover-anchor.js — deshalb muss jede fuer sich
// belegen, dass das Popover dort aufgeht, wo geklickt wurde.
//
// Warum e2e-app und kein Harness: die Aussage ist Geometrie im echten Shell-CSS.
// Hier haengt das Popover ausserdem an einem Menue-Eintrag, der selbst schon nach
// <body> teleportiert ist und im selben Klick geschlossen wird — ob das Rect
// davor noch gelesen wird, sieht man nur an der laufenden App.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

// Die Pendenz wird wieder abgeraeumt: die Ideen-Karte zeigt SEITEN-Ideen, und
// spaetere Specs arbeiten auf derselben Seite des Seed-Buchs.
let createdIdeeId = null;

test.afterAll(async ({ browser }) => {
  if (!createdIdeeId) return;
  const page = await browser.newPage();
  try {
    await page.goto('/');
    await page.waitForFunction(() => window.__app && window.Alpine.store('nav').selectedBookId);
    await page.evaluate((id) => fetch(`/ideen/${id}`, { method: 'DELETE' }), createdIdeeId);
  } finally {
    await page.close();
  }
});

test('ideen-karte: Verknuepfungs-Picker oeffnet am Menue-Knopf, nicht im Kartenkopf', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  const made = await page.evaluate(async (id) => {
    const tree = await fetch(`/content/books/${id}/tree`).then(r => r.json());
    const pageId = tree.chapters?.[0]?.pages?.[0]?.id;
    const idee = await fetch('/ideen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: id, page_id: pageId, content: 'Belegstelle für diese Passage suchen' }),
    }).then(r => r.json());
    return { pageId, ideeId: idee.id };
  }, bookId);
  createdIdeeId = made.ideeId;

  // Die Karte lebt neben dem Editor und laedt fuer die AKTIVE Seite — erst die
  // Seite waehlen, dann die Karte oeffnen.
  await page.evaluate(async (pid) => {
    await window.__app.selectPage(window.Alpine.store('nav').pages.find(p => p.id === pid));
  }, made.pageId);
  await page.evaluate(() => window.__app.toggleIdeenCard());

  const card = page.locator('#ideen-card');
  await expect(card).toBeVisible();
  const item = card.locator(`[data-idee-id="${made.ideeId}"]`);
  await expect(item).toBeVisible();

  // Der Weg zum Picker fuehrt hier ueber das Meatball-Menue der Idee.
  // Das Menue verschwindet beim Oeffnen — verankert wird darum am ⋯-Knopf,
  // der stehen bleibt (openLinkPicker(actionMenuAnchor(), …) in ideen.html).
  const trigger = item.locator('.idee-menu button');
  await trigger.click();
  const menuItem = page.getByRole('menuitem', { name: 'Verknüpfen' });
  await expect(menuItem).toBeVisible();
  const mb = await trigger.boundingBox();
  await menuItem.click();

  const popover = page.locator('.idee-link-popover');
  await expect(popover).toBeVisible();
  // Die Kopfzeile nennt die Idee — am schwebenden Popover ist sonst nicht zu
  // sehen, woran gerade verknuepft wird.
  await expect(popover).toContainText('Belegstelle für diese Passage suchen');

  // Die eigentliche Aussage: das Popover steht am Ausloeser, nicht im Kartenkopf.
  const pb = await popover.boundingBox();
  const gap = Math.min(Math.abs(pb.y - (mb.y + mb.height)), Math.abs(mb.y - (pb.y + pb.height)));
  expect(gap, `Popover ${gap}px vom Ausloeser entfernt`).toBeLessThan(24);
  expect(pb.x).toBeLessThanOrEqual(mb.x + mb.width);
  expect(pb.x + pb.width).toBeGreaterThanOrEqual(mb.x);
  // Und vollstaendig im Bild — ein Popover unterhalb des Viewports ist so gut
  // wie keins.
  expect(pb.y).toBeGreaterThanOrEqual(0);
  expect(pb.y + pb.height).toBeLessThanOrEqual(page.viewportSize().height);

  // Escape verwirft: der Picker ist ein Popover, kein Karten-Abschnitt.
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
});
