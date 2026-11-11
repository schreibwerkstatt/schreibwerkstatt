// Touch-Verhalten auf dem iPad (DESIGN.md „Touch"): Bezug ist der Zeiger
// (`pointer: coarse`), nicht die Breite — ein iPad im Querformat ist so breit
// wie ein Laptop und bekommt keine Phone-Regel ab. Geometrie haengt am echten
// Shell-CSS (Tokens + Komponenten), darum hier und nicht im Fixture-Harness.
//
// Weg aus der Praxis: Recherche-Fundstueck im Detail-Dialog → «Verknuepfen» →
// Picker mit zwei Comboboxen. Dazu Tooltip nach Tap und das
// Offenbleiben der Combobox, wenn der Browser beim Tippen ins Suchfeld scrollt.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test.use({ viewport: { width: 1194, height: 834 }, hasTouch: true, isMobile: true });

let created = [];
test.afterEach(async ({ page }) => {
  const ids = created;
  created = [];
  await page.evaluate(async (list) => {
    for (const id of list) await fetch(`/research/${id}`, { method: 'DELETE' });
  }, ids).catch(() => {});
});

async function openLinkPicker(page, body = 'Notiz') {
  const bookId = await selectSeededBook(page);
  const itemId = await page.evaluate(async ([id, text]) => {
    const made = await fetch('/research', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: id, kind: 'note', title: 'iPad', body: text }),
    }).then((r) => r.json());
    return made.id;
  }, [bookId, body]);
  created.push(itemId);
  await page.evaluate(([b, i]) => { location.hash = `#book/${b}/recherche/${i}`; }, [bookId, itemId]);
  const dlg = page.locator('.research-dialog[open]');
  await expect(dlg).toBeVisible();
  await dlg.locator('.research-link-add').tap();
  const picker = dlg.locator('.picker-popover:visible');
  await expect(picker).toBeVisible();
  return picker;
}

// Langer Fund: «Verknuepfen» steht oben im Dialog (feste Leiste unter dem Kopf),
// nicht nach dem Volltext am unteren Bildschirmrand — dort hatten Picker und
// Auswahllisten keinen Platz. Picker klappt nach unten am Knopf auf, im Dialog,
// und die Verknuepfung laesst sich komplett per Tap setzen.
test('iPad: langer Fund — Verknuepfen oben, Picker nach unten, Verknuepfung per Tap', async ({ page }) => {
  await bootApp(page);
  const long = Array.from({ length: 60 }, (_, i) => `Absatz ${i + 1}: ` + 'Lorem ipsum dolor sit amet. '.repeat(6)).join('\n\n');
  const picker = await openLinkPicker(page, long);
  const dlg = page.locator('.research-dialog[open]');
  const geo = await page.evaluate(() => {
    const d = document.querySelector('.research-dialog[open]').getBoundingClientRect();
    const b = document.querySelector('.research-dialog[open] .research-link-add').getBoundingClientRect();
    const p = [...document.querySelectorAll('.research-dialog[open] .picker-popover')].find((e) => e.getClientRects().length).getBoundingClientRect();
    return { d: { left: d.left, top: d.top, bottom: d.bottom }, b: { left: b.left, bottom: b.bottom }, p: { left: p.left, top: p.top }, vh: innerHeight };
  });
  expect(geo.b.bottom, 'Knopf in der oberen Hälfte').toBeLessThan(geo.vh / 2);
  expect(geo.p.top, 'Picker unter dem Knopf').toBeGreaterThanOrEqual(geo.b.bottom);
  expect(geo.p.left, 'Picker am Knopf, nicht an den Rand geklemmt').toBeGreaterThanOrEqual(geo.d.left);

  await picker.locator('.combobox-trigger').nth(1).tap();
  const opt = page.locator('.combobox-dropdown [role=option]').first();
  await expect(opt).toBeVisible();
  const box = await opt.boundingBox();
  expect(box.y + box.height, 'Option im Bildschirm').toBeLessThanOrEqual(geo.vh);
  await opt.tap();
  await picker.locator('.picker-popover__actions button').first().tap();
  await expect(dlg.locator('.research-dialog__links .research-links .entity-ref')).toHaveCount(1);
});

test('iPad: Combobox bleibt offen, wenn der Browser beim Tippen ins Suchfeld scrollt', async ({ page }) => {
  await bootApp(page);
  const picker = await openLinkPicker(page);
  await picker.locator('.combobox-trigger').first().tap();
  const search = page.locator('.combobox-dropdown .combobox-search');
  await expect(search).toBeVisible();
  // Auf Touch fokussiert die Combobox das Suchfeld nicht selbst (Tastatur).
  await search.tap();
  await expect(search).toBeFocused();
  // Simuliert den Scroll, mit dem Safari das Feld ueber die Tastatur schiebt.
  await page.evaluate(() => document.dispatchEvent(new Event('scroll')));
  await page.waitForTimeout(100);
  await expect(search, 'Liste bleibt offen').toBeVisible();
});

test('iPad: kein haengender Tooltip nach Tap auf einen Knopf mit data-tip', async ({ page }) => {
  await bootApp(page);
  // Eigener Sonden-Knopf ohne Handler: ein App-Knopf oeffnete beim Tap oft ein
  // Popover, das den Tooltip ohnehin wegblendet — dann bewiese der Test nichts.
  await page.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'tip-probe';
    b.type = 'button';
    b.dataset.tip = 'Sonde';
    b.textContent = 'Sonde';
    document.body.prepend(b);
  });
  // iOS-Safari-Folge eines Taps: pointerdown (touch) → emuliertes mouseover →
  // focus → click, und danach KEIN Verlassen (der Hover bleibt am Ziel kleben).
  // Chromiums Tap-Emulation schickt hinterher ein mouseover auf <body> und
  // raeumte den Tooltip so selbst weg — darum die Folge von Hand.
  // Gemessen wird synchron direkt nach der Folge: ein spaeterer Scroll irgendwo
  // in der bootenden App blendete den Tooltip ohnehin aus (hide bei scroll).
  const visible = await page.evaluate(() => {
    const b = document.getElementById('tip-probe');
    const r = b.getBoundingClientRect();
    const at = { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 };
    b.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerType: 'touch', isPrimary: true }));
    b.dispatchEvent(new PointerEvent('pointerup', { ...at, pointerType: 'touch', isPrimary: true }));
    b.dispatchEvent(new MouseEvent('mouseover', at));
    b.focus();
    b.dispatchEvent(new MouseEvent('click', at));
    return !!document.querySelector('.tip-layer.tip-visible');
  });
  expect(visible, 'Tooltip nach Tap').toBe(false);
  // Gegenprobe: per Tastatur-Fokus erscheint er weiterhin.
  await page.evaluate(() => document.getElementById('tip-probe').blur());
  await page.waitForTimeout(900);
  const onFocus = await page.evaluate(() => {
    document.getElementById('tip-probe').focus();
    return !!document.querySelector('.tip-layer.tip-visible');
  });
  expect(onFocus, 'Tooltip bei Tastatur-Fokus').toBe(true);
});
