// Einfügeort und Löschen an verschachtelten Grenzen im NOTEBOOK-Editor, gegen
// die ECHTE App. Schwesterspecs: notebook-keyboard.spec.js,
// notebook-block-boundaries.spec.js, notebook-slash-in-list.spec.js.
//
// Geprüft:
//   1. Trennlinie (Knopf, Cmd+Shift+H) landet nie in Liste, Verlauf oder
//      Abbildung (edit/view.js#insertHorizontalRule → caret-panel.js).
//   2. Tabelle/Diagramm/Bild mit Caret in einer leeren Zitat-/Verlaufszeile
//      stehen HINTER dem Wrapper, mit Caret in der Bildunterschrift hinter der
//      Abbildung; ein inzwischen beschriebener Ziel-Absatz wird nicht ersetzt
//      (caret-panel.js#blockInsertTarget/placeBlockNode).
//   3. Seiten-Toolbar ohne Caret im Editor nimmt die zuletzt gesehene Stelle,
//      nicht den Anfang (panel-methods.js#_editRangeForInsert).
//   4. Backspace am Anfang einer Unterlisten-Zeile löscht kein Bild darüber
//      (shared/block-edge.js#caretEdge zählt Text vor der Unterliste).
//   5. Überschrift ↔ Absatz verschmelzen ohne Inline-`style`.
//   6. Liste als Rand eines Zitats: Backspace/Delete daneben treffen deren
//      Randzeile; Zeilen der Liste verschmelzen ohne Browser-Merge.
//   7. Ein weicher Umbruch am Absatzanfang ist Inhalt: Backspace löscht ihn,
//      statt den Absatz hochzuziehen (shared/dom-block.js#caretAtBlockStart).
//   8. Auswahl bis an den Anfang des Folgeblocks zieht ihn nicht herein; eine
//      Auswahl ab vor der Checkbox lässt die Checkbox stehen
//      (line-merge.js#deleteRangeClean).
//   9. Enter/Shift+Enter über eine Auswahl über eine Blockgrenze: kein
//      Inline-`style` (toolbar/keydown-delete.js#_kbCollapseForInsert).
//  10. Zitat ohne `<p>` (Import-Markup): Enter verliert keinen Text,
//      Doppel-Enter verlässt es (keydown-enter.js#_kbQuoteEnter).
//  11. Einfügen: editor-interne Kopie behält Abbildung/Diagramm/Checkbox,
//      Google-Docs- und Word-Markup wird Auszeichnung bzw. Liste, mehrere
//      Zeilen in Legende/Checkbox-/Verlaufszeile je nach Ziel
//      (shared/paste.js, utils/html.js#sanitizePasteHtml, edit/input.js).
//  12. Struktur-Taste und das danach Getippte sind getrennte Undo-Schritte
//      (toolbar/_shared.js#historyStep).
//  13. Kürzel bei offenem Slash-Menü schliessen es (toolbar/keydown.js).

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

// Auswahl zwischen zwei Punkten; Offset als Zahl = im ersten Textknoten von
// `sel`, als 'el:N' = Kind-Index im Element selbst.
async function range(page, sc, so, ec, eo) {
  await page.evaluate(({ sc, so, ec, eo, s }) => {
    const ed = document.querySelector(s);
    const pt = (sel, o) => {
      const el = ed.querySelector(sel);
      return typeof o === 'string' ? [el, Number(o.slice(3))] : [el.firstChild, o];
    };
    const r = document.createRange();
    r.setStart(...pt(sc, so));
    r.setEnd(...pt(ec, eo));
    const g = document.getSelection();
    g.removeAllRanges();
    g.addRange(r);
  }, { sc, so, ec, eo, s: EDIT_SEL });
}

