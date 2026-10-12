// Vertrag der Fokus-Hervorhebung mit den nativen Clients (macOS + Android).
// Testkörper, registriert von focus-client-contract.spec.js (Chromium) und
// focus-client-contract.webkit.spec.js (WebKit, Engine des macOS-Clients).
// Beide laden den Editor-Kern per OTA und docken mit eigenen Overrides an die
// Hervorhebung an — eine Änderung, die hier rot wird, ändert das Verhalten in
// einer App, die ohne Update nachgeladen wird (docs/focus-editor-acceptance.md
// #native-clients). Die Namen der Kontaktstellen prüft zusätzlich
// `npm run check:clients` gegen die Client-Repos; dieser Test prüft, dass sie
// noch WIRKEN:
//
//   • Dimm-Stärke: der macOS-Client setzt `--focus-dim-opacity` für seinen
//     Dimm-Regler (unlayered Override auf `.focus-editor`). Jede Abdunkelung von
//     Inhalt muss daraus (oder aus `--focus-near-opacity`) kommen — eine fest
//     verdrahtete Opacity ignoriert den Regler.
//   • Granularität: `handle.setGranularity` schaltet alle vier Stufen live.
//   • Satz-Modus: Abdunkelung über `::highlight(focus-sentence-dim)` — der
//     macOS-Client färbt genau diesen Namen um.
//   • Schreiblinie: Android ersetzt `host.typewriterAnchor` durch einen Getter
//     (Anker folgt der Tastatur) — die Engine muss ihn bei jedem Recenter neu
//     lesen, nicht einmal beim Mount.

const { test, expect } = require('./fixtures');

