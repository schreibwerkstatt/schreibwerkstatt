// Lektorat-Befunde im Notebook-Edit-Modus (docs/lektorat.md, „Befunde im
// Edit-Modus"; editor/lektorat-live.js), gegen die ECHTE App: Befundliste und
// contenteditable stehen im selben Split, die Markierung hängt an der
// CSS-Custom-Highlight-API und an Template-Ausdrücken in editor-findings.html /
// editor-page-actions.html — beides sieht nur die gebootete App.
//
// Geprüft:
// - «Bearbeiten» bleibt im Prüfmodus erreichbar; Liste + Editor gleichzeitig
// - Fundstellen als Highlights je Befund-Klasse, nie als Markup im Editor-DOM
// - «Übernehmen» je Befund und «Angehakte übernehmen» schreiben in den Live-Text
// - selbst umgeschriebene Stelle → «umgeschrieben», nicht mehr auswählbar
// - Strg+Z nach einer Übernahme öffnet den Befund wieder
// - Lauf aus dem Edit-Modus speichert zuerst und setzt die Befunde gegen den Live-Text

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const HTML = '<p>Ein Fhler und eine Lüke. Er sagte er kommt.</p>';
const FINDINGS = [
  { typ: 'rechtschreibung', original: 'Ein Fhler', korrektur: 'Ein Fehler', erklaerung: 'x' },
  { typ: 'wiederholung', original: 'eine Lüke', korrektur: 'eine Lücke', erklaerung: 'x' },
  { typ: 'grammatik', original: 'sagte er kommt', korrektur: 'sagte, er kommt', erklaerung: 'x' },
];

async function openPage(page) {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => {
    await window.__app.selectPage(window.Alpine.store('nav').pages[0]);
  });
}

const hlSize = (page, name) => page.evaluate((n) => CSS.highlights.get('lektorat-live-' + n)?.size ?? 0, name);
const editText = (page) => page.evaluate(() => window.__app._getEditEl().textContent);

test('Befunde im Edit-Modus: markieren, übernehmen, umgeschrieben, Undo', async ({ page }) => {
  await openPage(page);
  await page.evaluate(({ html, findings }) => {
    const app = window.__app;
    app.originalHtml = html;
    app.lektoratFindings = findings.map(f => ({ ...f }));
    app.selectedFindings = app.lektoratFindings.map(f => app.findingPreselected(f));
    app.lastCheckId = null; // kein History-PATCH in diesem Test
    app.checkDone = true;
    app.updatePageView();
  }, { html: HTML, findings: FINDINGS });

  // «Bearbeiten» ist im Prüfmodus da und öffnet den Editor neben der Liste.
  await page.locator('.card-actions button[aria-label]').filter({ has: page.locator('use[href="/icons.svg#pencil"]') }).click();
  await expect.poll(() => page.evaluate(() => window.__app.editMode)).toBe(true);
  const rows = page.locator('.lektorat-split-findings label.finding');
  await expect(rows).toHaveCount(3);
  await expect(page.locator('.lektorat-split-preview [contenteditable="true"]').first()).toBeVisible();

  // Markiert als Highlight je Klasse — nichts davon im DOM.
  await expect.poll(() => hlSize(page, 'hard')).toBe(2);
  await expect.poll(() => hlSize(page, 'soft')).toBe(1);
  expect(await page.evaluate(() => window.__app._getEditEl().innerHTML)).not.toMatch(/mark|lektorat/);
  if (process.env.LIVE_SHOT) await page.screenshot({ path: process.env.LIVE_SHOT });

  // Einzeln übernehmen.
  const applyOne = await page.evaluate(() => window.__app.t('editor.findings.applyOne'));
  await rows.nth(0).getByRole('button', { name: applyOne }).click();
  await expect.poll(() => editText(page)).toContain('Ein Fehler');
  await expect(rows.nth(0)).toHaveClass(/finding--applied/);
  await expect.poll(() => hlSize(page, 'hard')).toBe(1);

  // Selbst umschreiben → nach der Tipp-Pause «umgeschrieben», Checkbox gesperrt.
  await page.evaluate(() => {
    const el = window.__app._getEditEl();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeValue.includes('eine Lüke')) n.nodeValue = n.nodeValue.replace('eine Lüke', 'ein Loch');
    }
  });
  await expect(rows.nth(1)).toHaveClass(/finding--rewritten/);
  await expect(rows.nth(1).locator('.finding-checkbox')).toBeDisabled();
  await expect.poll(() => hlSize(page, 'soft')).toBe(0);

  // Angehakte übernehmen (nur der offene harte Befund ist angehakt).
  const applySel = await page.evaluate(() => window.__app.t('editor.findings.applySelected', { n: 1 }));
  await page.getByRole('button', { name: applySel }).click();
  await expect.poll(() => editText(page)).toContain('sagte, er kommt');
  await expect(rows.nth(2)).toHaveClass(/finding--applied/);

  // Strg+Z nimmt die Übernahme zurück → Befund wieder offen.
  await page.evaluate(() => window.__app._getEditEl().focus());
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => editText(page)).toContain('sagte er kommt');
  await expect(rows.nth(2)).not.toHaveClass(/finding--applied/);
  await expect.poll(() => hlSize(page, 'hard')).toBe(1);

  // Fokusmodus: Markierung aus (Focus-Editor wird nicht angefasst).
  await page.evaluate(() => { window.__app.focusActive = true; });
  await expect.poll(() => hlSize(page, 'hard')).toBe(0);
  await page.evaluate(() => { window.__app.focusActive = false; });
  await expect.poll(() => hlSize(page, 'hard')).toBe(1);
});

