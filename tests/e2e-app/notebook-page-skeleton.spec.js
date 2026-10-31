// Lade-Skelett der Notebook-Leseansicht beim Seitenwechsel, gegen die ECHTE App.
//
// WARUM DIESE SCHICHT: der Fehler hängt am Zusammenspiel von Alpines
// x-show-Scheduling (Show und Hide laufen über requestAnimationFrame) mit dem
// Aus-/Einblenden der #editor-card, das selectPage → resetPage beim Wechsel
// auslöst. Ein Hide des Skeletts, das in ein noch ausstehendes Hide der Karte
// fällt, lief vor seinem eigenen, früher angestossenen Show — das Skelett blieb
// neben dem geladenen Text stehen. Das braucht den echten Template-Baum samt
// Karte, kein Fixture-Harness.
//
// Der Fehler tritt nur auf, wenn der Seiten-Load schneller als ein Frame ist
// (auf dem iPad aus dem SW-Cache). Lokal ist der Load langsamer; deshalb wird
// requestAnimationFrame künstlich verzögert, bis das Fenster sicher offen ist.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const SKELETON = '#editor-card .page-content-skeleton';
const READ_SHEET = '#editor-card .page-view-wrap .page-content-view';

test.describe('Notebook: Lade-Skelett beim Seitenwechsel', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => setTimeout(() => raf(cb), 150);
    });
    await bootApp(page);
    await selectSeededBook(page);
  });

  test('Skelett bleibt nach dem Wechsel nicht neben dem Text stehen', async ({ page }) => {
    const ids = await page.evaluate(() => window.Alpine.store('nav').pages.slice(0, 4).map(p => p.id));
    expect(ids.length).toBeGreaterThan(2);
    for (const id of ids) {
      await page.evaluate(async (pid) => {
        const p = window.Alpine.store('nav').pages.find(x => x.id === pid);
        await window.__app.selectPage(p);
      }, id);
      await page.waitForFunction(
        () => !window.__app.pageContentLoading && !!window.__app.renderedPageHtml,
        null, { timeout: 15000 },
      );
      await expect(page.locator(READ_SHEET)).toBeVisible();
      // Verzögerte Frames abwarten (mehrere Runden), dann erst urteilen.
      await page.waitForTimeout(800);
      await expect(page.locator(SKELETON)).toBeHidden();
    }
  });

  // Wechsel aus der Leseansicht: Karte bleibt stehen, kein Skelett dazwischen,
  // der alte Text weicht erst dem neuen (app-view/page.js#selectPage `swap`).
  test('Abschnittswechsel blendet die Karte nicht aus', async ({ page }) => {
    const ids = await page.evaluate(() => window.Alpine.store('nav').pages.slice(0, 3).map(p => p.id));
    expect(ids.length).toBeGreaterThan(1);
    await page.evaluate(async (pid) => {
      await window.__app.selectPage(window.Alpine.store('nav').pages.find(x => x.id === pid));
    }, ids[0]);
    await page.waitForFunction(() => !window.__app.pageContentLoading && !!window.__app.renderedPageHtml);
    await page.waitForTimeout(800);
    for (const id of ids.slice(1)) {
      const seen = await page.evaluate(async (pid) => {
        const card = document.getElementById('editor-card');
        const out = { cardHidden: false, skeleton: false, emptyHtml: false };
        const mo = new MutationObserver(() => {
          if (card.style.display === 'none') out.cardHidden = true;
          if (document.querySelector('#editor-card .page-content-skeleton')) out.skeleton = true;
        });
        mo.observe(document.getElementById('editor-card'), { attributes: true, subtree: true, childList: true });
        const stop = Alpine.effect(() => { if (!window.__app.renderedPageHtml) out.emptyHtml = true; });
        await window.__app.selectPage(window.Alpine.store('nav').pages.find(x => x.id === pid));
        await new Promise(r => setTimeout(r, 800));
        mo.disconnect();
        Alpine.release?.(stop);
        return out;
      }, id);
      expect(seen).toEqual({ cardHidden: false, skeleton: false, emptyHtml: false });
      await expect(page.locator(READ_SHEET)).toBeVisible();
      await expect(page.locator(READ_SHEET)).not.toHaveClass(/page-content-view--swapping/);
    }
  });
});

