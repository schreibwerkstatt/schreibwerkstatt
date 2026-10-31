// Split mit Leiste (layout/aside-split.css) in der echten App: Editor links,
// Seiten-Chat bzw. Referenz rechts in DERSELBEN Leiste. Geprüft wird, was nur
// mit vollem CSS und echtem Template-Baum stimmt:
//   - die Leiste steht neben dem Editor, in der Breite aus `--aside-w`;
//   - sie deckelt sich auf die Viewport-Höhe und scrollt als Ganzes, auch wenn
//     ihr Inhalt viel höher ist (sonst wäre ihr Ende — Eingabefeld — erst am
//     Seitenende erreichbar, während sie klebt);
//   - Chat und Referenz teilen den Platz (`asideSlot`), der Split bleibt stehen.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('Leiste neben dem Editor: Breite, Viewport-Deckel, ein Platz für Chat und Referenz', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 700 });
  await bootApp(page);
  await selectSeededBook(page);

  await page.evaluate(async () => {
    const nav = window.Alpine.store('nav');
    await window.__app.selectPage(nav.pages[0]);
  });
  await expect(page.locator('#editor-card')).toBeVisible();

  await page.evaluate(() => window.__app.toggleChatCard());
  const chat = page.locator('#chat-card');
  await expect(chat).toBeVisible();

  const geo = await page.evaluate(() => {
    const ed = document.querySelector('#editor-card').getBoundingClientRect();
    const ch = document.querySelector('#chat-card').getBoundingClientRect();
    return { edRight: ed.right, chLeft: ch.left, chWidth: ch.width, vw: innerWidth };
  });
  expect(geo.chLeft, 'Leiste steht rechts neben dem Editor').toBeGreaterThan(geo.edRight);
  // --aside-w = clamp(380px, 30vw, 560px)
  expect(Math.round(geo.chWidth)).toBe(Math.round(Math.min(560, Math.max(380, geo.vw * 0.3))));

  // Inhalt weit über Viewport-Höhe: die Leiste darf trotzdem nicht höher werden
  // als der Klebe-Rahmen (innerHeight − --sticky-top − --sticky-bottom).
  await page.locator('#chat-messages').evaluate(el => { el.style.minHeight = '2000px'; });
  const cap = await chat.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    max: innerHeight - 24 - 24,
    scrolls: el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto',
  }));
  expect(cap.height, 'Leiste deckelt sich auf den Viewport').toBeLessThanOrEqual(cap.max + 1);
  expect(cap.scrolls, 'Leiste scrollt als Ganzes').toBe(true);
  await page.locator('#chat-messages').evaluate(el => { el.style.minHeight = ''; });

  // Referenz löst den Chat im selben Platz ab; der Split bleibt.
  await page.evaluate(() => window.__app.toggleReferenceCard());
  await expect(page.locator('#reference-card')).toBeVisible();
  await expect(chat).toBeHidden();
  expect(await page.evaluate(() => window.__app.asideSlot)).toBe('reference');
  const refLeft = await page.locator('#reference-card').evaluate(el => el.getBoundingClientRect().left);
  expect(refLeft).toBeGreaterThan(geo.edRight);

  // Schliessen räumt den Platz, der Editor nimmt die volle Breite.
  await page.evaluate(() => window.__app.toggleReferenceCard());
  await expect(page.locator('#reference-card')).toBeHidden();
  expect(await page.evaluate(() => window.__app.editorAsideOpen)).toBe(false);
});

// Griff an der Spaltengrenze (aside-resize.js): Ziehen nach links verbreitert
// die Leiste, die Breite gilt für alle Leisten und überlebt einen Reload;
// Doppelklick setzt auf `--aside-w` zurück.
test('Leiste per Griff verbreitern, gespeichert, Doppelklick zurück', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 800 });
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => {
    await window.__app.selectPage(window.Alpine.store('nav').pages[0]);
    window.__app.toggleChatCard();
  });
  const chat = page.locator('#chat-card');
  await expect(chat).toBeVisible();
  const handle = page.locator('.main-aside-split.aside-split--on > .aside-split-handle');
  await expect(handle).toBeVisible();
  await expect(handle).not.toHaveAttribute('aria-label', 'aside.resizeHandle');
  // Einblend-Animation der Karte abwarten, sonst verschiebt sich die Geometrie
  // zwischen Messen und Ziehen.
  await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));

  const before = await chat.evaluate(el => el.getBoundingClientRect().width);
  const hb = await handle.boundingBox();
  // Griff sitzt im Spaltenabstand, links von der Leiste.
  const chLeft = await chat.evaluate(el => el.getBoundingClientRect().left);
  expect(hb.x + hb.width).toBeLessThanOrEqual(chLeft + 1);

  await page.mouse.move(hb.x + hb.width / 2, hb.y + 40);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 - 150, hb.y + 40, { steps: 5 });
  await page.mouse.up();
  const after = await chat.evaluate(el => el.getBoundingClientRect().width);
  expect(Math.round(after - before)).toBe(150);
  expect(await page.evaluate(() => localStorage.getItem('aside-width'))).toBe(String(Math.round(after)));

  // Über den 50vw-Deckel hinaus: die gespeicherte Breite folgt dem Bild.
  const hb2 = await handle.boundingBox();
  await page.mouse.move(hb2.x + 3, hb2.y + 40);
  await page.mouse.down();
  await page.mouse.move(0, hb2.y + 40, { steps: 5 });
  await page.mouse.up();
  const capped = await chat.evaluate(el => el.getBoundingClientRect().width);
  expect(Math.round(capped)).toBe(800);
  expect(await page.evaluate(() => localStorage.getItem('aside-width'))).toBe('800');

  await handle.dblclick();
  expect(Math.round(await chat.evaluate(el => el.getBoundingClientRect().width))).toBe(Math.round(before));
  expect(await page.evaluate(() => localStorage.getItem('aside-width'))).toBeNull();
});