test('Lauf aus dem Edit-Modus: speichert zuerst, Befunde gegen den Live-Text', async ({ page }) => {
  await openPage(page);
  await page.evaluate(() => window.__app.startEdit());
  await expect.poll(() => page.evaluate(() => window.__app.editMode)).toBe(true);
  // Ungespeicherte Änderung: der Lauf muss sie vorher speichern.
  await page.evaluate(() => {
    const el = window.__app._getEditEl();
    el.innerHTML = '<p>Ein Fhler im Text.</p>';
    window.__app._markEditDirty();
  });

  let saved = 0;
  page.on('request', (req) => {
    if (req.method() === 'PUT' && /\/content\/pages\//.test(req.url())) saved++;
  });
  await page.route('**/jobs/check', (route) => route.fulfill({ json: { jobId: 'live-1' } }));
  await page.route('**/jobs/live-1', (route) => route.fulfill({
    json: {
      id: 'live-1', type: 'check', status: 'done', progress: 100,
      result: {
        fehler: [
          { typ: 'rechtschreibung', original: 'Ein Fhler', korrektur: 'Ein Fehler', erklaerung: 'x' },
          { typ: 'grammatik', original: 'gibt es nicht', korrektur: 'gibt es', erklaerung: 'x' },
        ],
        originalHtml: '<p>Ein Fhler im Text.</p>',
        updatedAt: null,
      },
    },
  }));

  await page.evaluate(() => window.__app.runCheck());
  expect(saved).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.__app.checkDone)).toBe(true);
  expect(await page.evaluate(() => window.__app.editMode)).toBe(true);
  // Nur der Befund, dessen Stelle im Live-Text steht.
  await expect(page.locator('.lektorat-split-findings label.finding')).toHaveCount(1);
  await expect.poll(() => hlSize(page, 'hard')).toBe(1);
});

// Ein Befund kennt seine Stelle nur über den Text. Entsteht beim Schreiben ein
// zweites Vorkommen, darf «Übernehmen» nicht still das erste treffen.
test('Mehrdeutig beim Schreiben: Tag, gestrichelt, Übernehmen gesperrt, Flag am Lauf gespeichert', async ({ page }) => {
  await openPage(page);
  const ambiguousCalls = [];
  await page.route('**/history/check/77/ambiguous', async (route) => {
    ambiguousCalls.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, marked: 1 } });
  });
  await page.evaluate(({ html, findings }) => {
    const app = window.__app;
    app.originalHtml = html;
    app.lektoratFindings = findings.map(f => ({ ...f }));
    app.selectedFindings = app.lektoratFindings.map(f => app.findingPreselected(f));
    app.lastCheckId = 77;
    app.checkDone = true;
    app.startEdit();
  }, { html: '<p>Ein Satz.</p><p>Er sagte er kommt.</p>', findings: [FINDINGS[2]] });
  await expect.poll(() => hlSize(page, 'hard')).toBe(1);

  // Dieselbe Stelle VOR der gemeinten einfügen.
  await page.evaluate(() => {
    const p = window.__app._getEditEl().querySelector('p');
    p.firstChild.nodeValue = 'Sie sagte er kommt. Ein Satz.';
  });
  const row = page.locator('.lektorat-split-findings label.finding').first();
  const ambLabel = await page.evaluate(() => window.__app.t('editor.findings.ambiguous'));
  await expect(row.locator('> .tag').filter({ hasText: ambLabel })).toBeVisible();
  expect(await page.evaluate(() => window.__app.selectedFindings[0])).toBe(false);
  await expect.poll(() => hlSize(page, 'ambiguous')).toBe(2);
  expect(await hlSize(page, 'hard')).toBe(0);
  await expect.poll(() => ambiguousCalls.length).toBe(1);
  expect(ambiguousCalls[0]).toEqual({ originals: ['sagte er kommt'] });

  // Übernehmen verweigert, solange die Stelle zweimal dasteht.
  const applyOne = await page.evaluate(() => window.__app.t('editor.findings.applyOne'));
  await row.getByRole('button', { name: applyOne }).click();
  await expect(page.locator('#status')).toContainText(await page.evaluate(() => window.__app.t('lektorat.skip.ambiguous', { count: 1 })));
  expect(await editText(page)).not.toContain('sagte, er kommt');

  // Zweites Vorkommen wieder weg: Tag bleibt (es könnte das falsche übrig sein),
  // Übernehmen wirkt wieder — bewusst, an der jetzt einzigen Stelle.
  await page.evaluate(() => {
    const p = window.__app._getEditEl().querySelector('p');
    p.firstChild.nodeValue = 'Ein Satz.';
  });
  await expect.poll(() => hlSize(page, 'ambiguous')).toBe(1);
  await expect(row.locator('> .tag').filter({ hasText: ambLabel })).toBeVisible();
  await row.getByRole('button', { name: applyOne }).click();
  await expect.poll(() => editText(page)).toContain('Er sagte, er kommt.');
});

