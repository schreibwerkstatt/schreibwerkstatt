// Senden-/Stopp-Knopf eines Chats ist genau so hoch wie das Eingabefeld — auch
// wenn der LanguageTool-Dispatcher die Textarea beim Fokus in .lt-field-wrap
// wickelt. Geteiltes Markup (chat-send-btn.html + .chat-input-row) aller fünf
// Chats; geprüft am Plot-Chat stellvertretend.

const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app.js');

test('Chat: Senden-Knopf bündig mit dem Eingabefeld, auch im LanguageTool-Wrapper', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(() => window.__app.togglePlotCard());
  await page.locator('.card--plot .card-actions button[aria-pressed]').last().click();
  const row = page.locator('#plot-chat-card .chat-input-row');
  await expect(row).toBeVisible();

  const measure = () => row.evaluate((r) => {
    const ta = r.querySelector('textarea').getBoundingClientRect();
    const btn = r.querySelector('.chat-send-btn').getBoundingClientRect();
    return { taTop: ta.top, taBottom: ta.bottom, btnTop: btn.top, btnBottom: btn.bottom };
  });
  const expectFlush = async () => {
    const m = await measure();
    expect(Math.abs(m.btnTop - m.taTop)).toBeLessThan(0.5);
    expect(Math.abs(m.btnBottom - m.taBottom)).toBeLessThan(0.5);
  };

  await expectFlush();
  // Wrapper so einsetzen, wie es der Dispatcher beim Fokus tut (LanguageTool ist im Test aus).
  await row.evaluate((r) => {
    const ta = r.querySelector('textarea');
    const w = document.createElement('span');
    w.className = 'lt-field-wrap lt-field-wrap--textarea';
    ta.before(w);
    w.append(ta);
  });
  await expectFlush();
});
