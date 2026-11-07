// ⌘/Strg+Shift+1/2 gegen die ECHTE App: Leiste neben dem Notebook-Editor per
// Tastatur (public/js/editor/aside-hotkeys.js, docs/notebook-editor.md).
//
// Warum hier und nicht nur Unit: der Weg hängt an der Verdrahtung am
// `@keydown.window` der Shell, am Lazy-Partial der Karten (das Zitat muss die
// Karte erreichen, die beim Druck noch nicht gemountet ist) und an echter
// Selection/Fokus-Logik zwischen contenteditable und Textarea.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';
const IDEEN_INPUT = '#ideen-card .ideen-input-row .ideen-input';
const CHAT_INPUT = '#partial-chat .chat-input';

async function openFirstPageInEdit(page) {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => {
    const pages = window.Alpine.store('nav').pages;
    await window.__app.selectPage(pages[0]);
  });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.keyboard.press('Control+e');
  await expect(page.locator(EDIT_SEL)).toBeVisible({ timeout: 15000 });
}

// Markiert die ersten `n` Zeichen des ersten Textknotens im Editor.
async function selectStart(page, n) {
  return page.evaluate(({ sel, n }) => {
    const root = document.querySelector(sel);
    root.focus();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (t) => (t.data.trim().length >= n ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    const node = walker.nextNode();
    const r = document.createRange();
    r.setStart(node, 0);
    r.setEnd(node, n);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return s.toString();
  }, { sel: EDIT_SEL, n });
}

test('⌘/Strg+Shift+2: Markierung als Zitat in die Ideen, Esc zurück an dieselbe Stelle', async ({ page }) => {
  await openFirstPageInEdit(page);
  const picked = await selectStart(page, 12);
  expect(picked.length).toBe(12);

  await page.keyboard.press('Control+Shift+Digit2');
  const input = page.locator(IDEEN_INPUT);
  await expect(input).toBeFocused({ timeout: 15000 });
  const quoted = picked.replace(/\s+/g, ' ').trim();
  await expect(input).toHaveValue(`„${quoted}“\n`);

  await page.keyboard.press('Escape');
  await expect(page.locator(EDIT_SEL)).toBeFocused();
  expect(await page.evaluate(() => window.getSelection().toString())).toBe(picked);
  // Leiste bleibt offen, Entwurf bleibt stehen (nichts gespeichert).
  expect(await page.evaluate(() => window.__app.showIdeenCard)).toBe(true);
  await expect(input).toHaveValue(`„${quoted}“\n`);

  // Zweiter Druck aus dem Text: zurück ins Feld; dritter aus dem Feld: zu.
  await page.keyboard.press('Control+Shift+Digit2');
  await expect(input).toBeFocused();
  await page.keyboard.press('Control+Shift+Digit2');
  await expect.poll(() => page.evaluate(() => window.__app.showIdeenCard)).toBe(false);
  await expect(page.locator(EDIT_SEL)).toBeFocused();
});

test('⌘/Strg+Shift+1: Abschnitts-Chat auf und zu, ohne Markierung kein Zitat', async ({ page }) => {
  await openFirstPageInEdit(page);
  const canChat = await page.evaluate(() => window.__app.canOpenPageAside('chat'));
  test.skip(!canChat, 'Seed-Abschnitt erlaubt keinen Abschnitts-Chat');
  await page.evaluate((sel) => {
    const root = document.querySelector(sel);
    root.focus();
    const s = window.getSelection();
    s.collapse(root.firstElementChild || root, 0);
  }, EDIT_SEL);

  await page.keyboard.press('Control+Shift+Digit1');
  const input = page.locator(CHAT_INPUT).first();
  await expect(input).toBeFocused({ timeout: 15000 });
  await expect(input).toHaveValue('');

  await page.keyboard.press('Control+Shift+Digit1');
  await expect.poll(() => page.evaluate(() => window.__app.showChatCard)).toBe(false);
  await expect(page.locator(EDIT_SEL)).toBeFocused();
});

test('Palette: «Ideen zum Abschnitt» öffnet die Leiste, nur mit offenem Abschnitt gelistet', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const listed = () => page.evaluate(() => {
    const el = document.querySelector('[x-data="paletteCard"]');
    const data = el && window.Alpine.$data(el);
    return (data?.paletteSections() || []).flatMap(s => s.items).some(i => i.feature?.key === 'action.pageIdeen');
  });

  await page.keyboard.press('Control+k');
  await page.keyboard.type('>Ideen zum');
  await expect.poll(listed).toBe(false);
  await page.keyboard.press('Escape');

  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.keyboard.press('Control+k');
  await page.keyboard.type('>Ideen zum');
  await expect.poll(listed).toBe(true);
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__app.showIdeenCard)).toBe(true);
  await expect(page.locator(IDEEN_INPUT)).toBeFocused({ timeout: 15000 });
});
