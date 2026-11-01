// Abschnitts-Lektorat als Ablauf über Lese- und Edit-Modus (docs/lektorat.md,
// Notebook-Editor), gegen die ECHTE App: Seite laden/speichern läuft gegen den
// echten Server, nur der Lektorat-Lauf (page_checks) ist ein In-Memory-Stub —
// `/history/check/:id/details` liefert, was der letzte PATCH geschrieben hat,
// so wie der Server die Listen ersetzt (lektorat-booking.js).
//
// Ergänzt lektorat-live-edit.spec.js (Einzelmechanik im Edit-Modus) um die
// Wege, die quer laufen:
// - Leseansicht: eigener Vorschlag, Zurück auf KI, abwählen, «Angehakte
//   übernehmen» (Liste bleibt stehen), «Korrekturen rückgängig» (öffnet die
//   Befunde wieder, frühere Buchungen bleiben)
// - Rückgängig nach Fremd-Write: 409, nichts überschrieben
// - Leseansicht → Edit → Leseansicht: Auswahl wandert mit, Übernommenes bleibt
//   gesperrt, der Rest geht über «Angehakte übernehmen», Buchungen vereinigt
// - Leseansicht: «Übernehmen» je Befund, mehrdeutige Stelle wird übersprungen
// - Edit: Übernehmen → Strg+Z → «Abbrechen» stellt „übernommen" wieder her
// - Edit: umgeschrieben → zurückgeschrieben ist wieder offen
// - Edit: Redo nach Strg+Z stellt „übernommen" wieder her
// - Edit: eigener Vorschlag übernehmen, gebucht mit eigener Korrektur;
//   geleerter Vorschlag ist nicht übernehmbar
//
// Eigene Wegwerf-Seite statt der Seed-Seiten: andere Specs zählen den Seed.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const HTML = '<p>Ein Fhler und eine Lüke. Er sagte er kommt.</p>';
const F_FEHLER = { typ: 'rechtschreibung', original: 'Ein Fhler', korrektur: 'Ein Fehler', erklaerung: 'x' };
const F_LUEKE = { typ: 'wiederholung', original: 'eine Lüke', korrektur: 'eine Lücke', erklaerung: 'x' };
const F_KOMMA = { typ: 'grammatik', original: 'sagte er kommt', korrektur: 'sagte, er kommt', erklaerung: 'x' };
const VIEW_SEL = '#editor-card .page-content-view:not(.page-content-view--editing)';

let pageId = null;

test.afterEach(async ({ page }) => {
  if (pageId == null) return;
  const id = pageId;
  pageId = null;
  await page.evaluate(async (pid) => { await fetch('/content/pages/' + pid, { method: 'DELETE' }); }, id).catch(() => {});
});

async function openFreshPage(page, html = HTML) {
  await bootApp(page);
  await selectSeededBook(page);
  pageId = await page.evaluate(async (h) => {
    const nav = window.Alpine.store('nav');
    const first = nav.pages[0];
    const r = await fetch('/content/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: nav.selectedBookId, chapter_id: first.chapter_id || undefined, name: 'E2E Lektorat-Ablauf', html: h }),
    });
    if (!r.ok) throw new Error('createPage ' + r.status);
    const created = await r.json();
    const p = { ...created, chapterName: first.chapterName };
    nav.pages = [...nav.pages, p];
    await window.__app.selectPage(p);
    return created.id;
  }, html);
  await expect.poll(() => page.evaluate(() => window.__app.originalHtml || '')).toContain('Fhler');
}

// Lektorat-Lauf `checkId` als In-Memory-Stub. `initial`: schon gebuchte Listen.
async function mockRun(page, checkId, initial = {}) {
  const run = {
    server: { applied_errors_json: [], selected_errors_json: [], saved: false, ...initial },
    patches: [],
  };
  await page.route(`**/history/check/${checkId}/details`, route => route.fulfill({ json: run.server }));
  await page.route(`**/history/check/${checkId}/saved`, async (route) => {
    const body = route.request().postDataJSON();
    run.patches.push(body);
    run.server = { ...run.server, ...body };
    await route.fulfill({ json: { ok: true } });
  });
  return run;
}

