// Tastatur im NOTEBOOK-Editor gegen die ECHTE App — die Fälle, die nur ein
// Browser mit Editing-Default zeigt (Schwesterspecs: notebook-block-
// boundaries.spec.js, notebook-todo-delete.spec.js). Unit-Gegenstück für die
// DOM-reinen Teile: tests/unit/notebook-keyboard.test.mjs.
//
// Geprüft (public/js/editor/notebook/toolbar/keydown*.js, line-merge.js,
// slash.js, shared/inline-format.js, shared/paste.js):
//   1. Diagramm als Nachbar: Backspace/Delete merged nie in den Quelltext.
//   2. Backspace in Zeile 2 eines Zitats löscht nicht das Bild darüber.
//   3. Enter in einer Checkbox-Zeile teilt am Caret; am Zeilenanfang neue
//      Zeile darüber.
//   4. Enter auf leerer Zeile mitten im Gedicht teilt es.
//   5. Auswahl über Absatz ↔ Zitat löschen/überschreiben/ausschneiden: kein
//      Inline-`style`.
//   6. Cmd/Ctrl+I im (CSS-kursiven) Zitat: kein Inline-`style`.
//   7. `/` am Absatzanfang wandelt den Absatz um; ← schliesst das Menü.
//   8. Cmd/Ctrl+K mit Markierung öffnet den Link-Eingang, nicht die Palette.
//   9. Liste mit Unterliste: Backspace hängt an die tiefste Zeile darüber.
//  10. Struktur-Taste ist ein eigener Undo-Schritt.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';
const PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

async function enterNotebookEdit(page) {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
  await page.waitForTimeout(300);
}

// Inhalt setzen, Caret an `pos` ('start'|'end'|Zahl = Textoffset) in `target`.
async function seed(page, html, target, pos) {
  await page.evaluate(({ html, target, pos, EDIT_SEL }) => {
    const editEl = document.querySelector(EDIT_SEL);
    editEl.innerHTML = html;
    editEl.focus({ preventScroll: true });
    const el = editEl.querySelector(target);
    const r = document.createRange();
    if (typeof pos === 'number') {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n; let left = pos;
      while ((n = walker.nextNode())) {
        if (left <= n.data.length) { r.setStart(n, left); break; }
        left -= n.data.length;
      }
      r.collapse(true);
    } else {
      r.selectNodeContents(el);
      r.collapse(pos === 'start');
    }
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }, { html, target, pos, EDIT_SEL });
}

// Auswahl vom Textoffset `a` in `fromSel` bis `b` in `toSel`.
async function select(page, fromSel, a, toSel, b) {
  await page.evaluate(({ fromSel, a, toSel, b, EDIT_SEL }) => {
    const editEl = document.querySelector(EDIT_SEL);
    const text = (sel) => editEl.querySelector(sel).firstChild;
    const r = document.createRange();
    r.setStart(text(fromSel), a);
    r.setEnd(text(toSel), b);
    const s = document.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }, { fromSel, a, toSel, b, EDIT_SEL });
}

