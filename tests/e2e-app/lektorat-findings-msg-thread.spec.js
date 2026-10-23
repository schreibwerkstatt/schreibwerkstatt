// Lektorat-Befunde im Nachrichtenverlauf (div.msg-thread) in der Befundliste der
// Notebook-Leseansicht, gegen die ECHTE App.
//
// Chat-Schreibweise ist Figurenrede. Ein harter Befund darin (z.B. Rechtschreibung)
// darf nicht vorausgewählt sein — sonst bügelt „Korrekturen speichern" SMS-Sprache
// glatt, die der Autor nie einzeln angehakt hat — und trägt die Kennzeichnung
// „im Nachrichtenverlauf". Derselbe Typ ausserhalb des Verlaufs bleibt vorausgewählt.
// Die Kennzeichnung hängt am Alpine-Template (public/partials/editor-findings.html):
// ein Tippfehler im Ausdruck verschluckt Alpine still.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('Befundliste: harter Befund im Nachrichtenverlauf ist gekennzeichnet und nicht vorausgewählt', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => {
    await window.__app.selectPage(window.Alpine.store('nav').pages[0]);
  });
  await page.evaluate(() => {
    const app = window.__app;
    app.originalHtml = '<p>Er schrieb ihr ein Fhler.</p>'
      + '<div class="msg-thread"><p class="msg-name">Lena</p><p class="msg-in">bist du schon daa??</p></div>';
    app.lektoratFindings = [
      { typ: 'rechtschreibung', original: 'ein Fhler', korrektur: 'einen Fehler', erklaerung: 'Tippfehler.' },
      { typ: 'rechtschreibung', original: 'schon daa??', korrektur: 'schon da?', erklaerung: 'Tippfehler.' },
    ];
    app.selectedFindings = app.lektoratFindings.map(f => app.findingPreselected(f));
    app.checkDone = true;
  });

  expect(await page.evaluate(() => window.__app.selectedFindings)).toEqual([true, false]);

  const rows = page.locator('.lektorat-split-findings label.finding');
  await expect(rows).toHaveCount(2);
  // Über den Text, nicht nur die Klasse: die Zeile trägt weitere Tags mit
  // Tooltip (z.B. „mehrdeutig").
  const label = await page.evaluate(() => window.__app.t('editor.findings.inMsgThread'));
  const tag = (i) => rows.nth(i).locator('> .tag[data-tip]').filter({ hasText: label });
  await expect(tag(1)).toBeVisible();
  await expect(tag(1)).toHaveText(/\S/);
  await expect(tag(0)).toBeHidden();
  await expect(rows.nth(1).locator('.finding-checkbox')).not.toBeChecked();
  await expect(rows.nth(0).locator('.finding-checkbox')).toBeChecked();
});