async function paste(page, data) {
  await page.evaluate(({ data, s }) => {
    const dt = new DataTransfer();
    for (const [k, v] of Object.entries(data)) dt.setData(k, v);
    document.querySelector(s).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { data, s: EDIT_SEL });
}

async function placeTable(page) {
  return page.evaluate(async (s) => {
    const m = await import('/js/editor/notebook/toolbar/caret-panel.js');
    const editEl = document.querySelector(s);
    const tgt = m.blockInsertTarget(editEl, document.getSelection().getRangeAt(0));
    const t = document.createElement('table');
    t.innerHTML = '<tbody><tr><td>x</td></tr></tbody>';
    m.placeBlockNode(editEl, t, tgt);
  }, EDIT_SEL);
}

test.describe('Notebook — Einfügeort und verschachtelte Grenzen', () => {
  test('Trennlinie landet nie in Liste, Verlauf oder Abbildung', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<ul><li>Eins</li><li>Zwei</li></ul>', 'li', 'end');
    await page.keyboard.press(`${MOD}+Shift+h`);
    expect(await readHtml(page)).toBe('<ul><li>Eins</li><li>Zwei</li></ul><hr><p><br></p>');
    await seed(page, '<div class="msg-thread"><p class="msg-in">Hallo</p><p class="msg-in"><br></p></div>', '.msg-in + p', 'start');
    await page.keyboard.press(`${MOD}+Shift+h`);
    expect(await readHtml(page)).toBe('<div class="msg-thread"><p class="msg-in">Hallo</p></div><hr><p><br></p>');
    await seed(page, `<figure><img src="${PX}" alt=""><figcaption>Leg</figcaption></figure><p>B</p>`, 'figcaption', 'end');
    await page.keyboard.press(`${MOD}+Shift+h`);
    expect(await readHtml(page)).toBe('<figure><img src="PX" alt=""><figcaption>Leg</figcaption></figure><hr><p><br></p><p>B</p>');
    await expectNoStyle(page, 'Trennlinie');
  });

  test('Block aus Zitat-/Verlaufszeile und Legende landet dahinter', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<div class="msg-thread"><p class="msg-in">Hi</p><p class="msg-in"><br></p></div><p>N</p>', '.msg-in + p', 'start');
    await placeTable(page);
    expect(await readHtml(page)).toBe('<div class="msg-thread"><p class="msg-in">Hi</p></div><table><tbody><tr><td>x</td></tr></tbody></table><p>N</p>');
    await seed(page, '<blockquote data-src="1"><p>Z</p><p><br></p></blockquote>', 'blockquote p + p', 'start');
    await placeTable(page);
    expect(await readHtml(page)).toBe('<blockquote data-src="1"><p>Z</p></blockquote><table><tbody><tr><td>x</td></tr></tbody></table>');
    await seed(page, `<figure><img src="${PX}" alt=""><figcaption>Leg</figcaption></figure><p>B</p>`, 'figcaption', 'end');
    await placeTable(page);
    expect(await readHtml(page)).toBe('<figure><img src="PX" alt=""><figcaption>Leg</figcaption></figure><table><tbody><tr><td>x</td></tr></tbody></table><p>B</p>');
  });

  test('Inzwischen beschriebener Ziel-Absatz wird nicht ersetzt', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<p>A</p><p><br></p>', 'p + p', 'start');
    const out = await page.evaluate(async (s) => {
      const m = await import('/js/editor/notebook/toolbar/caret-panel.js');
      const editEl = document.querySelector(s);
      const tgt = m.blockInsertTarget(editEl, document.getSelection().getRangeAt(0));
      tgt.replace.textContent = 'getippt';
      const t = document.createElement('table');
      t.innerHTML = '<tbody><tr><td>x</td></tr></tbody>';
      m.placeBlockNode(editEl, t, tgt);
      return editEl.innerHTML.replace(/ data-bid="[^"]*"/g, '');
    }, EDIT_SEL);
    expect(out).toBe('<p>A</p><p>getippt</p><table><tbody><tr><td>x</td></tr></tbody></table>');
  });

  test('Seiten-Toolbar ohne Caret im Editor nimmt die zuletzt gesehene Stelle', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<p>Eins</p><p>Zwei</p><p>Drei</p>', 'p + p', 'end');
    await page.waitForTimeout(100); // selectionchange merkt die Stelle
    await page.evaluate(() => {
      const o = document.createElement('div');
      o.textContent = 'aussen';
      document.body.appendChild(o);
      const r = document.createRange();
      r.selectNodeContents(o);
      const g = document.getSelection();
      g.removeAllRanges();
      g.addRange(r);
      document.activeElement?.blur();
    });
    await page.evaluate(() => window.__app.editorInsert('hr'));
    await page.waitForTimeout(100);
    expect(await readHtml(page)).toBe('<p>Eins</p><p>Zwei</p><hr><p><br></p><p>Drei</p>');
  });

  test('Unterlisten-Zeile: Backspace löscht kein Bild und keine Linie darüber', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, `<figure><img src="${PX}" alt=""><figcaption>L</figcaption></figure><ul><li>A<ul><li>A1</li></ul></li></ul>`, 'li li', 'start');
    await page.keyboard.press('Backspace');
    expect(await readHtml(page)).toBe('<figure><img src="PX" alt=""><figcaption>L</figcaption></figure><ul><li>AA1</li></ul>');
    await seed(page, '<hr><ul><li>A<ul><li>A1</li></ul></li></ul>', 'li li', 'start');
    await page.keyboard.press('Backspace');
    expect(await readHtml(page)).toBe('<hr><ul><li>AA1</li></ul>');
  });

  test('Überschrift ↔ Absatz verschmelzen ohne Inline-style', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<h2>Titel</h2><p>Text</p>', 'p', 'start');
    await page.keyboard.press('Backspace');
    expect(await readHtml(page)).toBe('<h2>TitelText</h2>');
    await seed(page, '<p>Text</p><h2>Titel</h2>', 'p', 'end');
    await page.keyboard.press('Delete');
    expect(await readHtml(page)).toBe('<p>TextTitel</p>');
    await expectNoStyle(page, 'Überschrift');
  });

  test('Liste im Zitat: Randzeilen statt Browser-Merge', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<blockquote><p>a</p><ul><li>b</li></ul></blockquote><p>c</p>', 'blockquote + p', 'start');
    await page.keyboard.press('Backspace');
    expect(await readHtml(page)).toBe('<blockquote><p>a</p><ul><li>bc</li></ul></blockquote>');
    await seed(page, '<p>c</p><blockquote><ul><li>b</li></ul><p>a</p></blockquote>', 'p', 'end');
    await page.keyboard.press('Delete');
    expect(await readHtml(page)).toBe('<p>cb</p><blockquote><p>a</p></blockquote>');
    await seed(page, '<blockquote><ul><li>a</li><li>b</li></ul></blockquote>', 'li + li', 'start');
    await page.keyboard.press('Backspace');
    expect(await readHtml(page)).toBe('<blockquote><ul><li>ab</li></ul></blockquote>');
    await seed(page, '<blockquote><ul><li>b</li></ul></blockquote><p>Y</p>', 'blockquote li', 'end');
    await page.keyboard.press('Delete');
    expect(await readHtml(page), 'am Rand des Zitats kein Merge hinaus').toBe('<blockquote><ul><li>b</li></ul></blockquote><p>Y</p>');
    await expectNoStyle(page, 'Liste im Zitat');
  });

  test('Weicher Umbruch am Absatzanfang: Backspace löscht nur ihn', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<p>Vorher</p><p><br>Zeile</p>', 'p + p', 'end');
    await page.evaluate((s) => {
      const p = document.querySelector(`${s} p + p`);
      const r = document.createRange();
      r.setStart(p.lastChild, 0);
      r.collapse(true);
      const g = document.getSelection();
      g.removeAllRanges();
      g.addRange(r);
    }, EDIT_SEL);
    await page.keyboard.press('Backspace');
    expect(await readHtml(page)).toBe('<p>Vorher</p><p>Zeile</p>');
  });

  test('Auswahl bis zum Anfang des Folgeblocks zieht ihn nicht herein', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<h2>Titel</h2><p>Absatz</p>', 'h2', 0);
    await range(page, 'h2', 0, 'p', 'el:0');
    await page.keyboard.type('X');
    expect(await readHtml(page)).toBe('<h2>X</h2><p>Absatz</p>');
  });

  test('Auswahl ab vor der Checkbox lässt die Checkbox stehen', async ({ page }) => {
    await enterNotebookEdit(page);
    const todo = (t) => `<li class="todo-item"><input type="checkbox"><span class="todo-text">${t}</span></li>`;
    await seed(page, `<ul class="todo">${todo('Eins')}${todo('Zwei')}</ul>`, '.todo-text', 0);
    await range(page, 'li', 'el:0', 'li + li .todo-text', 2);
    await page.keyboard.press('Backspace');
    expect(await readHtml(page)).toBe(`<ul class="todo">${todo('ei')}</ul>`);
  });

  test('Enter und Shift+Enter über eine Auswahl Absatz ↔ Zitat: kein Inline-style', async ({ page }) => {
    await enterNotebookEdit(page);
    const html = '<p>Vorher</p><blockquote><p>Zitat</p></blockquote>';
    await seed(page, html, 'p', 0);
    await range(page, 'p', 3, 'blockquote p', 2);
    await page.keyboard.press('Enter');
    expect(await readHtml(page)).toBe('<p>Vor</p><p>tat</p>');
    await seed(page, html, 'p', 0);
    await range(page, 'p', 3, 'blockquote p', 2);
    await page.keyboard.press('Shift+Enter');
    expect(await readHtml(page)).toBe('<p>Vor<br>tat</p>');
    await expectNoStyle(page, 'Enter über Auswahl');
  });

  test('Zitat ohne <p>: Enter verliert keinen Text, Doppel-Enter verlässt es', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<blockquote>Zitattext<p><br></p></blockquote>', 'blockquote p', 'start');
    await page.keyboard.press('Enter');
    expect(await readHtml(page)).toBe('<blockquote><p>Zitattext</p></blockquote><p><br></p>');
    await seed(page, '<blockquote data-src="1">Zitattext</blockquote>', 'blockquote', 'end');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('X');
    expect(await readHtml(page)).toBe('<blockquote data-src="1"><p>Zitattext</p></blockquote><p>X</p>');
  });

  test('Code-Block in <code>: Doppel-Enter am Ende lässt keine Leerzeile stehen', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<pre><code>a<br>b</code></pre>', 'code', 'end');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    expect(await readHtml(page)).toBe('<pre><code>a<br>b</code></pre><p><br></p>');
  });

  test('Einfügen einer editor-internen Kopie behält Abbildung, Diagramm und Checkbox', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'ClipboardEvent traegt in Gecko kein synthetisches DataTransfer');
    await enterNotebookEdit(page);
    const own = `<figure><img src="${PX}" alt="x"><figcaption>Unter</figcaption><p class="figure-credit">Foto: K</p></figure>`
      + '<pre class="mermaid">graph TD</pre>'
      + '<ul class="todo"><li class="todo-item"><input type="checkbox" checked=""><span class="todo-text">T</span></li></ul>';
    await seed(page, '<p>X</p><p><br></p>', 'p + p', 'start');
    await paste(page, { 'text/plain': 'Unter', 'text/html': '<p>Unter</p>', 'text/x-schreibwerkstatt-html': own });
    expect(await readHtml(page)).toBe(`<p>X</p>${own.replace(PX, 'PX')}`);
    await expectNoStyle(page, 'interne Kopie');
  });

  test('Einfügen aus Google Docs und Word: Auszeichnung und echte Liste', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'ClipboardEvent traegt in Gecko kein synthetisches DataTransfer');
    await enterNotebookEdit(page);
    await seed(page, '<p>X</p>', 'p', 'end');
    await paste(page, { 'text/html': '<b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr">'
      + '<span style="font-weight:400">Normal </span><span style="font-weight:700">fett</span><span style="font-style:italic">kursiv</span></p></b>' });
    expect(await readHtml(page)).toBe('<p>XNormal <strong>fett</strong><em>kursiv</em></p>');
    await seed(page, '<p>X</p><p><br></p>', 'p + p', 'start');
    await paste(page, { 'text/html': "<p class=MsoListParagraphCxSpFirst style='mso-list:l0 level1 lfo1'><![if !supportLists]>"
      + "<span style='mso-list:Ignore'>·<span>&nbsp;&nbsp;</span></span><![endif]>Eins</p>"
      + "<p class=MsoListParagraphCxSpLast style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>·<span>&nbsp;</span></span>Zwei</p>" });
    expect(await readHtml(page)).toBe('<p>X</p><ul><li>Eins</li><li>Zwei</li></ul>');
    await expectNoStyle(page, 'Office');
  });

  test('Mehrere Zeilen in Legende, Checkbox- und Verlaufszeile', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'ClipboardEvent traegt in Gecko kein synthetisches DataTransfer');
    await enterNotebookEdit(page);
    const lines = { 'text/plain': 'Eins\nZwei', 'text/html': '<p>Eins</p><p>Zwei</p>' };
    await seed(page, `<figure><img src="${PX}" alt=""><figcaption>Leg</figcaption></figure><p>T</p>`, 'figcaption', 'end');
    await paste(page, lines);
    expect(await readHtml(page)).toBe('<figure><img src="PX" alt=""><figcaption>LegEins Zwei</figcaption></figure><p>T</p>');
    await seed(page, '<ul class="todo"><li class="todo-item"><input type="checkbox"><span class="todo-text">A</span></li></ul>', '.todo-text', 'end');
    await paste(page, lines);
    expect(await readHtml(page)).toBe('<ul class="todo"><li class="todo-item"><input type="checkbox"><span class="todo-text">AEins</span></li>'
      + '<li class="todo-item"><input type="checkbox"><span class="todo-text">Zwei</span></li></ul>');
    await seed(page, '<div class="msg-thread"><p class="msg-out">Hi</p></div>', '.msg-out', 'end');
    await paste(page, lines);
    expect(await readHtml(page)).toBe('<div class="msg-thread"><p class="msg-out">HiEins</p><p class="msg-out">Zwei</p></div>');
    await expectNoStyle(page, 'Zeilen einfügen');
  });

  test('Struktur-Taste und danach Getipptes sind getrennte Undo-Schritte', async ({ page }) => {
    await enterNotebookEdit(page);
    const brot = '<ul class="todo"><li class="todo-item"><input type="checkbox"><span class="todo-text">Brot</span></li>';
    await seed(page, `${brot}</ul>`, '.todo-text', 'end');
    await page.waitForTimeout(700);
    await page.keyboard.press('Enter');
    await page.keyboard.type('Milch');
    await page.keyboard.press(`${MOD}+z`);
    expect(await readHtml(page)).toBe(`${brot}<li class="todo-item"><input type="checkbox"><span class="todo-text"><br></span></li></ul>`);
  });

  test('Kürzel bei offenem Slash-Menü schliesst es', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<p>A</p><p><br></p>', 'p + p', 'start');
    await page.keyboard.type('/');
    const menu = page.locator('.edit-slash-menu');
    await expect(menu).toBeVisible();
    await page.keyboard.press(`${MOD}+b`);
    await expect(menu).toBeHidden();
  });
});