// Befundliste setzen wie nach einem Lauf; die Seite selbst bleibt der Serverstand.
async function showFindings(page, findings, checkId, { selected } = {}) {
  await page.evaluate(({ findings, checkId, selected }) => {
    const app = window.__app;
    app.lektoratFindings = findings.map(f => ({ ...f }));
    app.selectedFindings = selected ? [...selected] : app.lektoratFindings.map(f => app.findingPreselected(f));
    app.appliedOriginals = [];
    app.lastCheckId = checkId;
    app.checkDone = true;
    app._recomputeCorrectedHtml();
  }, { findings, checkId, selected });
}

const t = (page, key, params) => page.evaluate(([k, p]) => window.__app.t(k, p), [key, params]);
const rows = (page) => page.locator('.lektorat-split-findings label.finding');
const editText = (page) => page.evaluate(() => window.__app._getEditEl().textContent);
const serverHtml = (page) => page.evaluate(async (pid) => {
  const r = await fetch('/content/pages/' + pid, { cache: 'no-store' });
  return (await r.json()).html || '';
}, pageId);
const originals = (list) => (list || []).map(e => e.original);
// «Angehakte übernehmen» steht im Befundkopf und in der Abschnittsleiste.
const applySelIn = async (page, where, n) => page.locator(where === 'bar' ? '.card-actions' : '.finding-header')
  .getByRole('button', { name: await t(page, 'editor.findings.applySelected', { n }) });

async function clickPencil(page) {
  await page.locator('.card-actions button[aria-label]').filter({ has: page.locator('use[href="/icons.svg#pencil"]') }).click();
  await expect.poll(() => page.evaluate(() => window.__app.editMode)).toBe(true);
}

async function editKorrektur(page, row, value) {
  await row.getByRole('button', { name: await t(page, 'editor.findings.editKorrektur') }).click();
  const input = row.locator('.finding-korrektur-input');
  await expect(input).toBeFocused();
  await input.fill(value);
  await input.press('Enter');
  await expect(input).toBeHidden();
}

test('Leseansicht: eigener Vorschlag, abwählen, übernehmen, rückgängig — frühere Buchung bleibt', async ({ page }) => {
  await openFreshPage(page);
  const früher = { typ: 'grammatik', original: 'früher', korrektur: 'früher,' };
  const run = await mockRun(page, 9101, { applied_errors_json: [früher], selected_errors_json: [früher], saved: true });
  await showFindings(page, [F_FEHLER, F_LUEKE, F_KOMMA], 9101);
  const r = rows(page);
  await expect(r).toHaveCount(3);
  // Weich ist nicht vorausgewählt, hart schon.
  expect(await page.evaluate(() => [...window.__app.selectedFindings])).toEqual([true, false, true]);

  // Eigener Vorschlag am weichen Befund: wählt ihn an, Vorschau folgt.
  await editKorrektur(page, r.nth(1), 'ein Loch');
  await expect(r.nth(1).locator('.tag').filter({ hasText: await t(page, 'editor.findings.yourSuggestion') })).toBeVisible();
  expect(await page.evaluate(() => window.__app.selectedFindings[1])).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__app.correctedHtml || '')).toContain('ein Loch');

  // Zurück auf den KI-Vorschlag, dann doch wieder eigener.
  await r.nth(1).getByRole('button', { name: await t(page, 'editor.findings.resetToAi') }).click();
  await expect.poll(() => page.evaluate(() => window.__app.correctedHtml || '')).toContain('eine Lücke');
  await expect(r.nth(1).locator('.tag').filter({ hasText: await t(page, 'editor.findings.yourSuggestion') })).toBeHidden();
  await editKorrektur(page, r.nth(1), 'ein Loch');

  // Harten Befund abwählen: bleibt in Vorschau und Text stehen.
  await r.nth(2).locator('.finding-checkbox').uncheck();
  await expect.poll(() => page.evaluate(() => window.__app.correctedHtml || '')).toContain('sagte er kommt');

  await (await applySelIn(page, 'bar', 2)).click();
  // Liste bleibt stehen: Übernommenes gesperrt, Abgewähltes offen.
  await expect(r.nth(0)).toHaveClass(/finding--applied/);
  await expect(r.nth(1)).toHaveClass(/finding--applied/);
  await expect(r.nth(2)).not.toHaveClass(/finding--applied/);
  expect(await page.evaluate(() => window.__app.checkDone)).toBe(true);
  const saved = await serverHtml(page);
  expect(saved).toContain('Ein Fehler');
  expect(saved).toContain('ein Loch');
  expect(saved).toContain('sagte er kommt');
  await expect(page.locator(VIEW_SEL)).toContainText('ein Loch');

  // Gebucht: frühere Annahme + die zwei neuen, mit dem eigenen Vorschlag.
  expect(run.patches).toHaveLength(1);
  expect(originals(run.server.applied_errors_json)).toEqual(['früher', 'Ein Fhler', 'eine Lüke']);
  expect(run.server.applied_errors_json.find(e => e.original === 'eine Lüke').korrektur).toBe('ein Loch');
  expect(originals(run.server.selected_errors_json)).toEqual(['früher', 'Ein Fhler', 'eine Lüke']);

  // Rückgängig: alter Text zurück, nur die zwei neuen Buchungen ausgetragen.
  const undo = page.getByRole('button', { name: await t(page, 'lektorat.undoCorrections') });
  await expect(undo).toBeVisible();
  await undo.click();
  await expect.poll(() => serverHtml(page)).toContain('Ein Fhler');
  expect(await serverHtml(page)).toContain('eine Lüke');
  await expect(undo).toBeHidden();
  await expect(page.locator(VIEW_SEL)).toContainText('eine Lüke');
  // Die stehen gebliebene Liste öffnet die zurückgenommenen Befunde wieder.
  await expect(r.nth(0)).not.toHaveClass(/finding--applied/);
  await expect(r.nth(1)).not.toHaveClass(/finding--applied/);
  await expect.poll(() => run.patches.length).toBe(2);
  expect(originals(run.server.applied_errors_json)).toEqual(['früher']);
  expect(originals(run.server.selected_errors_json)).toEqual(['früher']);
  expect(run.server.saved).toBe(true);
});

