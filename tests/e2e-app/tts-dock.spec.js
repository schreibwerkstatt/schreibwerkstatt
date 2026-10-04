// Vorlese-Dock der Notebook-Leseansicht gegen die ECHTE App (voller Template-
// Baum, volles CSS). Das Harness (tests/e2e/tts-proof.spec.js) prueft die
// Abspiel-Logik; nur hier faellt auf, wenn das Dock-Markup in
// editor-body-view.html einen Alpine-Ausdruck verschluckt, eine Taste nicht
// erscheint oder der Store-Spiegel nicht greift. Audio ist gemockt (kein
// echtes Decoding), /tts/speak im Browser abgefangen.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const DOCK = '#editor-card .tts-dock';

test.describe('Notebook: Vorlese-Dock', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      class MockAudio {
        constructor(src) { this.src = src; this.paused = true; this.playbackRate = 1; this._l = {}; (window.__audios ||= []).push(this); }
        addEventListener(ev, cb) { (this._l[ev] = this._l[ev] || []).push(cb); }
        play() { this.paused = false; return Promise.resolve(); }
        pause() { this.paused = true; }
      }
      window.Audio = MockAudio;
    });
    await page.route('**/telemetry/tts-log', (r) => r.fulfill({ status: 204, body: '' }));
    await page.route('**/tts/speak*', (r) =>
      r.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.from([0x49, 0x44, 0x33, 0x04]) }));
    await bootApp(page);
    await selectSeededBook(page);
    // Feature-Schalter wie aus /config (Admin aktiviert).
    await page.evaluate(() => { window.Alpine.store('tts').enabled = true; });
    // Erste Seite mit Text oeffnen.
    await page.evaluate(async () => {
      const p = window.Alpine.store('nav').pages[0];
      await window.__app.selectPage(p);
    });
    await page.waitForFunction(() => !window.__app.pageContentLoading && !!window.__app.renderedPageHtml, null, { timeout: 15000 });
  });

  test('Dock erscheint, liest vor, Tempo/Weiterlesen/Stop greifen', async ({ page }) => {
    const dock = page.locator(DOCK);
    await expect(dock).toBeVisible();
    const main = dock.locator('.dock-btn:not(.dock-btn--sub)');
    await main.click();

    await page.waitForFunction(() => window.Alpine.store('tts').playing === true);
    await page.waitForFunction(() => CSS.highlights.has('tts-sentence'));
    const status = dock.locator('.tts-status');
    await expect(status).toBeVisible();
    await expect(status).toContainText('/');

    const rate = dock.locator('.dock-btn--text');
    await expect(rate).toHaveText('1×');
    await rate.click();
    await expect(rate).toHaveText('1.25×');
    expect(await page.evaluate(() => window.__audios.at(-1).playbackRate)).toBe(1.25);

    const cont = dock.locator('.dock-btn--sub[aria-pressed]');
    await expect(cont).toHaveAttribute('aria-pressed', 'false');
    await cont.click();
    await expect(cont).toHaveAttribute('aria-pressed', 'true');
    await expect(cont).toHaveClass(/is-on/);

    await page.evaluate(() => window.__app.stopTtsProof());
    await page.waitForFunction(() => window.Alpine.store('tts').playing === false);
    await expect(rate).toBeHidden();
    expect(await page.evaluate(() => CSS.highlights.has('tts-sentence'))).toBe(false);
  });

  test('Wechsel in den Edit-Modus beendet das Vorlesen', async ({ page }) => {
    await page.locator(`${DOCK} .dock-btn:not(.dock-btn--sub)`).click();
    await page.waitForFunction(() => window.Alpine.store('tts').playing === true);
    await page.evaluate(() => { window.__app.editMode = true; });
    await page.waitForFunction(() => window.Alpine.store('tts').playing === false);
  });
});
