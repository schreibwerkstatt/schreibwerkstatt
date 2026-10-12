// Grenzschutz im Standalone-Focus-Editor (nativer macOS-/Android-Client):
// shared/block-edge.js, angehängt in focus/standalone.js. In der SPA bedient ihn
// die Notebook-Toolbar (gegated in tests/e2e-app/focus-blocks-app.spec.js); die
// Schalen laden keine Toolbar und brauchen ihn deshalb im Mount selbst.
// Registriert von focus-standalone-blocks.spec.js (Chromium) und
// focus-standalone-blocks.webkit.spec.js (WebKit, Engine des macOS-Clients).

const { test, expect } = require('./fixtures');

const HARNESS = '/tests/fixtures/standalone-harness.html';

function registerStandaloneBlocks() {
  test.beforeEach(async ({ page }) => {
    await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.standaloneReady === true);
  });

  // Seite tauschen (gleiche id → kein Save der bisherigen) und Caret setzen:
  // `at` = 'start' | 'end' des Blocks Nummer `nth` (Top-Level-Kinder).
  async function load(page, html) {
    await page.evaluate((h) => window.__standalone.setPage({ id: 42, name: 'Testseite', html: h }), html);
  }
  async function caret(page, nth, at) {
    await page.evaluate(({ nth, at }) => {
      const c = document.querySelector('.focus-editor__content');
      const el = c.children[nth];
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(at === 'start');
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      c.focus();
    }, { nth, at });
  }
  const content = (page) => page.evaluate(() => document.querySelector('.focus-editor__content').innerHTML);
  // Blockfolge ohne den leeren Schluss-<p>, den die Engine beim Betreten
  // anhängt (`_focusAutoAddedP`) — Engine-Artefakt, nicht Teil der Seite.
  const tags = (page) => page.evaluate(() => {
    const kids = [...document.querySelector('.focus-editor__content').children];
    while (kids.length && kids.at(-1).tagName === 'P' && !kids.at(-1).textContent.trim()) kids.pop();
    return kids.map((n) => n.tagName);
  });

  const TABLE = '<table><tbody><tr><td>Zelle</td></tr></tbody></table>';

  test('Tabelle ist atomar, Öffnen allein speichert nicht', async ({ page }) => {
    await load(page, `<p>Davor</p>${TABLE}<p>Danach</p>`);
    expect(await page.evaluate(() =>
      document.querySelector('.focus-editor__content table').getAttribute('contenteditable'))).toBe('false');
    await page.evaluate(() => window.__standalone.save());
    expect(await page.evaluate(() => window.__saveLog.length)).toBe(0);
  });

  test('Backspace hinter der Tabelle löscht sie nicht', async ({ page }) => {
    await load(page, `<p>Davor</p>${TABLE}<p>Danach</p>`);
    await caret(page, 2, 'start');
    await page.keyboard.press('Backspace');
    expect(await tags(page)).toEqual(['P', 'TABLE', 'P']);
    expect(await content(page)).toContain('Danach');
  });

  test('Delete vor der Tabelle löscht sie nicht', async ({ page }) => {
    await load(page, `<p>Davor</p>${TABLE}<p>Danach</p>`);
    await caret(page, 0, 'end');
    await page.keyboard.press('Delete');
    expect(await tags(page)).toEqual(['P', 'TABLE', 'P']);
  });

  test('Leerer Absatz hinter der Tabelle verschwindet, Tabelle bleibt', async ({ page }) => {
    await load(page, `<p>Davor</p>${TABLE}<p><br></p><p>Weiter</p>`);
    await caret(page, 2, 'start');
    await page.keyboard.press('Backspace');
    expect(await tags(page)).toEqual(['P', 'TABLE', 'P']);
    // Caret sitzt im Folgeabsatz, Tippen landet dort.
    await page.keyboard.type('X');
    expect(await page.evaluate(() =>
      document.querySelector('.focus-editor__content').children[2].textContent)).toBe('XWeiter');
  });

  // Bild und Trennlinie sind hier bewusst NICHT geschützt (anders als im
  // SPA-Fokusmodus): Android legt Trennlinien selbst an und zeigt sie, Backspace
  // ist dort der einzige Löschweg. Der Grenzschutz darf die Taste nicht fressen.
  test('Trennlinie bleibt beim Default, der Grenzschutz fängt die Taste nicht ab', async ({ page }) => {
    await load(page, '<p>A</p><hr><p>B</p>');
    await caret(page, 2, 'start');
    const prevented = await page.evaluate(() => {
      const ev = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
      document.querySelector('.focus-editor__content').dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(prevented).toBe(false);
  });

  test('Absatz-Merge ohne Inline-style, als Schritt im Undo', async ({ page }) => {
    await load(page, '<p>Erster</p><p>Zweiter</p>');
    await caret(page, 1, 'start');
    await page.keyboard.press('Backspace');
    const html = await content(page);
    expect(html).toContain('ErsterZweiter');
    expect(html).not.toContain('style=');
    await expect.poll(() => page.evaluate(() => window.__standalone.canUndo())).toBe(true);
    await page.evaluate(() => window.__standalone.undo());
    expect(await tags(page)).toEqual(['P', 'P']);
  });

  test('Undo-Restore hält Tabellen atomar, Save ohne contenteditable', async ({ page }) => {
    await load(page, `<p>Davor</p>${TABLE}<p>Danach</p>`);
    await caret(page, 2, 'end');
    await page.keyboard.type(' neu');
    await expect.poll(() => page.evaluate(() => window.__standalone.canUndo())).toBe(true);
    await page.evaluate(() => window.__standalone.undo());
    expect(await page.evaluate(() =>
      document.querySelector('.focus-editor__content table').getAttribute('contenteditable'))).toBe('false');
    await page.evaluate(() => window.__standalone.redo());
    await page.evaluate(() => window.__standalone.save());
    const saved = await page.evaluate(() => window.__saveLog.at(-1)?.html || '');
    expect(saved).toContain('neu');
    expect(saved).toContain('<table');
    expect(saved).not.toContain('contenteditable');
  });
}

module.exports = { registerStandaloneBlocks };
