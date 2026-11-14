// Kantenfälle im NOTEBOOK-Editor gegen die ECHTE App, die nur ein Browser mit
// Editing-Default zeigt (Schwesterspecs: notebook-keyboard.spec.js,
// notebook-msg-thread.spec.js, notebook-block-boundaries.spec.js).
//
// Geprüft:
//   1. Alles markieren + Zeichen/Backspace/Delete: genau ein Absatz mit Caret-
//      Slot, kein loser Text unter der Wurzel (line-merge.js#deleteRangeClean).
//   2. Enter am Ende einer kursiven Verlaufszeile schreibt kursiv weiter
//      (toolbar/msg-thread.js#_kbMsgEnter).
//   3. Enter mit Auswahl über zwei Verlaufszeilen: keine Leerzeile dazwischen.
//   4. Text aus einer Überschrift in einen Absatz ziehen: kein Inline-`style`,
//      keine Überschrift im Absatz (edit/input.js#_onEditInput).
//   6. Cmd/Ctrl+S unter der offenen Verwerfen-Rückfrage speichert nicht; nach
//      «Verwerfen» steht auf dem Server der alte Stand (edit/save-guard.js).
//   7. Übernahme im Edit-Modus (Abschnitts-Chat/Lektorat): Caret bleibt im
//      Block, Fokus kehrt in den Text zurück, unveränderte Blöcke bleiben
//      dieselben Knoten (edit/input.js#_mountAcceptedHtml, edit/patch-html.js).
//   5. Abschnitt nur mit Abbildung: Autosave und ✓ speichern, die Leseansicht
//      zeigt das Bild statt des Leer-Zustands (shared/empty-content.js).

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';
const PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

// Eigener Abschnitt je Test (danach gelöscht): einige Fälle speichern, und der
// geseedete Abschnitt 1 gehört den Specs, die nach dieser im selben Shard laufen.
let freshPageId = null;

async function enterNotebookEdit(page) {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  freshPageId = await page.evaluate(async (bid) => {
    const { contentRepo } = await import('/js/repo/content.js');
    const created = await contentRepo.createPage({ book_id: parseInt(bid, 10), name: 'Kantenfaelle', html: '<p>Start.</p>' });
    await window.__app.loadPages();
    await window.__app.selectPage(window.Alpine.store('nav').pages.find((x) => x.id === created.id));
    return created.id;
  }, bookId);
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
  await page.waitForTimeout(300);
}

test.afterEach(async ({ page }) => {
  if (freshPageId == null) return;
  const id = freshPageId;
  freshPageId = null;
  await page.evaluate(async (pid) => {
    window.__app.editDirty = false;
    if (window.__app.editMode) await window.__app.cancelEdit();
    await window.__app.deletePageById(pid, { confirm: false });
  }, id).catch(() => {});
});

// Inhalt setzen, Caret ans Ende (oder an den Anfang) von `target`.
async function seed(page, html, target, atStart = false) {
  await page.evaluate(({ html, target, atStart, EDIT_SEL }) => {
    const editEl = document.querySelector(EDIT_SEL);
    editEl.innerHTML = html;
    editEl.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(editEl.querySelector(target));
    r.collapse(atStart);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }, { html, target, atStart, EDIT_SEL });
}

// Auswahl/Caret über Textoffsets: `q` (Selektor im Editor) + Offset (-1 = Ende),
// optional bis `q2` + `off2`.
async function caret(page, q, off = -1, q2 = null, off2 = null) {
  await page.evaluate(({ q, off, q2, off2, EDIT_SEL }) => {
    const root = document.querySelector(EDIT_SEL);
    const pos = (q, off) => {
      const el = root.querySelector(q);
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n; let last = null; let rem = off;
      if (off === -1) { while ((n = w.nextNode())) last = n; return last ? [last, last.data.length] : [el, el.childNodes.length]; }
      while ((n = w.nextNode())) { if (rem <= n.data.length) return [n, rem]; rem -= n.data.length; }
      return [el, 0];
    };
    const r = document.createRange();
    const [a, ao] = pos(q, off);
    r.setStart(a, ao);
    if (q2) { const [b, bo] = pos(q2, off2); r.setEnd(b, bo); } else r.collapse(true);
    root.focus({ preventScroll: true });
    const s = document.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }, { q, off, q2, off2, EDIT_SEL });
}

