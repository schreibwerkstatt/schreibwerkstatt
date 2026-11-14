// Block-Transforms des Slash-Menüs INNERHALB einer Liste — NOTEBOOK-Editor,
// gegen die ECHTE App.
//
// WARUM DIESE SCHICHT: der Ausgangszustand entsteht durch Chromiums eigenes
// contenteditable-Verhalten — Enter am Ende einer `<li>` legt die nächste `<li>`
// an, und genau in dieser leeren `<li>` greift der Slash-Trigger. In
// linkedom/jsdom gibt es kein Editing-Default, der Zustand wäre dort
// handgeschrieben und die Regression unsichtbar. Dazu kommt, dass das Menü nach
// <body> teleportiert wird und nur im echten Template-Baum anklickbar ist.
//
// WARUM DAS ZÄHLT: der Caret-Block ist in einer Liste die `<li>`
// (`CARET_BLOCK_SEL`). Ersetzt man sie an Ort und Stelle, landet der neue Block
// als Kind der `<ul>`/`<ol>`. Das ist ungültiges Markup, `cleanPageHtml` räumt
// es nicht auf (es überlebt Save + Reload), und Chromium hängt jeden per Enter
// erzeugten Folgeblock ebenfalls in die Liste — nach einem eingefügten
// Listen-Absatz (z.B. aus einer Outlook-Mail) führt dann kein Weg mehr aus der
// Liste heraus.
//
// Geprüfte Invarianten (public/js/editor/notebook/toolbar/_shared.js
// #replaceBlockOutsideList, konsumiert von slash.js/table.js/diagram.js):
//   1. Ein per Slash erzeugter Block ist danach Kind des Editor-Roots, nie Kind
//      einer Liste.
//   2. Die Liste wird an der Stelle aufgetrennt: was danach kam, bleibt als
//      zweite Liste dahinter stehen (bei `<ol>` mit fortgesetzter Nummerierung).
//   3. Verschachtelte Listen werden bis zum Root aufgetrennt.
//   4. Eine leer gewordene Listen-Hülle verschwindet.
//   5. Aus Zitat/Gedicht/Verlauf heraus: Überschrift, Absatz, Trennlinie und
//      eingesetzte Blöcke (Tabelle, Diagramm, Bild) stehen danach ausserhalb
//      (slash.js#placeOutsideWrapper, caret-panel.js#placeBlockNode); Listen,
//      Checklisten und Zitate dürfen im Wrapper stehen.
//   6. Kein Tastendruck/Transform erzeugt ein `style`-Attribut.

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

// Inhalt setzen und den Caret ans Ende von `caretSel` legen. Kein input-Event →
// editDirty bleibt false → der Seed wird nicht gespeichert.
async function seed(page, html, caretSel) {
  await page.evaluate(({ html, caretSel, EDIT_SEL }) => {
    const editEl = document.querySelector(EDIT_SEL);
    editEl.innerHTML = html;
    editEl.focus();
    const el = editEl.querySelector(caretSel);
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }, { html, caretSel, EDIT_SEL });
}

// Enter legt die nächste (leere) Zeile an — erst dort greift der Slash-Trigger.
// Das ist der Weg des Nutzers: Cursor ans Ende des letzten Punkts, Enter, `/`.
async function newLineThenSlash(page, label) {
  await page.keyboard.press('Enter');
  await page.keyboard.press('/');
  await page.waitForSelector('.edit-slash-menu', { state: 'visible', timeout: 5000 });
  await page.locator('.edit-slash-item', { hasText: label }).first().click();
  await page.waitForTimeout(100);
}

const html = (page) => page.evaluate((s) => document.querySelector(s).innerHTML, EDIT_SEL);

// Alle Top-Level-Kinder des Editor-Roots als Tag-Liste — die eigentliche
// Strukturaussage: liegt der neue Block auf der Wurzel oder in der Liste?
const topLevel = (page) => page.evaluate(
  (s) => Array.from(document.querySelector(s).children).map(el => el.tagName.toLowerCase()), EDIT_SEL);

// Blöcke, die in keiner Liste stehen dürfen.
const STRAY_IN_LIST = 'ul > p, ol > p, ul > h1, ul > h2, ul > h3, ol > h1, ol > h2, ol > h3, '
  + 'ul > hr, ol > hr, ul > blockquote, ol > blockquote, ul > pre, ol > pre, '
  + 'ul > figure, ol > figure, ul > table, ol > table, ul > div, ol > div';

async function expectNoStrayBlocks(page, label) {
  const strays = await page.evaluate(
    ({ s, sel }) => Array.from(document.querySelector(s).querySelectorAll(sel)).map(el => el.tagName.toLowerCase()),
    { s: EDIT_SEL, sel: STRAY_IN_LIST });
  expect(strays, `${label}: kein Block direkt in einer Liste`).toEqual([]);
  const styled = await page.evaluate(
    (s) => document.querySelector(s).querySelectorAll('[style]').length, EDIT_SEL);
  expect(styled, `${label}: kein style-Attribut`).toBe(0);
}

