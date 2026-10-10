// Struktur-Karte auf dem Handy gegen die ECHTE App: ein langer Kapitelname in der
// Tabelle darf die Karte nicht verbreitern — die Tabelle scrollt in ihrer eigenen
// Hülle (`.table-scroll`), die Seite bleibt bei Viewport-Breite.
//
// Die Karte ist nur bei Buchtyp 'journalismus' freigeschaltet; die Zeilen kommen
// aus den Abschnitten des Buchs und brauchen keinen Struktur-Lauf. Der lange Name
// wird nur im nav-Store gesetzt, nicht in der DB (die Smoke-DB lebt über den Lauf).

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test.describe.configure({ mode: 'serial' });

async function setBuchtyp(page, buchtyp) {
  await page.evaluate(async (bt) => {
    const bookId = window.Alpine.store('nav').selectedBookId;
    const res = await fetch(`/booksettings/${bookId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: 'de', region: 'CH', buchtyp: bt }),
    });
    if (!res.ok) throw new Error('booksettings PUT ' + res.status);
    await window.__app.loadBooks();
  }, buchtyp);
}

test.afterEach(async ({ page }) => {
  await setBuchtyp(page, 'roman').catch(() => {});
});

test('Handy: langer Kapitelname scrollt in der Tabelle, nicht die Karte', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await bootApp(page);
  await selectSeededBook(page);
  await setBuchtyp(page, 'journalismus');

  const longName = 'Ein Kapitel mit einem ausgesprochen langen Namen, der auf keinen Handybildschirm passt';
  await page.evaluate((name) => {
    const nav = Alpine.store('nav');
    const ch = nav.tree.find(c => c.type === 'chapter' && !c.solo);
    ch.name = name;
    nav.tree = [...nav.tree];
    window.__app.toggleStrukturCard();
  }, longName);

  const table = page.locator('.struktur-table');
  await expect(table).toBeVisible();
  await expect(table.locator('.entity-ref--kapitel .entity-ref__label', { hasText: longName }).first()).toBeVisible();

  const m = await page.evaluate(() => {
    const scroll = document.querySelector('.struktur-table').closest('.table-scroll');
    const card = document.querySelector('.card--struktur');
    return {
      hasScroll: !!scroll,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      cardOverflow: card.scrollWidth - card.clientWidth,
      cardRight: card.getBoundingClientRect().right,
      tableScrolls: scroll ? scroll.scrollWidth > scroll.clientWidth : false,
    };
  });
  expect(m.pageOverflow).toBe(0);
  expect(m.cardOverflow).toBe(0);
  expect(m.cardRight).toBeLessThanOrEqual(360);
  expect(m.hasScroll).toBe(true);
  // Der lange Name ist wirklich da und breiter als die Karte — sonst prüfte der Test nichts.
  expect(m.tableScrolls).toBe(true);
});
