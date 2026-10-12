// Tabellen, Checkbox-Listen und Absatz-Merges im FOCUS-Editor, gegen die ECHTE
// App — plus der Tabellen-Fall im Notebook, der denselben Handler nutzt.
//
// WARUM DIESE SCHICHT: geprüft wird das Ersetzen des nativen contenteditable-
// Löschverhaltens (ein Harness ohne Editing-Default sähe jeden nicht
// abgefangenen Tastendruck als No-Op) und die Sichtbarkeit unter dem echten
// Focus-CSS. Der Keydown-Dispatcher hängt an der Notebook-Toolbar-Karte und an
// `focusActive` des Alpine-Roots — beides gibt es im Focus-Harness nicht.
//
// Geprüfte Invarianten:
//   1. Eine Tabelle ist im Focus-Editor sichtbar und nie Ziel eines Backspace/
//      Delete an ihrer Grenze (notebook/toolbar/block-edge.js#_kbProtectedNeighbour).
//   2. Checkbox-Listen verhalten sich wie im Notebook: die Checkbox ist nie
//      Löschziel, Zeilen-Merge und Verlassen der Liste funktionieren.
//   3. Kein Merge im Focus-Editor hinterlässt ein Inline-`style` — der aktive
//      Absatz trägt eine eigene Spotlight-Farbe, die Chromium sonst einbäckt.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const NB = '#editor-card .page-content-view--editing';
const FO = '.focus-editor__content';

const TABLE_HTML = '<table contenteditable="false"><caption>Messwerte</caption><thead><tr><th scope="col">A</th>'
  + '<th scope="col">B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>';
const TABLE = `<p>Vorher</p>${TABLE_HTML}<p>Nachher</p>`;
const TODO = '<p>Vorher</p><ul class="todo">'
  + '<li class="todo-item"><input type="checkbox"><span class="todo-text">Erstens</span></li>'
  + '<li class="todo-item"><input type="checkbox" checked><span class="todo-text">Zweitens</span></li>'
  + '</ul><p>Nachher</p>';
const PLAIN = '<p>Vorher</p><p>Mitte</p><p>Nachher</p>';

// Seiteninhalt in den Notebook-Edit setzen und — für `focus` — über den echten
// Mirror in den Focus-Editor wechseln. `contenteditable="false"` an der Tabelle
// steht im Seed, weil der Notebook-Mount es so setzt (markTablesAtomic).
// Bewusst der ZWEITE Seed-Abschnitt: jeder Test hinterlässt einen Präsenz-
// Eintrag, und 30 davon auf dem ersten Abschnitt sprengen bei 480 px die
// Kopfzeile — der Schmal-Fenster-Test in focus-editor-app.spec.js, der danach
// auf dem ersten Abschnitt läuft, sähe dann horizontalen Overflow.
async function open(page, mode, html) {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[1]); });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(NB, { timeout: 15000 });
  await page.evaluate(({ NB, html }) => { document.querySelector(NB).innerHTML = html; }, { NB, html });
  if (mode === 'focus') {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('editor:focus:enter')));
    await page.waitForFunction(() => window.Alpine.$data(document.querySelector('.focus-editor'))?._focusState === 'active',
      null, { timeout: 15000 });
  }
  await page.waitForTimeout(200);
  return mode === 'focus' ? FO : NB;
}

// Caret an Anfang/Ende des `idx`-ten Treffers von `css` im Container `root`.
async function caret(page, root, css, idx, pos) {
  await page.evaluate(({ root, css, idx, pos }) => {
    const c = document.querySelector(root);
    const el = c.querySelectorAll(css)[idx];
    c.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(pos === 'start');
    const s = document.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }, { root, css, idx, pos });
  await page.waitForTimeout(100);
}

