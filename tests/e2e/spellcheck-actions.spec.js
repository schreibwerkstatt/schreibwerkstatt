// E2E: Popover-Aktionen des Spellcheck-Controllers (Harness, Notebook-Setup):
// Ignorieren (am Wort, nicht am Offset), Alle ignorieren, Plakette nach
// Ignorieren, Ersetzen nach Tippen ins markierte Wort, optionale Knoepfe ohne
// Uebersetzung (macOS-Client). LT-Mock: Walld -> Tippfehler, scheinet -> Grammatik.

const { test, expect } = require('./_helpers/fixtures');

const HARNESS = '/tests/fixtures/spellcheck-harness.html?kind=notebook';

async function open(page, query = '') {
  await page.goto(HARNESS + query, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
}

async function setText(page, html) {
  await page.evaluate((h) => { document.getElementById('editor').innerHTML = h; window.__spellcheckCtl.refresh(); }, html);
}

function typoCount(page) {
  return page.evaluate(() => CSS.highlights.get('lt-typo')?.size || 0);
}

async function clickTypo(page) {
  const pt = await page.evaluate(() => {
    const r = CSS.highlights.get('lt-typo').values().next().value.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(pt.x, pt.y);
  await page.waitForSelector('.lt-popover');
}

test('ignorieren: Plakette zaehlt sofort runter', async ({ page }) => {
  await open(page);
  await page.waitForSelector('.lt-badge[data-state="matches"]');
  await expect(page.locator('.lt-badge__label')).toHaveText('2');
  await clickTypo(page);
  await page.locator('.lt-popover__ignore').click();
  await expect(page.locator('.lt-badge__label')).toHaveText('1');
});

test('ignorieren ueberlebt Text, der davor eingefuegt wird', async ({ page }) => {
  await open(page);
  await expect.poll(() => typoCount(page)).toBe(1);
  await clickTypo(page);
  await page.locator('.lt-popover__ignore').click();
  await expect.poll(() => typoCount(page)).toBe(0);
  // Text vor dem Treffer verschiebt dessen Offset; der Re-Check darf ihn nicht
  // wieder markieren. Gewartet wird auf die Antwort des Re-Checks selbst und
  // darauf, dass der Grammatik-Treffer neu registriert ist.
  const recheck = page.waitForResponse((r) => r.url().includes('/languagetool/check'));
  await page.evaluate(() => {
    const p = document.querySelector('#editor p');
    p.firstChild.insertData(0, 'Am Morgen ');
  });
  await recheck;
  await page.waitForSelector('.lt-badge[data-state="matches"]');
  expect(await typoCount(page)).toBe(0);
});

test('alle ignorieren: trifft jede Stelle mit demselben Wort', async ({ page }) => {
  await open(page, '&i18n=1');
  await setText(page, '<p>Ein Walld.</p><p>Noch ein Walld hier.</p>');
  await expect.poll(() => typoCount(page)).toBe(2);
  await clickTypo(page);
  await page.locator('.lt-popover__ignore-all').click();
  await expect.poll(() => typoCount(page)).toBe(0);
  await expect(page.locator('.lt-badge')).toHaveAttribute('data-state', 'clean');
});

test('ersetzen nach Tippen ins markierte Wort: Text bleibt, wird neu geprueft', async ({ page }) => {
  await open(page);
  await expect.poll(() => typoCount(page)).toBe(1);
  await clickTypo(page);
  // Waehrend der Popover offen ist, aendert sich das Wort unter dem Squiggle.
  await page.evaluate(() => {
    const p = document.querySelector('#editor p');
    const t = p.firstChild;
    t.insertData(t.data.indexOf('Walld') + 3, 'X');
  });
  await page.locator('.lt-popover__replacement').first().click();
  const text = await page.locator('#editor').textContent();
  expect(text).toContain('WalXld');
  expect(text).not.toContain(' Wald.');
});

test('ohne Uebersetzung (macOS-Bridge): keine optionalen Knoepfe', async ({ page }) => {
  await open(page);
  await expect.poll(() => typoCount(page)).toBe(1);
  await clickTypo(page);
  await expect(page.locator('.lt-popover__ignore')).toHaveCount(1);
  await expect(page.locator('.lt-popover__ignore-all')).toHaveCount(0);
  await expect(page.locator('.lt-popover__rule')).toHaveCount(0);
  await expect(page.locator('.lt-popover__dict')).toHaveCount(1);
});

test('mit Uebersetzung und Buch: Buch-/Global-Woerterbuch und Regel abschalten', async ({ page }) => {
  await open(page, '&i18n=1');
  await expect.poll(() => typoCount(page)).toBe(1);
  await clickTypo(page);
  await expect(page.locator('.lt-popover__dict')).toHaveText([
    'T:spellcheck.popover.add_to_dict_book', 'T:spellcheck.popover.add_to_dict_global',
  ]);
  await expect(page.locator('.lt-popover__rule')).toHaveText('T:spellcheck.popover.disable_rule_book');
});
