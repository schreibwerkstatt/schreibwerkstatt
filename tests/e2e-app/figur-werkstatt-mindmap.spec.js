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
  expect(await page.locator('link[href="vendor/jsmind-0.9.1.css"]').count(),
    'kein Eager-Load in index.html').toBe(0);

  const draft = await openWerkstattWithDraft(page, `CSS-Probe ${RUN}`);
  try {
    const order = await page.evaluate(() => {
      const links = [...document.head.querySelectorAll('link[rel="stylesheet"]')].map(l => l.getAttribute('href'));
      return { vendor: links.indexOf('vendor/jsmind-0.9.1.css'), app: links.indexOf('css/entities/figur-werkstatt.css') };
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
    const editor = page.locator(`${CARD} jmnode .jsmind-editor`);
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
      // Geklemmt wird mit der gemessenen Groesse (action-menu.js, nach dem Render).
      const vp = page.viewportSize();
      await expect.poll(async () => {
        const mbox = await menu.boundingBox();
        const expLeft = Math.max(8, Math.min(vp.width - mbox.width - 8, x));
        const expTop = Math.max(8, Math.min(vp.height - mbox.height - 8, y));
        return Math.abs(mbox.x - expLeft) < 2 && Math.abs(mbox.y - expTop) < 2;
      }).toBe(true);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      // Das nachgereichte Maus-Event darf das Menue nicht wieder schliessen.
      await page.waitForTimeout(200);
      await expect(menu).toBeVisible();
      expect(await page.evaluate(() => window.Alpine.$data(document.querySelector('.card--werkstatt')).actionMenuTarget)).toBe('root');
    } finally {
      await deleteDraft(page, draft.id);
    }
  } finally {
    await ctx.close();
  }
});

test('Vollbild zeigt nur die Mindmap, Knoten-Menue bleibt sichtbar', async ({ page }) => {
  await bootApp(page);
  const draft = await openWerkstattWithDraft(page, `Vollbild-Probe ${RUN}`);
  try {
    await page.locator(`${CARD} .werkstatt-mindmap-controls button[aria-pressed]`).click();
    await page.waitForFunction(() => document.fullscreenElement?.classList.contains('werkstatt-mindmap-section'));
    await expect(page.locator(`${CARD} .werkstatt-mindmap-controls button[aria-pressed]`)).toHaveAttribute('aria-pressed', 'true');
    const geo = await page.evaluate(() => {
      const fs = document.fullscreenElement;
      const mm = fs.querySelector('.werkstatt-mindmap').getBoundingClientRect();
      return {
        detailHeadInFs: !!fs.querySelector('.werkstatt-detail-name'),
        mmBottomGap: window.innerHeight - mm.bottom,
        mmShare: mm.height / window.innerHeight,
      };
    });
    expect(geo.detailHeadInFs, 'Detail-Kopf gehoert nicht ins Vollbild').toBe(false);
    expect(geo.mmShare, 'Mindmap fuellt den Viewport').toBeGreaterThan(0.75);
    expect(geo.mmBottomGap).toBeGreaterThanOrEqual(0);

    await page.locator(`${CARD} jmnode.root`).click({ button: 'right' });
    const menu = page.locator(`${CARD} .werkstatt-context-menu`);
    await expect(menu).toBeVisible();
    expect(await menu.evaluate((m) => document.fullscreenElement.contains(m))).toBe(true);
    await page.keyboard.press('Escape');

    await page.evaluate(() => document.exitFullscreen());
    await expect(page.locator(`${CARD} .werkstatt-mindmap-controls button[aria-pressed]`)).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await deleteDraft(page, draft.id);
  }
});

// Ein neuer Knoten wächst beim Tippen mit (mindmap-editor.js): Knotenbreite
// und Nachbar-Layout folgen dem Text, nicht erst nach Enter. Lange Titel
// brechen um, statt den Knoten über max-width zu ziehen.
test('Knoten waechst beim Bearbeiten mit, Nachbarn ruecken mit', async ({ page }) => {
  await bootApp(page);
  const draft = await openWerkstattWithDraft(page, `Wachs-Probe ${RUN}`);
  try {
    const node = page.locator(`${CARD} jmnode[nodeid="custom"]`);
    await node.click();
    await page.keyboard.press('Tab');                       // neuer Unterknoten, sofort im Edit
    const editor = page.locator(`${CARD} jmnode .jsmind-editor`);
    await expect(editor).toBeFocused();
    const editing = page.locator(`${CARD} jmnode.is-editing`);
    const w0 = (await editing.boundingBox()).width;
    await editor.fill('');
    await editor.pressSequentially('Eine deutlich längere Beschriftung');
    await expect.poll(async () => (await editing.boundingBox()).width).toBeGreaterThan(w0 + 40);

    // Über max-width: Umbruch (Höhe wächst), Breite bleibt gedeckelt.
    const h1 = (await editing.boundingBox()).height;
    await editor.pressSequentially(' und noch viel mehr Text, der sicher umbrechen muss');
    await expect.poll(async () => (await editing.boundingBox()).height).toBeGreaterThan(h1 + 5);
    const maxW = await editing.evaluate((el) => parseFloat(getComputedStyle(el).maxWidth));
    expect((await editing.boundingBox()).width).toBeLessThanOrEqual(maxW + 1);

    // jsMind kennt die neue Grösse bereits (Layout live, nicht erst nach Enter).
    const sizes = await editing.evaluate((el) => {
      const jm = window.Alpine.$data(el.closest('.card--werkstatt'))._jm;
      const n = jm.get_node(el.getAttribute('nodeid'));
      return { client: el.clientWidth, jm: n._data.view.width };
    });
    expect(sizes.jm).toBe(sizes.client);

    await page.keyboard.press('Enter');
    await expect(page.locator(`${CARD} jmnode.is-editing`)).toHaveCount(0);
    await expect(page.locator(`${CARD} jmnode`, { hasText: 'Eine deutlich längere Beschriftung' })).toHaveCount(1);
  } finally {
    await deleteDraft(page, draft.id);
  }
});

