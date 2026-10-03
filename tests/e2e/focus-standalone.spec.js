// E2E für den Standalone-Bootstrap (focus/standalone.js): verifiziert, dass die
// Focus-Engine in einer fremden Schale OHNE window.__app/Alpine läuft — nur über
// setEditorHost + einen Bridge-Stub. Das ist der In-Repo-Beweis, bevor die
// WKWebView/Swift-Seite dazukommt.

const { test, expect } = require('./_helpers/fixtures');

const HARNESS = '/tests/fixtures/standalone-harness.html';

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.standaloneReady === true);
});

test('mountet: aktiver Focus-Editor, Inhalt geladen, focusActive=true', async ({ page }) => {
  const state = await page.evaluate(() => ({
    hasActiveEditor: !!document.querySelector('.focus-editor.is-active'),
    paragraphs: document.querySelectorAll('.focus-editor__content p').length,
    focusActive: window.__standalone.host.focusActive,
    focusState: window.__standalone.controller._focusState,
    listenersInstalled: window.__standalone.controller._focusListeners !== null,
  }));
  expect(state.hasActiveEditor).toBe(true);
  // 60 geladene Absätze + 1 Auto-Trailing-<p> (jumpToTrailingParagraph beim Enter).
  expect(state.paragraphs).toBe(61);
  expect(state.focusActive).toBe(true);
  expect(state.focusState).toBe('active');
  expect(state.listenersInstalled).toBe(true);
});

test('Granularität-Klasse + aktiver Absatz werden gesetzt', async ({ page }) => {
  const cls = await page.evaluate(() => document.querySelector('.focus-editor').className);
  expect(cls).toContain('focus-mode--paragraph');
  // Nach enterFocusMode markiert die Engine den aktiven Block.
  await page.waitForFunction(() => document.querySelectorAll('.focus-paragraph-active').length === 1);
});

test('Tippen markiert dirty und löst Autosave über die Bridge aus', async ({ page }) => {
  await page.evaluate(() => {
    const p = document.querySelector('.focus-editor__content p');
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    document.querySelector('.focus-editor__content').focus();
  });
  await page.keyboard.type(' NEUERTEXT');

  // editDirty wird synchron beim input gesetzt; Save kommt debounced (150ms).
  await page.waitForFunction(() => window.__saveLog.length >= 1, null, { timeout: 3000 });
  const log = await page.evaluate(() => window.__saveLog);
  expect(log[log.length - 1].html).toContain('NEUERTEXT');
  expect(log[log.length - 1].id).toBe(42);

  // Nach erfolgreichem Save ist editDirty wieder false.
  await page.waitForFunction(() => window.__standalone.host.editDirty === false);
});

test('Escape speichert, ohne den Editor abzureißen (kein Lese-Modus)', async ({ page }) => {
  await page.evaluate(() => {
    const c = document.querySelector('.focus-editor__content');
    c.focus();
    const p = c.querySelector('p');
    const sel = window.getSelection(); const r = document.createRange();
    r.selectNodeContents(p); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
  });
  await page.keyboard.type(' X');
  await page.evaluate(() => window.__saveLog.length = 0); // Autosave-Eintrag ignorieren
  await page.keyboard.press('Escape');

  await page.waitForFunction(() => window.__saveLog.length >= 1, null, { timeout: 3000 });
  const after = await page.evaluate(() => ({
    stillActive: !!document.querySelector('.focus-editor.is-active'),
    focusState: window.__standalone.controller._focusState,
    listeners: window.__standalone.controller._focusListeners !== null,
  }));
  expect(after.stillActive).toBe(true);
  expect(after.focusState).toBe('active');
  expect(after.listeners).toBe(true);
});

test('destroy() speichert geänderten Inhalt und räumt Engine-Listener ab', async ({ page }) => {
  await page.evaluate(() => {
    const c = document.querySelector('.focus-editor__content');
    c.focus();
    const p = c.querySelector('p');
    const sel = window.getSelection(); const r = document.createRange();
    r.selectNodeContents(p); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
  });
  await page.keyboard.type(' Y');
  await page.evaluate(() => window.__saveLog.length = 0); // Autosave-Eintrag ignorieren

  await page.evaluate(async () => { await window.__standalone.destroy(); });
  const state = await page.evaluate(() => ({
    saved: window.__saveLog.length >= 1,
    focusState: window.__standalone.controller._focusState,
    listeners: window.__standalone.controller._focusListeners,
  }));
  expect(state.saved).toBe(true);
  expect(state.focusState).toBe('idle');
  expect(state.listeners).toBe(null);
});

test('kein redundanter Save bei ungeänderter Seite (Gate via isNoChange)', async ({ page }) => {
  // Frisch geöffnete Seite: nur die Fokus-Engine hat das DOM normalisiert
  // (Aktiv-Markierung, Auto-Trailing-<p>) — inhaltlich nichts geändert.
  // Weder explizites save() noch destroy() dürfen einen PUT auslösen.
  const result = await page.evaluate(async () => {
    window.__saveLog.length = 0;
    await window.__standalone.save();
    const afterSave = window.__saveLog.length;
    await window.__standalone.destroy();
    return { afterSave, afterDestroy: window.__saveLog.length, dirty: window.__standalone.host.editDirty };
  });
  expect(result.afterSave).toBe(0);
  expect(result.afterDestroy).toBe(0);
  expect(result.dirty).toBe(false);
});

