// Nachrichtenverlauf im NOTEBOOK-Editor: Bedienung über mehrere Zeilen und
// Undo der Zeilenart. Tab und Zeilenleiste wirken auf alle markierten Zeilen,
// beide sind ein eigener Undo-Schritt, und eingefügte Verlaufszeilen bringen
// ihre Art mit (docs/nachrichtenverlauf.md § 2).
//
// Gegen die echte App (wie notebook-msg-thread.spec.js): Undo-Kern, Paste-
// Pipeline und Zeilenleiste hängen an der gebooteten Karte.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';

async function enterNotebookEdit(page) {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
  await page.waitForTimeout(300);
}

// Seed + Auswahl vom Anfang der Zeile `from` bis zum Ende der Zeile `to`
// (kollabiert, wenn `to` fehlt: Caret am Ende von `from`).
async function seed(page, html, from, to = null) {
  await page.evaluate(({ html, from, to }) => {
    const editEl = document.querySelector('#editor-card .page-content-view--editing');
    editEl.innerHTML = html;
    editEl.focus({ preventScroll: true });
    const a = editEl.querySelector(from);
    const r = document.createRange();
    if (to) {
      const b = editEl.querySelector(to);
      r.setStart(a.firstChild, 0);
      r.setEnd(b.firstChild, b.firstChild.length);
    } else {
      r.selectNodeContents(a);
      r.collapse(false);
    }
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
  }, { html, from, to });
  await page.waitForTimeout(400);
}

function kinds(page) {
  return page.evaluate(() => [...document.querySelectorAll('#editor-card .page-content-view--editing .msg-thread > p')]
    .map((p) => `${p.className}:${p.textContent}`));
}

async function undo(page) {
  await page.evaluate(() => window.__app.notebookUndo());
  await page.waitForTimeout(200);
}

const THREAD = '<p>Vorher</p><div class="msg-thread"><p class="msg-name">Lena</p><p class="msg-in">a</p>'
  + '<p class="msg-out">b</p><p class="msg-in">c</p></div><p>Nachher</p>';

test.describe('Notebook — Nachrichtenverlauf über mehrere Zeilen', () => {
  test('Tab auf markierten Zeilen wechselt jede Nachricht, Absender bleibt; Undo nimmt nur das zurück', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, THREAD, '.msg-name', '.msg-thread > p:last-child');
    await page.keyboard.press('Tab');
    expect(await kinds(page)).toEqual(['msg-name:Lena', 'msg-out:a', 'msg-in:b', 'msg-out:c']);
    await undo(page);
    expect(await kinds(page)).toEqual(['msg-name:Lena', 'msg-in:a', 'msg-out:b', 'msg-in:c']);
  });

  test('Tab nach dem Tippen: Undo nimmt nur den Seitenwechsel zurück, das Getippte bleibt', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, THREAD, '.msg-in');
    await page.keyboard.type('xy');
    await page.keyboard.press('Tab');
    expect(await kinds(page)).toContain('msg-out:axy');
    await undo(page);
    expect(await kinds(page)).toContain('msg-in:axy');
  });

  test('Zeilenleiste setzt die Art aller markierten Zeilen', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, THREAD, '.msg-thread > p:nth-child(2)', '.msg-thread > p:nth-child(3)');
    await page.waitForSelector('.edit-msg-bar', { state: 'visible', timeout: 5000 });
    await page.locator('.edit-msg-bar .edit-msg-btn').nth(3).click();
    expect(await kinds(page)).toEqual(['msg-name:Lena', 'msg-meta:a', 'msg-meta:b', 'msg-in:c']);
    await undo(page);
    expect(await kinds(page)).toEqual(['msg-name:Lena', 'msg-in:a', 'msg-out:b', 'msg-in:c']);
  });

  test('Einfügen kopierter Verlaufszeilen behält Ein-/Ausgang, Absender und Hinweis', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'ClipboardEvent traegt in Gecko kein synthetisches DataTransfer');
    await enterNotebookEdit(page);
    await seed(page, '<div class="msg-thread"><p class="msg-in">x</p><p class="msg-in"><br></p></div>',
      '.msg-thread > p:last-child');
    await page.evaluate(() => {
      const editEl = document.querySelector('#editor-card .page-content-view--editing');
      const dt = new DataTransfer();
      dt.setData('text/plain', 'Tom\nhi\nna?\n14:32');
      dt.setData('text/html', '<p class="msg-name">Tom</p><p class="msg-out">hi</p><p class="msg-in">na?</p><p class="msg-meta">14:32</p>');
      editEl.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(200);
    expect(await kinds(page)).toEqual(['msg-in:x', 'msg-name:Tom', 'msg-out:hi', 'msg-in:na?', 'msg-meta:14:32']);
  });

  test('Einfügen von Klartext-Zeilen schreibt die Art der Zielzeile weiter', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'ClipboardEvent traegt in Gecko kein synthetisches DataTransfer');
    await enterNotebookEdit(page);
    await seed(page, '<div class="msg-thread"><p class="msg-out">x</p></div>', '.msg-out');
    await page.evaluate(() => {
      const editEl = document.querySelector('#editor-card .page-content-view--editing');
      const dt = new DataTransfer();
      dt.setData('text/plain', ' eins\nzwei');
      editEl.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(200);
    expect(await kinds(page)).toEqual(['msg-out:xeins', 'msg-out:zwei']);
  });
});