test('Rückgängig nach Fremd-Write: 409, nichts überschrieben, Buchung bleibt', async ({ page, consoleGuard }) => {
  // Der 409 ist hier der erwartete Ausgang.
  consoleGuard.ignore(/\[undoLektoratCorrections\].*409|status of 409/);
  await openFreshPage(page);
  const run = await mockRun(page, 9102);
  await showFindings(page, [F_FEHLER], 9102);
  await (await applySelIn(page, 'header', 1)).click();
  await expect(rows(page).nth(0)).toHaveClass(/finding--applied/);
  expect(originals(run.server.applied_errors_json)).toEqual(['Ein Fhler']);

  // Im Edit-Modus kein Rückgängig.
  const undo = page.getByRole('button', { name: await t(page, 'lektorat.undoCorrections') });
  await expect(undo).toBeVisible();
  await page.evaluate(() => window.__app.startEdit());
  await expect(undo).toBeHidden();
  await page.evaluate(() => window.__app.cancelEdit());
  await expect.poll(() => page.evaluate(() => window.__app.editMode)).toBe(false);
  await expect(undo).toBeVisible();

  // Zweitgerät schreibt dazwischen.
  const foreign = '<p>Ein Fehler, vom Zweitgerät geändert.</p>';
  await page.evaluate(async ({ pid, html }) => {
    const r = await fetch('/content/pages/' + pid, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, name: 'E2E Lektorat-Ablauf', source: 'main', expected_updated_at: null }),
    });
    if (!r.ok) throw new Error('foreign PUT ' + r.status);
  }, { pid: pageId, html: foreign });

  await undo.click();
  await expect.poll(() => page.evaluate(() => window.__app.lektoratUndo)).toBeNull();
  await expect(undo).toBeHidden();
  expect(await serverHtml(page)).toContain('vom Zweitgerät geändert');
  expect(run.patches).toHaveLength(1);
  expect(originals(run.server.applied_errors_json)).toEqual(['Ein Fhler']);
});

