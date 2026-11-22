'use strict';
// Vorschaubilder beim Teilen (og:image) der öffentlichen Seiten.
//
//   node scripts/landing-shots/og-image.js   (npm run shots:og)
//
// Je Seite und Sprache ein 1200×630-JPEG unter public/img/landing/og-<seite>-<lang>.jpg
// — das Format, das Social-Vorschauen ohne Beschnitt zeigen (1.91:1). Inhalt:
// Markenzeile + Seitentitel links, der passende Landing-Screenshot rechts.
// Die Screenshots kommen aus `npm run shots:landing`; dieses Skript braucht
// keine laufende App, es setzt nur vorhandene Dateien zusammen.
// Die Seitenliste muss zu den `ogImageUrl(…)`-Aufrufen in routes/public*.js passen
// (gegated: tests/unit/seo-robots.test.js).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');
const { tServer } = require('../../lib/i18n-server');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT_DIR = path.join(PUBLIC, 'img', 'landing');
const W = 1200;
const H = 630;

// Seite → Screenshot + Titel-Key (der sichtbare Titel der Seite).
const PAGES = {
  landing:    { shot: 'lektorat',  titleKey: 'landing.heroTitle' },
  lektorat:   { shot: 'lektorat',  titleKey: 'publicPage.lektorat.h1' },
  testleser:  { shot: 'testleser', titleKey: 'publicPage.testleser.h1' },
  funktionen: { shot: 'schreiben', titleKey: 'publicFeatures.h1' },
};
const LANGS = ['de', 'en'];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fileUrl = (rel) => pathToFileURL(path.join(PUBLIC, rel)).href;

function cardHtml({ title, shot }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: 'Inter'; src: url('${fileUrl('fonts/Inter.var.woff2')}') format('woff2'); font-weight: 100 900; }
@font-face { font-family: 'Source Serif 4'; src: url('${fileUrl('fonts/SourceSerif4.var.woff2')}') format('woff2'); font-weight: 200 900; }
html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; }
body {
  background: #faf7f2; color: #1f1c18; font-family: 'Inter', sans-serif;
  display: grid; grid-template-columns: 470px 1fr; align-items: center;
  gap: 48px; padding: 0 0 0 72px; box-sizing: border-box;
}
.brand { display: flex; align-items: center; gap: 16px; margin-bottom: 36px; }
.brand img { width: 64px; height: 64px; }
.brand span { font-size: 28px; font-weight: 600; color: #1d4b73; letter-spacing: 0.01em; }
h1 { font-family: 'Source Serif 4', serif; font-size: 50px; line-height: 1.15; font-weight: 600; margin: 0; }
.rule { width: 72px; height: 5px; background: #c4a55a; border-radius: 3px; margin-top: 36px; }
.shot {
  width: 690px; height: 460px; object-fit: cover; object-position: left top;
  border-radius: 14px 0 0 14px; box-shadow: 0 18px 50px rgba(31, 28, 24, 0.18);
  border: 1px solid rgba(31, 28, 24, 0.08); border-right: 0;
}
</style></head><body>
<div>
  <div class="brand"><img src="${fileUrl('schreibwerkstatt_icon.svg')}" alt=""><span>Schreibwerkstatt</span></div>
  <h1>${esc(title.replace(/\.$/, ''))}</h1>
  <div class="rule"></div>
</div>
<img class="shot" src="${fileUrl(`img/landing/${shot}.webp`)}" alt="">
</body></html>`;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'og-image-'));
  try {
    for (const [key, cfg] of Object.entries(PAGES)) {
      for (const lang of LANGS) {
        const htmlPath = path.join(tmp, `${key}-${lang}.html`);
        fs.writeFileSync(htmlPath, cardHtml({ title: tServer(cfg.titleKey, lang), shot: cfg.shot }));
        await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        const out = path.join(OUT_DIR, `og-${key}-${lang}.jpg`);
        await page.screenshot({ path: out, type: 'jpeg', quality: 86 });
        console.log(`${path.relative(ROOT, out)}  ${Math.round(fs.statSync(out).size / 1024)} KB`);
      }
    }
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { PAGES, LANGS };
