// Fortschritts-Block über der Befundliste der Notebook-Leseansicht
// (docs/lektorat.md, „Fortschritt seit dem letzten Lektorat"), gegen die ECHTE
// App: der Block hängt an Template-Ausdrücken in editor-findings.html und an
// `collapsible` — ein verschluckter Alpine-Fehler fiele nur hier auf.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('Fortschritt: Zählzeile, Typ-Delta, Streuungs-Hinweis und behobene Stellen', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => {
    await window.__app.selectPage(window.Alpine.store('nav').pages[0]);
  });
  await page.evaluate(() => {
    const app = window.__app;
    app.lektoratFindings = [
      { typ: 'fuellwort', original: 'eigentlich', korrektur: '', erklaerung: 'Füllwort.' },
    ];
    app.selectedFindings = [false];
    app.lektoratProgress = {
      prevCheckedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
      prevCount: 4, count: 1,
      fixed: 2, viaApply: 1, remaining: 1, added: 0, notReported: 1,
      byType: [{ typ: 'grammatik', delta: -2 }, { typ: 'wiederholung', delta: 1 }],
      fixedItems: [
        { typ: 'grammatik', original: 'der Hund bellen', korrektur: 'der Hund bellt' },
        { typ: 'grammatik', original: 'wegen dem Regen', korrektur: 'wegen des Regens' },
      ],
    };
    app.checkDone = true;
  });

  const block = page.locator('.lektorat-split-findings .lektorat-progress');
  await expect(block).toBeVisible();
  await expect(block.locator('.lektorat-progress-total')).toHaveText(/4 → 1/);
  await expect(block.locator('.lektorat-progress-fixed')).toHaveText(/2.*1/);
  await expect(block.locator('.lektorat-progress-better')).toHaveText(/−2$/);
  await expect(block.locator('.lektorat-progress-worse')).toHaveText(/\+1$/);
  await expect(block.locator('.lektorat-progress-note')).toBeVisible();

  const items = block.locator('.applied-history-item');
  await expect(items.first()).toBeHidden();
  await block.locator('.collapsible-toggle').click();
  await expect(items).toHaveCount(2);
  await expect(items.first()).toBeVisible();
  if (process.env.PROGRESS_SHOT) await block.screenshot({ path: process.env.PROGRESS_SHOT });

  // Neuer Lauf/Schliessen räumt den Block weg.
  await page.evaluate(() => window.__app.closeFindings());
  await expect(block).toHaveCount(0);
});