test('Leseansicht → Edit → Leseansicht: Auswahl wandert mit, Rest per «Angehakte übernehmen», Buchungen vereinigt', async ({ page }) => {
  await openFreshPage(page);
  const run = await mockRun(page, 9103);
  await showFindings(page, [F_FEHLER, F_LUEKE, F_KOMMA], 9103);
  const r = rows(page);
  // In der Leseansicht: harten Komma-Befund abwählen.
  await r.nth(2).locator('.finding-checkbox').uncheck();

  await clickPencil(page);
  await expect(r).toHaveCount(3);
  expect(await page.evaluate(() => [...window.__app.selectedFindings])).toEqual([true, false, false]);
  const applySel = await applySelIn(page, 'header', 1);
  await applySel.click();
  await expect.poll(() => editText(page)).toContain('Ein Fehler');
  await expect(r.nth(0)).toHaveClass(/finding--applied/);
  await expect.poll(() => run.patches.length).toBe(1);
  expect(originals(run.server.applied_errors_json)).toEqual(['Ein Fhler']);
  expect(await serverHtml(page)).toContain('Ein Fehler');

  // Zurück in die Leseansicht (gespeichert, nichts mehr offen).
  await page.evaluate(() => window.__app.saveEdit());
  await expect.poll(() => page.evaluate(() => window.__app.editMode)).toBe(false);
  expect(await page.evaluate(() => window.__app.checkDone)).toBe(true);
  await expect(r.nth(0)).toHaveClass(/finding--applied/);
  await expect(r.nth(0).locator('.finding-checkbox')).toBeDisabled();
  // Vorschau beim Verlassen nachgeholt: Übernommenes steht, Abgewähltes nicht.
  await expect(page.locator(VIEW_SEL)).toContainText('Ein Fehler');
  await expect.poll(() => page.evaluate(() => window.__app.correctedHtml || '')).toContain('sagte er kommt');

  // Übernommenes lässt sich auch per «Alle» nicht erneut anwählen.
  await page.evaluate(() => window.__app.selectAllFindings(true));
  expect(await page.evaluate(() => [...window.__app.selectedFindings])).toEqual([false, true, true]);
  await r.nth(1).locator('.finding-checkbox').uncheck();

  await (await applySelIn(page, 'bar', 1)).click();
  await expect(r.nth(2)).toHaveClass(/finding--applied/);
  const saved = await serverHtml(page);
  expect(saved).toContain('Ein Fehler');
  expect(saved).toContain('sagte, er kommt');
  expect(saved).toContain('eine Lüke');
  expect(saved).not.toMatch(/Ein Ein|,,/);
  expect(run.patches).toHaveLength(2);
  expect(originals(run.server.applied_errors_json)).toEqual(['Ein Fhler', 'sagte er kommt']);
});

test('Leseansicht: «Übernehmen» je Befund, mehrdeutige Stelle wird übersprungen und nicht gezählt', async ({ page }) => {
  await openFreshPage(page, '<p>Ein Fhler und eine Lüke. Da bleibt eine Lüke.</p>');
  const run = await mockRun(page, 9104);
  await showFindings(page, [F_FEHLER, F_LUEKE], 9104, { selected: [true, true] });
  const r = rows(page);
  const applyOne = await t(page, 'editor.findings.applyOne');
  await expect(r.nth(1).locator('.tag').filter({ hasText: await t(page, 'editor.findings.ambiguous') })).toBeVisible();
  await expect(r.nth(1).getByRole('button', { name: applyOne })).toBeHidden();
  // Angehakt, aber nicht mitgezählt.
  await expect(await applySelIn(page, 'header', 1)).toBeEnabled();
  await expect(await applySelIn(page, 'bar', 1)).toBeVisible();

  await r.nth(0).getByRole('button', { name: applyOne }).click();
  await expect(r.nth(0)).toHaveClass(/finding--applied/);
  await expect.poll(() => serverHtml(page)).toContain('Ein Fehler');
  expect(await serverHtml(page)).not.toContain('eine Lücke');
  await expect.poll(() => run.patches.length).toBe(1);
  expect(originals(run.server.applied_errors_json)).toEqual(['Ein Fhler']);

  // Sammel-Übernehmen überspringt die mehrdeutige Stelle ebenso.
  await expect(await applySelIn(page, 'header', 0)).toBeDisabled();
  await expect(await applySelIn(page, 'bar', 0)).toBeHidden();
  expect(await page.evaluate(() => window.__app.selectedFindings[1])).toBe(true);
  await page.evaluate(() => window.__app.saveCorrections([1]));
  expect(await serverHtml(page)).not.toContain('eine Lücke');
  await expect(r.nth(1)).not.toHaveClass(/finding--applied/);
});

