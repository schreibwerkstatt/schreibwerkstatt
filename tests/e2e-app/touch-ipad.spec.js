// Touch-Verhalten auf dem iPad (DESIGN.md „Touch"): Bezug ist der Zeiger
// (`pointer: coarse`), nicht die Breite — ein iPad im Querformat ist so breit
// wie ein Laptop und bekommt keine Phone-Regel ab. Geometrie haengt am echten
// Shell-CSS (Tokens + Komponenten), darum hier und nicht im Fixture-Harness.
//
// Weg aus der Praxis: Recherche-Fundstueck aufgeklappt → «Verknuepfen» →
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
  const row = page.locator(`[data-research-id="${itemId}"]`);
  await expect(row.locator('.research-detail')).toBeVisible();
  // Der Deep-Link scrollt die Zeile weich nach oben — erst ruhig, dann tippen.
  await expect.poll(async () => {
    const a = await row.boundingBox(); await page.waitForTimeout(120); const b = await row.boundingBox();
    return a && b && a.y === b.y;
  }).toBe(true);
  await row.locator('.research-link-add').tap();
  const picker = page.locator('.recherche-link-picker:visible');
  await expect(picker).toBeVisible();
  return { picker, row };
}

// Langer Fund: «Verknuepfen» steht oben in der aufgeklappten Zeile (Leiste unter
// dem Kopf), nicht nach dem Volltext am unteren Bildschirmrand — dort hatten
// Picker und Auswahllisten keinen Platz. Picker klappt nach unten am Knopf auf,
// und die Verknuepfung laesst sich komplett per Tap setzen.
test('iPad: langer Fund — Verknuepfen oben, Picker nach unten, Verknuepfung per Tap', async ({ page }) => {
  await bootApp(page);
  const long = Array.from({ length: 60 }, (_, i) => `Absatz ${i + 1}: ` + 'Lorem ipsum dolor sit amet. '.repeat(6)).join('\n\n');
  const { picker, row } = await openLinkPicker(page, long);
  const geo = await page.evaluate(() => {
    const d = document.querySelector('.research-item--open').getBoundingClientRect();
    const b = document.querySelector('.research-item--open .research-link-add').getBoundingClientRect();
    const p = [...document.querySelectorAll('.recherche-link-picker')].find((e) => e.getClientRects().length).getBoundingClientRect();
    const t = document.querySelector('.research-item--open .research-detail__text').getBoundingClientRect();
    return { d: { left: d.left, top: d.top, bottom: d.bottom }, b: { left: b.left, bottom: b.bottom }, p: { left: p.left, right: p.right, top: p.top }, t: { top: t.top }, vh: innerHeight };
  });
  expect(geo.b.bottom, 'Knopf über dem Volltext, nicht danach').toBeLessThanOrEqual(geo.t.top);
  expect(geo.b.bottom, 'Knopf im Bild').toBeLessThan(geo.vh);
  expect(geo.p.top, 'Picker unter dem Knopf').toBeGreaterThanOrEqual(geo.b.bottom);
  // Am Knopf: der Picker deckt dessen linke Kante horizontal ab (passt er rechts
  // nicht ins Bild, rückt er nach links, bleibt aber über dem Knopf).
  expect(geo.p.left, 'Picker am Knopf').toBeLessThanOrEqual(geo.b.left);
  expect(geo.p.right, 'Picker am Knopf').toBeGreaterThan(geo.b.left);

  await picker.locator('.combobox-trigger').nth(1).tap();
  const opt = page.locator('.combobox-dropdown [role=option]').first();
  await expect(opt).toBeVisible();
  const box = await opt.boundingBox();
  expect(box.y + box.height, 'Option im Bildschirm').toBeLessThanOrEqual(geo.vh);
  await opt.tap();
  await picker.locator('.picker-popover__actions button').first().tap();
  await expect(row.locator('.research-detail__links .research-links .entity-ref')).toHaveCount(1);
});

test('iPad: Combobox bleibt offen, wenn der Browser beim Tippen ins Suchfeld scrollt', async ({ page }) => {
  await bootApp(page);
  const { picker } = await openLinkPicker(page);
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