test('Startansicht: Ebene 2 offen, tiefer eingeklappt; Aufklappen-Knopf zeigt alles', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const name = `Tiefe-Probe ${RUN}`;
  const mindmap = {
    meta: { name: 'figur-werkstatt', version: '1' }, format: 'node_tree',
    data: { id: 'root', topic: name, children: [
      { id: 'a', topic: 'Ast', expanded: true, children: [
        { id: 'a1', topic: 'Zweig', expanded: true, children: [{ id: 'a1x', topic: 'Blatt tief' }] },
      ] },
    ] },
  };
  const draft = await page.evaluate(async ({ bookId, name, mindmap }) => {
    const r = await fetch(`/draft-figures/${bookId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mindmap }),
    });
    return r.json();
  }, { bookId, name, mindmap });
  try {
    await page.evaluate(() => window.__app.toggleFigurWerkstattCard());
    await page.evaluate((id) => window.dispatchEvent(new CustomEvent('figur-werkstatt:select', { detail: { draftId: id } })), draft.id);
    await expect(page.locator(`${CARD} jmnode.root`)).toHaveText(name);
    await expect(page.locator(`${CARD} jmnode[nodeid="a1"]`)).toBeVisible();
    await expect(page.locator(`${CARD} jmnode[nodeid="a1x"]`)).toBeHidden();

    await page.locator(`${CARD} .werkstatt-mindmap-controls button`, { has: page.locator('use[href$="#chevrons-up-down"]') }).click();
    await expect(page.locator(`${CARD} jmnode[nodeid="a1x"]`)).toBeVisible();

    // Eingepasst: alle sichtbaren Knoten liegen im Canvas.
    const inside = await page.evaluate((card) => {
      const box = document.querySelector(`${card} .werkstatt-mindmap`).getBoundingClientRect();
      return [...document.querySelectorAll(`${card} jmnode`)].filter(n => n.offsetParent).every((n) => {
        const r = n.getBoundingClientRect();
        return r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
      });
    }, CARD);
    expect(inside).toBe(true);
  } finally {
    await deleteDraft(page, draft.id);
  }
});

// Drag-Plugin (vendor/jsmind-0.9.1.draggable-node.js): Knoten auf einen anderen
// ziehen hängt ihn um; die Figur wird dirty und Rückgängig trägt den Schritt.
test('Knoten per Ziehen umhaengen, Rueckgaengig stellt zurueck', async ({ page }) => {
  await bootApp(page);
  const draft = await openWerkstattWithDraft(page, `Drag-Probe ${RUN}`);
  try {
    const parentOf = (id) => page.evaluate(({ card, id }) => {
      const jm = window.Alpine.raw(window.Alpine.$data(document.querySelector(card))._jm);
      return jm.get_node(id)?.parent?.id;
    }, { card: CARD, id });
    expect(await parentOf('aussehen')).toBe('steckbrief');

    // Maus-Events treffen nur Sichtbares: Canvas ganz ins Bild holen.
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.locator(`${CARD} .werkstatt-mindmap`).evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.evaluate(() => window.Alpine.$data(document.querySelector('.card--werkstatt')).fitMindmap());
    const src = await page.locator(`${CARD} jmnode[nodeid="aussehen"]`).boundingBox();
    const dst = await page.locator(`${CARD} jmnode[nodeid="custom"]`).boundingBox();
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
    await page.mouse.down();
    // Das Plugin sucht sein Ziel per Intervall (200 ms Verzug, 100 ms Takt).
    // Ablegen auf der von der Wurzel abgewandten Seite des Ziels (data-side
    // aus mindmap-view.js#_tagMindmapNodes).
    const side = await page.locator(`${CARD} jmnode[nodeid="custom"]`).getAttribute('data-side');
    const tx = side === 'left' ? dst.x - src.width / 2 - 30 : dst.x + dst.width + src.width / 2 + 30;
    const ty = dst.y + dst.height / 2;
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(src.x + (tx - src.x) * i / 12, src.y + (ty - src.y) * i / 12);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(450);
    await page.mouse.up();

    await expect.poll(() => parentOf('aussehen')).toBe('custom');
    await page.locator(`${CARD} .werkstatt-mindmap-controls button`, { has: page.locator('use[href$="#undo"]') }).click();
    await expect.poll(() => parentOf('aussehen')).toBe('steckbrief');
  } finally {
    await deleteDraft(page, draft.id);
  }
});
