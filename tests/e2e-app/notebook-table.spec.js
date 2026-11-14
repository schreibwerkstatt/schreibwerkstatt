// Tabellen im NOTEBOOK-Editor, gegen die ECHTE App.
//
// WARUM DIESE SCHICHT: der Gitter-Dialog ist verschachteltes Alpine-Markup
// (`x-if` um zwei `x-for`-Ebenen, public/partials/editor-table-dialog.html).
// Alpine schluckt Expression-Fehler — ein Tippfehler dort zeigt sich nicht als
// Ausnahme, sondern als leeres Gitter. Der Smoke-Test faengt das NICHT: er
// oeffnet Karten, aber keinen Dialog. Dazu kommt `contenteditable`, das Chromium
// auswertet und nicht unser Code, und die Dirty-Erkennung, die den gemounteten
// Editor-DOM gegen den Server-Stand vergleicht.
//
// Geprueft:
//   1. Slash-Menue kennt „Tabelle"; der Dialog oeffnet mit gefuelltem Gitter.
//   2. Uebernehmen schreibt Markup nach dem Vertrag (thead/scope, data-align).
//   3. Die Tabelle ueberlebt Speichern → Neuladen → Edit-Modus.
//   4. `contenteditable` landet NIE in der Persistenz.
//   5. Oeffnen + Speichern ohne Aenderung erzeugt keine Aenderung (die Tabelle
//      ist beim Mount atomar markiert — ohne den Strip gaelte jede Seite mit
//      Tabelle beim Oeffnen als geaendert).
//   6. Klick auf eine gesetzte Tabelle oeffnet den Dialog zum Bearbeiten.
//   7. Bearbeiten behaelt das `data-bid` — sonst laufen Querverweise ins Leere.
//   8. Kopfzeile ab- und wieder einschalten bringt ihren Inhalt zurueck.
//   9. Die Spaltenausrichtung ist in der Leseansicht sichtbar (CSS auf data-align).
//  10. «Speichern» im Dialog ohne Aenderung schreibt nichts — eine importierte
//      Tabelle mit verbundenen Zellen bleibt unplaniert.
//  11. Gitter: Enter/Tab legen Zeilen an, Einfuegen aus einer Tabellen-
//      kalkulation verteilt sich, das Kopf-Menue verschiebt und fuegt ein.
//  12. Tabelle aus der Zwischenablage kommt als atomare Tabelle an, ohne style.
//  13. Alt+Enter neben einer Tabelle oeffnet ihren Dialog; Entfernen fragt nach.
//
// Konventionen wie notebook-xref.spec.js: Inhalt wird ANGEHAENGT, und jeder Test
// arbeitet auf einer eigenen Seite — die Smoke-DB lebt ueber den ganzen Lauf.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';
const DLG_SEL = 'dialog.table-dialog';

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

// Dialog ueber den Karten-Scope oeffnen (der Slash-Weg braucht echte Tastatur —
// den prueft Test 1 separat).
async function openTableDialog(page) {
  await page.evaluate(() => {
    const el = document.querySelector('#partial-editor-toolbar [x-data="editorToolbarCard"]')
      || document.querySelector('[x-data="editorToolbarCard"]');
    window.Alpine.$data(el).openTableDialog(null);
  });
  await page.waitForSelector(`${DLG_SEL}[open]`, { timeout: 5000 });
}

async function serverHtml(page) {
  return page.evaluate(async () => {
    const id = window.__app.currentPage.id;
    const r = await fetch(`/content/pages/${id}`, { headers: { Accept: 'application/json' } });
    return (await r.json()).html || '';
  });
}

test('Slash-Menue bietet „Tabelle" an', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 0);
  const keys = await page.evaluate(() => {
    const el = document.querySelector('[x-data="editorToolbarCard"]');
    return window.Alpine.$data(el).slashItems().map(i => i.key);
  });
  expect(keys).toContain('tabelle');
});

test('Dialog rendert ein befuelltes Gitter (verschachteltes x-for)', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 0);
  await openTableDialog(page);

  // Kopfzeile + zwei Datenzeilen × drei Spalten = 9 Zellenfelder. Bliebe ein
  // x-for stumm, waeren es 0 — genau der Fehler, den Alpine verschluckt.
  await expect(page.locator(`${DLG_SEL} .table-grid-input`)).toHaveCount(9);
  await expect(page.locator(`${DLG_SEL} .table-grid-colhead`)).toHaveCount(3);
  await expect(page.locator(`${DLG_SEL} .table-caption-input`)).toHaveCount(1);
  // Ausrichtungs-Knoepfe: drei pro Spalte.
  await expect(page.locator(`${DLG_SEL} .table-align-btn`)).toHaveCount(9);
});