test('Übernehmen: Caret hinter der Korrektur, mitgeänderter Befund „durch andere Korrektur erledigt"', async ({ page }) => {
  await openPage(page);
  await page.evaluate(() => {
    const app = window.__app;
    app.originalHtml = '<p>Er sagte er kommt bald.</p>';
    app.lektoratFindings = [
      { typ: 'grammatik', original: 'sagte er kommt', korrektur: 'sagte, er kommt', erklaerung: 'x' },
      { typ: 'wiederholung', original: 'sagte er', korrektur: 'meinte er', erklaerung: 'x' },
    ];
    app.selectedFindings = [true, false];
    app.lastCheckId = null;
    app.checkDone = true;
    app.startEdit();
  });
  await expect.poll(() => hlSize(page, 'hard')).toBe(1);
  const rows = page.locator('.lektorat-split-findings label.finding');
  const applyOne = await page.evaluate(() => window.__app.t('editor.findings.applyOne'));
  await rows.nth(0).getByRole('button', { name: applyOne }).click();
  await expect.poll(() => editText(page)).toContain('Er sagte, er kommt bald.');

  // C1: Caret steht direkt hinter „sagte, er kommt", Fokus im Editor.
  const caret = await page.evaluate(() => {
    const sel = document.getSelection();
    const el = window.__app._getEditEl();
    return {
      inEditor: el.contains(sel.anchorNode) && document.activeElement === el,
      before: sel.anchorNode.nodeValue.slice(0, sel.anchorOffset),
    };
  });
  expect(caret.inEditor).toBe(true);
  expect(caret.before.endsWith('sagte, er kommt')).toBe(true);

  // C2: der zweite Befund ist durch die erste Übernahme verschwunden.
  const label = await page.evaluate(() => window.__app.t('editor.findings.resolvedByOther'));
  await expect(rows.nth(1).locator('> .tag').filter({ hasText: label })).toBeVisible();
  const rewritten = await page.evaluate(() => window.__app.t('editor.findings.rewritten'));
  await expect(rows.nth(1).locator('> .tag').filter({ hasText: rewritten })).toBeHidden();
  await expect(rows.nth(1).locator('.finding-checkbox')).toBeDisabled();
});

// C3: Buchung mit explizitem Abschnitt (Save nach Abschnittswechsel / Outbox) —
// ohne geladenen Verlaufseintrag kommen die schon gebuchten Listen vom Server,
// der PATCH ersetzt sie sonst.
test('Buchung ausserhalb der offenen Seite: bisherige Annahmen bleiben erhalten', async ({ page }) => {
  await openPage(page);
  let patched = null;
  await page.route('**/history/check/88/details', (route) => route.fulfill({
    json: { errors_json: [], applied_errors_json: [{ typ: 'grammatik', original: 'früher', korrektur: 'früher,' }], selected_errors_json: [] },
  }));
  await page.route('**/history/check/88/saved', async (route) => {
    patched = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true } });
  });
  const pageId = await page.evaluate(({ findings }) => {
    const app = window.__app;
    app.originalHtml = '<p>Ein Fhler und mehr.</p>';
    app.lektoratFindings = [{ ...findings[0] }];
    app.selectedFindings = [true];
    app.lastCheckId = 88;
    app.pageHistory = [];
    app.checkDone = true;
    app.startEdit();
    return app.currentPage.id;
  }, { findings: FINDINGS });
  await expect.poll(() => hlSize(page, 'hard')).toBe(1);
  const applyOne = await page.evaluate(() => window.__app.t('editor.findings.applyOne'));
  await page.locator('.lektorat-split-findings label.finding').first().getByRole('button', { name: applyOne }).click();
  await expect.poll(() => editText(page)).toContain('Ein Fehler');

  await page.evaluate((id) => window.__app._flushLektoratLiveApplied('<p>Ein Fehler und mehr.</p>', id), pageId);
  await expect.poll(() => patched).not.toBeNull();
  expect(patched.applied_errors_json.map(e => e.original)).toEqual(['früher', 'Ein Fhler']);
});