function registerFocusClientContract() {
  const HARNESS = '/tests/fixtures/standalone-harness.html';
  const CLIENT_DIM = 0.123;   // ungewöhnlich, damit kein Default zufällig passt

  test.beforeEach(async ({ page }) => {
    await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.standaloneReady === true);
    // Override wie im macOS-Client (WebAssets+GlueTypography.swift): unlayered,
    // `!important`, auf `.focus-editor`.
    await page.addStyleTag({ content: `.focus-editor { --focus-dim-opacity: ${CLIENT_DIM} !important; }` });
    // Inhalt mit den Blockarten, die eigene Fokus-Regeln haben.
    await page.evaluate(() => {
      const c = document.querySelector('.focus-editor__content');
      c.insertAdjacentHTML('beforeend',
        '<blockquote><p>Zitat</p></blockquote>'
        + '<ul><li>Punkt</li></ul>'
        + '<pre>Code</pre>'
        + '<table><caption>Legende</caption><tbody><tr><td>Zelle</td></tr></tbody></table>'
        + '<div class="msg-thread"><p class="msg-in">Hallo</p><p class="msg-out">Hoi</p></div>'
        + '<p>Erster Satz. Zweiter Satz. Dritter Satz.</p>');
    });
  });

  async function placeCaret(page, nth) {
    await page.evaluate((i) => {
      const p = document.querySelectorAll('.focus-editor__content > p')[i];
      const r = document.createRange();
      r.setStart(p.firstChild, Math.min(12, p.firstChild.length));
      r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      document.querySelector('.focus-editor__content').focus();
      document.dispatchEvent(new Event('selectionchange'));
    }, nth);
  }

  // Effektive Opacity jedes Inhaltselements (ohne Vorfahren-Produkt), das nicht
  // voll deckend ist.
  function dimmed(page) {
    return page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('.focus-editor__content *')) {
        const o = parseFloat(getComputedStyle(el).opacity);
        if (o < 1) out.push({ tag: el.tagName, cls: el.className, o });
      }
      const cs = getComputedStyle(document.querySelector('.focus-editor'));
      return { out, near: parseFloat(cs.getPropertyValue('--focus-near-opacity')) };
    });
  }

  for (const gran of ['paragraph', 'sentence', 'window-3']) {
    test(`${gran}: jede Abdunkelung folgt der Client-Dimm-Stärke`, async ({ page }) => {
      await page.evaluate((g) => window.__standalone.setGranularity(g), gran);
      await placeCaret(page, 10);
      await expect.poll(() => page.evaluate(() =>
        document.querySelector('.focus-paragraph-active')?.textContent.startsWith('Absatz 10'))).toBe(true);

      expect(await page.evaluate(() => document.querySelector('.focus-editor').className))
        .toContain(`focus-mode--${gran}`);
      const { out, near } = await dimmed(page);
      expect(out.length).toBeGreaterThan(0);
      const allowed = gran === 'window-3' ? [CLIENT_DIM, near] : [CLIENT_DIM];
      for (const d of out) {
        expect(allowed.some((a) => Math.abs(d.o - a) < 1e-3), `${d.tag}.${d.cls} opacity ${d.o}`).toBe(true);
      }
      // Der aktive Absatz bleibt voll deckend.
      expect(await page.evaluate(() =>
        getComputedStyle(document.querySelector('.focus-paragraph-active')).opacity)).toBe('1');
      // Jede Blockart wird mitgedimmt (selbst oder über einen Vorfahren) — oder
      // ist gar nicht sichtbar. Sonst stünde sie in voller Deckung neben dem
      // gedimmten Text.
      const undimmed = await page.evaluate(() => {
        const c = document.querySelector('.focus-editor__content');
        const isDim = (el) => {
          for (let n = el; n && n !== c; n = n.parentElement) {
            const cs = getComputedStyle(n);
            if (cs.display === 'none' || parseFloat(cs.opacity) < 1) return true;
          }
          return false;
        };
        return ['blockquote', 'li', 'pre', 'table', '.msg-thread p']
          .filter((sel) => !isDim(c.querySelector(sel)));
      });
      expect(undimmed).toEqual([]);
    });
  }

  test('typewriter-only: nichts wird abgedunkelt', async ({ page }) => {
    await page.evaluate(() => window.__standalone.setGranularity('typewriter-only'));
    await placeCaret(page, 10);
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => document.querySelector('.focus-editor').className))
      .toContain('focus-mode--typewriter-only');
    const { out } = await dimmed(page);
    expect(out).toEqual([]);
  });

  test('Satz-Modus dunkelt über ::highlight(focus-sentence-dim) ab', async ({ page }) => {
    await page.evaluate(() => window.__standalone.setGranularity('sentence'));
    await page.evaluate(() => {
      const ps = document.querySelectorAll('.focus-editor__content > p');
      const p = ps[ps.length - 1];
      const r = document.createRange();
      r.setStart(p.firstChild, 'Erster Satz. Zw'.length);
      r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      document.querySelector('.focus-editor__content').focus();
      document.dispatchEvent(new Event('selectionchange'));
    });
    await expect.poll(() => page.evaluate(() => {
      const hl = CSS.highlights.get('focus-sentence-dim');
      return hl ? [...hl].map((r) => r.toString().trim()).sort().join('|') : null;
    })).toBe('Dritter Satz.|Erster Satz.');
  });

  test('Schreiblinie liest host.typewriterAnchor bei jedem Recenter neu (Android-Getter)', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 700 });
    await page.evaluate(() => {
      window.__anchor = 0.3;
      Object.defineProperty(window.__standalone.host, 'typewriterAnchor', {
        configurable: true, get: () => window.__anchor,
      });
    });
    const caretAt = async (anchor, nth) => {
      await page.evaluate((a) => { window.__anchor = a; }, anchor);
      await placeCaret(page, nth);
      await page.keyboard.type('x');
      let ratio = null;
      await expect.poll(async () => {
        ratio = await page.evaluate(() => {
          const r = getSelection().getRangeAt(0).getBoundingClientRect();
          const vv = window.visualViewport;
          return (r.top + r.height / 2 - (vv?.offsetTop || 0)) / (vv?.height || innerHeight);
        });
        return Math.abs(ratio - anchor) < 0.06;
      }, { timeout: 3000 }).toBe(true);
      return ratio;
    };
    await caretAt(0.3, 25);
    await caretAt(0.7, 40);
  });
}

module.exports = { registerFocusClientContract };
