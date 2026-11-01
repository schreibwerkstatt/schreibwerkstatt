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
//   und speichern sofort (nicht erst nach der Autosave-Pause)
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

  // Angehakte übernehmen (nur der offene harte Befund ist angehakt) — sofort
  // gespeichert, nicht erst nach der Autosave-Tipp-Pause.
  const puts = [];
  page.on('request', (req) => {
    if (req.method() === 'PUT' && /\/content\/pages\//.test(req.url())) puts.push(req.postData() || '');
  });
  const applySel = await page.evaluate(() => window.__app.t('editor.findings.applySelected', { n: 1 }));
  await page.locator('.finding-header').getByRole('button', { name: applySel }).click();
  await expect.poll(() => editText(page)).toContain('sagte, er kommt');
  await expect(rows.nth(2)).toHaveClass(/finding--applied/);
  await expect.poll(() => puts.some(b => b.includes('sagte, er kommt')), { timeout: 5000 }).toBe(true);

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
// zweites Vorkommen, darf «Übernehmen» nicht still das erste treffen. Das Flag
// ist reine Anzeige: kein Abwählen, nichts am Lauf gespeichert, fällt zurück.
test('Mehrfach beim Schreiben: Tag, gestrichelt, Übernehmen gesperrt, nur Anzeige', async ({ page }) => {
  await openPage(page);
  const historyWrites = [];
  page.on('request', (req) => {
    if (req.method() === 'PATCH' && /\/history\/check\//.test(req.url())) historyWrites.push(req.url());
  });
  // Übernehmen speichert sofort und bucht am Lauf — der Lauf 77 existiert nur hier.
  await page.route('**/history/check/77/details', route => route.fulfill({ json: { applied_errors_json: [], selected_errors_json: [] } }));
  await page.route('**/history/check/77/saved', route => route.fulfill({ json: { ok: true } }));
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
  const ambTag = row.locator('> .tag').filter({ hasText: await page.evaluate(() => window.__app.t('editor.findings.ambiguous')) });
  await expect(ambTag).toBeVisible();
  await expect.poll(() => hlSize(page, 'ambiguous')).toBe(2);
  expect(await hlSize(page, 'hard')).toBe(0);
  // Nur Anzeige: Häkchen bleibt, kein Flag am Befund-Objekt des Laufs.
  expect(await page.evaluate(() => window.__app.selectedFindings[0])).toBe(true);
  expect(await page.evaluate(() => window.__app.lektoratFindings[0].mehrdeutig)).toBeFalsy();

  // Nicht übernehmbar, solange die Stelle zweimal dasteht: kein Einzelknopf,
  // und «Angehakte übernehmen» zählt ihn nicht mit.
  const applyOne = await page.evaluate(() => window.__app.t('editor.findings.applyOne'));
  await expect(row.getByRole('button', { name: applyOne })).toBeHidden();
  expect(await page.evaluate(() => window.__app.applicableSelectedCount())).toBe(0);
  const applySel0 = await page.evaluate(() => window.__app.t('editor.findings.applySelected', { n: 0 }));
  await expect(page.locator('.finding-header').getByRole('button', { name: applySel0 })).toBeDisabled();

  // Zweites Vorkommen wieder weg: Tag fällt, Übernehmen wirkt wieder.
  await page.evaluate(() => {
    const p = window.__app._getEditEl().querySelector('p');
    p.firstChild.nodeValue = 'Ein Satz.';
  });
  await expect(ambTag).toBeHidden();
  await expect.poll(() => hlSize(page, 'hard')).toBe(1);
  expect(await hlSize(page, 'ambiguous')).toBe(0);
  await row.getByRole('button', { name: applyOne }).click();
  await expect.poll(() => editText(page)).toContain('Er sagte, er kommt.');
  expect(historyWrites.filter(u => /\/ambiguous$/.test(u))).toEqual([]);
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

test('Übernehmen bucht sofort; Strg+Z öffnet wieder und bucht mit dem nächsten Save aus', async ({ page }) => {
  await openPage(page);
  const patches = [];
  await page.route('**/history/check/88/details', route => route.fulfill({ json: { applied_errors_json: [], selected_errors_json: [] } }));
  await page.route('**/history/check/88/saved', async (route) => {
    patches.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });
  await page.evaluate(({ html, findings }) => {
    const app = window.__app;
    app.originalHtml = html;
    app.lektoratFindings = findings.map(f => ({ ...f }));
    app.selectedFindings = app.lektoratFindings.map(() => false);
    app.lastCheckId = 88;
    app.checkDone = true;
    app.startEdit();
  }, { html: '<p>Er sagte er kommt.</p>', findings: [FINDINGS[2]] });
  const row = page.locator('.lektorat-split-findings label.finding').first();
  await expect.poll(() => hlSize(page, 'hard')).toBe(1);

  const applyOne = await page.evaluate(() => window.__app.t('editor.findings.applyOne'));
  await row.getByRole('button', { name: applyOne }).click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0].applied_errors_json.map(e => e.original)).toEqual(['sagte er kommt']);

  await page.evaluate(() => window.__app._getEditEl().focus());
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => editText(page)).toContain('sagte er kommt');
  await expect(row).not.toHaveClass(/finding--applied/);
  // Noch nicht gespeichert → noch nicht ausgebucht.
  expect(patches.length).toBe(1);
  await page.evaluate(() => window.__app.quickSave());
  await expect.poll(() => patches.length).toBe(2);
  expect(patches[1].applied_errors_json).toEqual([]);
  expect(patches[1].selected_errors_json).toEqual([]);
});

// Die gebuchten Listen ändern auch andere Wege («Übernehmen» in der
// Leseansicht, «Korrekturen rückgängig»). Jede Buchung geht vom frischen
// Serverstand aus — ein Session-Cache überschriebe deren Einträge.
test('Buchung liest den Serverstand jedes Mal frisch: fremde Annahmen bleiben', async ({ page }) => {
  await openPage(page);
  let server = { applied_errors_json: [], selected_errors_json: [] };
  const patches = [];
  await page.route('**/history/check/89/details', route => route.fulfill({ json: server }));
  await page.route('**/history/check/89/saved', async (route) => {
    const body = route.request().postDataJSON();
    patches.push(body);
    server = body;
    await route.fulfill({ json: { ok: true } });
  });
  await page.evaluate(({ findings }) => {
    const app = window.__app;
    app.originalHtml = '<p>Ein Fhler und eine Lüke.</p>';
    app.lektoratFindings = findings.map(f => ({ ...f }));
    app.selectedFindings = app.lektoratFindings.map(() => false);
    app.lastCheckId = 89;
    app.checkDone = true;
    app.startEdit();
  }, { findings: FINDINGS.slice(0, 2) });
  const rows = page.locator('.lektorat-split-findings label.finding');
  await expect.poll(() => hlSize(page, 'hard')).toBe(1);
  const applyOne = await page.evaluate(() => window.__app.t('editor.findings.applyOne'));
  await rows.nth(0).getByRole('button', { name: applyOne }).click();
  await expect.poll(() => patches.length).toBe(1);

  // Inzwischen bucht ein anderer Weg eine weitere Annahme am selben Lauf.
  const other = { typ: 'grammatik', original: 'anderswo', korrektur: 'anderswo,' };
  server = { applied_errors_json: [...server.applied_errors_json, other], selected_errors_json: [...server.selected_errors_json, other] };

  await rows.nth(1).getByRole('button', { name: applyOne }).click();
  await expect.poll(() => patches.length).toBe(2);
  expect(patches[1].applied_errors_json.map(e => e.original)).toEqual(['Ein Fhler', 'anderswo', 'eine Lüke']);
});

// Wird die Befundliste neu gesetzt (Verlaufseintrag neu geladen), gelten die
// Übernahmen der Session weiter — sonst liesse sich eine Korrektur, die das
// Original enthält, ein zweites Mal anwenden („sagte er,,").
test('Neu gesetzte Befundliste: Übernahmen der Session bleiben übernommen', async ({ page }) => {
  await openPage(page);
  await page.route('**/history/check/90/details', route => route.fulfill({ json: { applied_errors_json: [], selected_errors_json: [] } }));
  await page.route('**/history/check/90/saved', route => route.fulfill({ json: { ok: true } }));
  await page.evaluate(({ findings }) => {
    const app = window.__app;
    app.originalHtml = '<p>Er sagte er kommt.</p>';
    app.lektoratFindings = findings.map(f => ({ ...f }));
    app.selectedFindings = [false];
    app.lastCheckId = 90;
    app.checkDone = true;
    app.startEdit();
  }, { findings: [FINDINGS[2]] });
  const row = page.locator('.lektorat-split-findings label.finding').first();
  const applyOne = await page.evaluate(() => window.__app.t('editor.findings.applyOne'));
  await expect.poll(() => hlSize(page, 'hard')).toBe(1);
  await row.getByRole('button', { name: applyOne }).click();
  await expect(row).toHaveClass(/finding--applied/);

  // Wie loadHistoryEntry mit einem Verlaufsstand ohne diese Annahme: neue
  // Befund-Objekte, „übernommen" leer, Lauf ab- und wieder angewählt.
  await page.evaluate(() => {
    const app = window.__app;
    app.checkDone = false;
    app.lektoratFindings = [];
    app.appliedOriginals = [];
    app.lastCheckId = null;
  });
  await expect(row).toBeHidden();
  await page.evaluate(({ findings }) => {
    const app = window.__app;
    app.lektoratFindings = findings.map(f => ({ ...f }));
    app.selectedFindings = [true];
    app.appliedOriginals = [];
    app.lastCheckId = 90;
    app.checkDone = true;
  }, { findings: [FINDINGS[2]] });
  await expect(row).toHaveClass(/finding--applied/);
  await expect(row.getByRole('button', { name: applyOne })).toBeHidden();
  expect(await page.evaluate(() => window.__app.selectedFindings[0])).toBe(false);
});

test('Hover hebt nur hervor, Klick auf den Befundtext zeigt die Stelle; Caret ausserhalb löscht die Hervorhebung', async ({ page }) => {
  await openPage(page);
  const filler = Array.from({ length: 80 }, (_, i) => `<p>Absatz ${i} ohne Befund, nur Text zum Scrollen.</p>`).join('');
  await page.evaluate(({ html, findings }) => {
    const app = window.__app;
    app.originalHtml = html;
    app.lektoratFindings = findings.map(f => ({ ...f }));
    app.selectedFindings = [true];
    app.lastCheckId = null;
    app.checkDone = true;
    app.startEdit();
  }, { html: filler + '<p>Ganz unten steht Ein Fhler.</p>', findings: [FINDINGS[0]] });
  await expect.poll(() => hlSize(page, 'hard')).toBe(1);
  const rangeTop = () => page.evaluate(() => {
    const r = [...CSS.highlights.get('lektorat-live-hard')][0];
    return Math.round(r.getBoundingClientRect().top);
  });
  const row = page.locator('.lektorat-split-findings label.finding').first();

  // Maus direkt bewegen: Playwrights hover() scrollte die Zeile selbst in Sicht.
  const orig = row.locator('.finding-original');
  await orig.scrollIntoViewIfNeeded();
  const before = await rangeTop();
  const box = await orig.boundingBox();
  await page.mouse.move(box.x + 4, box.y + 4);
  await expect.poll(() => hlSize(page, 'active')).toBe(1);
  await page.waitForTimeout(400);
  expect(await rangeTop()).toBe(before);

  // Zeiger verlässt den Befund: Hervorhebung erlischt (kein Caret in der Stelle).
  await page.mouse.move(box.x - 40, box.y + box.height + 200);
  await expect.poll(() => hlSize(page, 'active')).toBe(0);
  expect(await page.evaluate(() => window.__app.lektoratLiveActiveIdx)).toBe(-1);
  await page.mouse.move(box.x + 4, box.y + 4);
  await expect.poll(() => hlSize(page, 'active')).toBe(1);

  // Klick auf den Befundtext: Stelle kommt in Sicht, Häkchen bleibt.
  await row.locator('.finding-original').click();
  await expect.poll(async () => {
    const top = await rangeTop();
    return top >= 0 && top < page.viewportSize().height;
  }).toBe(true);
  expect(await page.evaluate(() => window.__app.selectedFindings[0])).toBe(true);

  // Caret in die Stelle → aktiv; Caret in den ersten Absatz → erlischt.
  await page.evaluate(() => {
    const r = [...CSS.highlights.get('lektorat-live-hard')][0];
    window.__app._getEditEl().focus({ preventScroll: true });
    document.getSelection().setBaseAndExtent(r.startContainer, r.startOffset + 1, r.startContainer, r.startOffset + 1);
  });
  await expect.poll(() => page.evaluate(() => window.__app.lektoratLiveActiveIdx)).toBe(0);
  await page.evaluate(() => {
    const first = window.__app._getEditEl().querySelector('p').firstChild;
    document.getSelection().setBaseAndExtent(first, 1, first, 1);
  });
  await expect.poll(() => page.evaluate(() => window.__app.lektoratLiveActiveIdx)).toBe(-1);
  expect(await hlSize(page, 'active')).toBe(0);
});

test('Strg+Z per Anker: Korrektur steht auch anderswo; Übernommenes anspringbar, ohne Zusatz-Tags', async ({ page }) => {
  await openPage(page);
  const finding = { typ: 'grammatik', original: 'das er kommt', korrektur: 'dass er kommt', erklaerung: 'x', abgelehnt: true };
  await page.evaluate(({ html, findings }) => {
    const app = window.__app;
    app.originalHtml = html;
    app.lektoratFindings = findings.map(f => ({ ...f }));
    app.selectedFindings = [false];
    app.lastCheckId = null;
    app.checkDone = true;
    app.startEdit();
  }, { html: '<p>Ich weiss, dass er kommt.</p><p>Sie meint, das er kommt.</p>', findings: [finding] });
  await expect.poll(() => hlSize(page, 'hard')).toBe(1);
  const row = page.locator('.lektorat-split-findings label.finding').first();
  const rejTag = row.locator('> .tag').filter({ hasText: await page.evaluate(() => window.__app.t('editor.findings.rejected')) });
  await expect(rejTag).toBeVisible();

  const applyOne = await page.evaluate(() => window.__app.t('editor.findings.applyOne'));
  await row.getByRole('button', { name: applyOne }).click();
  await expect.poll(() => editText(page)).toContain('meint, dass er kommt');
  await expect(row).toHaveClass(/finding--applied/);
  // Erledigt: Zusatz-Tag weg, nicht markiert, aber per Hover/Klick auffindbar —
  // an der eingesetzten Korrektur, nicht an der gleichlautenden im ersten Absatz.
  await expect(rejTag).toBeHidden();
  expect(await hlSize(page, 'hard')).toBe(0);
  await page.evaluate(() => window.__app.lektoratLiveFocus(0));
  await expect.poll(() => hlSize(page, 'active')).toBe(1);
  const activeText = () => page.evaluate(() => {
    const r = [...CSS.highlights.get('lektorat-live-active')][0];
    return r.startContainer.parentElement.closest('p').textContent;
  });
  expect(await activeText()).toContain('Sie meint');

  // Strg+Z: am Anker steht wieder das Original → Befund offen, obwohl
  // «dass er kommt» im ersten Absatz weiter steht.
  await page.evaluate(() => window.__app._getEditEl().focus());
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => editText(page)).toContain('meint, das er kommt');
  await expect(row).not.toHaveClass(/finding--applied/);
  await expect.poll(() => hlSize(page, 'hard')).toBe(1);
  await expect(rejTag).toBeVisible();
});