// Inhalt ohne Laufzeit-Klassen (Spotlight), Block-IDs und den Auto-Slot des
// Focus-Editors am Ende.
function readHtml(page, root) {
  return page.evaluate((root) => {
    const c = document.querySelector(root).cloneNode(true);
    c.querySelectorAll('[class*="focus-paragraph"]').forEach((el) => {
      [...el.classList].filter((k) => k.startsWith('focus-paragraph')).forEach((k) => el.classList.remove(k));
      if (!el.classList.length) el.removeAttribute('class');
    });
    return c.innerHTML.replace(/ data-bid="[^"]*"/g, '').replace(/<p><br><\/p>$/, '');
  }, root);
}

async function expectIntact(page, root, label) {
  const bad = await page.evaluate((root) => {
    const c = document.querySelector(root);
    return {
      styled: c.querySelectorAll('[style]').length,
      naked: c.querySelectorAll('li.todo-item:not(:has(input[type=checkbox]))').length,
      loose: [...c.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).length,
    };
  }, root);
  expect(bad, label).toEqual({ styled: 0, naked: 0, loose: 0 });
}

const visible = (page, sel) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  return !!el && el.getBoundingClientRect().height > 0;
}, sel);

test.describe('Focus — Tabellen', () => {
  test('Tabelle samt Legende ist sichtbar', async ({ page }) => {
    await open(page, 'focus', TABLE);
    expect(await visible(page, `${FO} table`)).toBe(true);
    expect(await visible(page, `${FO} table caption`)).toBe(true);
    expect(await visible(page, `${FO} table td`)).toBe(true);
  });

  test('Backspace hinter der Tabelle löscht sie nicht', async ({ page }) => {
    await open(page, 'focus', TABLE);
    await caret(page, FO, ':scope > p', 1, 'start');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    expect(await readHtml(page, FO)).toBe(TABLE);
    await expectIntact(page, FO, 'Backspace danach');
  });

  test('Delete vor der Tabelle löscht sie nicht', async ({ page }) => {
    await open(page, 'focus', TABLE);
    await caret(page, FO, ':scope > p', 0, 'end');
    await page.keyboard.press('Delete');
    expect(await readHtml(page, FO)).toBe(TABLE);
    await expectIntact(page, FO, 'Delete davor');
  });

  test('Leerer Absatz hinter der Tabelle lässt sich entfernen, Caret springt weiter', async ({ page }) => {
    await open(page, 'focus', `<p>Vorher</p>${TABLE_HTML}<p><br></p><p>Nachher</p>`);
    await caret(page, FO, ':scope > p', 1, 'start');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('X');
    expect(await readHtml(page, FO)).toBe(`<p>Vorher</p>${TABLE_HTML}<p>XNachher</p>`);
    await expectIntact(page, FO, 'leerer Absatz');
    expect(await page.evaluate(() => window.__app.editDirty)).toBe(true);
  });
});

