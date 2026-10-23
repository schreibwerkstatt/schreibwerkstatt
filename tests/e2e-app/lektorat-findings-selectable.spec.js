// Befundliste der Notebook-Leseansicht, gegen die ECHTE App: welche Befunde sich
// anhaken lassen und wie mehrdeutige Fundstellen erscheinen.
//
// - `mehrdeutig` (Server: lektorat-page.js#markAmbiguous) trägt das Tag
//   „mehrdeutig" und ist nicht vorausgewählt — «Übernehmen» ersetzt das erste
//   Vorkommen, das nicht das gemeinte sein muss.
// - Übernommene Befunde und Befunde ohne wirksamen Vorschlag haben eine
//   gesperrte Checkbox; «Alle» lässt sie aus (editor/lektorat.js#findingSelectable).
// Die Bindungen hängen am Alpine-Template (public/partials/editor-findings.html):
// ein Tippfehler im Ausdruck verschluckt Alpine still.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('Befundliste: mehrdeutig gekennzeichnet, Übernommenes und Vorschlagsloses gesperrt', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => {
    await window.__app.selectPage(window.Alpine.store('nav').pages[0]);
  });
  await page.evaluate(() => {
    const app = window.__app;
    app.originalHtml = '<p>Er sagte, dass er kommt. Sie wusste, dass er lügt. Ein Fhler und eine Lüke.</p>';
    app.appliedOriginals = ['Ein Fhler'];
    app.lektoratFindings = [
      { typ: 'grammatik', original: 'dass er', korrektur: 'das er', erklaerung: 'x', mehrdeutig: true },
      { typ: 'rechtschreibung', original: 'Ein Fhler', korrektur: 'Ein Fehler', erklaerung: 'x' },
      { typ: 'rechtschreibung', original: 'eine Lüke', korrektur: '', erklaerung: 'x' },
      { typ: 'rechtschreibung', original: 'Sie wusste', korrektur: 'Sie wusste,', erklaerung: 'x' },
    ];
    app.selectedFindings = app.lektoratFindings.map(f => app.findingPreselected(f));
    app.checkDone = true;
  });

  expect(await page.evaluate(() => window.__app.selectedFindings)).toEqual([false, false, false, true]);

  const rows = page.locator('.lektorat-split-findings label.finding');
  await expect(rows).toHaveCount(4);
  const label = await page.evaluate(() => window.__app.t('editor.findings.ambiguous'));
  const ambiguousTag = (i) => rows.nth(i).locator('> .tag').filter({ hasText: label });
  await expect(ambiguousTag(0)).toBeVisible();
  await expect(ambiguousTag(3)).toBeHidden();

  const box = (i) => rows.nth(i).locator('.finding-checkbox');
  await expect(box(0)).toBeEnabled();
  await expect(box(1)).toBeDisabled();
  await expect(box(2)).toBeDisabled();
  await expect(box(3)).toBeEnabled();

  await page.locator('.finding-toggle-group button').first().click();
  expect(await page.evaluate(() => window.__app.selectedFindings)).toEqual([true, false, false, true]);
});
