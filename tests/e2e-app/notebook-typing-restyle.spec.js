// Tippen im NOTEBOOK-Editor auf einem grossen Abschnitt: Enter und Backspace
// dürfen nicht den ganzen Editor neu stilberechnen. Ein CSS-Selektor, der
// leere Absätze über Geschwister (`~`, `+`) oder `:has()` auf
// `.page-content-view` sucht, lässt Chromium bei jedem Blockwechsel den ganzen
// Editor-Teilbaum invalidieren — auch wenn er nur der Leseansicht gilt
// (`:not(--editing)` wirkt erst nach dem Treffer). Die Kosten wachsen linear
// mit der Blockzahl; oberste Priorität ist flüssiges Tippen auf ~34K-Zeichen-
// Abschnitten (docs/notebook-editor.md, «Sheet-Optik»).
//
// Gemessen wird die Elementzahl je Stil-Lauf (`UpdateLayoutTree`) aus einem
// Chromium-Trace, nicht die Zeit — die schwankt mit der Maschine, die Zahl
// nicht. Nur Chromium (Tracing-API).

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';
const BLOCKS = 300;
// Ein Blockwechsel berührt Caret-Block, Nachbarn und Editor-Chrome (heute ~26
// Elemente); ein Selektor über alle Blöcke läge bei > BLOCKS.
const MAX_RESTYLED = 80;

// Eigener Abschnitt je Test (danach gelöscht): Tippen löst den Autosave aus,
// und der geseedete Abschnitt 1 gehört den Specs, die im selben Shard folgen.
let freshPageId = null;

async function openFreshPage(page) {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  freshPageId = await page.evaluate(async (bid) => {
    const { contentRepo } = await import('/js/repo/content.js');
    const created = await contentRepo.createPage({ book_id: parseInt(bid, 10), name: 'Tipp-Last', html: '<p>Start.</p>' });
    await window.__app.loadPages();
    await window.__app.selectPage(window.Alpine.store('nav').pages.find((x) => x.id === created.id));
    return created.id;
  }, bookId);
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
}

test.afterEach(async ({ page }) => {
  if (freshPageId == null) return;
  const id = freshPageId;
  freshPageId = null;
  await page.evaluate(async (pid) => {
    window.__app.editDirty = false;
    if (window.__app.editMode) await window.__app.cancelEdit();
    await window.__app.deletePageById(pid, { confirm: false });
  }, id).catch(() => {});
});

test('Enter/Backspace auf grossem Abschnitt stilberechnet nicht den ganzen Editor', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Tracing nur in Chromium');
  await openFreshPage(page);
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
  await page.evaluate(({ sel, n }) => {
    const el = document.querySelector(sel);
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(i % 7 === 3 ? '<p><br></p>' : `<p>Zeile ${i} mit etwas Text, damit sie wie Prosa umbricht.</p>`);
    el.innerHTML = parts.join('');
    el.focus();
    const p = el.children[Math.floor(n / 2)];
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(r);
  }, { sel: EDIT_SEL, n: BLOCKS });
  await page.waitForTimeout(500);

  const browser = page.context().browser();
  const counts = {};
  for (const key of ['Enter', 'Backspace']) {
    await browser.startTracing(page, { categories: ['devtools.timeline'] });
    for (let i = 0; i < 3; i++) { await page.keyboard.press(key); await page.waitForTimeout(120); }
    const trace = JSON.parse((await browser.stopTracing()).toString());
    const events = trace.traceEvents || trace;
    counts[key] = Math.max(0, ...events
      .filter((e) => e.name === 'UpdateLayoutTree' && e.ph === 'X')
      .map((e) => e.args?.elementCount || 0));
  }
  expect(counts.Enter, `Enter: ${counts.Enter} Elemente je Stil-Lauf`).toBeLessThan(MAX_RESTYLED);
  expect(counts.Backspace, `Backspace: ${counts.Backspace} Elemente je Stil-Lauf`).toBeLessThan(MAX_RESTYLED);
});

test('Leseansicht: führende Leerabsätze bleiben unsichtbar, im Edit-Modus sichtbar', async ({ page }) => {
  await openFreshPage(page);
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
  await page.evaluate((sel) => {
    document.querySelector(sel).innerHTML = '<p><br></p><p><br></p><p>Erster Text.</p><p><br></p><p>Zweiter.</p>';
    window.__app._markEditDirty();
  }, EDIT_SEL);
  await page.evaluate(() => window.__app.quickSave());
  await page.waitForFunction(() => window.__app.editDirty === false && !window.__app.editSaving, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.cancelEdit());
  await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 15000 });
  const view = await page.evaluate(() => {
    const v = document.querySelector('.page-view-wrap .page-content-view');
    return Array.from(v.children).map((c) => getComputedStyle(c).display === 'none');
  });
  // Der Server fasst die Leerabsätze vorn zusammen und räumt hinten auf: vorn
  // einer versteckt, der Leerabsatz in der Mitte bleibt sichtbar.
  expect(view).toEqual([true, false, false, false]);
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
  const edit = await page.evaluate((sel) => Array.from(document.querySelector(sel).children)
    .map((c) => getComputedStyle(c).display === 'none'), EDIT_SEL);
  expect(edit[0]).toBe(false);
});

// Prüfmodus im Edit-Modus (editor/lektorat-live.js): registriert sind nur die
// Fundstellen im sichtbaren Band — Chromium malt bei jeder Taste alle
// registrierten Highlight-Ranges neu. Beim Scrollen wandern sie nach.
test('Prüfmodus: nur sichtbare Fundstellen sind markiert, Scrollen führt nach', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'CSS Custom Highlight API');
  await openFreshPage(page);
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
  const registered = () => page.evaluate(() => [...CSS.highlights]
    .filter(([n]) => n.startsWith('lektorat-live') && n !== 'lektorat-live-active')
    .reduce((a, [, h]) => a + h.size, 0));
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const parts = [];
    const N = 300;
    for (let i = 0; i < N; i++) parts.push(`<p>Zeile ${i} mit Text.${i === 2 ? ' Oben steht Fehlerwort eins.' : ''}${i === N - 3 ? ' Unten steht Fehlerwort zwei.' : ''}</p>`);
    el.innerHTML = parts.join('');
    el.scrollTop = 0;
    const app = window.__app;
    const findings = [
      { original: 'Fehlerwort eins', korrektur: 'Wort eins', typ: 'stil', erklaerung: 'x' },
      { original: 'Fehlerwort zwei', korrektur: 'Wort zwei', typ: 'stil', erklaerung: 'x' },
    ];
    app.lektoratFindings = findings;
    app.selectedFindings = findings.map(() => true);
    app.appliedOriginals = [];
    app.lastCheckId = 4711;
    app.checkDone = true;
    app._syncLektoratLive();
  }, EDIT_SEL);
  expect(await registered()).toBe(1);
  await page.evaluate((sel) => document.querySelector(sel).lastElementChild.scrollIntoView({ block: "end" }), EDIT_SEL);
  await page.waitForTimeout(150);
  expect(await registered()).toBe(1);
  // Die untere Fundstelle ist es jetzt.
  const text = await page.evaluate(() => [...CSS.highlights].filter(([n]) => n.startsWith('lektorat-live'))
    .flatMap(([, h]) => [...h].map((r) => r.toString())).join('|'));
  expect(text).toContain('Fehlerwort zwei');
});
