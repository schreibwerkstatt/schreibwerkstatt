// Focus-Editor: die Punkte der Akzeptanzliste (docs/focus-editor-acceptance.md),
// die focus-editor-app.spec.js nicht abdeckt — gegen die ECHTE App, mit echter
// Tastatur und Maus statt Methodenaufrufen, wo der Griff selbst das Verhalten ist.
//
//   #6  Klick mitten in einen Absatz: Caret landet dort, kein Recenter-Sprung
//   #8  Granularität live umschalten: Markierung + Satz-Highlight neu gerechnet
//   #9  Escape speichert: Leseansicht, Server-Stand und Kennzahlen aktuell
//   #12 Offline + Escape: Edit-Modus bleibt, Entwurf erhalten
//   Escape während eines laufenden Saves (Invariante 16): Exit nach dem Save
//   Save im Fokus frischt den Wiederaufnahme-Snapshot auf
//
// Die Specs teilen EINEN Seed-Stand (workers: 1), und viele andere arbeiten auf
// `pages[0]`. Darum hier die LETZTE Seite des Seeds, und jeder Test, der
// speichert, stellt ihren Inhalt im afterEach über den regulären PUT wieder her.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const FOCUS = '.focus-editor__content';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

// Stand der Testseite vor dem Test — afterEach schreibt ihn zurück.
let restore = null;

test.afterEach(async ({ page, context }) => {
  await context.setOffline(false).catch(() => {});
  if (!restore) return;
  const r = restore;
  restore = null;
  await page.unroute('**/content/pages/*').catch(() => {});
  const status = await page.evaluate(async ({ id, html, name }) => {
    // Lokalen Entwurf mit verwerfen, sonst bietet der nächste Test ihn an.
    for (const k of Object.keys(localStorage)) if (k.includes('draft')) localStorage.removeItem(k);
    const res = await fetch('/content/pages/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, name, source: 'main', expected_updated_at: null }),
    });
    return res.status;
  }, r);
  expect(status, 'Testseite liess sich nicht zurücksetzen').toBeLessThan(300);
});

function focusState(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.focus-editor');
    return el && window.Alpine ? window.Alpine.$data(el)?._focusState : null;
  });
}

async function waitFocusState(page, state, timeout = 15000) {
  await page.waitForFunction((s) => {
    const el = document.querySelector('.focus-editor');
    return !!el && window.Alpine?.$data(el)?._focusState === s;
  }, state, { timeout });
}

// Buch → letzte Seite → Fokusmodus über das Trampoline-Event (wie der
// Focus-Button im Page-View-Header). `remember` merkt den Stand für afterEach.
async function enterFocusOnLastPage(page, { remember = false } = {}) {
  await bootApp(page);
  await selectSeededBook(page);
  const info = await page.evaluate(async () => {
    const pages = window.Alpine.store('nav').pages;
    const p = pages[pages.length - 1];
    await window.__app.selectPage(p);
    return { id: p.id, name: p.name };
  });
  await page.waitForFunction(() => window.__app.showEditorCard === true && window.__app.originalHtml != null, null, { timeout: 15000 });
  if (remember) restore = { ...info, html: await page.evaluate(() => window.__app.originalHtml) };
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('editor:focus:enter-from-pageview')));
  await waitFocusState(page, 'active');
  await page.waitForTimeout(200);
  return info;
}

// Lange Seite ohne Save: Absätze direkt an den Container (kein input-Event →
// editDirty bleibt false). Mehrere Sätze pro Absatz für den Satz-Modus.
async function seedParagraphs(page, count) {
  await page.evaluate(({ sel, n }) => {
    const el = document.querySelector(sel);
    for (let i = 1; i <= n; i++) {
      const p = document.createElement('p');
      p.textContent = `Absatz ${i}. Gregor Samsa erwachte aus unruhigen Träumen. Er lag auf seinem panzerartig harten Rücken. Sein Blick fiel zum Fenster.`;
      el.appendChild(p);
    }
  }, { sel: FOCUS, n: count });
  await page.waitForTimeout(150);
}

const scrollTop = (page) => page.evaluate((sel) => Math.round(document.querySelector(sel).scrollTop), FOCUS);

