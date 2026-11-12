// Kartenwechsel-Indikator gegen die ECHTE App (app/view-switch.js,
// `.layout-main.is-view-switching` in css/layout/twocolumn.css).
//
// Aussagen:
//  1. Kalter Wechsel Abschnitt → Karte: solange das Partial lädt, steht die alte
//     Ansicht gedimmt und klick-gesperrt, oben läuft der Balken, `aria-busy`.
//     Danach: Karte sichtbar, ungedimmt, kein `aria-busy`.
//  2. Die neue Karte steht nach dem Wechsel nie gedimmt (der Indikator endet vor
//     dem Snapshot des Cross-Fades).
//  3. Schlägt der Partial-Load fehl, bleibt nichts gedimmt/gesperrt stehen.
//
// Das Partial wird per Route festgehalten — nur so ist der Zwischenzustand im
// echten Template-Baum greifbar (wie card-loading-skeleton.spec.js).

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

async function openFirstSection(page) {
  const pageId = await page.evaluate(() => {
    const ch = window.Alpine.store('nav').tree.find(i => i.type === 'chapter' && !i.solo && i.pages.length);
    return ch.pages[0].id;
  });
  await page.evaluate(async (pid) => {
    await window.__app.selectPage(window.Alpine.store('nav').pages.find(x => x.id === pid));
  }, pageId);
  await page.waitForFunction(() => !window.__app.pageContentLoading && !!window.__app.renderedPageHtml);
}

async function holdPartial(page, name) {
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.route(`**/partials/${name}.html`, async (route) => {
    await gate;
    await route.continue();
  });
  return release;
}

const main = (page) => page.locator('.layout-main');

test.describe('Kartenwechsel-Indikator', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page);
    await selectSeededBook(page);
    await openFirstSection(page);
  });

  test('kalter Wechsel: alte Ansicht gedimmt + Balken, danach neue Karte klar', async ({ page }) => {
    const release = await holdPartial(page, 'recherche');
    await page.evaluate(() => { window.__toggleDone = window.__app.toggleRechercheCard().then(() => true); });

    await expect(main(page)).toHaveClass(/is-view-switching/);
    await expect(main(page)).toHaveAttribute('aria-busy', 'true');
    // Alte Ansicht steht noch (kein leerer Zwischen-Frame) — gedimmt, ohne Klicks.
    const editorWrap = page.locator('.layout-main > .main-aside-split.aside-split--on, .layout-main > .main-aside-split:has(#editor-card)').last();
    await expect(page.locator('#editor-card')).toBeVisible();
    const dim = await editorWrap.evaluate(el => ({ o: getComputedStyle(el).opacity, pe: getComputedStyle(el).pointerEvents }));
    expect(Number(dim.o)).toBeLessThan(1);
    expect(dim.pe).toBe('none');
    // Spinner (::before, sticky in der Hauptspalte) und Balken (::after, fixed
    // oben) — beide animieren nur transform (Compositor).
    const pseudo = await main(page).evaluate(el => {
      const read = (p) => { const cs = getComputedStyle(el, p); return { content: cs.content, position: cs.position, anim: cs.animationName }; };
      return { spinner: read('::before'), bar: read('::after') };
    });
    expect(pseudo.spinner.content).not.toBe('none');
    expect(pseudo.spinner.position).toBe('sticky');
    expect(pseudo.spinner.anim).toBe('viewSwitchSpin');
    expect(pseudo.bar.content).not.toBe('none');
    expect(pseudo.bar.position).toBe('fixed');
    expect(['viewSwitchSlide', 'none']).toContain(pseudo.bar.anim); // 'none' unter reduced-motion
    const spinW = await main(page).evaluate(el => parseFloat(getComputedStyle(el, '::before').width));
    expect(spinW).toBeGreaterThan(20);

    release();
    await page.waitForFunction(() => window.__toggleDone);
    await page.evaluate(() => window.__toggleDone);
    await expect(page.locator('#recherche-card')).toBeVisible();
    await expect(main(page)).not.toHaveClass(/is-view-switching/);
    await expect(main(page)).not.toHaveAttribute('aria-busy', /.*/);
    const op = await page.locator('#partial-recherche').evaluate(el => getComputedStyle(el).opacity);
    expect(Number(op)).toBe(1);
  });

  test('neue Karte wird nie gedimmt gemalt, kalter Wechsel ohne eingefrorenen Cross-Fade', async ({ page }) => {
    // Jeder gemalte Frame (rAF) und jeder Cross-Fade-Snapshot wird geprüft:
    // ist die neue Ansicht sichtbar, darf der Indikator nicht mehr an sein —
    // sonst erschiene sie gedimmt und hellte danach auf.
    await page.evaluate(() => {
      window.__bad = [];
      window.__vt = 0;
      const check = (where) => {
        const el = document.querySelector('.layout-main');
        const dimmed = el.classList.contains('is-view-switching');
        const card = document.getElementById('recherche-card');
        if (dimmed && card && card.offsetParent) window.__bad.push(where + ':recherche');
        const ed = document.getElementById('editor-card');
        if (dimmed && ed && ed.offsetParent && !window.__app.showEditorCard) window.__bad.push(where + ':editor-stale');
      };
      const loop = () => { check('frame'); window.__raf = requestAnimationFrame(loop); };
      loop();
      if (typeof document.startViewTransition === 'function') {
        const orig = document.startViewTransition.bind(document);
        document.startViewTransition = (cb) => { window.__vt++; return orig(async () => { await cb(); check('snapshot'); }); };
      }
    });
    // Kalt: der Indikator steht → kein Cross-Fade (der friert Spinner und Balken ein).
    await page.evaluate(() => window.__app.toggleRechercheCard());
    await expect(page.locator('#recherche-card')).toBeVisible();
    expect(await page.evaluate(() => window.__vt)).toBe(0);
    // Warm hin und zurück: schnell, mit Cross-Fade, Indikator nie im Snapshot.
    await openFirstSection(page);
    await page.evaluate(() => window.__app.toggleRechercheCard());
    await expect(page.locator('#recherche-card')).toBeVisible();
    await page.waitForTimeout(100);
    const bad = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return window.__bad; });
    expect(bad).toEqual([]);
    await expect(main(page)).not.toHaveClass(/is-view-switching/);
  });

  test('fehlgeschlagener Partial-Load: alte Ansicht bleibt, nichts gedimmt', async ({ page, consoleGuard }) => {
    consoleGuard.ignore(/ensurePartial:recherche|Failed to load resource|net::ERR_FAILED/);
    await page.route('**/partials/recherche.html', route => route.abort());
    await page.evaluate(() => window.__app.toggleRechercheCard());
    // Kein Umschalten auf eine leere Karten-Hülle: der Editor bleibt offen.
    expect(await page.evaluate(() => window.__app.showRechercheCard)).toBe(false);
    await expect(main(page)).not.toHaveClass(/is-view-switching/);
    await expect(page.locator('#editor-card')).toBeVisible();
    const pe = await page.locator('#editor-card').evaluate(el => getComputedStyle(el).pointerEvents);
    expect(pe).not.toBe('none');
  });
});
