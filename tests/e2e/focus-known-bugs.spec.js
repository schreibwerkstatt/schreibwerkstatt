// Bekannte Fehler des Focus-Editors — als `test.fail()` festgehalten.
//
// Gefunden beim Durchspielen der Akzeptanzliste in WebKit (Safari, macOS-Client
// in WKWebView). Bewusst NICHT behoben: der Focus-Editor ist stabilisiert, eine
// Änderung braucht einen ausdrücklichen Auftrag (public/js/editor/CLAUDE.md).
//
// `test.fail()` heisst: der Test beschreibt das RICHTIGE Verhalten und schlägt
// heute erwartungsgemäss fehl. Wer den Fehler behebt, bekommt ein „Expected to
// fail, but passed" — dann `test.fail()` entfernen, und der Test wird zum
// normalen Regressionsschutz.

const { test, expect } = require('./_helpers/fixtures');

const HARNESS = '/tests/fixtures/focus-harness.html';
const EDITOR = '#editor-card .focus-editor__content';

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.harnessReady === true);
  await page.evaluate(() => { window.harness.editMode = true; window.harness.enterFocusMode(); });
  await page.waitForFunction(() => window.harness._focusListeners !== null);
  await page.waitForTimeout(150);
});

test('Browser-eigener Scroll zwischen Tastendruck und Recenter-Frame verwirft den Typewriter nicht', async ({ page }) => {
  // Symptom in WebKit: nach Strg+Pos1, Strg+Ende oder einem Klick nahe am Rand
  // bleibt der ERSTE getippte Buchstabe am Rand stehen, erst der zweite holt die
  // Zeile auf die Schreiblinie. Mechanismus: der Tastendruck plant einen
  // Typewriter-Tick (`_focusUpdateActive(true)`, gecancelter RAF). Noch vor
  // diesem Frame scrollt WebKit selbst, um den Caret sichtbar zu machen. Dieser
  // Scroll trägt keine prog-Marke, `onScroll` hält ihn für Lese-Scrollen und
  // ruft `_focusUpdateActive(false, { preferCenter: true })` — das cancelt den
  // geplanten Tick. Chromium scrollt in der Lage nicht selbst; der Ablauf ist
  // hier darum von Hand nachgestellt und läuft in jeder Engine.
  test.fail();
  const r = await page.evaluate(async (sel) => {
    const c = document.querySelector(sel);
    // Caret in einen Absatz setzen (das selectionchange recentert ihn auf die
    // Linie) …
    const p = c.querySelectorAll('p')[10];
    const range = document.createRange();
    range.setStart(p.firstChild, 3);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    await new Promise(res => setTimeout(res, 400));
    // … dann per Lese-Scroll von der Linie weg an den Rand schieben (ein
    // User-Scroll löst keinen Typewriter aus), wie nach einem Sprung.
    c.scrollTop -= 300;
    await new Promise(res => setTimeout(res, 400));
    // „Tastendruck": Tick planen …
    window.harness._focusUpdateActive(true);
    // … und im selben Task der browser-eigene Reveal-Scroll (ohne prog-Marke).
    c.scrollTop += 10;
    await new Promise(res => setTimeout(res, 400));
    const rr = getSelection().getRangeAt(0).cloneRange();
    const n = rr.startContainer;
    if (n.nodeType === 3 && rr.startOffset > 0) rr.setStart(n, rr.startOffset - 1);
    const rect = rr.getBoundingClientRect();
    const ratio = parseFloat(getComputedStyle(c).getPropertyValue('--focus-anchor')) || 0.5;
    const anchor = (visualViewport?.offsetTop || 0) + (visualViewport?.height || innerHeight) * ratio;
    return { off: Math.round(rect.top + rect.height / 2 - anchor), lh: parseFloat(getComputedStyle(c).lineHeight) || 30 };
  }, EDITOR);
  expect(Math.abs(r.off), `Abstand zur Schreiblinie ${r.off}px`).toBeLessThanOrEqual(r.lh / 2);
});