test('Zeile/Spalte hinzufuegen und entfernen wirkt aufs Gitter', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 0);
  await openTableDialog(page);

  await page.locator(`${DLG_SEL} .table-dialog-tools button`).nth(0).click(); // Zeile
  await expect(page.locator(`${DLG_SEL} .table-grid-input`)).toHaveCount(12);
  await page.locator(`${DLG_SEL} .table-dialog-tools button`).nth(1).click(); // Spalte
  await expect(page.locator(`${DLG_SEL} .table-grid-input`)).toHaveCount(16);
  // Kopfzeile abschalten → die Kopf-Felder verschwinden.
  await page.locator(`${DLG_SEL} .table-dialog-tools button`).nth(2).click();
  await expect(page.locator(`${DLG_SEL} .table-grid-input`)).toHaveCount(12);
});

test('Uebernehmen schreibt Markup nach dem Vertrag und ueberlebt den Save', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 1);
  await openTableDialog(page);

  // Zellen ueber die echten Felder befuellen (Input-Event-Pfad, nicht via State).
  const cells = page.locator(`${DLG_SEL} .table-grid-input`);
  await cells.nth(0).fill('Jahr');
  await cells.nth(1).fill('Umsatz');
  await cells.nth(2).fill('Quote');
  await cells.nth(3).fill('2023');
  await cells.nth(4).fill('1.2 Mio');
  await cells.nth(5).fill('4.1 %');
  await page.locator(`${DLG_SEL} .table-caption-input`).fill('Umsatz nach Jahr');
  // Zweite Spalte rechtsbuendig.
  await page.locator(`${DLG_SEL} .table-grid-colhead`).nth(1)
    .locator('.table-align-btn').nth(2).click();

  await page.locator(`${DLG_SEL} .editor-dialog__actions button.primary`).click();
  await page.waitForSelector(`${DLG_SEL}[open]`, { state: 'detached', timeout: 5000 });

  await expect(page.locator(`${EDIT_SEL} table`)).toHaveCount(1);
  await page.evaluate(async () => { await window.__app.saveEdit(); });
  await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 15000 });

  const html = await serverHtml(page);
  expect(html).toContain('<table');
  expect(html).toContain('<caption>Umsatz nach Jahr</caption>');
  expect(html).toMatch(/<th[^>]*scope="col"/);
  expect(html).toContain('data-align="right"');
  expect(html).toContain('1.2 Mio');
  // Editor-Laufzeit gehoert nie in die Persistenz.
  expect(html).not.toContain('contenteditable');
  // Die Nummer ist ein Render-Artefakt — sie darf nicht mitgespeichert werden.
  expect(html).not.toMatch(/Tab\.\s*\d/);

  // Leseansicht: die Ausrichtung wirkt (manuscript-content.css, data-align).
  const align = await page.locator('#editor-card .page-content-view td[data-align="right"]').first()
    .evaluate((el) => getComputedStyle(el).textAlign);
  expect(align).toBe('right');
});

test('Abschnitt mit Tabelle oeffnen und speichern laesst sie unberuehrt', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 1);
  const before = await serverHtml(page);
  expect(before).toContain('<table');

  await page.evaluate(async () => { await window.__app.saveEdit(); });
  await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 15000 });
  const after = await serverHtml(page);
  expect(after).toBe(before);
});

test('Klick auf eine gesetzte Tabelle oeffnet den Dialog zum Bearbeiten', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 1);
  await page.locator(`${EDIT_SEL} table`).first().click();
  await page.waitForSelector(`${DLG_SEL}[open]`, { timeout: 5000 });

  // Bearbeiten-Modus: „Tabelle entfernen" ist sichtbar, das Gitter traegt den
  // gespeicherten Inhalt.
  await expect(page.locator(`${DLG_SEL} .editor-dialog__actions button.danger`)).toBeVisible();
  await expect(page.locator(`${DLG_SEL} .table-caption-input`)).toHaveValue('Umsatz nach Jahr');
  const first = await page.locator(`${DLG_SEL} .table-grid-input`).first().inputValue();
  expect(first).toBe('Jahr');

  await page.locator(`${DLG_SEL} .editor-dialog__actions button:not(.primary):not(.danger)`).last().click();
  await page.waitForSelector(`${DLG_SEL}[open]`, { state: 'detached', timeout: 5000 });
});

