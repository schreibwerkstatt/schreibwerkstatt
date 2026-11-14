// Abbildungen im NOTEBOOK-Editor, gegen die ECHTE App.
//
// WARUM DIESE SCHICHT: beide tragenden Invarianten des Features sind
// Persistenz-Aussagen, und die lassen sich nur prüfen, wenn ein echter
// Save-Pfad mit echtem Server-Cleaner dazwischen liegt:
//
//   1. Ersatztext und Bildnachweis stehen IM Manuskript (der Dialog schreibt
//      wirklich in die Seite, nicht nur in seinen eigenen State).
//   2. Die Nummer der Legende steht NICHT im Manuskript. Sie ist ein
//      Render-Artefakt, das die Leseansicht als Laufzeit-Badge zeigt — läuft es
//      in den Save-Pfad, trägt die Seite die Zählung vom Tag des Hinsehens und
//      im Export stünde sie doppelt.
//
// Dazu kommt die Dirty-Erkennung: sie vergleicht gemounteten Editor-DOM gegen
// den Server-Stand, und ein Fehler dort zeigt sich als „Seite gilt beim Öffnen
// als geändert" — ein Fixture-Harness bemerkt das nicht.
//
// Konventionen wie notebook-diagram.spec.js: Inhalt wird ANGEHÄNGT, und jeder
// Test arbeitet auf einer eigenen Seite — die Smoke-DB lebt über den ganzen Lauf.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';
const READ_SEL = '#editor-card .page-content-view:not(.page-content-view--editing)';

async function boot(page) {
  await bootApp(page);
  await selectSeededBook(page);
}

async function openPageInEdit(page, pageIdx) {
  await page.evaluate(async (i) => {
    await window.__app.selectPage(window.Alpine.store('nav').pages[i]);
  }, pageIdx);
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
}

async function serverHtml(page) {
  return page.evaluate(async () => {
    const id = window.__app.currentPage.id;
    const r = await fetch(`/content/pages/${id}`, { headers: { Accept: 'application/json' } });
    return (await r.json()).html || '';
  });
}

// Ein winziges, echtes Bild als data:-URL. Eine tote `src` hätte im Layout die
// Grösse 0 und wäre nicht anklickbar — der Klick aufs Bild ist aber genau der
// Einstieg, den dieser Test prüfen soll.
const IMG_SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAH0lEQVR4nGM4UWFDFcQwatCoQaMGjRo0atCoQQNvEAChWVcufqy1ZwAAAABJRU5ErkJggg==';

// Abbildung anhängen. Der Datei-Dialog des Slash-Menüs lässt sich hier nicht
// fahren; gesetzt wird deshalb dasselbe Markup, das `buildFigureHtml` erzeugt —
// der Weg danach (Dialog, Save, Leseansicht) ist der echte.
async function appendFigure(page, caption) {
  await page.evaluate(({ cap, src }) => {
    const editEl = document.querySelector('#editor-card .page-content-view--editing');
    editEl.insertAdjacentHTML('beforeend',
      `<figure><img src="${src}" alt=""><figcaption>${cap}</figcaption></figure>`);
    window.__app._markEditDirty?.();
  }, { cap: caption, src: IMG_SRC });
}

// Seite aus dem SERVER-Stand neu laden. Nötig, bevor die Nummer einer FRISCH
// eingefügten Abbildung sichtbar werden kann: das `data-bid` — der Zeiger, über
// den die Nummer zugeordnet wird — vergibt `ensureBlockIds` am Schreib-
// Chokepoint, und der Editor behält nach dem Speichern seinen eigenen Stand
// (`originalHtml = html`). Dieselbe Eigenschaft hat der Querverweis-Picker:
// eine eben eingefügte Abbildung ist erst nach dem Neuladen ein Ziel.
async function reloadPageFromServer(page, pageIdx) {
  await page.evaluate(async (i) => {
    const pages = window.Alpine.store('nav').pages;
    await window.__app.selectPage(pages[i === 0 ? 1 : 0]);
    await window.__app.selectPage(pages[i]);
  }, pageIdx);
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
}

