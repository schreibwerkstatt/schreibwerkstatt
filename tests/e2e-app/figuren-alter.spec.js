// Alterstabelle (Reiter „Alter" der Figuren-Karte) gegen die ECHTE App
// (playwright.app.config.js).
//
// Warum diese Schicht und nicht ein Fixture-Harness: Testgegenstand ist die
// ganze Kette — nested Partial (`partial-figuren-alter`), der `sortableTable`-
// Scope, zwei Filter-Comboboxen, deren Options-Expression die karten-lokale
// Liste reaktiv liest, und die aufklappbare Beleg-Zeile (ein `<tbody>` pro Zeile
// aus dem x-for, siehe DESIGN.md „Aufklappbare Tabellenzeile"). Der Smoke oeffnet
// die Figuren-Karte, betritt aber nur den Standard-Reiter — Tabelle und
// Belegzeile bleiben dort ungerendert.
//
// Der Alters-Index selbst kommt aus einem KI-Job und ist in der Testumgebung
// nicht erzeugbar. Darum wird die EINE Leseroute abgefangen (`page.route`) und
// mit einer realistischen Antwort bedient; alles andere (Figuren, Karte, Filter,
// Sortierung, Aufklappen) laeuft echt.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const CARD = '.card--figuren';
const RUN = String(Date.now()).slice(-6);
const A_NAME = `Alter-Anna ${RUN}`;
const B_NAME = `Alter-Bert ${RUN}`;

// Bestand des geteilten Wegwerf-Buchs nach JEDEM Lauf zurueckschreiben — auch
// nach einem Fehlschlag. Sonst sehen spaetere Specs (Kapitel-Dashboard) die
// gesaeten Figuren statt ihrer gemockten.
let restore = null;
test.afterEach(async ({ page }) => {
  if (!restore) return;
  const { bookId, before } = restore;
  restore = null;
  await page.evaluate(async ({ id, before }) => {
    await fetch(`/figures/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figuren: before }),
    });
  }, { id: bookId, before });
});

async function seedFiguren(page, bookId) {
  return page.evaluate(async ({ bookId, aName, bName }) => {
    const cur = await (await fetch(`/figures/${bookId}`)).json();
    const existing = cur?.figuren || [];
    const a = { id: `fig_alter_a_${Date.now()}`, name: aName, typ: 'hauptfigur', geburtstag: '1900', beziehungen: [], kapitel: [], eigenschaften: [] };
    const b = { id: `fig_alter_b_${Date.now()}`, name: bName, typ: 'randfigur', beziehungen: [], kapitel: [], eigenschaften: [] };
    const r = await fetch(`/figures/${bookId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figuren: [...existing, a, b] }),
    });
    if (!r.ok) throw new Error(`PUT /figures fehlgeschlagen: ${r.status}`);
    return { aId: a.id, bId: b.id, before: existing };
  }, { bookId, aName: A_NAME, bName: B_NAME });
}

