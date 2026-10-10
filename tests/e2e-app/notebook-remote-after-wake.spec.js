// Notebook-Editor: Remote-Save eines anderen Geraets, waehrend der Tab
// versteckt war, landet beim Aufwachen im offenen Edit — statt dass der
// naechste Autosave mit dem alten Stempel in 409 PAGE_CONFLICT laeuft.
//
// Warum gegen die ECHTE App: der Pfad verbindet Root (Wake-Handler in
// app-init.js → app-view/bookscope.js), Root-Trampoline und die Notebook-Karte
// (edit/conflict.js#_pullRemoteIntoEditor) mit dem echten /changes-Feed und
// dem OCC-Guard des Servers. Jedes Teilstueck einzeln ist trivial; gebrochen
// waere die Verdrahtung.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';
// Fremdes Geraet: gueltige UUID, damit der Server sie als device_id annimmt
// und der /changes-Feed den Save nicht als Echo dieses Browsers ausfiltert.
const OTHER_DEVICE = '0b5e8c1e-1111-4222-8333-444455556666';

async function openPageInEdit(page, pageIdx) {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async (i) => {
    await window.__app.selectPage(window.Alpine.store('nav').pages[i]);
  }, pageIdx);
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
}

// Zweites Geraet speichert die Seite: erster Absatz bekommt einen Zusatz.
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
    return { status: r.status, blocks: (cur.html.match(/<p[\s>]/g) || []).length };
  }, { marker, device: OTHER_DEVICE });
}

// Tab > 30 s versteckt, dann wieder sichtbar (app-init.js-Schwelle).
async function hideAndWake(page) {
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
}

// Caret ans Ende des LETZTEN Absatzes — nicht der Wurzel: Firefox setzt den
// Text bei einem Range auf der Wurzel hinter das letzte </p>, wo ihn kein
// Block (und damit kein Block-Merge) mehr traegt.
async function caretToEnd(page) {
  await page.locator(EDIT_SEL).click();
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const r = document.createRange();
    r.selectNodeContents(el.lastElementChild || el);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }, EDIT_SEL);
}

test('Clean-Edit: Remote-Stand erscheint nach dem Aufwachen im Editor, Folge-Save ohne Konflikt', async ({ page }) => {
  await openPageInEdit(page, 2);
  const res = await remoteSaveFirstBlock(page, 'WAKEPROBE_CLEAN');
  expect(res.status).toBe(200);

  await hideAndWake(page);
  await expect(page.locator(EDIT_SEL)).toContainText('WAKEPROBE_CLEAN', { timeout: 10000 });

  // Weiterschreiben + speichern: kein Konflikt, beide Stände auf dem Server.
  await caretToEnd(page);
  await page.keyboard.type(' LOCALPROBE_CLEAN');
  await page.evaluate(() => window.__app.quickSave());
  const state = await page.evaluate(async () => {
    const app = window.__app;
    const srv = await (await fetch(`/content/pages/${app.currentPage.id}?__fresh=1`)).json();
    return { conflict: app.editConflict, resolution: app.conflictResolution, html: srv.html };
  });
  expect(state.conflict).toBeNull();
  expect(state.resolution).toBeNull();
  expect(state.html).toContain('WAKEPROBE_CLEAN');
  expect(state.html).toContain('LOCALPROBE_CLEAN');
});

// Hier liefert schon der Event-Stream den Remote-Save (Collab-Pfad,
// app-collab.js#_onCurrentPageRemoteEdit) — der Test sichert damit den
// Collab-Zweig ab, der Clean-Test oben den Wake-Zweig.
test('Dirty-Edit: Remote-Edit in anderem Block wird vor dem Speichern still gemergt', async ({ page }) => {
  await openPageInEdit(page, 3);
  await caretToEnd(page);
  await page.keyboard.type(' LOCALPROBE_DIRTY');
  await expect(page.locator(EDIT_SEL)).toContainText('LOCALPROBE_DIRTY');
  const res = await remoteSaveFirstBlock(page, 'WAKEPROBE_DIRTY');
  expect(res.status).toBe(200);
  // Ohne zweiten Block kollidierten lokale und Remote-Aenderung zwangslaeufig.
  expect(res.blocks).toBeGreaterThan(1);

  await hideAndWake(page);
  const ed = page.locator(EDIT_SEL);
  await expect(ed).toContainText('WAKEPROBE_DIRTY', { timeout: 10000 });
  await expect(ed).toContainText('LOCALPROBE_DIRTY');
  const st = await page.evaluate(() => ({
    dirty: window.__app.editDirty,
    conflict: window.__app.editConflict,
    resolution: window.__app.conflictResolution,
  }));
  expect(st.dirty).toBe(true);
  expect(st.conflict).toBeNull();
  expect(st.resolution).toBeNull();
  // Der Draft steht auf der neuen Basis (Remote-Stand + dessen Stempel): mit
  // der alten liefe er beim naechsten Oeffnen noch einmal gegen den schon
  // eingearbeiteten Remote-Stand.
  const draft = await page.evaluate(() => {
    const pid = window.__app.currentPage.id;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith('editor_draft_') && k.endsWith(':' + pid)) return JSON.parse(localStorage.getItem(k));
      if (k === 'editor_draft_' + pid) return JSON.parse(localStorage.getItem(k));
    }
    return null;
  });
  expect(draft?.originalUpdatedAt).toBe(await page.evaluate(() => window.__app.currentPage.updated_at));
  expect(draft?.originalHtml).toContain('WAKEPROBE_DIRTY');
  expect(draft?.html).toContain('LOCALPROBE_DIRTY');

  await page.evaluate(() => window.__app.quickSave());
  const html = await page.evaluate(async () => {
    const srv = await (await fetch(`/content/pages/${window.__app.currentPage.id}?__fresh=1`)).json();
    return srv.html;
  });
  expect(html).toContain('WAKEPROBE_DIRTY');
  expect(html).toContain('LOCALPROBE_DIRTY');
});

// Erster Save eines Geraets, das das Buch vorher NICHT offen hatte (Mac-Client-
// Push, Offline-Ausgang nach dem Wiederverbinden): kein voller Collab-Poll
// laeuft, nur die Baum-Drift-Probe sieht den Save — und der volle Poll, den
// der Save danach anstoesst, setzt seine Basis HINTER ihn. Die Probe muss die
// offene Seite deshalb selbst bedienen (book/tree/catchup.js#_checkTreeDrift).
test('Erster Save eines bisher abwesenden Geraets erreicht den offenen Editor', async ({ page }) => {
  await openPageInEdit(page, 1);
  const res = await remoteSaveFirstBlock(page, 'FIRSTSAVEPROBE');
  expect(res.status).toBe(200);
  await expect(page.locator(EDIT_SEL)).toContainText('FIRSTSAVEPROBE', { timeout: 15000 });

  await caretToEnd(page);
  await page.keyboard.type(' LOCALPROBE_FIRST');
  await page.evaluate(() => window.__app.quickSave());
  const html = await page.evaluate(async () => {
    const srv = await (await fetch(`/content/pages/${window.__app.currentPage.id}?__fresh=1`)).json();
    return srv.html;
  });
  expect(html).toContain('FIRSTSAVEPROBE');
  expect(html).toContain('LOCALPROBE_FIRST');
});