test('Edit: Übernehmen → Strg+Z → «Abbrechen» stellt „übernommen" wieder her, nichts ausgebucht', async ({ page }) => {
  await openFreshPage(page);
  const run = await mockRun(page, 9104);
  await showFindings(page, [F_FEHLER, F_KOMMA], 9104, { selected: [false, false] });
  await clickPencil(page);
  const r = rows(page);
  const applyOne = await t(page, 'editor.findings.applyOne');

  await r.nth(0).getByRole('button', { name: applyOne }).click();
  await expect(r.nth(0)).toHaveClass(/finding--applied/);
  await expect.poll(() => run.patches.length).toBe(1);

  await page.evaluate(() => window.__app._getEditEl().focus());
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => editText(page)).toContain('Ein Fhler');
  await expect(r.nth(0)).not.toHaveClass(/finding--applied/);
  expect(await page.evaluate(() => window.__app.editDirty)).toBe(true);

  // Abbrechen verwirft den ungespeicherten Strg+Z-Stand (Rückfrage bestätigen).
  void page.evaluate(() => { window.__app.cancelEdit(); });
  await page.getByRole('button', { name: await t(page, 'edit.discardEdit') }).click();
  await expect.poll(() => page.evaluate(() => window.__app.editMode)).toBe(false);
  await expect(r.nth(0)).toHaveClass(/finding--applied/);
  await expect(r.nth(0).locator('.finding-checkbox')).toBeDisabled();
  expect(await serverHtml(page)).toContain('Ein Fehler');
  // Nicht ausgebucht: der Save mit dem zurückgenommenen Stand kam nie.
  expect(run.patches).toHaveLength(1);
  expect(originals(run.server.applied_errors_json)).toEqual(['Ein Fhler']);
  // Der andere Befund ist unberührt offen.
  await expect(r.nth(1)).not.toHaveClass(/finding--applied|finding--rewritten/);
});

test('Edit: umgeschrieben → zurückgeschrieben ist wieder offen', async ({ page }) => {
  await openFreshPage(page);
  await mockRun(page, 9105);
  await showFindings(page, [F_FEHLER, F_LUEKE], 9105, { selected: [true, false] });
  await clickPencil(page);
  const r = rows(page);
  const setText = (from, to) => page.evaluate(([a, b]) => {
    const walker = document.createTreeWalker(window.__app._getEditEl(), NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) if (n.nodeValue.includes(a)) n.nodeValue = n.nodeValue.replace(a, b);
  }, [from, to]);

  // Selbst umschreiben → „umgeschrieben", abgewählt, gesperrt.
  await setText('Ein Fhler', 'Kein Fehler');
  await expect(r.nth(0)).toHaveClass(/finding--rewritten/);
  await expect(r.nth(0).locator('.finding-checkbox')).toBeDisabled();
  expect(await page.evaluate(() => window.__app.selectedFindings[0])).toBe(false);
  // Zurückschreiben → wieder offen und anwählbar (Häkchen bleibt aus).
  await setText('Kein Fehler', 'Ein Fhler');
  await expect(r.nth(0)).not.toHaveClass(/finding--rewritten/);
  await expect(r.nth(0).locator('.finding-checkbox')).toBeEnabled();
  expect(await page.evaluate(() => window.__app.selectedFindings[0])).toBe(false);
});

// Strg+Z nimmt die Übernahme zurück, Redo setzt die Korrektur am Anker wieder
// ein: wieder „übernommen", nicht „umgeschrieben". Einmal mit gebuchter
// Übernahme (_unbook), einmal mit ungespeicherter (_undone).
test('Edit: Redo nach Strg+Z stellt „übernommen" wieder her', async ({ page }) => {
  await openFreshPage(page);
  const run = await mockRun(page, 9107);
  await showFindings(page, [F_LUEKE], 9107, { selected: [false] });
  await clickPencil(page);
  const r = rows(page);
  const applyOne = await t(page, 'editor.findings.applyOne');
  await r.nth(0).getByRole('button', { name: applyOne }).click();
  await expect(r.nth(0)).toHaveClass(/finding--applied/);
  await expect.poll(() => run.patches.length).toBe(1);
  await page.evaluate(() => window.__app._getEditEl().focus());
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => editText(page)).toContain('eine Lüke');
  await expect(r.nth(0)).not.toHaveClass(/finding--applied/);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => editText(page)).toContain('eine Lücke');
  await expect(r.nth(0)).toHaveClass(/finding--applied/, { timeout: 3000 });
  await expect(r.nth(0)).not.toHaveClass(/finding--rewritten/);

  // Speichern ändert an der Buchung nichts: sie war und ist übernommen.
  await page.evaluate(() => window.__app.quickSave());
  await expect.poll(() => serverHtml(page)).toContain('eine Lücke');
  expect(originals(run.server.applied_errors_json)).toEqual(['eine Lüke']);
});

