// Markierung nach einem Sprung auf einen Abschnitt (book/passage-highlight.js):
// steht bis zu 10 s, ein Klick irgendwo räumt sie vorher ab. Einzelwort-
// Snippets treffen zuerst das ganze Wort, nicht einen Wortteil.
const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const hasHit = (page) => page.evaluate(() => window.CSS.highlights.has('passage-hit'));

async function longestPage(page) {
  return page.evaluate(async () => {
    let best = null;
    for (const p of window.Alpine.store('nav').pages) {
      const r = await fetch(`/content/pages/${p.id}`);
      if (!r.ok) continue;
      const j = await r.json();
      const html = j.html || j.content_html || j.page?.html || '';
      const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!best || text.length > best.text.length) best = { id: p.id, text };
    }
    return best;
  });
}

test('Markierung hält über 5 s und verschwindet beim Klick', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const target = await longestPage(page);
  expect(target, 'kein Abschnitt mit Text im Seed').toBeTruthy();
  const words = target.text.split(' ').filter(w => /^[\p{L}]{7,}$/u.test(w));
  const term = words[Math.floor(words.length * 0.8)];
  expect(term).toBeTruthy();

  await page.evaluate(([id, snippet]) => window.__app.gotoPageById(id, { snippet }), [target.id, term]);
  await expect.poll(() => hasHit(page), { timeout: 5000 }).toBe(true);

  await page.waitForTimeout(5000);
  expect(await hasHit(page)).toBe(true);

  await page.mouse.click(5, 5);
  await expect.poll(() => hasHit(page)).toBe(false);
});

test('Einzelwort trifft das ganze Wort vor einem Wortteil', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const target = await longestPage(page);
  // Ein Wort, das früher im Text auch als Teil eines längeren Wortes steht.
  const tokens = target.text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  let pick = null;
  for (let i = 0; i < tokens.length && !pick; i++) {
    const w = tokens[i];
    if (w.length < 3) continue;
    const firstWhole = tokens.indexOf(w);
    const partBefore = tokens.slice(0, firstWhole).some(t => t !== w && t.includes(w));
    if (partBefore) pick = w;
  }
  test.skip(!pick, 'Seed bietet kein Wort, das vorher als Wortteil steht');

  await page.evaluate(([id, snippet]) => window.__app.gotoPageById(id, { snippet }), [target.id, pick]);
  await expect.poll(() => hasHit(page), { timeout: 5000 }).toBe(true);
  const ctx = await page.evaluate(() => {
    const r = [...window.CSS.highlights.get('passage-hit')][0];
    const full = r.startContainer.nodeValue || '';
    return { before: full[r.startOffset - 1] || '', after: (r.endContainer.nodeValue || '')[r.endOffset] || '', text: r.toString() };
  });
  expect(ctx.text.toLowerCase()).toBe(pick);
  expect(/\p{L}/u.test(ctx.before)).toBe(false);
  expect(/\p{L}/u.test(ctx.after)).toBe(false);
});
