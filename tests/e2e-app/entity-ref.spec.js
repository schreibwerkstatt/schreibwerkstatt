// Entitäts-Referenz (`x-entity-ref`, public/js/entity-ref.js) gegen die ECHTE App.
//
// Warum hier und nicht nur im Unit-Test: die Auflösung ist dort abgedeckt, aber
// ob die Direktive registriert ist, ob das Komponenten-CSS geladen ist (Typ-Farbe
// am linken Rand) und ob ein Kapitel-Klick wirklich in der Kapitelbewertung
// landet, zeigt nur der komplette Boot. Das Seed-Buch hat keine Figuren — eine
// Figur wird darum in den Katalog-Store gelegt, die Referenzen werden in einen
// Container gerendert und per `Alpine.initTree` belebt.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test.describe.configure({ mode: 'serial' });

async function mountRefs(page, specs) {
  await page.evaluate((list) => {
    Alpine.store('catalog').figuren = [{
      id: 4711, name: 'Grete Samsa', kurzname: 'Grete', typ: 'hauptfigur',
      beschreibung: 'Schwester, spielt Geige.', kapitel: [], eigenschaften: ['fleissig'],
    }];
    const host = document.createElement('div');
    host.id = 'entity-ref-probe';
    host.className = 'entity-refs';
    for (const spec of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'entity-ref';
      b.setAttribute('x-entity-ref', spec);
      host.appendChild(b);
    }
    document.querySelector('main, body').prepend(host);
    Alpine.initTree(host);
  }, specs);
}

test('rendert Typ-Präfix, Label und Typ-Farbe; Kapitel-Klick öffnet die Kapitelbewertung', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const chapterName = await page.evaluate(() => {
    const ch = Alpine.store('nav').tree.find(c => c.type === 'chapter' && !c.solo && c.pages.length > 1);
    return ch.name;
  });

  await mountRefs(page, [
    "{ type: 'figur', id: 4711 }",
    `{ type: 'kapitel', name: ${JSON.stringify(chapterName)} }`,
    "{ type: 'kapitel', name: 'Gibt es nicht' }",
  ]);

  const refs = page.locator('#entity-ref-probe .entity-ref');
  const fig = refs.nth(0);
  await expect(fig).toHaveClass(/entity-ref--figur/);
  await expect(fig.locator('.entity-ref__label')).toHaveText('Grete');
  // Mit Hover-Vorschau kein Zeilen-Tooltip: das Popover trägt den vollen Namen.
  await expect(fig).not.toHaveAttribute('data-tip', /./);
  await expect(fig.locator('.entity-ref__kind')).not.toHaveText('');

  // Typ-Farbe kommt aus entity-ref.css: Figur und Kapitel unterscheiden sich am linken Rand.
  const [figColor, kapColor] = await Promise.all([
    fig.evaluate(el => getComputedStyle(el).borderLeftColor),
    refs.nth(1).evaluate(el => getComputedStyle(el).borderLeftColor),
  ]);
  expect(figColor).not.toBe(kapColor);

  // Unauflösbarer Name: Rohtext, abgeschaltet.
  const dead = refs.nth(2);
  await expect(dead).toHaveClass(/entity-ref--unresolved/);
  await expect(dead).toBeDisabled();

  await refs.nth(1).click();
  await expect.poll(() => page.evaluate(() => window.__app.showKapitelReviewCard)).toBe(true);
});

test('Hover zeigt die Vorschau mit Katalog-Kontext, Verlassen schliesst sie', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const chapterName = await page.evaluate(() =>
    Alpine.store('nav').tree.find(c => c.type === 'chapter' && !c.solo && c.pages.length > 1).name);

  await mountRefs(page, [
    "{ type: 'figur', id: 4711 }",
    `{ type: 'kapitel', name: ${JSON.stringify(chapterName)} }`,
    "{ type: 'figur', id: 4711, preview: false }",
  ]);
  const refs = page.locator('#entity-ref-probe .entity-ref');
  const pop = page.locator('.entity-ref-preview');

  await refs.nth(0).hover();
  await expect(pop).toBeVisible();
  await expect(pop.locator('.entity-ref-preview__title')).toHaveText('Grete Samsa');
  await expect(pop.locator('.entity-ref-preview__text')).toHaveText('Schwester, spielt Geige.');
  await expect(pop).toContainText('fleissig');
  // Typ-Akzent wie am Chip (entity-ref--figur am Layer).
  await expect(pop).toHaveClass(/entity-ref--figur/);

  // Popover hängt am Trigger: darunter (oder darüber), nicht irgendwo.
  const [r, p] = await Promise.all([refs.nth(0).boundingBox(), pop.boundingBox()]);
  expect(Math.min(Math.abs(p.y - (r.y + r.height)), Math.abs(r.y - (p.y + p.height)))).toBeLessThan(8);

  // Wechsel auf das Kapitel: Inhalt folgt, Umfang aus den Seiten des Kapitels.
  await refs.nth(1).hover();
  await expect(pop.locator('.entity-ref-preview__title')).toHaveText(chapterName);
  await expect(pop.locator('dl')).not.toBeEmpty();

  await page.mouse.move(0, 0);
  await expect(pop).toBeHidden();

  // preview: false → klassischer Tooltip, kein Popover.
  await expect(refs.nth(2)).toHaveAttribute('data-tip', 'Grete Samsa');
  await refs.nth(2).hover();
  await page.waitForTimeout(700);
  await expect(pop).toBeHidden();
});

