// Markierte Absätze → Nachrichtenverlauf im NOTEBOOK-Editor, gegen die ECHTE
// App: Bubble-Knöpfe nur bei schlichten Absätzen, Seitenwahl der ersten
// Nachricht, abwechselnde Seiten, Anführungszeichen weg, Merge mit einem
// angrenzenden Verlauf, Undo als ein Schritt. Und zurück: markierte
// Verlaufszeilen (Bubble) bzw. die Caret-Zeile (Zeilenleiste) werden
// schlichte Absätze, der Verlauf teilt sich.
//
// WARUM DIESE SCHICHT: die Bubble hängt an `selectionchange` und am echten
// Template (x-show auf `bubbleMsgOk`); ein Fixture-Harness lädt beides nicht.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';
const BTN_IN = '.edit-bubble-btn--msg >> nth=0';
const BTN_OUT = '.edit-bubble-btn--msg >> nth=1';
const BTN_UNWRAP = '.edit-bubble-btn--msg-unwrap';
const THREAD = '<p>Vorher</p><div class="msg-thread"><p id="a" class="msg-name">Lena</p>'
  + '<p id="b" class="msg-in">eins</p><p id="c" class="msg-out">zwei</p><p id="d" class="msg-in">drei</p></div><p>Nachher</p>';

async function enterNotebookEdit(page) {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
  await page.waitForTimeout(300);
}

// Selektion von Anfang `from` bis Ende `to` (CSS-Selektoren im Editor).
async function seedSelect(page, html, from, to) {
  await page.evaluate(({ html, from, to }) => {
    const editEl = document.querySelector('#editor-card .page-content-view--editing');
    editEl.innerHTML = html;
    editEl.focus({ preventScroll: true });
    const a = editEl.querySelector(from);
    const b = editEl.querySelector(to);
    const r = document.createRange();
    r.setStart(a.firstChild || a, 0);
    r.setEnd(b.lastChild || b, (b.lastChild || b).textContent.length);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }, { html, from, to });
  await page.waitForTimeout(150);
}

function readHtml(page) {
  return page.evaluate(() => document.querySelector('#editor-card .page-content-view--editing')
    .innerHTML.replace(/ data-bid="[^"]*"/g, ''));
}

test.describe('Notebook — Absätze in Nachrichtenverlauf umwandeln', () => {
  test('erste Nachricht eingehend, dann abwechselnd, Anführungszeichen weg', async ({ page }) => {
    await enterNotebookEdit(page);
    await seedSelect(page,
      '<p>Vorher</p><p id="a">„Bist du da?“</p><p><br></p><p>«gleich»</p><p id="b">„Ja“, sagte sie, „gern“</p><p>Nachher</p>',
      '#a', '#b');
    await expect(page.locator(BTN_IN)).toBeVisible();
    await page.locator(BTN_IN).click();
    const html = await readHtml(page);
    expect(html).toBe('<p>Vorher</p><div class="msg-thread"><p id="a" class="msg-in">Bist du da?</p>'
      + '<p class="msg-out">gleich</p><p id="b" class="msg-in">„Ja“, sagte sie, „gern“</p></div><p>Nachher</p>');
    expect(await page.locator(`${EDIT_SEL} [style]`).count()).toBe(0);

    // Ein Undo-Schritt stellt den Vorher-Stand her.
    await page.evaluate(() => window.__app.notebookUndo());
    expect(await readHtml(page)).toContain('<p id="a">„Bist du da?“</p>');
    expect(await readHtml(page)).not.toContain('msg-thread');
  });

  test('erste Nachricht ausgehend, angrenzender Verlauf wird zusammengezogen', async ({ page }) => {
    await enterNotebookEdit(page);
    await seedSelect(page,
      '<div class="msg-thread"><p class="msg-in">Hallo</p></div><p id="a">eins</p><p id="b">zwei</p>',
      '#a', '#b');
    await page.locator(BTN_OUT).click();
    expect(await readHtml(page)).toBe('<div class="msg-thread"><p class="msg-in">Hallo</p>'
      + '<p id="a" class="msg-out">eins</p><p id="b" class="msg-in">zwei</p></div>');
  });

  test('keine Knöpfe, wenn die Selektion etwas anderes als schlichte Absätze erfasst', async ({ page }) => {
    await enterNotebookEdit(page);
    await seedSelect(page, '<p id="a">eins</p><h2 id="b">Titel</h2>', '#a', '#b');
    await expect(page.locator('.edit-bubble-toolbar')).toBeVisible();
    await expect(page.locator(BTN_IN)).toBeHidden();
    await seedSelect(page, '<div class="msg-thread"><p id="a" class="msg-in">x</p></div>', '#a', '#a');
    await expect(page.locator(BTN_IN)).toBeHidden();
  });
});

test.describe('Notebook — Zeilen aus dem Nachrichtenverlauf lösen', () => {
  test('Bubble: markierte Zeilen mitten im Verlauf werden Absätze, der Verlauf teilt sich', async ({ page }) => {
    await enterNotebookEdit(page);
    await seedSelect(page, THREAD, '#b', '#c');
    await expect(page.locator(BTN_UNWRAP)).toBeVisible();
    await expect(page.locator(BTN_IN)).toBeHidden();
    await page.locator(BTN_UNWRAP).click();
    expect(await readHtml(page)).toBe('<p>Vorher</p><div class="msg-thread"><p id="a" class="msg-name">Lena</p></div>'
      + '<p id="b">eins</p><p id="c">zwei</p>'
      + '<div class="msg-thread"><p id="d" class="msg-in">drei</p></div><p>Nachher</p>');
    expect(await page.locator(`${EDIT_SEL} [style]`).count()).toBe(0);

    await page.evaluate(() => window.__app.notebookUndo());
    expect(await readHtml(page)).toBe(THREAD);
  });

  test('Bubble: ganzer Verlauf samt Erzählabsatz markiert, Verlauf verschwindet', async ({ page }) => {
    await enterNotebookEdit(page);
    await seedSelect(page, THREAD, ':scope > p:first-child', '#d');
    await page.locator(BTN_UNWRAP).click();
    expect(await readHtml(page)).toBe('<p>Vorher</p><p id="a">Lena</p><p id="b">eins</p>'
      + '<p id="c">zwei</p><p id="d">drei</p><p>Nachher</p>');
  });

  test('Zeilenleiste: Lösen-Knopf macht die Caret-Zeile zum Absatz, weitertippen bleibt drin', async ({ page }) => {
    await enterNotebookEdit(page);
    await page.evaluate((html) => {
      const editEl = document.querySelector('#editor-card .page-content-view--editing');
      editEl.innerHTML = html;
      editEl.focus({ preventScroll: true });
      const r = document.createRange();
      r.selectNodeContents(editEl.querySelector('#d'));
      r.collapse(false);
      document.getSelection().removeAllRanges();
      document.getSelection().addRange(r);
    }, THREAD);
    const bar = page.locator('.edit-msg-bar');
    await expect(bar).toBeVisible();
    await bar.locator('.edit-msg-btn--unwrap').click();
    expect(await readHtml(page)).toBe('<p>Vorher</p><div class="msg-thread"><p id="a" class="msg-name">Lena</p>'
      + '<p id="b" class="msg-in">eins</p><p id="c" class="msg-out">zwei</p></div><p id="d">drei</p><p>Nachher</p>');
    await expect(bar).toBeHidden();
    await page.keyboard.type('!');
    expect(await readHtml(page)).toContain('<p id="d">drei!</p>');
  });
});