const readHtml = (page) => page.evaluate((s) => document.querySelector(s).innerHTML
  .replace(/ data-bid="[^"]*"/g, ''), EDIT_SEL);

test.describe('Notebook — Kantenfälle', () => {
  test('Alles markieren + Zeichen/Backspace/Delete: ein Absatz mit Caret-Slot', async ({ page }) => {
    await enterNotebookEdit(page);
    const html = '<p>Erster Absatz.</p><p>Zweiter Absatz.</p><p>Dritter.</p>';

    await seed(page, html, 'p');
    await page.keyboard.press(`${MOD}+a`);
    await page.keyboard.type('Neu');
    expect(await readHtml(page)).toBe('<p>Neu</p>');
    await page.keyboard.press('Enter');
    await page.keyboard.type('zwei');
    expect(await readHtml(page)).toBe('<p>Neu</p><p>zwei</p>');

    for (const key of ['Backspace', 'Delete']) {
      await seed(page, html, 'p');
      await page.keyboard.press(`${MOD}+a`);
      await page.keyboard.press(key);
      expect(await readHtml(page), key).toBe('<p><br></p>');
      await page.keyboard.type('x');
      expect(await readHtml(page), `${key} + Tippen`).toBe('<p>x</p>');
    }
  });

  test('Verlauf: Enter am Ende einer kursiven Zeile schreibt kursiv weiter', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<div class="msg-thread"><p class="msg-in"><i>Hallo du</i></p></div><p>Nach</p>', '.msg-in');
    await page.keyboard.press('Enter');
    await page.keyboard.type('neu');
    expect(await readHtml(page)).toBe('<div class="msg-thread"><p class="msg-in"><i>Hallo du</i></p><p class="msg-in"><i>neu</i></p></div><p>Nach</p>');

    // Ungeformte Zeile bleibt ungeformt.
    await seed(page, '<div class="msg-thread"><p class="msg-in">Hallo du</p></div>', '.msg-in');
    await page.keyboard.press('Enter');
    await page.keyboard.type('neu');
    expect(await readHtml(page)).toBe('<div class="msg-thread"><p class="msg-in">Hallo du</p><p class="msg-in">neu</p></div>');
  });

  test('Verlauf: Enter mit Auswahl über zwei Zeilen lässt keine Leerzeile', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<p>Eins</p><div class="msg-thread"><p class="msg-in"><i>Hallo du</i></p><p class="msg-out">Antwort</p></div><p>Nach</p>', '.msg-in');
    await caret(page, '.msg-in', 3, '.msg-out', 3);
    await page.keyboard.press('Enter');
    const out = await readHtml(page);
    expect(out).toBe('<p>Eins</p><div class="msg-thread"><p class="msg-in"><i>Hal</i></p><p class="msg-in">wort</p></div><p>Nach</p>');
  });

  test('Ziehen aus einer Überschrift in einen Absatz: kein Inline-style, keine Überschrift im Absatz', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<h2>Titel gross</h2><p>Eins zwei drei</p><p>Ziel Absatz hier</p>', 'h2');
    await caret(page, 'h2', 0, 'h2', 5);
    const box = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const r = document.getSelection().getRangeAt(0).getBoundingClientRect();
      const t = el.querySelector('p:last-child').getBoundingClientRect();
      return { sx: r.left + r.width / 2, sy: r.top + r.height / 2, tx: t.left + 60, ty: t.top + t.height / 2 };
    }, EDIT_SEL);
    await page.mouse.move(box.sx, box.sy);
    await page.mouse.down();
    await page.mouse.move(box.sx + 5, box.sy + 5, { steps: 3 });
    await page.mouse.move(box.tx, box.ty, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const res = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return { html: el.innerHTML, styled: el.querySelectorAll('[style]').length, nestedHead: el.querySelectorAll('p h1, p h2, p h3, p h4').length, text: el.textContent };
    }, EDIT_SEL);
    expect(res.styled, res.html).toBe(0);
    expect(res.nestedHead, res.html).toBe(0);
    expect(res.text).toContain('Titel');
    expect(await page.evaluate(() => window.__app.editDirty)).toBe(true);
  });

  test('Abschnitt nur mit Abbildung: speichert und zeigt das Bild', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, `<figure><img src="${PX}" alt=""><figcaption><br></figcaption></figure><p><br></p>`, 'p');
    await page.evaluate(() => window.__app._markEditDirty());
    await page.evaluate(() => window.__app.quickSave());
    await page.waitForFunction(() => window.__app.editDirty === false && !window.__app.editSaving, null, { timeout: 15000 });
    await page.evaluate(() => window.__app.saveEdit());
    await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 15000 });
    const state = await page.evaluate(() => ({
      empty: window.__app.currentPageEmpty,
      img: !!document.querySelector('.page-view-wrap .page-content-view img'),
      saved: window.__app.originalHtml.includes('<img'),
    }));
    expect(state).toEqual({ empty: false, img: true, saved: true });
  });

  test('Cmd/Ctrl+S unter der Verwerfen-Rückfrage speichert nicht', async ({ page }) => {
    await enterNotebookEdit(page);
    const before = await page.evaluate(() => window.__app.originalHtml);
    await seed(page, '<p>Verworfener Text.</p>', 'p');
    await page.evaluate(() => window.__app._markEditDirty());
    await page.evaluate(() => { window.__app.cancelEdit(); });
    await page.locator('#app-confirm-dialog[open]').waitFor();
    await page.keyboard.press(`${MOD}+s`);
    await page.waitForTimeout(600);
    await page.locator('#app-confirm-dialog[open] .confirm-dialog-btn--danger').click();
    await page.waitForFunction(() => window.__app.editMode === false);
    const server = await page.evaluate(async () => {
      const id = window.__app.currentPage.id;
      const r = await fetch(`/content/pages/${id}?fresh=1`, { cache: 'no-store' });
      return r.ok ? (await r.json()).html : null;
    });
    expect(server).not.toContain('Verworfener');
    expect(await page.evaluate(() => window.__app.originalHtml)).toBe(before);
  });

  test('Übernahme im Edit-Modus: Caret und Fokus bleiben, nur der geänderte Block wird getauscht', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<p>Alpha beta.</p><p>Gamma delta.</p><p>Eins zwei drei.</p><p>Schluss.</p>', 'p:nth-of-type(3)');
    await caret(page, 'p:nth-of-type(3)', 4);
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      el.querySelector('p:nth-of-type(4)').__keep = 1;
      // Klick auf «Übernehmen» nimmt dem Editor den Fokus.
      document.querySelector('#editor-card button')?.focus();
    }, EDIT_SEL);

    // Ersetzung in einem anderen Block oberhalb.
    expect(await page.evaluate(() => window.__app._applyTextReplacement('Alpha', 'Alphabet und mehr'))).toEqual({ ok: true });
    const st = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return { focused: document.activeElement === el, kept: el.querySelector('p:nth-of-type(4)').__keep === 1 };
    }, EDIT_SEL);
    expect(st).toEqual({ focused: true, kept: true });
    await page.keyboard.type('X');
    expect(await readHtml(page)).toBe('<p>Alphabet und mehr beta.</p><p>Gamma delta.</p><p>EinsX zwei drei.</p><p>Schluss.</p>');

    // Ersetzung im Caret-Block vor dem Caret: der Caret wandert mit.
    await caret(page, 'p:nth-of-type(3)', -1);
    expect(await page.evaluate(() => window.__app._applyTextReplacement('EinsX', 'Einundzwanzig'))).toEqual({ ok: true });
    await page.keyboard.type('!');
    expect(await readHtml(page)).toBe('<p>Alphabet und mehr beta.</p><p>Gamma delta.</p><p>Einundzwanzig zwei drei.!</p><p>Schluss.</p>');
  });
});