test.describe('Focus — Checkbox-Listen', () => {
  test('Klick hakt ab, Enter legt eine Zeile mit Checkbox an', async ({ page }) => {
    await open(page, 'focus', TODO);
    expect(await visible(page, `${FO} input[type=checkbox]`)).toBe(true);
    await page.click(`${FO} input[type=checkbox] >> nth=0`);
    await caret(page, FO, '.todo-text', 0, 'end');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Neu');
    expect(await readHtml(page, FO)).toBe('<p>Vorher</p><ul class="todo">'
      + '<li class="todo-item"><input type="checkbox" checked=""><span class="todo-text">Erstens</span></li>'
      + '<li class="todo-item"><input type="checkbox"><span class="todo-text">Neu</span></li>'
      + '<li class="todo-item"><input type="checkbox" checked=""><span class="todo-text">Zweitens</span></li>'
      + '</ul><p>Nachher</p>');
    await expectIntact(page, FO, 'Klick + Enter');
  });

  test('Backspace am Zeilenanfang fügt mit der Zeile darüber zusammen', async ({ page }) => {
    await open(page, 'focus', TODO);
    await caret(page, FO, '.todo-text', 1, 'start');
    await page.keyboard.press('Backspace');
    expect(await readHtml(page, FO)).toBe('<p>Vorher</p><ul class="todo">'
      + '<li class="todo-item"><input type="checkbox"><span class="todo-text">ErstensZweitens</span></li>'
      + '</ul><p>Nachher</p>');
    await expectIntact(page, FO, 'Zeilen-Merge');
  });

  test('Backspace am Anfang der ersten Zeile verlässt die Liste', async ({ page }) => {
    await open(page, 'focus', TODO);
    await caret(page, FO, '.todo-text', 0, 'start');
    await page.keyboard.press('Backspace');
    expect(await readHtml(page, FO)).toBe('<p>Vorher</p><p>Erstens</p><ul class="todo">'
      + '<li class="todo-item"><input type="checkbox" checked=""><span class="todo-text">Zweitens</span></li>'
      + '</ul><p>Nachher</p>');
    await expectIntact(page, FO, 'Liste verlassen');
  });

  test('Backspace hinter der Liste hängt an die letzte Zeile an', async ({ page }) => {
    await open(page, 'focus', TODO);
    await caret(page, FO, ':scope > p', 1, 'start');
    await page.keyboard.press('Backspace');
    expect(await readHtml(page, FO)).toBe('<p>Vorher</p><ul class="todo">'
      + '<li class="todo-item"><input type="checkbox"><span class="todo-text">Erstens</span></li>'
      + '<li class="todo-item"><input type="checkbox" checked=""><span class="todo-text">ZweitensNachher</span></li>'
      + '</ul>');
    await expectIntact(page, FO, 'Backspace danach');
  });

  test('Delete vor der Liste frisst keine Checkbox', async ({ page }) => {
    await open(page, 'focus', TODO);
    await caret(page, FO, ':scope > p', 0, 'end');
    await page.keyboard.press('Delete');
    expect(await readHtml(page, FO)).toBe('<p>VorherErstens</p><ul class="todo">'
      + '<li class="todo-item"><input type="checkbox" checked=""><span class="todo-text">Zweitens</span></li>'
      + '</ul><p>Nachher</p>');
    await expectIntact(page, FO, 'Delete davor');
  });
});

test.describe('Focus — Absatz-Merge', () => {
  test('Backspace und Delete fügen zusammen, ohne Inline-style', async ({ page }) => {
    await open(page, 'focus', PLAIN);
    await caret(page, FO, ':scope > p', 1, 'start');
    await page.keyboard.press('Backspace');
    expect(await readHtml(page, FO)).toBe('<p>VorherMitte</p><p>Nachher</p>');
    await expectIntact(page, FO, 'Backspace');
    await caret(page, FO, ':scope > p', 0, 'end');
    await page.keyboard.press('Delete');
    expect(await readHtml(page, FO)).toBe('<p>VorherMitteNachher</p>');
    await expectIntact(page, FO, 'Delete');
    // Caret sitzt an der Naht: Tippen landet zwischen den beiden Teilen.
    await page.keyboard.type('|');
    expect(await readHtml(page, FO)).toBe('<p>VorherMitte|Nachher</p>');
  });

  test('Undo nimmt den Merge zurück', async ({ page }) => {
    await open(page, 'focus', PLAIN);
    // Der Seed selbst ist kein Undo-Schritt — erst eine Eingabe legt die Basis.
    await caret(page, FO, ':scope > p', 2, 'end');
    await page.keyboard.type('Z');
    await page.waitForTimeout(700);
    await caret(page, FO, ':scope > p', 1, 'start');
    await page.keyboard.press('Backspace');
    expect(await readHtml(page, FO)).toBe('<p>VorherMitte</p><p>NachherZ</p>');
    await page.waitForTimeout(700);
    await page.keyboard.press('ControlOrMeta+z');
    expect(await readHtml(page, FO)).toBe('<p>Vorher</p><p>Mitte</p><p>NachherZ</p>');
  });
});

test.describe('Notebook — Tabelle', () => {
  test('Backspace hinter der Tabelle lässt Tabelle und Absatz stehen', async ({ page }) => {
    await open(page, 'notebook', TABLE);
    await caret(page, NB, ':scope > p', 1, 'start');
    await page.keyboard.press('Backspace');
    expect(await readHtml(page, NB)).toBe(TABLE);
    await expectIntact(page, NB, 'Notebook Backspace');
  });
});

