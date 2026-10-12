// Nachrichtenverlauf (div.msg-thread) im FOCUS-Editor, gegen die ECHTE App.
//
// Der Focus-Editor zeigt die Zeilen als normale Absätze, nutzt aber für Enter
// und Löschen dieselben Handler wie der Notebook (Dispatcher-Ausnahme am
// Focus-Hard-Stop, notebook/toolbar/keydown.js). Geprüft wird, was ohne sie
// passierte: Doppel-Enter blieb im Verlauf (weitergetippte Erzählung wurde zur
// Nachricht), Backspace/Delete an der Grenze zogen Erzählung in den Verlauf
// bzw. eine Nachricht in die Erzählung.
//
// WARUM DIESE SCHICHT: der Keydown-Dispatcher hängt an der Notebook-Toolbar-
// Karte (editor-toolbar-card.js) und an `focusActive` des Alpine-Roots — beides
// gibt es im Focus-Harness nicht.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const FOCUS = '.focus-editor__content';
const THREAD = '<p>Vorher</p><div class="msg-thread"><p class="msg-name">Lena</p><p class="msg-in">Hallo</p>'
  + '<p class="msg-out">Hi</p></div><p>Nachher</p>';

async function enterFocus(page) {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('editor:focus:enter-from-pageview')));
  await page.waitForFunction(() => {
    const d = window.Alpine.$data(document.querySelector('.focus-editor'));
    return !!d && d._focusState === 'active';
  }, null, { timeout: 15000 });
  await page.waitForTimeout(200);
}

// Inhalt setzen und Caret an Anfang/Ende von `target`. Kein `input` — die
// Seite bleibt un-dirty, bis eine Taste sie ändert.
async function seed(page, target, pos) {
  await page.evaluate(({ sel, html, target, pos }) => {
    const c = document.querySelector(sel);
    c.innerHTML = html;
    const el = c.querySelector(target);
    c.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(pos === 'start');
    const s = document.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }, { sel: FOCUS, html: THREAD, target, pos });
  await page.waitForTimeout(150);
}

// Inhalt ohne Laufzeit-Klassen (Spotlight) und Block-IDs.
function readHtml(page) {
  return page.evaluate((sel) => {
    const c = document.querySelector(sel).cloneNode(true);
    c.querySelectorAll('[class*="focus-paragraph"]').forEach((el) => {
      [...el.classList].filter((k) => k.startsWith('focus-paragraph')).forEach((k) => el.classList.remove(k));
      if (!el.classList.length) el.removeAttribute('class');
    });
    return c.innerHTML.replace(/ data-bid="[^"]*"/g, '');
  }, FOCUS);
}

// Genau ein Block trägt die Hervorhebung (Invariante 18), und zwar der mit dem Caret.
function activeMark(page) {
  return page.evaluate((sel) => {
    const c = document.querySelector(sel);
    const marked = c.querySelectorAll('.focus-paragraph-active');
    const node = document.getSelection().anchorNode;
    const caretEl = node?.nodeType === 3 ? node.parentElement : node;
    return { count: marked.length, onCaret: marked.length === 1 && marked[0].contains(caretEl) };
  }, FOCUS);
}

async function expectIntact(page, label) {
  expect(await activeMark(page), `${label}: Hervorhebung`).toEqual({ count: 1, onCaret: true });
  const styled = await page.evaluate((sel) => document.querySelector(sel).querySelectorAll('[style]').length, FOCUS);
  expect(styled, `${label}: kein Inline-style`).toBe(0);
  expect(await page.evaluate(() => window.__app.editDirty), `${label}: dirty`).toBe(true);
}

test.describe('Focus — Nachrichtenverlauf', () => {
  test('Doppel-Enter verlässt den Verlauf, Erzählung landet dahinter', async ({ page }) => {
    await enterFocus(page);
    await seed(page, '.msg-out', 'end');
    await page.keyboard.press('Enter');
    await page.keyboard.type('bin da');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Erzählung');
    expect(await readHtml(page)).toBe('<p>Vorher</p><div class="msg-thread"><p class="msg-name">Lena</p>'
      + '<p class="msg-in">Hallo</p><p class="msg-out">Hi</p><p class="msg-out">bin da</p></div>'
      + '<p>Erzählung</p><p>Nachher</p>');
    await expectIntact(page, 'Doppel-Enter');
  });

  test('Enter auf leerer Zeile mitten im Verlauf teilt ihn', async ({ page }) => {
    await enterFocus(page);
    await seed(page, '.msg-in', 'end');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Pause');
    expect(await readHtml(page)).toBe('<p>Vorher</p><div class="msg-thread"><p class="msg-name">Lena</p>'
      + '<p class="msg-in">Hallo</p></div><p>Pause</p><div class="msg-thread"><p class="msg-out">Hi</p></div>'
      + '<p>Nachher</p>');
    await expectIntact(page, 'Teilen');
  });

  test('Backspace am Verlaufsanfang löst die Zeile als Absatz heraus', async ({ page }) => {
    await enterFocus(page);
    await seed(page, '.msg-name', 'start');
    await page.keyboard.press('Backspace');
    expect(await readHtml(page)).toBe('<p>Vorher</p><p>Lena</p><div class="msg-thread">'
      + '<p class="msg-in">Hallo</p><p class="msg-out">Hi</p></div><p>Nachher</p>');
    await expectIntact(page, 'Backspace Anfang');
  });

  test('Backspace hinter dem Verlauf hängt an die letzte Zeile, ohne Inline-style', async ({ page }) => {
    await enterFocus(page);
    await seed(page, 'div.msg-thread + p', 'start');
    await page.keyboard.press('Backspace');
    expect(await readHtml(page)).toBe('<p>Vorher</p><div class="msg-thread"><p class="msg-name">Lena</p>'
      + '<p class="msg-in">Hallo</p><p class="msg-out">HiNachher</p></div>');
    await expectIntact(page, 'Backspace danach');
  });

  test('Delete zwischen zwei Zeilen: die empfangende behält ihre Art', async ({ page }) => {
    await enterFocus(page);
    await seed(page, '.msg-in', 'end');
    await page.keyboard.press('Delete');
    expect(await readHtml(page)).toBe('<p>Vorher</p><div class="msg-thread"><p class="msg-name">Lena</p>'
      + '<p class="msg-in">HalloHi</p></div><p>Nachher</p>');
    await expectIntact(page, 'Delete');
  });

  test('Tab wechselt im Focus-Editor keine Seite', async ({ page }) => {
    await enterFocus(page);
    await seed(page, '.msg-in', 'end');
    await page.keyboard.press('Tab');
    expect(await readHtml(page)).toContain('<p class="msg-in">Hallo</p>');
  });
});
