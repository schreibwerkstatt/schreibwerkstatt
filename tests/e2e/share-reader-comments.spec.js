const { test, expect } = require('./_helpers/fixtures');

// Verifiziert, dass die Share-Reader-Kommentare die GETEILTE Karten-Optik
// (components/comment-rail.css, `.comment-rail__*`) tatsächlich rendern und die
// --cr-*-Theming-Brücke auf das Share-Token-Universum auflöst. Treibt das echte
// share-reader.js gegen einen Fetch-Stub (Mock-Threads), prüft also Markup +
// CSS-Bridge in einem Zug. Der Console-Guard (fixtures.js) macht den Test rot,
// falls der Bootstrap (Optionen-Menü, Composer, Layout …) einen Fehler wirft.
const URL = 'http://localhost:8765/tests/fixtures/share-reader-harness.html';

// Share-Light-Palette (share.css :root): Surface #fff, Akzent #1d4b73.
const SURFACE_LIGHT = 'rgb(255, 255, 255)';
const SURFACE_DARK = 'rgb(42, 39, 34)';   // #2a2722 (html[data-theme=dark])
const ACCENT_LIGHT = 'rgb(29, 75, 115)';  // #1d4b73

test('share-reader: verankerter Thread rendert als geteilte comment-rail-Karte', async ({ page }) => {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // share-reader.js fetcht async und rendert dann — auf die Karte warten.
  const thread = page.locator('.share-comments__list .comment-rail__thread');
  await expect(thread).toHaveCount(1);

  // Quote-Snippet ohne literale Anführungszeichen (= SPA-Optik).
  const quote = thread.locator('.comment-rail__quote');
  await expect(quote).toHaveText('anchored passage');

  // Avatar-Pip mit Initialen.
  const avatar = thread.locator('.comment-rail__avatar').first();
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveText('LM'); // Lena Muster

  // Brücke aufgelöst: Karte hat Share-Surface-Hintergrund + Elevation (kein
  // transparenter/unstyled Block, was ein gebrochenes --cr-Mapping wäre).
  const bg = await thread.evaluate(el => getComputedStyle(el).backgroundColor);
  expect(bg).toBe(SURFACE_LIGHT);
  const shadow = await thread.evaluate(el => getComputedStyle(el).boxShadow);
  expect(shadow).not.toBe('none');
});

test('share-reader: Autor-Antwort bekommt den Akzent-Balken (--cr-accent)', async ({ page }) => {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const reply = page.locator('.share-comments__list .comment-rail__comment--reply.comment-rail__comment--author');
  await expect(reply).toHaveCount(1);
  const borderColor = await reply.evaluate(el => getComputedStyle(el).borderLeftColor);
  expect(borderColor).toBe(ACCENT_LIGHT);
});

test('share-reader: allgemeine Kommentare erben die Brücke (body-weit)', async ({ page }) => {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // Nicht-verankerter Thread landet in der getrennten .share-general-Sektion —
  // die Brücke auf body.share-page muss auch dort greifen.
  const general = page.locator('.share-general__list .comment-rail__thread');
  await expect(general).toHaveCount(1);
  const bg = await general.evaluate(el => getComputedStyle(el).backgroundColor);
  expect(bg).toBe(SURFACE_LIGHT);
});

test('share-reader: Dark-Mode flippt die Karten-Surface über die Brücke', async ({ page }) => {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.share-comments__list .comment-rail__thread')).toHaveCount(1);

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  const bg = await page.locator('.share-comments__list .comment-rail__thread')
    .evaluate(el => getComputedStyle(el).backgroundColor);
  expect(bg).toBe(SURFACE_DARK);
});

// Namens-Modal öffnet beim ersten Besuch automatisch und läge über allem —
// für die Interaktions-Tests als „weggeklickt" vormerken.
async function gotoDismissed(page) {
  await page.addInitScript(() => { try { sessionStorage.setItem('sw_share_name_dismissed', '1'); } catch {} });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
}

test('share-reader: Karten haben Innenabstand (Spacing-Tokens auf der Share-Seite)', async ({ page }) => {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const thread = page.locator('.share-comments__list .comment-rail__thread');
  await expect(thread).toHaveCount(1);
  // components/comment-rail.css rechnet mit --space-*; fehlt tokens/spacing.css
  // auf der Share-Seite, fallen Padding/Gap still auf 0.
  const s = await thread.evaluate(el => {
    const c = getComputedStyle(el);
    const meta = getComputedStyle(el.querySelector('.comment-rail__meta'));
    return { padding: c.padding, rowGap: c.rowGap, metaGap: meta.columnGap };
  });
  expect(s.padding).toBe('8px 10px');
  expect(s.rowGap).toBe('4px');
  expect(s.metaGap).toBe('6px');
  const wrap = await thread.locator('.comment-rail__body').first().evaluate(el => getComputedStyle(el).overflowWrap);
  expect(wrap).toBe('anywhere');
});

test('share-reader: Antwort-Box erst auf „Antworten", Abbrechen ist ein Ghost-Knopf', async ({ page }) => {
  await gotoDismissed(page);
  const thread = page.locator('.share-comments__list .comment-rail__thread');
  await expect(thread).toHaveCount(1);
  await expect(thread.locator('textarea')).toHaveCount(0);

  await thread.locator('.share-thread__reply-toggle').click();
  const ta = thread.locator('.comment-rail__textarea');
  await expect(ta).toBeFocused();
  await ta.fill('Entwurf');

  const cancel = thread.locator('.share-thread__reply-actions .share-composer__cancel');
  const bg = await cancel.evaluate(el => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgba(0, 0, 0, 0)'); // nicht die gefüllte Akzent-Fläche
  await cancel.click();
  await expect(thread.locator('textarea')).toHaveCount(0);
  await expect(thread.locator('.share-thread__reply-toggle')).toBeVisible();
});

test('share-reader: Klick auf die Karte wählt den verankerten Thread aus', async ({ page }) => {
  await gotoDismissed(page);
  const thread = page.locator('.share-comments__list .comment-rail__thread');
  await expect(thread).toHaveCount(1);
  await thread.locator('.comment-rail__body').first().click();
  await expect(thread).toHaveClass(/comment-rail__thread--selected/);
  // Allgemeine Threads haben keine Karten-Aktion → kein Hand-Zeiger.
  const cursor = await page.locator('.share-general__list .comment-rail__thread')
    .evaluate(el => getComputedStyle(el).cursor);
  expect(cursor).toBe('default');
});

test('share-reader: Mobile — Tipp auf die Markierung öffnet den Thread als Sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await gotoDismissed(page);
  await expect(page.locator('.share-comments__list .comment-rail__thread')).toHaveCount(1);

  const scrollBefore = await page.evaluate(() => window.scrollY);
  const box = await page.evaluate(() => {
    const p = document.querySelector('[data-bid="b1"]');
    const tn = p.firstChild;
    const i = tn.textContent.indexOf('anchored passage');
    const r = document.createRange();
    r.setStart(tn, i + 2); r.setEnd(tn, i + 3);
    const b = r.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.mouse.click(box.x, box.y);

  const sheet = page.locator('#share-sheet [role="dialog"]');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.comment-rail__thread')).toHaveCount(1);
  await expect(sheet.locator('.comment-rail__quote')).toHaveText('anchored passage');
  // Leser bleibt an der Lesestelle (kein Sprung zur Liste unter dem Artikel).
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);

  await page.keyboard.press('Escape');
  await expect(page.locator('#share-sheet')).toHaveCount(0);
});
