// Sprünge aus dem REFERENZ-SLOT (Begleitpanel neben dem Notebook-Editor) gegen
// die ECHTE App.
//
// WARUM DIESE SCHICHT: der Slot ist kein Eintrag in `EXCLUSIVE_CARDS` — der
// registry-getriebene Smoke öffnet ihn nie. Geprüft wird die Kette Katalog →
// Slot-Zeile → Entitäts-Referenz-Registry → Katalog-Karte mit aufgeklappter
// Zeile, die kein Unit-Test abbildet.
//
// Geprüfte Invarianten:
//   1. Klick auf eine Figurenzeile öffnet die Figurenkarte mit genau dieser Figur.
//   2. Mit markiertem Text in der Zeile springt der Klick nicht (Kopieren aus
//      der Beschreibung darf den Editor nicht schliessen).
//   3. Nichts davon erzeugt einen unbehandelten Alpine-/Library-Fehler.
//   4. Chips der Kopfzeile (Jahr-`.tag`, Ereignistyp-Badge) sind gleich hoch
//      und vertikal bündig — hängt am echten CSS, darum hier statt im Harness.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const REF = '#reference-card';
const FIG = {
  id: 'refjump_f1', name: 'Referenzsprung Figur', typ: 'nebenfigur',
  beschreibung: 'Beschreibung zum Markieren.', kapitel: [], eigenschaften: [], beziehungen: [],
};

test('Referenz-Slot: Figurenzeile springt in die Figurenkarte', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const before = await page.evaluate(async ({ id, add }) => {
    const existing = (await (await fetch(`/figures/${id}`)).json())?.figuren || [];
    await fetch(`/figures/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figuren: [...existing, add] }),
    });
    return existing;
  }, { id: bookId, add: FIG });

  try {
    await page.evaluate(async (bid) => {
      await window.__app.loadFiguren(bid);
      const p = window.Alpine.store('nav').pages[0];
      await window.__app.selectPage(p);
    }, bookId);
    await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
    await page.evaluate(async () => { await window.__app.toggleReferenceCard(); });
    await page.waitForSelector(REF, { state: 'visible', timeout: 15000 });

    // Buch-Scope: die Testfigur steht sicher in der Liste, egal welcher Abschnitt offen ist.
    await page.locator(`${REF} .card-actions .icon-btn`).first().click();
    await page.locator(`${REF} .tabs-btn`, { hasText: /Figuren|Characters/ }).click();
    const row = page.locator(`${REF} .reference-row`, { hasText: FIG.name });
    await expect(row).toBeVisible({ timeout: 15000 });

    // Invariante 2: Text in der Zeile mit der Maus markiert (Ziehen über die
    // Beschreibung) → der Klick am Ende des Ziehens springt nicht. Der Sprung
    // wäre asynchron — darum kurz warten, bevor «nicht gesprungen» gilt.
    const box = await row.locator('.reference-row-desc').boundingBox();
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    expect(await page.evaluate(() => String(window.getSelection()).trim().length)).toBeGreaterThan(0);
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => window.__app.showFiguresCard)).toBe(false);
    await expect(page.locator(REF)).toBeVisible();
    await page.evaluate(() => window.getSelection().removeAllRanges());

    // Invariante 1: Sprung auf genau diese Figur.
    await row.locator('.reference-row-title').click();
    await page.waitForFunction(() => window.__app.showFiguresCard === true, null, { timeout: 15000 });
    await expect.poll(() => page.evaluate(() => window.Alpine.store('catalogUi').selectedFigurId)).toBe(FIG.id);
    await expect(page.locator(REF)).toBeHidden();
  } finally {
    await page.evaluate(async ({ id, before }) => {
      await fetch(`/figures/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ figuren: before }),
      });
    }, { id: bookId, before });
  }
});