test('alterstabelle: Reiter rendert, Filter greifen, Belege klappen auf', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const seeded = await seedFiguren(page, bookId);
  restore = { bookId, before: seeded.before };
  // Beleg-Seite: eine echte Seite des Buchs — die Seiten-Referenz löst gegen
  // den Buchbaum auf, eine erfundene ID bliebe unaufgelöst.
  const realPage = await page.evaluate(() => {
    const nav = window.Alpine.store('nav');
    const p = (nav.pages || [])[0];
    const c = (nav.tree || []).find(x => x.type === 'chapter' && String(x.id) === String(p.chapter_id));
    return { id: p.id, name: p.name, chapterId: p.chapter_id, chapter: c && !c.solo ? c.name : null };
  });

  // Leseroute des Alters-Index bedienen: Anna hat eine belegte Spanne MIT
  // Widerspruch, Bert gar keine Zeile (der haeufige Fall „nichts bekannt").
  await page.route('**/figures/*/alter', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        figuren: [{
          fig_id: seeded.aId,
          name: A_NAME,
          alter_von: 12, alter_bis: 19,
          bezugsjahr_von: 1912, bezugsjahr_bis: 1919,
          geburtsjahr: 1900, gerechnet: 25, geburtsjahr_quelle: 'kuratiert',
          quelle: 'text', konfidenz: 0.7,
          widerspruch: [{ typ: 'rechnung', a: 19, b: 25 }],
          begruendung: null,
          scanned_at: '2026-01-02T03:04:05.000Z',
          belege: [
            { art: 'alter', wert: 12, bezugsjahr: 1912, zitat: 'sie war zwölf Jahre alt', page_id: realPage.id, page_name: realPage.name, chapter_id: null, chapter_name: realPage.chapter, unsicher: false, begruendung: null },
            { art: 'alter', wert: 19, bezugsjahr: 1919, zitat: 'die neunzehnjährige Anna', page_id: null, page_name: 'Seite Zwei', chapter_id: null, chapter_name: 'Kapitel Zwei', unsicher: true, begruendung: null },
          ],
        }],
        geburten: { [seeded.aId]: { y: 1900, m: 3, d: null, quelle: 'steckbrief' } },
        scan: { scanned_at: '2026-01-02T03:04:05.000Z', figuren_total: 2, mit_alter: 1, belege_total: 2, embed_used: true, model: 'test' },
      }),
    });
  });

  await page.evaluate(() => window.__app.toggleFiguresCard());
  const card = page.locator(CARD);
  await expect(card).toBeVisible();

  // Reiter wechseln → Tabelle + geladener Index.
  await card.locator('.tabs-btn', { hasText: 'Alter' }).click();
  const table = card.locator('.figur-alter-table');
  await expect(table).toBeVisible();
  await page.waitForFunction(
    () => !!window.Alpine.$data(document.querySelector('.card--figuren')).figurenAlterData?.scan,
    null, { timeout: 15000 },
  );

  // Graph darf auf diesem Reiter nicht mitlaufen (kein vis-Bundle, kein Canvas).
  await expect(card.locator('.figuren-graph-wrap')).toBeHidden();

  const rowA = table.locator('tbody', { hasText: A_NAME }).first();
  const rowB = table.locator('tbody', { hasText: B_NAME }).first();
  await expect(rowA).toBeVisible();
  await expect(rowB).toBeVisible();

  // Spanne als Spanne, nicht als Einzelwert; Widerspruch als „prüfen"-Plakette.
  await expect(rowA.locator('.figur-alter-age')).toHaveText('12–19');
  await expect(rowA.locator('.tag--stale')).toHaveText('prüfen');
  // Bert hat nichts — die Tabelle behauptet dort kein Alter, und ohne Alter auch
  // kein Bezugsjahr (`jahr_im_roman` faellt sonst aufs Buchende zurueck).
  await expect(rowB.locator('.figur-alter-age')).toHaveText('unbekannt');
  // Der gerechnete Wert stammt aus dem Index (Spalte `gerechnet`), nicht aus dem
  // Katalog-Feld `alter_im_roman` — der Server kennt dort auch ein nur im Text
  // gefundenes Geburtsjahr.
  await expect(rowA.locator('td').nth(4)).toHaveText('25');

  // Belege aufklappen: zwei Fundstellen, die zweite als unsicher markiert.
  await expect(rowA.locator('.figur-alter-belege-row')).toBeHidden();
  await rowA.locator('tr.figur-alter-row').click();
  await expect(rowA.locator('.figur-alter-beleg')).toHaveCount(2);
  await expect(rowA.locator('.figur-alter-zitat').first()).toContainText('zwölf Jahre alt');
  // Beleg MIT Seite bekommt eine Seiten-Referenz, der ohne bleibt ohne — beide
  // Zweige (`x-if`: der Beleg ohne Seite rendert keinen Knoten).
  const orte = rowA.locator('.figur-alter-beleg .entity-ref--seite');
  await expect(orte).toHaveCount(1);
  await expect(orte.first()).toBeEnabled();
  await expect(orte.first().locator('.entity-ref__label')).toHaveText(realPage.name);
  // Kapitel-Kontext steht in der Hover-Vorschau, nicht im Tooltip (Referenzen
  // mit Vorschau tragen bewusst kein data-tip).
  await expect(orte.first()).not.toHaveAttribute('data-tip', /.*/);
  if (realPage.chapter) {
    // Erst in den Blick scrollen, dann überfahren: hover() scrollt sonst selbst,
    // und jedes Scrollen schliesst die Vorschau absichtlich (entity-ref-popover.js).
    await orte.first().scrollIntoViewIfNeeded();
    await orte.first().hover();
    const pop = page.locator('.entity-ref-preview');
    await expect(pop.locator('.entity-ref-preview__title')).toHaveText(realPage.name);
    await expect(pop.locator('.entity-ref-preview__meta')).toContainText(realPage.chapter);
    await page.mouse.move(0, 0);
    await expect(pop).toBeHidden();
  }
  await expect(rowA.locator('.figur-alter-beleg').nth(1).locator('.entity-ref')).toHaveCount(0);

  // Filter „nur mit Alter" (dritte Combobox, nach Typ und Kapitel) blendet Bert aus.
  const boxes = card.locator('.figur-alter .filter-bar:not(.figur-alter-stichtag) .combobox-wrap');
  await expect(boxes).toHaveCount(3);

  // Kapitel-Filter (zweite Combobox): Auftritte entstehen nur in der Analyse
  // (figure_appearances), darum bekommt Anna ihr Kapitel im Katalog-Store. Die
  // Optionen sind die Kapitel, in denen Figuren auftreten — per ID, mit Label aus
  // dem Buchbaum —, und die Auswahl laesst nur Figuren dieses Kapitels stehen.
  const chap = await page.evaluate(({ aId, chapterId }) => {
    const store = window.Alpine.store('catalog');
    store.figuren = store.figuren.map(f => f.id === aId
      ? { ...f, kapitel: [{ chapter_id: chapterId, name: 'x', haeufigkeit: 1 }] } : f);
    // Auswertungs-Label mit Kapitelnummer (app-ui.js#_kapitelLabel).
    return window.__app._kapitelLabel(chapterId);
  }, { aId: seeded.aId, chapterId: realPage.chapterId });
  expect(chap).toBeTruthy();
  await expect(boxes.nth(1)).toBeVisible();
  await boxes.nth(1).locator('.combobox-trigger').click();
  const expected = await page.evaluate(() =>
    window.Alpine.$data(document.querySelector('.card--figuren')).figurenKapitelOptionen().map(o => o.label));
  expect(expected).toContain(chap);
  const opts = boxes.nth(1).locator('.combobox-option');
  // «Alle Kapitel» + je ein Kapitel mit Auftritt.
  await expect(opts).toHaveCount(expected.length + 1);
  await opts.filter({ hasText: chap }).first().click();
  await expect(rowB).toBeHidden();
  await expect(rowA).toBeVisible();
  await boxes.nth(1).locator('.combobox-trigger').click();
  await opts.first().click();
  await expect(rowB).toBeVisible();

  await boxes.nth(2).locator('.combobox-trigger').click();
  await boxes.nth(2).locator('.combobox-option').filter({ hasText: 'Nur mit Alter' }).click();
  await expect(rowB).toBeHidden();
  await expect(rowA).toBeVisible();

  // Suche schraenkt weiter ein.
  await card.locator('.figur-alter .filter-search-input').fill(B_NAME);
  await expect(table.locator('tbody', { hasText: A_NAME })).toHaveCount(0);

  // Filter zuruecksetzen, dann Stichtag: Jahr allein → Spanne, mit Monat → exakt;
  // die Spalte erscheint erst mit Jahr und traegt den Stichtag im Kopf.
  await card.locator('.figur-alter .filter-search-input').fill('');
  await boxes.nth(2).locator('.combobox-trigger').click();
  await boxes.nth(2).locator('.combobox-option').first().click();
  await expect(rowB).toBeVisible();
  const stichtag = card.locator('.figur-alter-stichtag');
  const ageCells = (row) => row.locator('tr.figur-alter-row .figur-alter-age');
  await expect(ageCells(rowA)).toHaveCount(1);
  await stichtag.locator('input.form-num').fill('1915');
  await stichtag.locator('input.form-num').blur();
  await expect(ageCells(rowA)).toHaveCount(2);
  await expect(ageCells(rowA).nth(1)).toHaveText('14–15');
  await expect(ageCells(rowB).nth(1)).toHaveText('–');
  await stichtag.locator('.combobox-trigger').click();
  await stichtag.locator('.combobox-option').nth(6).click(); // «Ganzes Jahr» + Jan…Jun
  await expect(ageCells(rowA).nth(1)).toHaveText('15');
  await expect(table.locator('thead th').nth(3)).toContainText('1915');
  // Belegzeile spannt die zusaetzliche Spalte mit.
  await expect(rowA.locator('.figur-alter-belege-row td')).toHaveAttribute('colspan', /^(9|10)$/);

});

