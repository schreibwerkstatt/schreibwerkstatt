// Notebook-Editor: ein Save, dessen Antwort unterwegs verloren geht (Zug,
// Funkloch), ist ein EIGENER Stand — der nächste Save darf dafür kein
// Konflikt-Modal öffnen. Der PUT erreicht den Server (route.fetch), die
// Antwort erreicht den Client nicht (route.abort).

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';

// Eigener, frisch angelegter Abschnitt je Test: die geseedeten Abschnitte
// teilen sich alle Specs eines Shards, und eine Vorgänger-Spec hinterlässt dort
// Diagramm oder Bild am Seitenende — caretToEnd landete dann in der Figur.
async function openFreshPageInEdit(page) {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => {
    const chapterId = window.Alpine.store('nav').pages.find((p) => p.chapter_id)?.chapter_id;
    const r = await fetch('/content/pages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chapter_id: chapterId,
        name: 'Verlorene Antwort ' + Math.random().toString(36).slice(2, 8),
        html: '<p>Tom steht am Fenster und sieht hinaus.</p><p>Draussen regnet es seit dem Morgen.</p>',
      }),
    });
    const created = await r.json();
    window.__freshPageId = created.id;
    await window.__app.loadPages();
    const pg = window.Alpine.store('nav').pages.find((p) => p.id === created.id);
    await window.__app.selectPage(pg);
  });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
}

// Abschnitt wieder entfernen: die Shard-DB teilen alle folgenden Specs.
test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    if (window.__freshPageId) await fetch(`/content/pages/${window.__freshPageId}`, { method: 'DELETE' });
  }).catch(() => {});
});

async function caretToEnd(page) {
  await page.locator(EDIT_SEL).click();
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const r = document.createRange();
    r.selectNodeContents(el.lastElementChild);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }, EDIT_SEL);
}

// Nächsten Seiten-PUT zum Server durchlassen, die Antwort verwerfen.
async function loseNextSaveResponse(page) {
  let landed = null;
  const done = new Promise((resolve) => {
    page.route(/\/content\/pages\/\d+$/, async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      const res = await route.fetch();
      landed = res.status();
      await route.abort('timedout');
      await page.unroute(/\/content\/pages\/\d+$/);
      resolve();
    });
  });
  return { done, status: () => landed };
}

test('Verlorene Save-Antwort + neue Absätze: kein Konflikt-Modal beim nächsten Save', async ({ page, consoleGuard }) => {
  consoleGuard.ignore(/\[quickSave\] (TypeError: Failed to fetch|JSHandle@object)/);
  await openFreshPageInEdit(page);
  await caretToEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Verlorenkus zieht sich Tom zurueck.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Er schaut mir in die Augen.');

  const lost = await loseNextSaveResponse(page);
  await page.evaluate(() => window.__app.quickSave());
  await lost.done;
  expect(lost.status()).toBe(200);

  // Weiterschreiben in beiden neuen Absätzen, dann erneut speichern.
  await page.keyboard.type(' Raeuspert sich.');
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const p = el.children[el.children.length - 2];
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }, EDIT_SEL);
  await page.keyboard.type(' Ein Kompliment?');
  await page.evaluate(() => window.__app.quickSave());
  await page.waitForTimeout(500);

  const cr = await page.evaluate(() => window.__app.conflictResolution
    ? window.__app.conflictResolution.conflicts.map((c) => ({ l: !!c.local_html, r: !!c.remote_html }))
    : null);
  expect(cr).toBeNull();
  const server = await page.evaluate(async () => {
    const p = window.__app.currentPage;
    return (await (await fetch(`/content/pages/${p.id}?__fresh=1`)).json()).html;
  });
  expect(server).toContain('Raeuspert sich.');
  expect(server).toContain('Ein Kompliment?');
  expect(server.split('Verlorenkus').length - 1).toBe(1);
});