// Wrapper-Grenzen und Zeilen-Merges: Sollwert ist jeweils, was der Notebook-
// Editor liefert. Der Browser-Default bäckt im Focus-Editor `style` ein und
// verwirft im Gedicht (`display: contents`) ganze Verse. `|` markiert, wo der
// Caret danach steht.
const WRAPPERS = [
  ['Zitat', 'blockquote', '<p>A</p><p>B</p>'],
  ['Gedicht', 'div class="poem"', '<p>A</p><p>B</p>'],
  ['Liste', 'ul', '<li>A</li><li>B</li>'],
];
const close = (open) => `</${open.split(' ')[0]}>`;
const wrap = (open, inner) => `<p>Vorher</p><${open}>${inner}${close(open)}<p>Nachher</p>`;

for (const [name, tag, inner] of WRAPPERS) {
  const html = wrap(tag, inner);
  const lines = tag === 'ul' ? ':scope > ul > li' : `:scope > ${tag.split(' ')[0]} > p`;
  const [l1, l2] = tag === 'ul' ? ['li', 'li'] : ['p', 'p'];
  const cases = [
    ['Backspace hinter dem Block', ':scope > p', 1, 'start', 'Backspace',
      `<p>Vorher</p><${tag}><${l1}>A</${l1}><${l2}>B|Nachher</${l2}>${close(tag)}`],
    ['Delete vor dem Block', ':scope > p', 0, 'end', 'Delete',
      `<p>Vorher|A</p><${tag}><${l2}>B</${l2}>${close(tag)}<p>Nachher</p>`],
    ['Backspace in der ersten Zeile', lines, 0, 'start', 'Backspace',
      `<p>Vorher</p><p>|A</p><${tag}><${l2}>B</${l2}>${close(tag)}<p>Nachher</p>`],
    ['Backspace in der zweiten Zeile', lines, 1, 'start', 'Backspace',
      `<p>Vorher</p><${tag}><${l1}>A|B</${l1}>${close(tag)}<p>Nachher</p>`],
    ['Delete am Ende der ersten Zeile', lines, 0, 'end', 'Delete',
      `<p>Vorher</p><${tag}><${l1}>A|B</${l1}>${close(tag)}<p>Nachher</p>`],
  ];
  test.describe(`Focus — ${name}`, () => {
    for (const [label, css, idx, pos, key, want] of cases) {
      test(label, async ({ page }) => {
        await open(page, 'focus', html);
        await caret(page, FO, css, idx, pos);
        await page.keyboard.press(key);
        await page.keyboard.type('|');
        expect(await readHtml(page, FO)).toBe(want);
        await expectIntact(page, FO, `${name}: ${label}`);
      });
    }
  });
}

const FIGURE = '<figure><img src="/icons.svg" alt="Bild"><figcaption>Legende</figcaption></figure>';

test.describe('Focus — Bild und Trennlinie', () => {
  for (const [name, block] of [['Bild', FIGURE], ['Trennlinie', '<hr>']]) {
    test(`${name}: Backspace dahinter und Delete davor löschen nichts`, async ({ page }) => {
      const html = `<p>Vorher</p>${block}<p>Nachher</p>`;
      await open(page, 'focus', html);
      await caret(page, FO, ':scope > p', 1, 'start');
      await page.keyboard.press('Backspace');
      await caret(page, FO, ':scope > p', 0, 'end');
      await page.keyboard.press('Delete');
      expect(await readHtml(page, FO)).toBe(html);
      await expectIntact(page, FO, name);
    });
  }

  test('Backspace in der leeren Legende lässt das Bild stehen', async ({ page }) => {
    const html = '<p>Vorher</p><figure><img src="/icons.svg" alt="Bild"><figcaption><br></figcaption></figure><p>Nachher</p>';
    await open(page, 'focus', html);
    await caret(page, FO, 'figcaption', 0, 'start');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    expect(await page.evaluate((FO) => document.querySelectorAll(`${FO} figure img`).length, FO)).toBe(1);
    await expectIntact(page, FO, 'leere Legende');
  });
});
