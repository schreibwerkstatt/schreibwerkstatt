// Sprung-Scroll auf dem Handy gegen die ECHTE App (volles CSS, einspaltiges
// Layout unter 960px): ein Ziel aus der Command-Palette muss nach dem Sprung im
// Bild stehen, und die Palette gibt keinem Textfeld den Fokus zurück (das
// öffnete auf Android die Tastatur mitten im Sprung wieder).
//
// Die Bildschirmtastatur selbst gibt es in Desktop-Chromium nicht. Der dritte
// Test ersetzt darum `window.visualViewport` durch ein Objekt mit kleinerer Höhe
// und prüft, dass scrollToWhenReady wartet, bis die Tastatur unten ist.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

async function runPalette(page, query) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('palette:open')));
  const input = page.locator('.palette-input');
  await expect(input).toBeVisible();
  await input.fill(query);
  await expect(page.locator('.palette-item--active')).toBeVisible();
  await input.press('Enter');
  await expect(input).toBeHidden();
}

// Oberkante des Elements relativ zum Fenster.
function topOf(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el && el.getClientRects().length ? Math.round(el.getBoundingClientRect().top) : null;
  }, selector);
}

// Das Element kommt an den oberen Fensterrand (Toleranz für Rundung) und bleibt
// dort, nachdem Animationen und Nachladen durch sind — ein Scroll auf ein noch
// verschobenes Ziel landete sonst um den Rest daneben.
async function expectLandsAtTop(page, selector) {
  const inBand = async () => {
    const top = await topOf(page, selector);
    return top !== null && top >= -2 && top < 120;
  };
  await expect.poll(inBand, { timeout: 3000 }).toBe(true);
  await page.waitForTimeout(700);
  expect(await topOf(page, selector)).toBeGreaterThanOrEqual(-2);
  expect(await inBand()).toBe(true);
}

async function scrollToBottom(page) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
}

test('Handy: Palette-Sprung auf eine Karte landet an deren Anfang', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  await scrollToBottom(page);
  // Vor dem Öffnen hält ein Textfeld den Fokus (wie beim Tippen im Editor).
  await page.evaluate(() => {
    const field = document.createElement('input');
    field.type = 'text';
    field.id = 'scroll-jump-field';
    document.body.append(field);
    field.focus({ preventScroll: true });
  });

  await runPalette(page, 'Figuren');
  await expectLandsAtTop(page, '[x-show="$app.showFiguresCard"]');

  // Kein Textfeld hält nach dem Sprung den Fokus — auch nicht das von vorher.
  const focusedIsText = await page.evaluate(async () => {
    const { isTextEntry } = await import('/js/utils/scroll-when-ready.js');
    return isTextEntry(document.activeElement);
  });
  expect(focusedIsText).toBe(false);
});

test('Handy: Palette-Sprung auf einen Abschnitt zeigt den Editor', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const pageName = await page.evaluate(() => window.Alpine.store('nav').pages[0]?.name);
  expect(pageName).toBeTruthy();
  await scrollToBottom(page);

  await runPalette(page, `#${pageName}`);
  await expect(page.locator('#editor-card')).toBeVisible();
  await expectLandsAtTop(page, '#editor-card');
});

test('scrollToWhenReady wartet, bis eine zufahrende Tastatur unten ist', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);

  const result = await page.evaluate(async () => {
    const { scrollToWhenReady } = await import('/js/utils/scroll-when-ready.js');
    const frames = (n) => new Promise((r) => {
      const step = (k) => (k ? requestAnimationFrame(() => step(k - 1)) : r());
      step(n);
    });
    // Ziel weit unterhalb des Fensters.
    const spacer = document.createElement('div');
    spacer.style.height = '3000px';
    const target = document.createElement('div');
    target.id = 'scroll-jump-target';
    target.textContent = 'Ziel';
    document.body.append(spacer, target);
    window.scrollTo(0, 0);

    // Tastatur offen, kein Textfeld fokussiert → sie fährt gleich zu.
    const fakeVv = { height: window.innerHeight - 300, scale: 1 };
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fakeVv });
    document.activeElement?.blur?.();

    scrollToWhenReady('#scroll-jump-target', { tries: 120 });
    await frames(15);
    const scrolledWhileOpen = window.scrollY;

    // Tastatur unten.
    fakeVv.height = window.innerHeight;
    await frames(10);
    await new Promise(r => setTimeout(r, 800));
    const scrolledAfter = window.scrollY;

    delete window.visualViewport;
    spacer.remove();
    target.remove();
    return { scrolledWhileOpen, scrolledAfter };
  });

  expect(result.scrolledWhileOpen).toBe(0);
  expect(result.scrolledAfter).toBeGreaterThan(1000);
});