test('Bearbeiten behaelt die Block-ID der Tabelle (Querverweis-Anker)', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 1);
  const before = await serverHtml(page);
  const bid = (before.match(/<table[^>]*data-bid="([0-9a-f]+)"/) || [])[1];
  expect(bid, 'die gespeicherte Tabelle muss ein data-bid tragen').toBeTruthy();

  await page.locator(`${EDIT_SEL} table`).first().click();
  await page.waitForSelector(`${DLG_SEL}[open]`, { timeout: 5000 });
  await page.locator(`${DLG_SEL} .table-grid-input`).nth(4).fill('9.9 Mio');
  await page.locator(`${DLG_SEL} .editor-dialog__actions button.primary`).click();
  await page.waitForSelector(`${DLG_SEL}[open]`, { state: 'detached', timeout: 5000 });

  await page.evaluate(async () => { await window.__app.saveEdit(); });
  await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 15000 });
  const after = await serverHtml(page);
  expect(after).toContain('9.9 Mio');
  expect(after).toContain(`data-bid="${bid}"`);
});

test('Kopfzeile ab- und wieder einschalten bringt ihren Inhalt zurueck', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 0);
  await openTableDialog(page);

  const cells = page.locator(`${DLG_SEL} .table-grid-input`);
  await cells.nth(0).fill('Jahr');
  const toggle = page.locator(`${DLG_SEL} .table-dialog-tools button`).nth(2);
  await toggle.click();
  await expect(cells).toHaveCount(6);
  await toggle.click();
  await expect(cells).toHaveCount(9);
  await expect(cells.nth(0)).toHaveValue('Jahr');
});

// Tabelle direkt in den Live-Editor setzen (wie ein Import sie hinterlaesst)
// und atomar machen, wie der Mount es tut.
async function injectTable(page, html) {
  await page.evaluate(({ sel, html }) => {
    const edit = document.querySelector(sel);
    const box = document.createElement('div');
    box.innerHTML = html;
    const t = box.firstElementChild;
    t.setAttribute('contenteditable', 'false');
    edit.appendChild(t);
    const p = document.createElement('p');
    p.innerHTML = 'danach';
    edit.appendChild(p);
  }, { sel: EDIT_SEL, html });
}

test('Speichern im Dialog ohne Aenderung planiert keine verbundenen Zellen', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 2);
  await injectTable(page, '<table><tbody><tr><td colspan="2">Gesamt</td></tr><tr><td>a</td><td>b</td></tr></tbody></table>');

  await page.locator(`${EDIT_SEL} table`).last().click();
  await page.waitForSelector(`${DLG_SEL}[open]`, { timeout: 5000 });
  await expect(page.locator(`${DLG_SEL} .table-dialog-warn`)).toBeVisible();
  await page.locator(`${DLG_SEL} .editor-dialog__actions button.primary`).click();
  await page.waitForSelector(`${DLG_SEL}[open]`, { state: 'detached', timeout: 5000 });

  await expect(page.locator(`${EDIT_SEL} table td[colspan="2"]`)).toHaveCount(1);
});

test('Gitter: Enter und Tab wandern und legen Zeilen an', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 0);
  await openTableDialog(page);
  const cell = (r, c) => page.locator(`${DLG_SEL} [data-cell="${r}:${c}"]`);

  // Fokus steht beim Oeffnen in der ersten Zelle (Kopf).
  await expect(cell(-1, 0)).toBeFocused();
  // Enter: gleiche Spalte, naechste Zeile; in der letzten Zeile neue Zeile.
  await page.keyboard.press('Enter');
  await expect(cell(0, 0)).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(cell(2, 0)).toBeFocused();
  // Tab in der letzten Zelle: noch eine Zeile, Fokus in deren erste Zelle.
  await cell(2, 2).focus();
  await page.keyboard.press('Tab');
  await expect(cell(3, 0)).toBeFocused();
});

// Gecko ignoriert das im `ClipboardEvent`-Konstruktor uebergebene
// `DataTransfer` (Muster notebook-cite.spec.js) — Paste nur in Chromium.
test('Gitter: Einfuegen aus einer Tabellenkalkulation verteilt sich', async ({ page, browserName }) => {
  test.skip(browserName === 'firefox', 'ClipboardEvent traegt in Gecko kein synthetisches DataTransfer');
  await boot(page);
  await openPageInEdit(page, 0);
  await openTableDialog(page);
  const cell = (r, c) => page.locator(`${DLG_SEL} [data-cell="${r}:${c}"]`);

  // Einfuegen ab Zelle (0,1): 2 Zeilen × 3 Spalten → eine Spalte kommt dazu.
  await cell(0, 1).focus();
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const dt = new DataTransfer();
    dt.setData('text/plain', 'A\tB\t"C\nmit Umbruch"\r\nD\tE\tF\r\n');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, `${DLG_SEL} [data-cell="0:1"]`);
  await expect(page.locator(`${DLG_SEL} .table-grid-colhead`)).toHaveCount(4);
  await expect(cell(0, 1)).toHaveValue('A');
  await expect(cell(0, 3)).toHaveValue('C mit Umbruch');
  await expect(cell(1, 2)).toHaveValue('E');
  await expect(page.locator(`${DLG_SEL} tbody tr:not(.table-grid-headrow)`)).toHaveCount(2);
});