const readHtml = (page) => page.evaluate((s) => document.querySelector(s).innerHTML
  .replace(/ data-bid="[^"]*"/g, '')
  .replace(/ contenteditable="false"/g, '')
  .replace(/data:image\/gif;base64,[^"]*/g, 'PX'), EDIT_SEL);

async function expectNoStyle(page, label) {
  const n = await page.evaluate((s) => document.querySelector(s).querySelectorAll('[style]').length, EDIT_SEL);
  expect(n, `${label}: kein Inline-style`).toBe(0);
}

test.describe('Notebook — Tastatur', () => {
  test('Diagramm-Nachbar: Backspace/Delete lassen den Quelltext unangetastet', async ({ page }) => {
    await enterNotebookEdit(page);
    const html = '<p>Vorher</p><pre class="mermaid">graph TD</pre><p>Nachher</p>';
    await seed(page, html, 'pre + p', 'start');
    await page.keyboard.press('Backspace');
    expect(await page.evaluate((s) => document.querySelector(`${s} pre`).textContent, EDIT_SEL)).toBe('graph TD');
    expect(await page.evaluate((s) => document.querySelector(`${s} pre + p`).textContent, EDIT_SEL)).toBe('Nachher');
    await seed(page, html, 'p', 'end');
    await page.keyboard.press('Delete');
    expect(await page.evaluate((s) => document.querySelector(`${s} > p`).textContent, EDIT_SEL)).toBe('Vorher');
    await expectNoStyle(page, 'Diagramm');
  });

  test('Backspace in Zeile 2 eines Zitats löscht nicht das Bild darüber', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, `<figure><img src="${PX}" alt=""><figcaption>L</figcaption></figure><blockquote><p>Eins</p><p>Zwei</p></blockquote>`,
      'blockquote p:last-child', 'start');
    await page.keyboard.press('Backspace');
    expect(await readHtml(page)).toBe('<figure><img src="PX" alt=""><figcaption>L</figcaption></figure><blockquote><p>EinsZwei</p></blockquote>');
  });

  test('Checkbox-Zeile: Enter teilt am Caret, am Zeilenanfang neue Zeile darüber', async ({ page }) => {
    await enterNotebookEdit(page);
    const todo = '<ul class="todo"><li class="todo-item"><input type="checkbox"><span class="todo-text">Einkaufen</span></li></ul>';
    await seed(page, todo, '.todo-text', 3);
    await page.keyboard.press('Enter');
    expect(await page.evaluate((s) => [...document.querySelectorAll(`${s} .todo-text`)].map((x) => x.textContent), EDIT_SEL))
      .toEqual(['Ein', 'kaufen']);
    await seed(page, todo, '.todo-text', 'start');
    await page.keyboard.press('Enter');
    expect(await page.evaluate((s) => [...document.querySelectorAll(`${s} .todo-text`)].map((x) => x.textContent.trim()), EDIT_SEL))
      .toEqual(['', 'Einkaufen']);
  });

  test('Gedicht: Enter auf leerer Zeile in der Mitte teilt es', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<div class="poem"><p>Eins</p><p><br></p><p>Zwei</p></div>', '.poem p:nth-child(2)', 'start');
    await page.keyboard.press('Enter');
    expect(await readHtml(page)).toBe('<div class="poem"><p>Eins</p></div><p><br></p><div class="poem"><p>Zwei</p></div>');
  });

  test('Auswahl über Absatz ↔ Zitat: löschen, überschreiben, ausschneiden ohne Inline-style', async ({ page }) => {
    await enterNotebookEdit(page);
    const html = '<p>Vorher</p><blockquote><p>Zitat</p></blockquote>';
    await seed(page, html, 'p', 'start');
    await select(page, ':scope > p', 3, 'blockquote p', 2);
    await page.keyboard.press('Backspace');
    expect(await readHtml(page)).toBe('<p>Vortat</p>');
    await expectNoStyle(page, 'Backspace');

    await seed(page, html, 'p', 'start');
    await select(page, ':scope > p', 3, 'blockquote p', 2);
    await page.keyboard.type('x');
    expect(await readHtml(page)).toBe('<p>Vorxtat</p>');
    await expectNoStyle(page, 'Tippen');

    await seed(page, html, 'p', 'start');
    await select(page, ':scope > p', 3, 'blockquote p', 2);
    await page.keyboard.press(`${MOD}+x`);
    expect(await readHtml(page)).toBe('<p>Vortat</p>');
    await expectNoStyle(page, 'Ausschneiden');
  });

  test('Cmd/Ctrl+I im Zitat schreibt kein Inline-style', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<blockquote><p>Ganz kursiv</p></blockquote>', 'blockquote p', 'start');
    await select(page, 'blockquote p', 0, 'blockquote p', 4);
    await page.keyboard.press(`${MOD}+i`);
    await expectNoStyle(page, 'Auswahl');
    await seed(page, '<blockquote><p>Ganz kursiv</p></blockquote>', 'blockquote p', 4);
    await page.keyboard.press(`${MOD}+i`);
    await page.keyboard.type('x');
    await expectNoStyle(page, 'Caret + Tippen');
  });

  test('Slash am Absatzanfang wandelt um; Pfeiltaste schliesst das Menü', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<p>Titel <em>hier</em></p>', 'p', 'start');
    await page.keyboard.press('/');
    await page.waitForSelector('.edit-slash-menu', { state: 'visible', timeout: 5000 });
    await page.keyboard.type('h2');
    await page.keyboard.press('Enter');
    expect(await readHtml(page)).toBe('<h2>Titel <em>hier</em></h2>');

    await seed(page, '<p>Text</p>', 'p', 'start');
    await page.keyboard.press('/');
    await page.waitForSelector('.edit-slash-menu', { state: 'visible', timeout: 5000 });
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.edit-slash-menu')).toBeHidden();

    await seed(page, '<p>Text</p>', 'p', 2);
    await page.keyboard.press('/');
    expect(await readHtml(page)).toBe('<p>Te/xt</p>');
  });

  test('Cmd/Ctrl+K mit Markierung öffnet den Link-Eingang statt der Palette', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<p>Ein Link</p>', 'p', 'start');
    await select(page, 'p', 4, 'p', 8);
    await page.keyboard.press(`${MOD}+k`);
    await expect(page.locator('.edit-link-bar')).toBeVisible();
    await expect(page.locator('.palette-overlay')).toBeHidden();
  });

  test('Liste mit Unterliste: Backspace hängt an die tiefste Zeile darüber', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<ul><li>A<ul><li>A1</li></ul></li><li>B</li></ul>', ':scope > ul > li:last-child', 'start');
    await page.keyboard.press('Backspace');
    expect(await readHtml(page)).toBe('<ul><li>A<ul><li>A1B</li></ul></li></ul>');
    await expectNoStyle(page, 'Unterliste');
  });

  test('Enter in der Checkbox-Liste ist ein eigener Undo-Schritt', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<ul class="todo"><li class="todo-item"><input type="checkbox"><span class="todo-text">Ab</span></li></ul>', '.todo-text', 'end');
    await page.evaluate(() => window.__app._historyReset?.(document.querySelector('#editor-card .page-content-view--editing').innerHTML));
    await page.keyboard.type('c');
    await page.keyboard.press('Enter');
    await page.keyboard.press(`${MOD}+z`);
    expect(await page.evaluate((s) => [...document.querySelectorAll(`${s} .todo-text`)].map((x) => x.textContent), EDIT_SEL))
      .toEqual(['Abc']);
  });
});