// Ein Save aus DIESEM Browser, den dieser Tab nicht geschickt hat — Bucheditor,
// ein anderer Tab, die Outbox: gleiches Konto, gleiche Geräte-ID. Er ist eine
// fremde Änderung wie jede andere und wird gemergt; der nächste Save des
// Notebook-Editors darf ihn nicht still überschreiben. Konto + Geräte-ID taugen
// nicht als «eigener Stand» — die Geräte-ID gilt für den ganzen Browser.
async function typeTwoNewParagraphs(page, tag) {
  await caretToEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type(`${tag} zieht sich Tom zurueck. Ein Kompliment?`);
  await page.keyboard.press('Enter');
  await page.keyboard.type(`${tag}Er schaut mir in die Augen, rueckt die Brille zurecht.`);
}

test('Save aus demselben Browser (nicht von diesem Tab) wird gemergt, nicht überschrieben', async ({ page }) => {
  await openFreshPageInEdit(page);
  await typeTwoNewParagraphs(page, 'Eigenstand');
  // Ersten Absatz ändern, wie es der Bucheditor in einem anderen Tab täte:
  // derselbe Browser, also dieselbe Geräte-ID, aber nicht über diesen Tab.
  const status = await page.evaluate(async () => {
    const p = window.__app.currentPage;
    const cur = await (await fetch(`/content/pages/${p.id}?__fresh=1`)).json();
    const doc = new DOMParser().parseFromString(cur.html, 'text/html');
    doc.body.firstElementChild.textContent = 'Aus dem Bucheditor geaendert.';
    const r = await fetch(`/content/pages/${p.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html: doc.body.innerHTML,
        device_id: localStorage.getItem('sw_device_id'),
        expected_updated_at: cur.updated_at,
      }),
    });
    return r.status;
  });
  expect(status).toBe(200);

  await page.evaluate(() => window.__app.quickSave());
  await page.waitForTimeout(500);

  expect(await page.evaluate(() => !!window.__app.conflictResolution)).toBe(false);
  const server = await page.evaluate(async () => {
    const p = window.__app.currentPage;
    return (await (await fetch(`/content/pages/${p.id}?__fresh=1`)).json()).html;
  });
  expect(server).toContain('Aus dem Bucheditor geaendert.');
  expect(server).toContain('Ein Kompliment?');
  expect(server).toContain('rueckt die Brille zurecht.');
});

test('Gegenprobe: dieselbe Stelle von einem anderen Gerät geändert öffnet das Modal', async ({ page }) => {
  const OTHER_DEVICE = '0b5e8c1e-1111-4222-8333-444455556667';
  await openFreshPageInEdit(page);
  await typeTwoNewParagraphs(page, 'Fremdprobe');
  await page.evaluate(() => window.__app.quickSave());
  await page.waitForTimeout(300);
  const bid = await page.evaluate((sel) => document.querySelector(sel).lastElementChild.getAttribute('data-bid'), EDIT_SEL);
  expect(bid).toBeTruthy();

  // Lokal weiterschreiben, dasselbe Absatz-Ende ändert ein anderes Gerät.
  await page.keyboard.type(' Raeuspert sich.');
  const status = await page.evaluate(async ({ bid, device }) => {
    const p = window.__app.currentPage;
    const cur = await (await fetch(`/content/pages/${p.id}?__fresh=1`)).json();
    const html = cur.html.replace(new RegExp(`(<p data-bid="${bid}">)[^<]*`), '$1Er schaut weg.');
    const r = await fetch(`/content/pages/${p.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, device_id: device, expected_updated_at: cur.updated_at }),
    });
    return r.status;
  }, { bid, device: OTHER_DEVICE });
  expect(status).toBe(200);

  await page.evaluate(() => window.__app.quickSave());
  await expect.poll(() => page.evaluate(() => window.__app.conflictResolution?.conflicts?.length || 0)).toBe(1);
  await expect(page.locator('.conflict-modal__title')).toBeVisible();
  await expect(page.locator('.conflict-block__preview')).toHaveCount(2);
  await expect(page.locator('.conflict-block__preview').first()).toHaveClass(/is-active/);
});
