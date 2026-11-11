// Volltext-Treffer → Sprung in den Abschnitt MIT markierter Fundstelle
// (search-hit.js → gotoPageById(id, { snippet }) → book/passage-highlight.js).
// Gegen die echte Suche (FTS-Index des Seed-Buchs), nicht gegen eine
// abgefangene Antwort: der Snippet-Aufbau des Servers (<mark>, «…») ist genau
// das, was die Markierung im Abschnittstext wiederfinden muss.
const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('Volltext-Treffer markiert die Fundstelle im Abschnitt', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  // Ein Wort aus dem hinteren Teil des längsten Abschnitts als Suchbegriff.
  const target = await page.evaluate(async (bid) => {
    const pages = window.Alpine.store('nav').pages;
    let best = null;
    for (const p of pages) {
      const r = await fetch(`/content/pages/${p.id}`);
      if (!r.ok) continue;
      const j = await r.json();
      const html = j.html || j.content_html || j.page?.html || '';
      const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!best || text.length > best.text.length) best = { id: p.id, text };
    }
    return best;
  }, bookId);
  expect(target, 'kein Abschnitt mit Text im Seed').toBeTruthy();
  const words = target.text.split(' ').filter(w => /^[\p{L}]{7,}$/u.test(w));
  const term = words[Math.floor(words.length * 0.8)];
  expect(term).toBeTruthy();

  await page.evaluate(() => window.__app.toggleSearchCard());
  await page.locator('.search-q').fill(term);
  const hit = page.locator('.search-hit').first();
  await expect(hit).toBeVisible();
  await hit.click();

  await expect.poll(() => page.evaluate(() => String(window.__app.currentPage?.id))).toBe(String(target.id));
  await expect.poll(() => page.evaluate(() => window.CSS.highlights.has('passage-hit')), { timeout: 5000 }).toBe(true);
  const marked = await page.evaluate(() => {
    const h = window.CSS.highlights.get('passage-hit');
    const r = [...h][0];
    return r.toString();
  });
  expect(marked.toLowerCase()).toContain(term.toLowerCase());
});

// Stelle nicht gefunden: der Ersatz-Sprung an den Abschnittsanfang kommt erst
// nach den Ladeschritten von selectPage — hat der User bis dahin selbst
// gescrollt/geklickt, unterbleibt er (sonst risse er ihn aus dem Text).
test('Nicht gefundene Fundstelle: kein Hochscrollen nach eigener Bewegung', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const ids = await page.evaluate(() => window.Alpine.store('nav').pages.slice(0, 2).map(p => p.id));
  await page.evaluate(() => {
    window.__tops = 0;
    const orig = window.__app._scrollToEditorCard.bind(window.__app);
    window.__app._scrollToEditorCard = () => { window.__tops++; return orig(); };
  });
  const jump = (id) => page.evaluate((pid) => { window.__app.gotoPageById(pid, { snippet: 'Xylophonquark Zwetschgenbaum' }); }, id);

  // Ohne Zutun: Ersatz-Sprung an den Anfang.
  await jump(ids[0]);
  await expect.poll(() => page.evaluate(() => window.__tops)).toBe(1);

  // Mit Mausrad während des Sprungs: kein Ersatz-Sprung.
  await jump(ids[1]);
  await page.mouse.move(640, 450);
  await page.mouse.wheel(0, 200);
  await expect.poll(() => page.evaluate(() => String(window.__app.currentPage?.id))).toBe(String(ids[1]));
  await page.waitForTimeout(2500); // 60 Frames Suche + Puffer
  expect(await page.evaluate(() => window.__tops)).toBe(1);
});
