// Tooltip bei Fokus nur für Tastatur-Fokus (public/js/tooltip.js): öffnet ein
// Mausklick einen Dialog, setzt `showModal()` den Fokus programmatisch auf den
// ersten Knopf darin. Zeigte der Tooltip-Layer dann dessen `data-tip`, blitzte
// er auf und verschwand bei der nächsten Mausbewegung (Revisions-Viewer:
// «Version anheften …» oben links hinter dem Dialog). Per Tab erscheint er.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp } = require('./_helpers/app');

test('Tooltip: kein Tooltip bei Fokus nach Mausklick, wohl aber per Tab', async ({ page }) => {
  await bootApp(page);
  await page.evaluate(() => {
    const opener = document.createElement('button');
    opener.id = 'tip-opener'; opener.type = 'button'; opener.textContent = 'Öffnen';
    const dlg = document.createElement('dialog');
    dlg.id = 'tip-dialog';
    dlg.innerHTML = '<button type="button" id="tip-first" data-tip="Erster Knopf">Eins</button>'
      + '<button type="button" id="tip-second" data-tip="Zweiter Knopf">Zwei</button>';
    opener.addEventListener('click', () => dlg.showModal());
    document.body.prepend(opener, dlg);
    // Das Aufblitzen dauert nur einen Frame (die nächste Maus-Grenze räumt den
    // Tooltip weg) — darum jedes Einblenden mitschreiben, nicht den Endzustand.
    window.__tipShown = [];
    new MutationObserver(() => {
      const l = document.querySelector('.tip-layer.tip-visible');
      if (l) window.__tipShown.push(l.textContent);
    }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
  });
  await page.locator('#tip-opener').click();
  await expect(page.locator('#tip-first')).toBeFocused();
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__tipShown), 'Tooltip nach Mausklick-Fokus').toEqual([]);

  await page.keyboard.press('Tab');
  await expect(page.locator('#tip-second')).toBeFocused();
  await expect(page.locator('.tip-layer.tip-visible')).toContainText('Zweiter Knopf');
});
