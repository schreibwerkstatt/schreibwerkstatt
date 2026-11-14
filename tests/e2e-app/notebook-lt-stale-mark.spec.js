// LanguageTool im NOTEBOOK-Editor: eine korrigierte Stelle verliert ihre
// Markierung auch dann, wenn während der Prüf-Anfrage nur ein Attribut im
// Editor wechselt. Der Autosave setzt `data-bid` an neuen Absätzen
// (edit/save-guard.js#_ensureLiveBlockIds) — das ändert das Markup, nicht den
// Text, und weckt den MutationObserver des Controllers nicht (er beobachtet
// keine Attribute). Verwarf der Controller die Antwort wegen des geänderten
// Markups, lief kein neuer Check, und die Wellenlinie blieb auf dem
// korrigierten Wort stehen.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';
const TYPO = 'widerzuerkennen';
let freshPageId = null;

test.afterEach(async ({ page }) => {
  if (freshPageId == null) return;
  const id = freshPageId; freshPageId = null;
  await page.evaluate(async (pid) => {
    window.__app.editDirty = false;
    if (window.__app.editMode) await window.__app.cancelEdit();
    await window.__app.deletePageById(pid, { confirm: false });
  }, id).catch(() => {});
});

test('Korrektur räumt die Markierung ab, auch wenn der Autosave während der Prüfung ein Attribut setzt', async ({ page }) => {
  // LT-Mock: jedes Vorkommen des Tippfehlers ist ein Treffer. Kommt die
  // korrigierte Fassung, setzt der Mock vor der Antwort ein Attribut im Editor
  // — wie der Autosave mitten in der Anfrage.
  await page.route('**/languagetool/check', async (route) => {
    const text = JSON.parse(route.request().postData() || '{}').text || '';
    const matches = [];
    for (let i = text.indexOf(TYPO); i >= 0; i = text.indexOf(TYPO, i + TYPO.length)) {
      matches.push({
        message: 'Tippfehler', offset: i, length: TYPO.length,
        rule: { id: 'SWISS_GERMAN_SPELLER_RULE', category: { id: 'TYPOS' } },
        replacements: [{ value: 'wiederzuerkennen' }],
        context: { text: TYPO, offset: 0, length: TYPO.length },
      });
    }
    if (text.includes('wiederzuerkennen')) {
      await page.evaluate((s) => {
        document.querySelectorAll(`${s} p`)[1].setAttribute('data-bid', 'ffffffffffffffff');
      }, EDIT_SEL);
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ matches }) });
  });

  await bootApp(page);
  const bookId = await selectSeededBook(page);
  freshPageId = await page.evaluate(async (bid) => {
    const { contentRepo } = await import('/js/repo/content.js');
    const created = await contentRepo.createPage({ book_id: parseInt(bid, 10), name: 'LT', html: '<p>Ich schaue zu.</p><p>Noch ein Absatz.</p>' });
    await window.__app.loadPages();
    await window.__app.selectPage(window.Alpine.store('nav').pages.find((x) => x.id === created.id));
    return created.id;
  }, bookId);
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => {
    const c = window.Alpine.store('config');
    c.languagetoolDebounceMs = 300;
    c.languagetoolEnabled = true;
  });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });

  const marked = () => page.evaluate(() => {
    const h = CSS.highlights.get('lt-typo');
    return h ? [...h].map((r) => r.toString()) : null;
  });

  // Vor dem Punkt des ersten Absatzes den Tippfehler tippen.
  await page.locator(`${EDIT_SEL} p`).first().click();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type(`, um sie ${TYPO}`);
  await expect.poll(marked, { timeout: 10000 }).toEqual([TYPO]);

  // Korrektur: Caret hinter «wi», «e» einfügen.
  const fixed = page.waitForResponse((r) => r.url().includes('/languagetool/check')
    && (r.request().postData() || '').includes('wiederzuerkennen'));
  for (let k = 0; k < TYPO.length - 2; k++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('e');
  await fixed;
  await expect.poll(marked, { timeout: 5000 }).toEqual([]);
});