async function setFigureNumbering(page, on) {
  await page.evaluate(async (flag) => {
    const bookId = window.Alpine.store('nav').selectedBookId;
    await fetch(`/booksettings/${bookId}/xrefs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figure_numbering: flag ? 1 : 0 }),
    });
  }, on);
}

test('Bild-Dialog schreibt Ersatztext und Bildnachweis ins Manuskript', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 0);
  await appendFigure(page, 'Der Käfer');

  // Öffnen über den ECHTEN Einstieg: Klick aufs Bild. Das `<img>` ist ein
  // Void-Element — ohne diese Verdrahtung gäbe es keinen Weg zu Ersatztext und
  // Bildnachweis, und ein Fehler darin wäre in einem Fixture-Harness unsichtbar.
  await page.click(`${EDIT_SEL} figure img`);
  await page.waitForSelector('dialog.image-dialog[open]', { timeout: 10000 });

  // Felder über die echten Eingabefelder füllen (x-model → Card-State).
  await page.fill('#image-alt-input', 'Ein Käfer auf einem Blatt');
  await page.fill('#image-credit-input', 'Foto: Keystone');
  await page.click('dialog.image-dialog .editor-dialog__actions button.primary');
  await page.waitForSelector('dialog.image-dialog[open]', { state: 'detached', timeout: 10000 })
    .catch(() => page.waitForFunction(() => !document.querySelector('dialog.image-dialog')?.open,
      null, { timeout: 10000 }));

  // Im Editor: Nachweis als LETZTES Kind der Abbildung und atomar — er wird im
  // Dialog gepflegt, nicht frei getippt.
  const inEditor = await page.evaluate(() => {
    const fig = document.querySelector('#editor-card .page-content-view--editing figure');
    const credit = fig.querySelector('p.figure-credit');
    return {
      alt: fig.querySelector('img').getAttribute('alt'),
      credit: credit?.textContent,
      creditIsLast: fig.lastElementChild === credit,
      creditEditable: credit?.getAttribute('contenteditable'),
      caption: fig.querySelector('figcaption').textContent,
    };
  });
  expect(inEditor).toEqual({
    alt: 'Ein Käfer auf einem Blatt',
    credit: 'Foto: Keystone',
    creditIsLast: true,
    creditEditable: 'false',
    caption: 'Der Käfer',
  });

  await page.evaluate(async () => { await window.__app.saveEdit(); });
  await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 15000 });

  const stored = await serverHtml(page);
  expect(stored).toContain('alt="Ein Käfer auf einem Blatt"');
  // Attributreihenfolge nicht festnageln: `ensureBlockIds` setzt am
  // Write-Chokepoint zusätzlich ein `data-bid` auf jeden Block.
  expect(stored).toMatch(/<p\b[^>]*class="figure-credit"[^>]*>Foto: Keystone<\/p>/);
  expect(stored).toContain('<figcaption>Der Käfer</figcaption>');
  // Laufzeit-Attribut gehört nie in die Persistenz (Server-Cleaner).
  expect(stored).not.toContain('contenteditable');
});

test('Legenden-Nummer steht in der Leseansicht, nie in der Seite', async ({ page }) => {
  await boot(page);
  await setFigureNumbering(page, true);
  await openPageInEdit(page, 1);
  await appendFigure(page, 'Das Zimmer');
  await page.evaluate(async () => { await window.__app.saveEdit(); });
  await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 15000 });
  await reloadPageFromServer(page, 1);

  // Leseansicht: das Badge steht VOR dem Legendentext und ist ein eigenes
  // Element — die Nummer wird nie in den Text des Autors geschrieben.
  await page.waitForSelector(`${READ_SEL} figcaption .xref-num`, { timeout: 20000 });
  const shown = await page.evaluate((sel) => {
    const cap = document.querySelector(`${sel} figcaption`);
    const badge = cap.querySelector('.xref-num');
    return {
      badgeText: badge.textContent,
      badgeIsFirst: cap.firstChild === badge,
      captionText: cap.textContent,
    };
  }, READ_SEL);
  expect(shown.badgeText).toMatch(/^Abb\. \d+(\.\d+)?: $/);
  expect(shown.badgeIsFirst).toBe(true);
  expect(shown.captionText).toContain('Das Zimmer');

  // Die gespeicherte Seite trägt weder Badge noch Nummer.
  const stored = await serverHtml(page);
  expect(stored).toContain('<figcaption>Das Zimmer</figcaption>');
  expect(stored).not.toContain('xref-num');
  expect(stored).not.toContain('Abb. ');
});

test('Öffnen und Speichern ohne Änderung erzeugt keine Scheinänderung', async ({ page }) => {
  await boot(page);
  await setFigureNumbering(page, true);
  await openPageInEdit(page, 2);
  await appendFigure(page, 'Die Wanze');
  await page.evaluate(() => {
    const fig = document.querySelector('#editor-card .page-content-view--editing figure');
    const card = window.Alpine.$data(document.querySelector('[x-data="editorToolbarCard"]'));
    card.openImageForEl(fig);
    card.imageCredit = 'Foto: A';
    card.applyImageMeta();
  });
  await page.evaluate(async () => { await window.__app.saveEdit(); });
  await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 15000 });
  await reloadPageFromServer(page, 2);
  // Badge in der Leseansicht abwarten — danach steht ein Fremdknoten im DOM,
  // gegen den der Dirty-Vergleich beim nächsten Edit-Start laufen müsste.
  await page.waitForSelector(`${READ_SEL} figcaption .xref-num`, { timeout: 20000 });

  // Editor erneut öffnen: der Editier-Container wird aus dem Server-Stand
  // gemountet, das Badge darf dort nicht auftauchen und die Seite nicht als
  // geändert gelten.
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
  const state = await page.evaluate(() => ({
    dirty: window.__app.editDirty,
    badgeInEditor: !!document.querySelector('#editor-card .page-content-view--editing .xref-num'),
  }));
  expect(state).toEqual({ dirty: false, badgeInEditor: false });
});

test('Leere Legende: im Edit-Modus Schreibplatz, in der Leseansicht keine Leerzeile', async ({ page }) => {
  await boot(page);
  await setFigureNumbering(page, false);
  await openPageInEdit(page, 3);
  await appendFigure(page, '<br>');
  expect(await page.locator(`${EDIT_SEL} figcaption`).last().isVisible()).toBe(true);
  await page.evaluate(async () => { await window.__app.saveEdit(); });
  await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 15000 });
  await page.waitForSelector(`${READ_SEL} figure`, { timeout: 15000 });
  expect(await page.locator(`${READ_SEL} figure figcaption`).last().isVisible()).toBe(false);
});