test('Gitter: Aktionsmenue am Zeilenkopf verschiebt und fuegt ein', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 0);
  await openTableDialog(page);
  const cell = (r, c) => page.locator(`${DLG_SEL} [data-cell="${r}:${c}"]`);
  await cell(0, 0).fill('eins');
  await cell(1, 0).fill('zwei');

  const rowMenu = (r) => page.locator(`${DLG_SEL} tbody tr:not(.table-grid-headrow)`).nth(r)
    .locator('.table-grid-menu-btn');
  await rowMenu(0).click();
  const menu = page.locator('.context-menu[role="menu"]:visible');
  await expect(menu).toBeVisible();
  await menu.locator('.context-menu-item').nth(3).click(); // nach unten
  await expect(cell(0, 0)).toHaveValue('zwei');
  await expect(cell(1, 0)).toHaveValue('eins');
  // Das Feld folgt seiner Zeile (stabiler Schluessel), nicht dem Index.
  await rowMenu(1).click();
  await menu.locator('.context-menu-item').nth(0).click(); // darueber einfuegen
  await expect(cell(1, 0)).toHaveValue('');
  await expect(cell(2, 0)).toHaveValue('eins');
  // Dialog bleibt offen (Esc/Klick im Menue gilt nur dem Menue).
  await expect(page.locator(`${DLG_SEL}[open]`)).toHaveCount(1);
});

test('Tabelle aus der Zwischenablage kommt als atomare Tabelle an', async ({ page, browserName }) => {
  test.skip(browserName === 'firefox', 'ClipboardEvent traegt in Gecko kein synthetisches DataTransfer');
  await boot(page);
  await openPageInEdit(page, 3);
  await page.evaluate((sel) => {
    const edit = document.querySelector(sel);
    const p = document.createElement('p');
    p.textContent = 'Vorher';
    edit.appendChild(p);
    edit.focus();
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    const dt = new DataTransfer();
    dt.setData('text/html', '<meta charset="utf-8"><style>td{color:red}</style>'
      + '<table style="width:300px"><tr><th style="font-weight:bold">Jahr</th><th align="right">Umsatz</th></tr>'
      + '<tr><td class="xl65" style="color:red">2023</td><td>1.2 Mio</td></tr></table>');
    dt.setData('text/plain', 'Jahr\tUmsatz\n2023\t1.2 Mio');
    edit.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, EDIT_SEL);

  const t = page.locator(`${EDIT_SEL} > table`).last();
  await expect(t).toHaveCount(1);
  await expect(t).toHaveAttribute('contenteditable', 'false');
  const info = await t.evaluate((el) => ({
    html: el.outerHTML,
    inP: !!el.closest('p'),
    next: el.nextElementSibling?.tagName || null,
  }));
  expect(info.inP).toBe(false);
  expect(info.next).toBe('P');
  expect(info.html).not.toContain('style=');
  expect(info.html).toContain('<th scope="col">Jahr</th>');
  expect(info.html).toContain('<td>2023</td>');
  // Kein Textbrei aus aneinandergeklebten Zellen.
  const text = await page.locator(EDIT_SEL).innerText();
  expect(text).not.toContain('JahrUmsatz');
});

test('Alt+Enter neben einer Tabelle oeffnet den Dialog, Entfernen fragt nach', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 2);
  await injectTable(page, '<table><tbody><tr><td>x</td><td>y</td></tr></tbody></table>');
  // Caret an den Anfang des Absatzes hinter der Tabelle.
  await page.evaluate((sel) => {
    const edit = document.querySelector(sel);
    const p = edit.lastElementChild;
    edit.focus();
    const r = document.createRange();
    r.setStart(p.firstChild, 0);
    r.collapse(true);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }, EDIT_SEL);
  await page.keyboard.press('Alt+Enter');
  await page.waitForSelector(`${DLG_SEL}[open]`, { timeout: 5000 });
  await expect(page.locator(`${DLG_SEL} [data-cell="0:1"]`)).toHaveValue('y');

  const asked = await page.evaluate(() => {
    window.__asked = 0;
    window.__app.appConfirm = async () => { window.__asked++; return false; };
    return true;
  });
  expect(asked).toBe(true);
  await page.locator(`${DLG_SEL} .editor-dialog__actions button.danger`).click();
  await expect.poll(() => page.evaluate(() => window.__asked)).toBe(1);
  // Abgelehnt: Dialog offen, Tabelle noch da.
  await expect(page.locator(`${DLG_SEL}[open]`)).toHaveCount(1);
  await expect(page.locator(`${EDIT_SEL} table`).last()).toContainText('y');
});