// Geometrie der Kopfzeile: Chips verschiedener Bauart (`.tag` fürs Jahr,
// `.gz-subtyp-badge` für den Ereignistyp) sitzen gleich hoch auf einer
// Mittellinie — in jedem Reiter dasselbe Chip-Mass (editor/reference-slot.css).
test('Referenz-Slot: Jahr-Chip und Ereignistyp-Badge sind vertikal bündig', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => {
    const p = window.Alpine.store('nav').pages[0];
    await window.__app.selectPage(p);
  });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(async () => { await window.__app.toggleReferenceCard(); });
  await page.waitForSelector(REF, { state: 'visible', timeout: 15000 });
  await page.locator(`${REF} .card-actions .icon-btn`).first().click();
  const anchor = await page.evaluate(() => {
    const p = window.__app.currentPage;
    window.Alpine.store('catalog').globalZeitstrahl = [{
      id: 'refgeo_e1', ereignis: 'Bündigkeitstest', datum_year: 1990, subtyp: 'reise',
      bedeutung: 'Bedeutung des Testereignisses.',
      figuren: [], kapitel: ['Testkapitel'], chapter_ids: [p.chapter_id], page_ids: [p.id],
    }];
    return { pageId: p.id };
  });
  await page.locator(`${REF} .tabs-btn`, { hasText: /Ereignisse|Events/ }).click();
  const head = page.locator(`${REF} .reference-row`, { hasText: 'Bündigkeitstest' }).locator('.reference-row-head');
  await expect(head).toBeVisible({ timeout: 15000 });
  const [tag, badge] = await Promise.all([
    head.locator('> .tag').first().boundingBox(),
    head.locator('> .gz-subtyp-badge').boundingBox(),
  ]);
  expect(Math.abs(tag.height - badge.height)).toBeLessThanOrEqual(0.5);
  expect(Math.abs((tag.y + tag.height / 2) - (badge.y + badge.height / 2))).toBeLessThanOrEqual(0.5);

  // Zeilen-Grammatik (cards/reference-rows.js): Kopf → Beschreibung → Verweise
  // → «in Abschnitten» — im Buch-Scope mit jedem verankerten Abschnitt.
  const row = page.locator(`${REF} .reference-row`, { hasText: 'Bündigkeitstest' });
  await expect(row.locator('.reference-row-desc')).toHaveText('Bedeutung des Testereignisses.');
  const refLines = row.locator('.reference-row-refs:visible');
  await expect(refLines).toHaveCount(2);
  await expect(refLines.nth(0).locator('.entity-ref')).toHaveCount(1);
  expect(anchor.pageId).toBeTruthy();
  await expect(refLines.nth(1).locator('.entity-ref')).toHaveCount(1);

  // Jeder Reiter rendert mit dem geteilten Zeilen-Ende ohne Alpine-Fehler
  // (die Fixture schlägt bei unbehandelten Fehlern an).
  const tabs = page.locator(`${REF} .tabs-btn:visible`);
  for (let i = 0; i < await tabs.count(); i++) await tabs.nth(i).click();
});

// Bearbeitungsmodus: (5) eine eben getippte Figur erscheint im Seiten-Scope,
// ohne dass gespeichert wurde (Live-Stand aus dem Editor), und (6) der Sprung
// aus dem Slot speichert die ungespeicherte Bearbeitung vorher — der Server
// kennt den Text, bevor der Editor schliesst.
test('Referenz-Slot im Bearbeitungsmodus: Live-Namenstreffer + Speichern vor dem Sprung', async ({ page }) => {
  const LIVE = { ...FIG, id: 'refjump_live', name: 'Quirinalia', beschreibung: '' };
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const before = await page.evaluate(async ({ id, add }) => {
    const existing = (await (await fetch(`/figures/${id}`)).json())?.figuren || [];
    await fetch(`/figures/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figuren: [...existing, add] }),
    });
    await window.__app.loadFiguren(id);
    return existing;
  }, { id: bookId, add: LIVE });

  const pageId = await page.evaluate(async () => {
    const nav = window.Alpine.store('nav');
    const first = nav.pages[0];
    const r = await fetch('/content/pages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: nav.selectedBookId, chapter_id: first.chapter_id || undefined,
        name: 'Referenz Live', html: '<p>Ein Absatz ohne Namen.</p>' }),
    });
    const created = await r.json();
    nav.pages = [...nav.pages, { ...created, chapterName: first.chapterName }];
    await window.__app.selectPage(nav.pages[nav.pages.length - 1]);
    return created.id;
  });

  try {
    await page.waitForFunction((pid) => window.__app.showEditorCard && window.__app.currentPage?.id === pid,
      pageId, { timeout: 15000 });
    await page.evaluate(() => window.__app.startEdit());
    const edit = page.locator('#editor-card .page-content-view--editing');
    await expect(edit).toBeVisible({ timeout: 15000 });
    await page.evaluate(async () => { await window.__app.toggleReferenceCard(); });
    await page.waitForSelector(REF, { state: 'visible', timeout: 15000 });
    await page.locator(`${REF} .tabs-btn`, { hasText: /Figuren|Characters/ }).click();
    const row = page.locator(`${REF} .reference-row`, { hasText: LIVE.name });
    await expect(row).toHaveCount(0);

    // (5) Tippen, nicht speichern — die Figur erscheint nach der Eingabepause.
    await edit.locator('p').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Quirinalia kommt.');
    await expect(row).toBeVisible({ timeout: 5000 });
    expect(await page.evaluate(() => window.__app.editDirty)).toBe(true);

    // (6) Sprung speichert vorher.
    await row.locator('.reference-row-title').click();
    await page.waitForFunction(() => window.__app.showFiguresCard === true, null, { timeout: 15000 });
    const html = await page.evaluate(async (pid) =>
      (await (await fetch(`/content/pages/${pid}?__fresh=1`, { cache: 'no-store' })).json()).html || '', pageId);
    expect(html).toContain('Quirinalia kommt.');
  } finally {
    await page.evaluate(() => window.__app._teardownEditSession?.());
    await page.evaluate(async ({ id, before, pid }) => {
      await fetch('/content/pages/' + pid, { method: 'DELETE' });
      await fetch(`/figures/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ figuren: before }),
      });
    }, { id: bookId, before, pid: pageId });
  }
});