// Langsame Bridge: jeder savePage-Aufruf wartet, bis der Test ihn freigibt.
// Misst nebenbei die maximale Zahl gleichzeitig laufender Saves.
async function installSlowBridge(page) {
  await page.evaluate(() => {
    const st = { running: 0, maxRunning: 0, release: [] };
    window.__slow = st;
    window.__bridge.savePage = (p) => new Promise((resolve) => {
      st.running++;
      st.maxRunning = Math.max(st.maxRunning, st.running);
      window.__saveLog.push({ id: p.id, name: p.name, html: p.html });
      st.release.push(() => { st.running--; resolve({}); });
    });
  });
}

async function typeAtFirstParagraph(page, text) {
  await page.evaluate(() => {
    const c = document.querySelector('.focus-editor__content');
    c.focus();
    const p = c.querySelector('p');
    const sel = window.getSelection(); const r = document.createRange();
    r.selectNodeContents(p); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
  });
  await page.keyboard.type(text);
}

test('Saves laufen nacheinander: kein zweiter savePage, solange einer läuft', async ({ page }) => {
  await installSlowBridge(page);
  await typeAtFirstParagraph(page, ' EINS');
  await page.evaluate(() => { window.__saveLog.length = 0; window.__p1 = window.__standalone.save(); });
  await page.waitForFunction(() => window.__slow.running === 1);
  await typeAtFirstParagraph(page, ' ZWEI');
  // Zweiter Save (wie Escape/destroy während des ersten) — darf nicht parallel starten.
  await page.evaluate(() => { window.__p2 = window.__standalone.save(); });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__slow.running)).toBe(1);

  // Ersten freigeben → Folgelauf startet mit dem neuen Stand.
  await page.evaluate(() => window.__slow.release.shift()());
  await page.waitForFunction(() => window.__slow.release.length === 1);
  await page.evaluate(() => window.__slow.release.shift()());
  await page.evaluate(() => Promise.all([window.__p1, window.__p2]));

  const r = await page.evaluate(() => ({ max: window.__slow.maxRunning, log: window.__saveLog.map(e => e.html) }));
  expect(r.max).toBe(1);
  expect(r.log[r.log.length - 1]).toContain('ZWEI');
});

test('Seitenwechsel während eines Saves: originalHtml gehört danach der neuen Seite', async ({ page }) => {
  await installSlowBridge(page);
  await typeAtFirstParagraph(page, ' ALT');
  await page.evaluate(() => { window.__p = window.__standalone.save(); });
  await page.waitForFunction(() => window.__slow.running === 1);
  // setPage sichert die alte Seite hinter dem laufenden Save — nicht darauf
  // warten, sondern alle anstehenden Saves der langsamen Bridge freigeben.
  await page.evaluate(() => { window.__sp = window.__standalone.setPage({ id: 43, name: 'Neu', html: '<p>Neue Seite</p>' }); });
  await page.evaluate(async () => {
    let done = false;
    Promise.all([window.__p, window.__sp]).then(() => { done = true; });
    while (!done) {
      while (window.__slow.release.length) window.__slow.release.shift()();
      await new Promise(r => setTimeout(r, 10));
    }
  });
  const r = await page.evaluate(() => ({
    original: window.__standalone.host.originalHtml,
    pageId: window.__standalone.host.currentPage.id,
  }));
  expect(r.pageId).toBe(43);
  expect(r.original).toContain('Neue Seite');
  expect(r.original).not.toContain('ALT');
});

test('setPage auf eine andere Seite sichert vorher Ungespeichertes der bisherigen', async ({ page }) => {
  await typeAtFirstParagraph(page, ' LETZTEWORTE');
  // Sofort wechseln — der 150-ms-Autosave ist noch nicht gelaufen.
  await page.evaluate(async () => {
    window.__saveLog.length = 0;
    await window.__standalone.setPage({ id: 43, name: 'Neu', html: '<p>Neue Seite</p>' });
  });
  const log = await page.evaluate(() => window.__saveLog);
  const prev = log.find(e => e.id === 42);
  expect(prev, 'alte Seite wurde nicht gesichert').toBeTruthy();
  expect(prev.html).toContain('LETZTEWORTE');
  // Der neue Stand landet NICHT unter der alten ID.
  expect(log.some(e => e.id === 42 && e.html.includes('Neue Seite'))).toBe(false);
});

test('setPage auf dieselbe Seite (Sync-Pull) speichert nicht', async ({ page }) => {
  await typeAtFirstParagraph(page, ' LOKAL');
  await page.evaluate(async () => {
    window.__saveLog.length = 0;
    await window.__standalone.setPage({ id: 42, name: 'Testseite', html: '<p>Server-Stand</p>' });
  });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__saveLog.length)).toBe(0);
});