// Schulsystem im Buch: Spalte «Schulzeit» (Zeitraeume je Stufe), Klasse am
// Stichtag — auch ausserhalb der Schulzeit mit Wort statt «–» — und der
// «prüfen»-Hinweis, wenn sich die Geburtsjahre der Quellen widersprechen.
test('alterstabelle: Schulzeit, Klasse am Stichtag, Geburtsjahr-Widerspruch', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const seeded = await seedFiguren(page, bookId);
  restore = { bookId, before: seeded.before };

  const geburten = {
    [seeded.aId]: { y: 1985, m: 3, d: null, quelle: 'steckbrief' },
    [seeded.bId]: { y: 1986, m: null, d: null, quelle: 'geburts_ereignis',
      widerspruch: [{ quelle: 'geburts_ereignis', jahr: 1986 }, { quelle: 'alters_index', jahr: 1987 }] },
  };
  await page.route('**/figures/*/alter', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ figuren: [], geburten, scan: null }),
  }));
  await page.route('**/figures/*/schulwege', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      schulsystem: { vorlage: 'ch_so_1990' },
      wege: { [seeded.aId]: { fig_id: seeded.aId, weg: 'bez', einschulung_jahr: null, repetitionen: [], source: 'autor', vorschlag: null, klassenangaben: [] } },
      geburten, handlungsjahr: 2001,
    }),
  }));
  // Berufsweg/Hobbys: eine laufende Lehre ab 2000, ein Hobby 1993–1996, ein
  // offener Vorschlag (zählt nie am Stichtag).
  await page.route('**/figures/*/stationen', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      berufe: { [seeded.aId]: [
        { id: 1, status: 'aktiv', source: 'autor', art: 'ausbildung', taetigkeit: 'Lehre als Köchin', von_jahr: 2000 },
        { id: 2, status: 'vorschlag', source: 'ki', art: 'beruf', taetigkeit: 'Pilotin', von_jahr: 1990 },
      ] },
      hobbys: { [seeded.aId]: [{ id: 3, status: 'aktiv', source: 'autor', hobby: 'Geige', von_jahr: 1993, bis_jahr: 1996 }] },
    }),
  }));

  await page.evaluate(() => window.__app.toggleFiguresCard());
  const card = page.locator(CARD);
  await card.locator('.tabs-btn', { hasText: 'Alter' }).click();
  const table = card.locator('.figur-alter-table');
  await expect(table).toBeVisible();
  const rowA = table.locator('tbody', { hasText: A_NAME }).first();
  const rowB = table.locator('tbody', { hasText: B_NAME }).first();

  // Anna: Maerz 1985, Weg Bez → eingeschult 1991, sicher.
  const zeitA = rowA.locator('.figur-alter-schulzeit-zeile');
  await expect(zeitA).toHaveText(['Primarschule 1991–1997', 'Bezirksschule 1997–2000']);
  // Bert: nur Jahr → Einschulung offen, Zeitraeume als «≈».
  await expect(rowB.locator('.figur-alter-schulzeit-zeile').first()).toContainText('≈');
  // Bert: Geburtsjahre widersprechen sich → «prüfen» mit beiden Quellen im Tooltip.
  const badge = rowB.locator('.tag--stale:visible');
  await expect(badge).toHaveText('prüfen');
  await expect(badge).toHaveAttribute('data-tip', /Zeitstrahl 1986, Alters-Analyse 1987/);
  await expect(rowA.locator('.tag--stale:visible')).toHaveCount(0);

  // Stichtag Juni 1995 → 4. Primar; Juni 2001 → abgeschlossen (Wort, nicht «–»).
  const stichtag = card.locator('.figur-alter-stichtag');
  await stichtag.locator('input.form-num').fill('1995');
  await stichtag.locator('input.form-num').blur();
  await stichtag.locator('.combobox-trigger').click();
  await stichtag.locator('.combobox-option').nth(6).click();
  const head = await table.locator('thead th').allTextContents();
  const klasseIdx = head.indexOf('Klasse');
  expect(klasseIdx).toBeGreaterThan(0);
  const klasseA = rowA.locator('tr.figur-alter-row > td').nth(klasseIdx);
  await expect(klasseA).toHaveText('4. Primar');
  // Tätigkeit am Stichtag (book/figure-stationen.js): 1995 nur das Hobby, der
  // Vorschlag von 1990 nicht; 2001 nur die Lehre.
  const taetIdx = head.indexOf('Tätigkeit');
  expect(taetIdx).toBeGreaterThan(klasseIdx);
  const taetA = rowA.locator('tr.figur-alter-row > td').nth(taetIdx);
  await expect(taetA).toHaveText('Geige');
  await stichtag.locator('input.form-num').fill('2001');
  await stichtag.locator('input.form-num').blur();
  await expect(klasseA).toHaveText('Schule abgeschlossen (2000)');
  await expect(taetA).toHaveText('Lehre als Köchin');
  // Belegzeile spannt alle Spalten: 8 + Schulzeit + Stichtag + Klasse + Tätigkeit.
  expect(head.length).toBe(12);
});