test('Edit: Redo einer noch ungespeicherten Übernahme stellt „übernommen" wieder her und bucht sie', async ({ page }) => {
  await openFreshPage(page);
  const run = await mockRun(page, 9108);
  await showFindings(page, [F_FEHLER], 9108, { selected: [false] });
  await clickPencil(page);
  const r = rows(page);
  // Der Save der Übernahme hängt, bis Strg+Z durch ist: sie ist noch nicht gebucht.
  let release;
  const held = new Promise(res => { release = res; });
  let holdNext = true;
  await page.route(`**/content/pages/${pageId}`, async (route) => {
    if (route.request().method() !== 'PUT' || !holdNext) return route.continue();
    holdNext = false;
    await held;
    await route.continue();
  });
  await r.nth(0).getByRole('button', { name: await t(page, 'editor.findings.applyOne') }).click();
  await expect(r.nth(0)).toHaveClass(/finding--applied/);
  await page.evaluate(() => window.__app._getEditEl().focus());
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => editText(page)).toContain('Ein Fhler');
  await expect(r.nth(0)).not.toHaveClass(/finding--applied/);
  release();
  // Der Save mit der Korrektur kommt an, nachdem Strg+Z sie zurückgenommen hat: nichts gebucht.
  await expect.poll(() => serverHtml(page)).toContain('Ein Fehler');
  await page.waitForTimeout(300);
  expect(run.patches).toHaveLength(0);

  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => editText(page)).toContain('Ein Fehler');
  await expect(r.nth(0)).toHaveClass(/finding--applied/, { timeout: 3000 });
  await expect(r.nth(0)).not.toHaveClass(/finding--rewritten/);
  await page.evaluate(() => window.__app.quickSave());
  await expect.poll(() => run.patches.length).toBe(1);
  expect(originals(run.server.applied_errors_json)).toEqual(['Ein Fhler']);
});

test('Edit: eigener Vorschlag wird übernommen und so gebucht; geleerter ist nicht übernehmbar', async ({ page }) => {
  await openFreshPage(page);
  const run = await mockRun(page, 9106);
  await showFindings(page, [F_FEHLER, F_KOMMA], 9106, { selected: [false, false] });
  await clickPencil(page);
  const r = rows(page);
  const applyOne = await t(page, 'editor.findings.applyOne');

  // Vorschlag leeren: kein Übernehmen, Checkbox gesperrt.
  await editKorrektur(page, r.nth(0), '');
  await expect(r.nth(0).getByRole('button', { name: applyOne })).toBeHidden();
  await expect(r.nth(0).locator('.finding-checkbox')).toBeDisabled();

  // Eigener Vorschlag: angehakt, übernommen, gebucht mit eigener Korrektur.
  await editKorrektur(page, r.nth(1), 'sagte, dass er kommt');
  expect(await page.evaluate(() => window.__app.selectedFindings[1])).toBe(true);
  await r.nth(1).getByRole('button', { name: applyOne }).click();
  await expect.poll(() => editText(page)).toContain('Er sagte, dass er kommt.');
  await expect(r.nth(1)).toHaveClass(/finding--applied/);
  await expect.poll(() => run.patches.length).toBe(1);
  const entry = run.server.applied_errors_json[0];
  expect(entry.original).toBe('sagte er kommt');
  expect(entry.korrektur).toBe('sagte, dass er kommt');
  expect(await serverHtml(page)).toContain('sagte, dass er kommt');
  expect(await editText(page)).toContain('Ein Fhler');
});
