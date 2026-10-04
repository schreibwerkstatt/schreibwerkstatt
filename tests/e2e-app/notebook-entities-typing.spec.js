// Notebook-Editor Entity-Highlights beim Tippen gegen die ECHTE App.
//
// Warum E2E: die Highlights sind lebende DOM-Ranges in `CSS.highlights`. Tippt
// der User direkt vor einem hervorgehobenen Namen, haelt der Browser den
// Range-Start fest und schiebt das Ende mit — der neue Text liegt im Highlight.
// Das sieht nur, wer echte Tastatureingaben gegen den echten Editor faehrt.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';

async function setup(page) {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.innerHTML = '<p>Lea ging nach Hause.</p><p>Am Abend kam Lea zurück.</p>';
    window.__app.$store.catalog.figuren = [{ id: 1, name: 'Lea' }];
    window.__app.entitiesEnabledForCurrentBook = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, EDIT_SEL);
  await expect.poll(() => highlighted(page)).toEqual(['Lea', 'Lea']);
}

const highlighted = (page) => page.evaluate(
  () => [...(CSS.highlights.get('entity-figure') || [])].map(r => r.toString()));

async function caretBefore(page, needle) {
  await page.locator(EDIT_SEL).click();
  await page.evaluate(([sel, needle]) => {
    const w = document.createTreeWalker(document.querySelector(sel), NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const i = n.nodeValue.indexOf(needle);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      return;
    }
  }, [EDIT_SEL, needle]);
}

test('Tippen direkt vor einem hervorgehobenen Namen zieht den neuen Text nicht ins Highlight', async ({ page }) => {
  await setup(page);
  await caretBefore(page, 'Lea ging');
  for (const ch of 'Es regnet. ') {
    await page.keyboard.type(ch);
    // Vor dem Debounce-Recompute: kein Highlight darf mehr als den Namen umfassen.
    for (const s of await highlighted(page)) expect(s).toBe('Lea');
  }
  // Nach der Tipp-Pause sind beide Namen wieder hervorgehoben.
  await expect.poll(() => highlighted(page)).toEqual(['Lea', 'Lea']);
  // Nicht awaiten: nach Änderungen wartet cancelEdit auf den Verwerfen-Dialog.
  await page.evaluate(() => { window.__app.cancelEdit(); });
});

test('Name am Absatzende ohne Satzzeichen wird hervorgehoben, auch vor einem Folgeabsatz', async ({ page }) => {
  await setup(page);
  // Neuer Absatz am Ende des ersten, ohne Satzzeichen — wie mitten im Schreiben.
  await page.locator(EDIT_SEL).click();
  await page.evaluate((sel) => {
    const p = document.querySelector(sel).querySelector('p');
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }, EDIT_SEL);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Dann kam Lea');
  await expect.poll(() => highlighted(page)).toEqual(['Lea', 'Lea', 'Lea']);

  // Zeilenumbruch innerhalb eines Absatzes (<br>) trennt ebenso.
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('Sie lachte');
  await expect.poll(() => highlighted(page)).toEqual(['Lea', 'Lea', 'Lea']);
  // Nicht awaiten: nach Änderungen wartet cancelEdit auf den Verwerfen-Dialog.
  await page.evaluate(() => { window.__app.cancelEdit(); });
});
