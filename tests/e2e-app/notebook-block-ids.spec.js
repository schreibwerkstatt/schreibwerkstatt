// Notebook-Editor: Block-IDs (`data-bid`) im Live-Editor und das
// Konflikt-Modal des Block-Merge.
//
// Warum gegen die ECHTE App: die IDs vergibt der Server beim Page-Write
// (lib/html-clean.js#ensureBlockIds), und den Ausgangszustand des ersten Falls
// erzeugt erst Chromiums contenteditable-Default — Enter mitten im Absatz
// klont das Absatz-Element samt `data-bid`. Der Block-Merge
// (shared/block-merge.js) haengt am echten OCC-Guard des Servers.
//
//  1. Enter-Split + Remote-Edit: zwei Absaetze mit derselben ID — der Merge
//     fuehrt Bloecke per ID zusammen und verlor die erste Haelfte still.
//  2. Neuer Absatz gespeichert, Remote-Edit, weitergetippt: der Client muss
//     nach dem Save die Server-IDs kennen, sonst gilt der eigene neue Absatz
//     als „remote geaendert, lokal geloescht" → falscher Konflikt.
//  3. Konflikt-Modal: kein Abbruch per Klick daneben, Hintergrund-Saves
//     speichern nicht unter dem offenen Modal und setzen die Entscheidungen
//     nicht zurueck, Abbrechen nur mit Bestaetigung + lokale Sicherung.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';
const OTHER_DEVICE = '0b5e8c1e-1111-4222-8333-444455556668';

async function createPage(page, html, name) {
  return page.evaluate(async ({ html, name }) => {
    const nav = window.Alpine.store('nav');
    const first = nav.pages[0];
    const r = await fetch('/content/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: nav.selectedBookId, chapter_id: first.chapter_id || undefined, name, html }),
    });
    if (!r.ok) throw new Error('createPage ' + r.status);
    const created = await r.json();
    nav.pages = [...nav.pages, { ...created, chapterName: first.chapterName }];
    await window.__app.selectPage(nav.pages[nav.pages.length - 1]);
    return created.id;
  }, { html, name });
}

async function deletePage(page, id) {
  await page.evaluate(async (pid) => { await fetch('/content/pages/' + pid, { method: 'DELETE' }); }, id);
}

async function serverHtml(page, id) {
  return page.evaluate(async (pid) => {
    const r = await fetch(`/content/pages/${pid}?__fresh=1`, { cache: 'no-store' });
    return (await r.json()).html || '';
  }, id);
}