test('#6 Klick mitten in einen Absatz: Caret landet dort, kein Recenter-Sprung', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await enterFocusOnLastPage(page);
  await seedParagraphs(page, 30);
  // Weg vom Seitenende, damit oberhalb der Schreiblinie Absätze stehen.
  await page.evaluate((sel) => { const el = document.querySelector(sel); el.scrollTop = el.scrollHeight / 2; }, FOCUS);
  await page.waitForTimeout(300);

  const target = await page.evaluate((sel) => {
    const c = document.querySelector(sel);
    const mid = innerHeight / 2;
    for (const p of c.querySelectorAll('p')) {
      const r = p.getBoundingClientRect();
      if (r.top > 80 && r.bottom < mid - 60) return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: p.textContent.slice(0, 10) };
    }
    return null;
  }, FOCUS);
  expect(target, 'kein Absatz deutlich oberhalb der Schreiblinie').not.toBeNull();

  const before = await scrollTop(page);
  await page.mouse.click(target.x, target.y);
  // Länger als die Klick-Schonfrist (POINTER_GRACE_MS) warten.
  await page.waitForTimeout(700);
  expect(await scrollTop(page), 'Klick hat einen Recenter-Sprung ausgelöst').toBe(before);
  const inTarget = await page.evaluate((t) => getSelection().anchorNode?.parentElement?.closest('p')?.textContent.startsWith(t), target.text);
  expect(inTarget, 'Caret sitzt nicht im angeklickten Absatz').toBe(true);
  guard.assertClean();
});

test('#8 Granularität live umschalten rechnet Markierung und Satz-Highlight neu', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await enterFocusOnLastPage(page);
  await seedParagraphs(page, 12);
  // Caret mitten in einen mehrsätzigen Absatz (zweiter Satz).
  await page.evaluate((sel) => {
    const p = [...document.querySelectorAll(sel + ' p')].find(x => x.textContent.startsWith('Absatz 6.'));
    const tn = p.firstChild;
    const r = document.createRange();
    r.setStart(tn, tn.textContent.indexOf('Er lag') + 3);
    r.collapse(true);
    document.querySelector(sel).focus({ preventScroll: true });
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }, FOCUS);
  await page.waitForTimeout(300);

  const snapshot = () => page.evaluate((sel) => ({
    cls: document.querySelector('.focus-editor').className,
    active: document.querySelectorAll(sel + ' .focus-paragraph-active').length,
    activeText: document.querySelector(sel + ' .focus-paragraph-active')?.textContent.slice(0, 10) || null,
    near: document.querySelectorAll(sel + ' .focus-paragraph-near').length,
    // Ohne Custom-Highlight-API degradiert der Satz-Modus lautlos (Invariante 10).
    hlApi: typeof CSS !== 'undefined' && !!CSS.highlights,
    hlRanges: (typeof CSS !== 'undefined' && CSS.highlights?.get('focus-sentence-dim')?.size) || 0,
  }), FOCUS);

  await page.evaluate(() => { window.__app.focusGranularity = 'sentence'; });
  await page.waitForTimeout(300);
  const s = await snapshot();
  expect(s.cls).toContain('focus-mode--sentence');
  expect(s.active).toBe(1);
  expect(s.activeText).toBe('Absatz 6. ');
  // Satz 1 davor und Satz 3 danach gedimmt.
  if (s.hlApi) expect(s.hlRanges).toBe(2);
  expect(await focusState(page), 'Umschalten darf den Modus nicht verlassen').toBe('active');

  await page.evaluate(() => { window.__app.focusGranularity = 'window-3'; });
  await page.waitForTimeout(300);
  const w = await snapshot();
  expect(w.cls).toContain('focus-mode--window-3');
  expect(w.near).toBe(2);
  expect(w.hlRanges, 'Satz-Highlight muss beim Verlassen des Satz-Modus weg').toBe(0);

  await page.evaluate(() => { window.__app.focusGranularity = 'paragraph'; });
  await page.waitForTimeout(300);
  const p = await snapshot();
  expect(p.cls).toContain('focus-mode--paragraph');
  expect(p.cls).not.toContain('focus-mode--window-3');
  expect(p.near).toBe(0);
  expect(p.active).toBe(1);
  guard.assertClean();
});

test('#9 Escape speichert: Leseansicht, Server-Stand und Kennzahlen aktuell', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  const { id } = await enterFocusOnLastPage(page, { remember: true });
  // Vor dem Tippen messen: ein Autosave während des Tippens zöge die Kennzahl
  // sonst schon nach.
  const wordsBefore = await page.evaluate((pid) => window.__app.tokEsts?.[pid]?.words ?? null, id);
  await page.keyboard.type(' Akzeptanzneun schliesst den Fokus.', { delay: 10 });

  await page.keyboard.press('Escape');
  await waitFocusState(page, 'idle');
  await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 10000 });

  const r = await page.evaluate((pid) => {
    const view = document.querySelector('#editor-card .page-content-view:not(.page-content-view--editing)');
    return {
      overlay: !!document.querySelector('.focus-editor.is-active'),
      bodyClass: document.body.classList.contains('focus-mode'),
      view: !!view && view.textContent.includes('Akzeptanzneun'),
      words: window.__app.tokEsts?.[pid]?.words ?? null,
    };
  }, id);
  expect(r.overlay).toBe(false);
  expect(r.bodyClass).toBe(false);
  expect(r.view, 'Leseansicht zeigt den getippten Text nicht').toBe(true);
  const server = await page.evaluate(async (pid) => JSON.stringify(await (await fetch('/content/pages/' + pid)).json()), id);
  expect(server).toContain('Akzeptanzneun');
  // Vier getippte Wörter — die Kennzahl muss sie enthalten.
  if (wordsBefore != null) expect(r.words, `Wörter vorher ${wordsBefore}, nachher ${r.words}`).toBeGreaterThanOrEqual(wordsBefore + 4);
  else expect(r.words).toBeGreaterThan(0);
  guard.assertClean();
});

