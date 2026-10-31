// Reiter-Wunsch (card-request.js#openCardWith) an eine geschlossene, schon
// gemountete Karte, die sich einen anderen Reiter gemerkt hat: die Karte muss
// schon beim Einblenden auf dem gewünschten Reiter stehen. Fälle: Sprung auf
// eine Figur (Palette `@`, Verweis) bei Figuren-Karte auf einem Graph-Reiter,
// Palette-Sprung auf einen Reiter der Bucheinstellungen bzw. des PDF-Exports. `openCardWith` dispatcht das CARD_REQUEST-Event
// erst NACH dem Öffnen — holt die Karte den Wunsch nur dort ab, steht sie in
// den Frames dazwischen auf dem gemerkten Graph-Reiter (sichtbares Aufblitzen).
// Gemessen wird deterministisch im `open`-Callback, also nach dem Einblenden
// und vor dem Event.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('figuren: Reiter-Wunsch greift beim Einblenden, nicht erst nach dem Event', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const before = await page.evaluate(async (id) => {
    const cur = await (await fetch(`/figures/${id}`)).json();
    const existing = cur?.figuren || [];
    await fetch(`/figures/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figuren: [...existing,
        { id: 'fig_tabreq_a', name: 'Tabreq Anna', typ: 'hauptfigur', beziehungen: [], kapitel: [], eigenschaften: [] }] }),
    });
    await window.__app.loadFiguren(id);
    return existing;
  }, bookId);

  try {
    const result = await page.evaluate(async () => {
      const app = window.__app;
      await app.toggleFiguresCard();
      const ctx = window.Alpine.$data(document.querySelector('.card--figuren'));
      ctx.setFigurenGraphModus('figur');
      await app.toggleOrteCard();
      const { openCardWith, CARD_REQUEST } = await import('/js/cards/card-request.js');
      let atShow = null;
      await openCardWith(CARD_REQUEST.FIGUREN_TAB, 'liste', async () => {
        await app.toggleFiguresCard({ skipCardScroll: true });
        await window.Alpine.nextTick();
        const wrap = document.querySelector('.figuren-graph-wrap');
        atShow = { mode: ctx.figurenGraphModus, graphVisible: !!wrap?.getClientRects().length };
      });
      return { atShow, final: ctx.figurenGraphModus };
    });
    expect(result.atShow).toEqual({ mode: 'liste', graphVisible: false });
    expect(result.final).toBe('liste');
  } finally {
    await page.evaluate(async ({ id, before }) => {
      await fetch(`/figures/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ figuren: before }),
      });
    }, { id: bookId, before });
  }
});

// Bucheinstellungen und PDF-Export: Karte auf Reiter A lassen, schliessen, per
// Wunsch auf Reiter B öffnen — gemessen wie oben im `open`-Callback.
for (const c of [
  { name: 'bucheinstellungen', sel: '.card--settings', key: 'BOOK_SETTINGS_TAB', field: 'bookSettingsTab',
    flag: 'showBookSettingsCard', toggle: 'toggleBookSettingsCard', from: 'publication', to: 'expose' },
  { name: 'pdf-export', sel: '.card--pdfexport', key: 'PDF_EXPORT_TAB', field: 'activeTab',
    flag: 'showPdfExportCard', toggle: 'togglePdfExportCard', from: 'chapter', to: 'pagination' },
]) {
  test(`${c.name}: Reiter-Wunsch greift beim Einblenden, nicht erst nach dem Event`, async ({ page }) => {
    await bootApp(page);
    await selectSeededBook(page);
    const result = await page.evaluate(async (c) => {
      const app = window.__app;
      await app[c.toggle]();
      const el = document.querySelector(c.sel);
      if (!el) throw new Error('Karte fehlt: ' + c.sel);
      const ctx = window.Alpine.$data(el);
      ctx[c.field] = c.from;
      await app.toggleOrteCard();
      if (app[c.flag]) throw new Error('Karte nicht geschlossen');
      const { openCardWith, CARD_REQUEST } = await import('/js/cards/card-request.js');
      let atShow = null;
      await openCardWith(CARD_REQUEST[c.key], c.to, async () => {
        await app[c.toggle]({ skipCardScroll: true });
        await window.Alpine.nextTick();
        atShow = ctx[c.field];
      });
      return { atShow, final: ctx[c.field] };
    }, c);
    expect(result.atShow).toBe(c.to);
    expect(result.final).toBe(c.to);
  });
}
