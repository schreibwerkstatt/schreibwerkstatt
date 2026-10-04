// Focus-Editor (SPA): Remote-Save eines anderen Geraets auf die offene Seite.
//
// Der Fokusmodus ist derselbe Edit-Vorgang wie der Notebook-Edit auf einem
// gespiegelten Container (`_getEditEl` loest dorthin auf). Kommt eine
// Remote-Aenderung an, muss sie IN DEN CONTAINER — ruecken nur `originalHtml`
// und `updated_at` vor, speichert der naechste Autosave den alten Text unter
// frischem Stempel, und die Remote-Aenderung ist ohne jede Meldung weg.
//
// Gegen die ECHTE App: Collab-Event-Stream, Root-Trampoline, Notebook-Karte
// und Focus-Container muessen zusammenspielen.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const FOCUS = '.focus-editor__content';
const OTHER_DEVICE = '0b5e8c1e-1111-4222-8333-444455556677';

async function enterFocus(page, pageIdx) {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async (i) => {
    await window.__app.selectPage(window.Alpine.store('nav').pages[i]);
  }, pageIdx);
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('editor:focus:enter-from-pageview')));
  await page.waitForFunction(() => {
    const el = document.querySelector('.focus-editor');
    if (!el || !window.Alpine) return false;
    const d = window.Alpine.$data(el);
    return !!d && d._focusState === 'active';
  }, null, { timeout: 15000 });
  await page.waitForTimeout(200);
}

// Zweites Geraet haengt an den ERSTEN Absatz einen Marker.
async function remoteSaveFirstBlock(page, marker) {
  return page.evaluate(async ({ marker, device }) => {
    const p = window.__app.currentPage;
    const cur = await (await fetch(`/content/pages/${p.id}?__fresh=1`)).json();
    const html = cur.html.replace('</p>', ` ${marker}</p>`);
    const r = await fetch(`/content/pages/${p.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, device_id: device, expected_updated_at: cur.updated_at }),
    });
    const saved = await r.json();
    return { status: r.status, updatedAt: saved.updated_at };
  }, { marker, device: OTHER_DEVICE });
}

// Zweites Geraet hat das Buch offen (wie das Handy, auf dem parallel
// geschrieben wird): Praesenz anmelden, dann den eigenen Ping sofort
// nachziehen, damit der volle Collab-Poll laeuft und seine Basis steht,
// BEVOR das andere Geraet speichert.
async function otherDeviceOpensBook(page) {
  await page.evaluate(async (device) => {
    const bookId = window.Alpine.store('nav').selectedBookId;
    await fetch(`/content/books/${bookId}/device-ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: device }),
    });
    window.__app._pingDevicePresenceNow();
  }, OTHER_DEVICE);
  await page.waitForFunction(() => {
    const c = window.Alpine.store('collab');
    return !!c._collabPollTimer && !!c._collabSince;
  }, null, { timeout: 10000 });
}

// Caret ans Ende des LETZTEN Absatzes, im Textknoten.
async function caretToEndOfLastBlock(page) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const ps = el.querySelectorAll('p');
    const last = ps[ps.length - 1];
    const r = document.createRange();
    r.selectNodeContents(last);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    el.focus();
  }, FOCUS);
}

async function serverHtml(page) {
  return page.evaluate(async () => {
    const srv = await (await fetch(`/content/pages/${window.__app.currentPage.id}?__fresh=1`)).json();
    return srv.html;
  });
}

test('Focus clean: Remote-Aenderung erscheint im Container und ueberlebt den naechsten Save', async ({ page }) => {
  await enterFocus(page, 4);
  await otherDeviceOpensBook(page);
  const res = await remoteSaveFirstBlock(page, 'FOCUSREMOTE_CLEAN');
  expect(res.status).toBe(200);

  // Verarbeitet ist der Remote-Save, sobald der Editor-Stempel nachgezogen ist.
  await page.waitForFunction((at) => window.__app.currentPage?.updated_at === at, res.updatedAt, { timeout: 15000 });
  await expect(page.locator(FOCUS)).toContainText('FOCUSREMOTE_CLEAN', { timeout: 5000 });

  await caretToEndOfLastBlock(page);
  await page.keyboard.type(' FOCUSLOCAL_CLEAN');
  await page.evaluate(() => window.__app.quickSave());
  const html = await serverHtml(page);
  expect(html).toContain('FOCUSLOCAL_CLEAN');
  expect(html).toContain('FOCUSREMOTE_CLEAN');
});

test('Focus dirty: lokaler und Remote-Edit in verschiedenen Absaetzen landen beide im Container und auf dem Server', async ({ page }) => {
  await enterFocus(page, 3);
  await otherDeviceOpensBook(page);
  await caretToEndOfLastBlock(page);
  await page.keyboard.type(' FOCUSLOCAL_DIRTY');
  const res = await remoteSaveFirstBlock(page, 'FOCUSREMOTE_DIRTY');
  expect(res.status).toBe(200);

  const ed = page.locator(FOCUS);
  await expect(ed).toContainText('FOCUSREMOTE_DIRTY', { timeout: 15000 });
  await expect(ed).toContainText('FOCUSLOCAL_DIRTY');
  expect(await page.evaluate(() => window.__app.conflictResolution)).toBeNull();

  await page.evaluate(() => window.__app.quickSave());
  const html = await serverHtml(page);
  expect(html).toContain('FOCUSREMOTE_DIRTY');
  expect(html).toContain('FOCUSLOCAL_DIRTY');
});

// Ohne Zweit-Geraete-Praesenz laeuft kein Collab-Poll: nur der Wake-Check
// (app-view/bookscope.js#_checkEditedPageAfterWake) bemerkt den Remote-Save.
test('Focus nach dem Aufwachen: Remote-Save aus der versteckten Phase erscheint im Container', async ({ page }) => {
  await enterFocus(page, 2);
  const res = await remoteSaveFirstBlock(page, 'FOCUSREMOTE_WAKE');
  expect(res.status).toBe(200);

  await page.evaluate(() => {
    let state = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + 31_000;
    state = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator(FOCUS)).toContainText('FOCUSREMOTE_WAKE', { timeout: 10000 });

  await caretToEndOfLastBlock(page);
  await page.keyboard.type(' FOCUSLOCAL_WAKE');
  await page.evaluate(() => window.__app.quickSave());
  const html = await serverHtml(page);
  expect(html).toContain('FOCUSREMOTE_WAKE');
  expect(html).toContain('FOCUSLOCAL_WAKE');
});