test('#12 Offline + Escape: Edit-Modus bleibt, Entwurf ist erhalten', async ({ page, context }) => {
  const guard = attachConsoleGuard(page);
  // Der Netzwerkfehler des Save-Versuchs ist der Testgegenstand.
  guard.ignore(/Failed to fetch|NetworkError|Load failed|ERR_INTERNET_DISCONNECTED|\[quickSave\]/);
  await enterFocusOnLastPage(page, { remember: true });
  await page.keyboard.type(' Offlinesatz bleibt erhalten.', { delay: 10 });
  await context.setOffline(true);
  await page.keyboard.press('Escape');
  await waitFocusState(page, 'idle');
  await page.waitForTimeout(500);

  const r = await page.evaluate(() => {
    const ed = document.querySelector('#editor-card .page-content-view--editing');
    const draft = Object.keys(localStorage).some(k => k.includes('draft') && (localStorage.getItem(k) || '').includes('Offlinesatz'));
    return { editMode: window.__app.editMode, focusActive: window.__app.focusActive, dirty: window.__app.editDirty, draft, inEditor: !!ed && ed.textContent.includes('Offlinesatz') };
  });
  expect(r.focusActive).toBe(false);
  expect(r.editMode, 'unsauberer Exit muss im Edit-Modus bleiben').toBe(true);
  expect(r.dirty).toBe(true);
  expect(r.draft, 'Entwurf fehlt in localStorage').toBe(true);
  expect(r.inEditor, 'Text fehlt im Normal-Editor').toBe(true);
  guard.assertClean();
});

test('Escape während eines laufenden Saves verlässt den Modus erst nach dem Save', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await enterFocusOnLastPage(page, { remember: true });
  // PUT künstlich verzögern, damit Escape sicher in den laufenden Save fällt.
  await page.route('**/content/pages/*', async (route) => {
    if (route.request().method() === 'PUT') await new Promise(r => setTimeout(r, 1200));
    await route.continue();
  });
  await page.keyboard.type(' Waehrendsave', { delay: 10 });
  await page.evaluate(() => { window.__app.quickSave(); });
  await page.waitForFunction(() => window.__app.editSaving === true, null, { timeout: 5000 });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__app.editSaving), 'Save sollte noch laufen').toBe(true);
  expect(await focusState(page), 'kein Exit mitten im Save').toBe('active');

  // Ohne zweiten Tastendruck: der vorgemerkte Exit läuft nach dem Save.
  await waitFocusState(page, 'idle');
  const r = await page.evaluate(() => ({ focusActive: window.__app.focusActive, editMode: window.__app.editMode, saved: window.__app.originalHtml.includes('Waehrendsave') }));
  expect(r.focusActive).toBe(false);
  expect(r.editMode).toBe(false);
  expect(r.saved).toBe(true);
  guard.assertClean();
});

test('Save im Fokus frischt den Wiederaufnahme-Snapshot auf', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await enterFocusOnLastPage(page, { remember: true });
  // Eintritt „vor 59 Minuten" vortäuschen.
  await page.evaluate(() => sessionStorage.setItem('focus.snapshot', JSON.stringify({ pageId: window.__app.currentPage.id, ts: Date.now() - 59 * 60 * 1000 })));
  await page.keyboard.type(' snapshot', { delay: 10 });
  await page.evaluate(() => window.__app.quickSave());
  await page.waitForTimeout(300);
  const ageS = await page.evaluate(() => {
    const s = JSON.parse(sessionStorage.getItem('focus.snapshot') || 'null');
    return s ? (Date.now() - s.ts) / 1000 : null;
  });
  expect(ageS).not.toBeNull();
  expect(ageS, 'Snapshot wurde beim Save nicht aufgefrischt').toBeLessThan(10);
  // Escape (sauberer Exit) räumt den Snapshot ab.
  await page.keyboard.press('Escape');
  await waitFocusState(page, 'idle');
  expect(await page.evaluate(() => sessionStorage.getItem('focus.snapshot'))).toBeNull();
  guard.assertClean();
});