test('Absatz am Listenende verlässt die Liste', async ({ page }) => {
  await enterNotebookEdit(page);
  await seed(page, '<p>Anfang</p><ul><li>Eins</li><li>Zwei</li></ul><p>Ende</p>', 'ul > li:last-child');
  await newLineThenSlash(page, 'Absatz');
  await expectNoStrayBlocks(page, 'Absatz am Listenende');
  expect(await topLevel(page)).toEqual(['p', 'ul', 'p', 'p']);

  // Und der Weg bleibt offen: Weitertippen erzeugt Absätze, keine Punkte.
  await page.keyboard.type('Fliesstext');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Noch einer');
  expect(await html(page)).toBe(
    '<p>Anfang</p><ul><li>Eins</li><li>Zwei</li></ul><p>Fliesstext</p><p>Noch einer</p><p>Ende</p>');
});

test('Absatz mitten in der Liste trennt sie auf', async ({ page }) => {
  await enterNotebookEdit(page);
  await seed(page, '<p>A</p><ul><li>Eins</li><li>Zwei</li><li>Drei</li></ul>', 'ul > li:nth-child(2)');
  await newLineThenSlash(page, 'Absatz');
  await expectNoStrayBlocks(page, 'Absatz mitten in der Liste');
  await page.keyboard.type('Dazwischen');
  expect(await html(page)).toBe(
    '<p>A</p><ul><li>Eins</li><li>Zwei</li></ul><p>Dazwischen</p><ul><li>Drei</li></ul>');
});

test('nummerierte Liste zählt nach dem Schnitt weiter', async ({ page }) => {
  await enterNotebookEdit(page);
  await seed(page, '<ol><li>Eins</li><li>Zwei</li><li>Drei</li></ol>', 'ol > li:nth-child(2)');
  await newLineThenSlash(page, 'Absatz');
  await expectNoStrayBlocks(page, 'nummerierte Liste');
  const tail = await page.evaluate((s) => {
    const ols = document.querySelector(s).querySelectorAll('ol');
    return { count: ols.length, start: ols[ols.length - 1].getAttribute('start') };
  }, EDIT_SEL);
  expect(tail.count).toBe(2);
  expect(tail.start, 'zweite <ol> zählt bei 3 weiter').toBe('3');
});

test('verschachtelte Liste: der Absatz landet auf der Wurzel', async ({ page }) => {
  await enterNotebookEdit(page);
  await seed(page, '<p>A</p><ul><li>Eins<ul><li>Unter</li></ul></li><li>Zwei</li></ul>', 'ul ul > li');
  await newLineThenSlash(page, 'Absatz');
  await expectNoStrayBlocks(page, 'verschachtelte Liste');
  expect(await topLevel(page)).toEqual(['p', 'ul', 'p', 'ul']);
  await page.keyboard.type('Fliesstext');
  // Beide Ebenen sind aufgetrennt: die innere Liste behält ihren Punkt, die
  // äussere wird um den neuen Absatz herum geteilt.
  expect(await html(page)).toBe(
    '<p>A</p><ul><li>Eins<ul><li>Unter</li></ul></li></ul><p>Fliesstext</p><ul><li>Zwei</li></ul>');
});

test('Trennlinie in der Liste landet samt Folgeabsatz auf der Wurzel', async ({ page }) => {
  await enterNotebookEdit(page);
  await seed(page, '<p>A</p><ul><li>Eins</li></ul><p>E</p>', 'ul > li');
  await newLineThenSlash(page, 'Trennlinie');
  await expectNoStrayBlocks(page, 'Trennlinie in der Liste');
  expect(await topLevel(page)).toEqual(['p', 'ul', 'hr', 'p', 'p']);
});

test('Checkliste: der Absatz verlässt sie ohne Checkbox', async ({ page }) => {
  await enterNotebookEdit(page);
  await seed(page, '<p>A</p><ul class="todo"><li class="todo-item">'
    + '<input type="checkbox"><span class="todo-text">Eins</span></li></ul>', '.todo-text');
  await newLineThenSlash(page, 'Absatz');
  await expectNoStrayBlocks(page, 'Checkliste');
  await page.keyboard.type('Fliesstext');
  const out = await html(page);
  expect(out, 'Absatz steht hinter der Liste').toContain('</ul><p>Fliesstext</p>');
  expect(out, 'keine Checkbox im Absatz').not.toMatch(/<p>[^<]*<input/);
});

test('Blockzitat: die Überschrift steht danach ausserhalb', async ({ page }) => {
  await enterNotebookEdit(page);
  await seed(page, '<p>A</p><blockquote><p>Zitat</p></blockquote><p>E</p>', 'blockquote > p');
  await newLineThenSlash(page, 'Überschrift 2');
  expect(await topLevel(page), 'Überschrift hinter dem Zitat').toEqual(['p', 'blockquote', 'h2', 'p']);
  const inside = await page.evaluate((s) => !!document.querySelector(s).querySelector('blockquote h2'), EDIT_SEL);
  expect(inside, 'keine <h2> im Blockzitat').toBe(false);
});
