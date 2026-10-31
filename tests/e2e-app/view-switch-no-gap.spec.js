// Wechsel zwischen Hauptansichten ohne leeren Zwischenstand, gegen die ECHTE App.
//
// Geprüft wird am Root-State (Alpine.effect sieht jeden Flush), nicht an Pixeln:
// ein Flush, in dem keine Hauptkarte offen ist oder der Editor ohne Text steht,
// ist ein gerenderter Frame mit leerer Spalte bzw. leerer Karte.
// - Abschnitt → Kapitelbewertung: toggleKapitelReviewCard lädt das Partial VOR
//   dem Umschalten (book/kapitel-review.js).
// - Karte → Abschnitt: selectPage lädt den Inhalt vor und schaltet in einem
//   Schritt um (app-view/page.js, `deferClose`).

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

async function watchGaps(page, predicate) {
  await page.evaluate((src) => {
    const bad = new Function('app', 'return ' + src);
    window.__gaps = 0;
    window.__gapStop = Alpine.effect(() => { if (bad(window.__app)) window.__gaps++; });
  }, predicate);
}
async function gaps(page) {
  return page.evaluate(() => { Alpine.release?.(window.__gapStop); return window.__gaps; });
}

test.describe('Ansichtswechsel ohne Lücke', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page);
    await selectSeededBook(page);
  });

  test('Abschnitt → Kapitel → Abschnitt', async ({ page }) => {
    const { pageId, chapterId } = await page.evaluate(() => {
      const ch = window.Alpine.store('nav').tree.find(i => i.type === 'chapter' && !i.solo && i.pages.length);
      return { pageId: ch.pages[0].id, chapterId: ch.id };
    });
    const open = (id) => page.evaluate(async (pid) => {
      await window.__app.selectPage(window.Alpine.store('nav').pages.find(x => x.id === pid));
    }, id);
    await open(pageId);
    await page.waitForFunction(() => !window.__app.pageContentLoading && !!window.__app.renderedPageHtml);

    await watchGaps(page, '!app.showEditorCard && !app.showKapitelReviewCard');
    await page.evaluate((cid) => window.__app.openKapitelReviewForChapter(cid), chapterId);
    await page.waitForFunction(() => window.__app.showKapitelReviewCard);
    expect(await gaps(page)).toBe(0);

    await watchGaps(page, 'app.showEditorCard && !app.renderedPageHtml && !app.pageLoadError && !app.currentPageEmpty');
    await open(pageId);
    await page.waitForFunction(() => !window.__app.pageContentLoading && !!window.__app.renderedPageHtml);
    expect(await gaps(page)).toBe(0);
    await expect(page.locator('#editor-card .page-view-wrap > .page-content-view')).toBeVisible();
  });
});