test('geerbte Referenz: gleiches Label, Zusatz „Strang", Herkunft in der Vorschau', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  await mountRefs(page, [
    "{ type: 'figur', id: 4711 }",
    "{ type: 'figur', id: 4711, inherited: true, title: 'Vom Strang geerbt' }",
  ]);
  const refs = page.locator('#entity-ref-probe .entity-ref');
  const direct = refs.nth(0);
  const inherited = refs.nth(1);

  await expect(inherited).toHaveClass(/entity-ref--inherited/);
  await expect(direct.locator('.entity-ref__origin')).toHaveCount(0);
  await expect(inherited.locator('.entity-ref__origin')).toHaveText(
    await page.evaluate(() => window.__app.t('entityRef.inherited')));
  // Label sieht aus wie bei jeder Referenz — die Herkunft trägt der Zusatz, nicht die Schrift.
  const style = el => { const s = getComputedStyle(el); return `${s.fontStyle}|${s.color}`; };
  expect(await inherited.locator('.entity-ref__label').evaluate(style))
    .toBe(await direct.locator('.entity-ref__label').evaluate(style));

  // Figur hat eine Vorschau statt Tooltip: die Herkunft steht dort als erste Meta-Zeile.
  await inherited.hover();
  const pop = page.locator('.entity-ref-preview');
  await expect(pop).toBeVisible();
  await expect(pop.locator('.entity-ref-preview__meta')).toContainText('Vom Strang geerbt');
});

test('Handy: lange Beat-Titel in einer Meta-Zeile brechen um statt die Karte zu verbreitern', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await bootApp(page);
  await selectSeededBook(page);
  const long = 'Grete entdeckt im Morgengrauen, dass der Untermieter längst ausgezogen ist und die Miete trotzdem weiterläuft';
  await page.evaluate((title) => {
    const box = document.createElement('div');
    box.id = 'entity-ref-row-probe';
    box.style.width = '320px';
    // Gleiche Struktur wie plot-backlinks.html (mit Wrap) und eine Reihe ohne.
    box.innerHTML = ['entity-refs entity-refs--wrap', 'entity-refs'].map(cls => `
      <div class="entity-meta-row">
        <span class="entity-meta-label">Im Plot</span>
        <span class="${cls}">
          <button type="button" class="entity-ref"></button>
        </span>
      </div>`).join('');
    for (const b of box.querySelectorAll('.entity-ref')) {
      b.setAttribute('x-entity-ref', `{ type: 'beat', id: 1, label: ${JSON.stringify(title)} }`);
    }
    document.querySelector('main, body').prepend(box);
    Alpine.initTree(box);
  }, long);

  const rows = page.locator('#entity-ref-row-probe .entity-meta-row');
  for (const i of [0, 1]) {
    const [rowW, chipRight, rowRight] = await rows.nth(i).evaluate(r => {
      const c = r.querySelector('.entity-ref').getBoundingClientRect();
      return [r.scrollWidth - r.clientWidth, c.right, r.getBoundingClientRect().right];
    });
    expect(rowW).toBe(0);
    expect(chipRight).toBeLessThanOrEqual(rowRight + 0.5);
  }
  // Wrap-Reihe: der ganze Titel steht da, mehrzeilig.
  const wrapLabel = rows.nth(0).locator('.entity-ref__label');
  await expect(wrapLabel).toHaveText(long);
  expect(await wrapLabel.evaluate(el => el.scrollWidth <= el.clientWidth && el.getClientRects().length >= 1
    && el.getBoundingClientRect().height > parseFloat(getComputedStyle(el).lineHeight) * 1.5)).toBe(true);
  // Standard-Reihe: einzeilig mit Ellipsis.
  expect(await rows.nth(1).locator('.entity-ref__label').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
});

test('abgeschnittenes Label ohne Vorschau zeigt den vollen Titel als Tooltip', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const long = 'Ein Beat mit einem Titel, der in einem schmalen Kasten niemals ganz Platz hat';
  await page.evaluate((title) => {
    const box = document.createElement('div');
    box.id = 'entity-ref-tip-probe';
    box.className = 'entity-refs';
    box.style.width = '160px';
    for (const label of [title, 'Kurz']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'entity-ref';
      b.setAttribute('x-entity-ref', `{ type: 'beat', id: 1, label: ${JSON.stringify(label)} }`);
      box.appendChild(b);
    }
    document.querySelector('main, body').prepend(box);
    Alpine.initTree(box);
  }, long);
  const refs = page.locator('#entity-ref-tip-probe .entity-ref');
  await refs.nth(0).hover();
  await expect(refs.nth(0)).toHaveAttribute('data-tip', long);
  await expect(page.locator('.tip-visible')).toContainText(long);
  await refs.nth(1).hover();
  await expect(refs.nth(1)).not.toHaveAttribute('data-tip', /./);
});