async function openInEdit(page, html, name) {
  await bootApp(page);
  await selectSeededBook(page);
  const pageId = await createPage(page, html, name);
  await page.waitForFunction((pid) => window.__app.showEditorCard && window.__app.currentPage?.id === pid
    && (window.__app.originalHtml || '').includes('data-bid'), pageId, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
  return pageId;
}

// Zweites Geraet ersetzt `from` durch `to` im Server-Stand.
async function remoteReplace(page, pageId, from, to) {
  return page.evaluate(async ({ pid, from, to, device }) => {
    const cur = await (await fetch(`/content/pages/${pid}?__fresh=1`, { cache: 'no-store' })).json();
    if (!cur.html.includes(from)) throw new Error('remoteReplace: ' + from + ' fehlt');
    const r = await fetch(`/content/pages/${pid}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: cur.html.replace(from, to), device_id: device, expected_updated_at: cur.updated_at }),
    });
    return r.status;
  }, { pid: pageId, from, to, device: OTHER_DEVICE });
}

// Caret in den Absatz, der `needle` enthaelt, direkt hinter `needle`.
async function caretAfter(page, needle) {
  await page.locator(EDIT_SEL).click();
  await page.evaluate(({ sel, needle }) => {
    const el = document.querySelector(sel);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = walker.nextNode())) {
      const i = t.data.indexOf(needle);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(t, i + needle.length);
      r.collapse(true);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return;
    }
    throw new Error('caretAfter: ' + needle + ' fehlt');
  }, { sel: EDIT_SEL, needle });
}

test('Enter-Split + Remote-Edit: stiller Merge behaelt beide Haelften des geteilten Absatzes', async ({ page }) => {
  const pageId = await openInEdit(page,
    '<p>Alpha erster Absatz bleibt.</p><p>Beta zweiter Absatz wird geteilt hier.</p><p>Gamma dritter Absatz.</p>',
    'E2E Block-IDs Split');
  try {
    await caretAfter(page, 'Beta zweiter Absatz');
    await page.keyboard.press('Enter');
    await page.keyboard.type('X');

    expect(await remoteReplace(page, pageId, 'Alpha erster', 'Alpha REMOTE_SPLIT erster')).toBe(200);
    await page.evaluate(() => window.__app.quickSave());

    expect(await page.evaluate(() => window.__app.conflictResolution)).toBeNull();
    const html = await serverHtml(page, pageId);
    expect(html).toContain('REMOTE_SPLIT');
    expect(html).toContain('Beta zweiter Absatz');
    expect(html).toContain('X wird geteilt hier.');
    expect(html).toContain('Gamma dritter Absatz.');
    // Keine doppelte ID im Live-Editor.
    const dup = await page.evaluate((sel) => {
      const ids = [...document.querySelector(sel).children].map((c) => c.getAttribute('data-bid')).filter(Boolean);
      return ids.length - new Set(ids).size;
    }, EDIT_SEL);
    expect(dup).toBe(0);
  } finally {
    await page.evaluate(() => window.__app._teardownEditSession?.());
    await deletePage(page, pageId);
  }
});

test('Neuer Absatz gespeichert, Remote-Edit, weitergetippt: kein falscher Konflikt', async ({ page }) => {
  const pageId = await openInEdit(page,
    '<p>Alpha erster Absatz.</p><p>Gamma letzter Absatz.</p>',
    'E2E Block-IDs Neu');
  try {
    await caretAfter(page, 'Gamma letzter Absatz.');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Neu eins');
    await page.evaluate(() => window.__app.quickSave());
    expect(await serverHtml(page, pageId)).toContain('Neu eins');

    expect(await remoteReplace(page, pageId, 'Alpha erster', 'Alpha REMOTE_NEW erster')).toBe(200);
    await page.keyboard.type(' und mehr');
    await page.evaluate(() => window.__app.quickSave());

    expect(await page.evaluate(() => window.__app.conflictResolution)).toBeNull();
    const html = await serverHtml(page, pageId);
    expect(html).toContain('REMOTE_NEW');
    expect(html).toContain('Neu eins und mehr');
    expect(html).toContain('Gamma letzter Absatz.');
  } finally {
    await page.evaluate(() => window.__app._teardownEditSession?.());
    await deletePage(page, pageId);
  }
});

test('Konflikt-Modal: kein Abbruch per Klick daneben, kein Hintergrund-Save, Abbrechen nur mit Bestaetigung', async ({ page }) => {
  const pageId = await openInEdit(page,
    '<p>Alpha gemeinsamer Absatz.</p><p>Omega Rest.</p>',
    'E2E Block-IDs Modal');
  try {
    await caretAfter(page, 'Alpha gemeinsamer');
    await page.keyboard.type(' LOKAL');
    expect(await remoteReplace(page, pageId, 'Alpha gemeinsamer', 'Alpha FERN gemeinsamer')).toBe(200);
    await page.evaluate(() => window.__app.saveEdit());
    await expect(page.locator('.conflict-modal')).toBeVisible();

    // Klick neben das Modal (Overlay-Ecke) schliesst nichts.
    await page.mouse.click(5, 5);
    await expect(page.locator('.conflict-modal')).toBeVisible();

    // Entscheidung treffen, dann laufen Hintergrund-Saves an: kein PUT, das
    // Modal bleibt mit der getroffenen Entscheidung stehen.
    await page.locator('.conflict-block__choices button').nth(1).click();
    const bid = await page.evaluate(() => window.__app.conflictResolution.conflicts[0].bid);
    expect(await page.evaluate((b) => window.__app.conflictResolution.decisions[b], bid)).toBe('remote');
    await page.evaluate(async () => {
      await window.__app.quickSave();
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
    });
    await page.waitForTimeout(300);
    expect(await serverHtml(page, pageId)).not.toContain('LOKAL');
    expect(await page.evaluate((b) => window.__app.conflictResolution?.decisions?.[b], bid)).toBe('remote');

    // Abbrechen fragt nach; „Nein" laesst das Modal stehen.
    await page.locator('.conflict-modal__actions button').first().click();
    await expect(page.locator('#app-confirm-dialog')).toBeVisible();
    await page.locator('#app-confirm-dialog .confirm-dialog-btn--cancel').click();
    await expect(page.locator('.conflict-modal')).toBeVisible();

    // „Verwerfen": Server-Stand im Editor, lokale Fassung gesichert.
    await page.locator('.conflict-modal__actions button').first().click();
    await page.locator('#app-confirm-dialog .confirm-dialog-btn--danger').click();
    await expect(page.locator('.conflict-modal')).toBeHidden();
    await expect(page.locator(EDIT_SEL)).toContainText('Alpha FERN gemeinsamer');
    const backup = await page.evaluate((pid) => {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.endsWith(`${pid}:discarded`)) return JSON.parse(localStorage.getItem(k)).html;
      }
      return null;
    }, pageId);
    expect(backup).toContain('LOKAL');
  } finally {
    await page.evaluate(() => window.__app._teardownEditSession?.());
    await deletePage(page, pageId);
  }
});
