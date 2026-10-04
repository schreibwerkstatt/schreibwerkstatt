// Figuren-Werkstatt-Mindmap (jsMind) gegen die ECHTE App (playwright.app.config.js).
//
// Warum diese Schicht: alles hier haengt an der gebooteten App mit vollem CSS —
// das nachgeladene Vendor-CSS und seine Position in der Kaskade, die SVG-Linien
// von jsMind gegen das Theme-Token und die Kopplung Namensfeld ↔ Wurzel-Knoten
// ueber den echten Alpine-Scope. Der Smoke oeffnet die Karte nur leer.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const CARD = '.card--werkstatt';
const RUN = String(Date.now()).slice(-6);

async function openWerkstattWithDraft(page, name) {
  const bookId = await selectSeededBook(page);
  const draft = await page.evaluate(async ({ bookId, name }) => {
    const r = await fetch(`/draft-figures/${bookId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new Error(`POST /draft-figures fehlgeschlagen: ${r.status}`);
    return r.json();
  }, { bookId, name });
  await page.evaluate(() => window.__app.toggleFigurWerkstattCard());
  await expect(page.locator(CARD)).toBeVisible();
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent('figur-werkstatt:select', { detail: { draftId: id } })), draft.id);
  await expect(page.locator(`${CARD} jmnode.root`)).toHaveText(name);
  return draft;
}

async function deleteDraft(page, id) {
  await page.evaluate((id) => fetch(`/draft-figures/${id}`, { method: 'DELETE' }), id);
}

test('Vendor-CSS laedt mit der Werkstatt und steht vor dem App-CSS', async ({ page }) => {
  await bootApp(page);
  expect(await page.locator('link[href="vendor/jsmind-0.8.7.css"]').count(),
    'kein Eager-Load in index.html').toBe(0);

  const draft = await openWerkstattWithDraft(page, `CSS-Probe ${RUN}`);
  try {
    const order = await page.evaluate(() => {
      const links = [...document.head.querySelectorAll('link[rel="stylesheet"]')].map(l => l.getAttribute('href'));
      return { vendor: links.indexOf('vendor/jsmind-0.8.7.css'), app: links.indexOf('css/entities/figur-werkstatt.css') };
    });
    expect(order.vendor).toBeGreaterThanOrEqual(0);
    expect(order.vendor, 'figur-werkstatt.css muss das Vendor-CSS ueberschreiben').toBeLessThan(order.app);
    // Vendor-Regel wirkt (jmnode absolut positioniert) UND die App-Bruecke gewinnt.
    const node = page.locator(`${CARD} jmnode.root`);
    await expect(node).toHaveCSS('position', 'absolute');
    const [bg, primary] = await node.evaluate((el) => [
      getComputedStyle(el).backgroundColor,
      (() => { const p = document.createElement('span'); p.style.color = 'var(--color-primary)'; document.body.appendChild(p); const c = getComputedStyle(p).color; p.remove(); return c; })(),
    ]);
    expect(bg).toBe(primary);
  } finally {
    await deleteDraft(page, draft.id);
  }
});

test('Linienfarbe folgt dem Theme-Wechsel', async ({ page }) => {
  await bootApp(page);
  const draft = await openWerkstattWithDraft(page, `Theme-Probe ${RUN}`);
  try {
    const strokeNow = () => page.locator(`${CARD} .werkstatt-mindmap svg path`).first().getAttribute('stroke');
    const tokenNow = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-border').trim());
    expect(await strokeNow()).toBe(await tokenNow());

    const before = await strokeNow();
    await page.evaluate(() => {
      const el = document.documentElement;
      el.setAttribute('data-theme', el.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });
    const token = await tokenNow();
    expect(token, 'Theme-Token muss sich ueberhaupt unterscheiden').not.toBe(before);
    await expect.poll(strokeNow).toBe(token);
  } finally {
    await deleteDraft(page, draft.id);
  }
});

test('Namensfeld und Wurzel-Knoten bleiben gekoppelt, der Server haelt es fest', async ({ page }) => {
  await bootApp(page);
  const name = `Wurzel-Probe ${RUN}`;
  const draft = await openWerkstattWithDraft(page, name);
  try {
    const root = page.locator(`${CARD} jmnode.root`);
    const nameInput = page.locator(`${CARD} #werkstatt-name-${draft.id}`);

    // Formular → Wurzel, live.
    await nameInput.fill(`${name} neu`);
    await expect(root).toHaveText(`${name} neu`);

    // Wurzel im Canvas umbenennen → Formular.
    await root.dblclick();
    const editor = page.locator(`${CARD} jmnode input`);
    await editor.fill(`${name} canvas`);
    await editor.press('Enter');
    await expect(nameInput).toHaveValue(`${name} canvas`);

    // Speichern: der Server liefert Name und Wurzel deckungsgleich.
    await page.keyboard.press('Control+s');
    await expect.poll(async () => {
      const d = await page.evaluate((id) => fetch(`/draft-figures/by-id/${id}`).then(r => r.json()), draft.id);
      return [d.name, d.mindmap?.data?.topic];
    }).toEqual([`${name} canvas`, `${name} canvas`]);

    // Fremder Schreibweg ohne Mindmap-Anpassung: Server zieht die Wurzel nach.
    const d2 = await page.evaluate((id) => fetch(`/draft-figures/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Nur-Name' }),
    }).then(r => r.json()), draft.id);
    expect(d2.mindmap.data.topic).toBe('Nur-Name');
  } finally {
    await deleteDraft(page, draft.id);
  }
});

test('Long-Press auf einen Knoten oeffnet das Knoten-Menue', async ({ browser }) => {
  // Touch-Events gehen ueber CDP (Input.dispatchTouchEvent) — das gibt es nur in Chromium.
  test.skip(test.info().project.name !== 'chromium', 'CDP-Touch nur in Chromium');
  const ctx = await browser.newContext({ hasTouch: true });
  const page = await ctx.newPage();
  try {
    await bootApp(page);
    const draft = await openWerkstattWithDraft(page, `Touch-Probe ${RUN}`);
    try {
      // Die Wurzel: jsMind zentriert sie, Aeste koennen im overflow:hidden-
      // Canvas ausserhalb liegen.
      const node = page.locator(`${CARD} jmnode.root`);
      await node.scrollIntoViewIfNeeded();
      const box = await node.boundingBox();
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await page.waitForTimeout(700);
      const menu = page.locator(`${CARD} .werkstatt-context-menu`);
      await expect(menu).toBeVisible();
      // Lage: das Menü sitzt am Finger (viewport-verankert, auf den Viewport
      // geklemmt) — nicht um den Karten-Offset verschoben.
      const vp = page.viewportSize();
      const mbox = await menu.boundingBox();
      const expLeft = Math.max(8, Math.min(vp.width - 240 - 8, x));
      const expTop = Math.max(8, Math.min(vp.height - 240 - 8, y));
      expect(Math.abs(mbox.x - expLeft)).toBeLessThan(2);
      expect(Math.abs(mbox.y - expTop)).toBeLessThan(2);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      // Das nachgereichte Maus-Event darf das Menue nicht wieder schliessen.
      await page.waitForTimeout(200);
      await expect(menu).toBeVisible();
      expect(await page.evaluate(() => window.Alpine.$data(document.querySelector('.card--werkstatt')).contextMenuNodeId)).toBe('root');
    } finally {
      await deleteDraft(page, draft.id);
    }
  } finally {
    await ctx.close();
  }
});
