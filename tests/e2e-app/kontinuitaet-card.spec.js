// Kontinuitäts-Karte gegen die ECHTE App (siehe playwright.app.config.js).
//
// Das Dev-Seed-Buch hat keine Kontinuitätsbefunde — der Smoke öffnet die Karte,
// aber Befundliste, Filter-Tabs und Detail hängen an `x-for`/`x-show` über einem
// leeren Ergebnis. Hier liefert eine Route-Interception den Check mit den echten
// Kapitel-/Abschnitts-IDs des Seeds; geprüft wird, was nur am gerenderten DOM
// steht: aufgelöster `__i18n:`-Marker der Zusammenfassung, Schwere-Zähler mit
// derselben Normalisierung wie der Filter, abwählbarer aktiver Tab, Status
// «Erledigt», Filter-Reset, Tastatur-Aufklappen, Quellen-Link nur für http(s),
// Kapitelanfang-Kennzeichnung, sichtbarer Triage-Rollback und Lade-Fehler mit Retry.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test.describe.configure({ mode: 'serial' });

const json = (body, status = 200) => (route) => route.fulfill({
  status, contentType: 'application/json', body: JSON.stringify(body),
});

function mockCheck(ch1, ch2) {
  return {
    checked_at: '2026-10-01T10:00:00Z',
    model: 'mock',
    summary: '__i18n:kontinuitaet.faktencheck.summaryFound__',
    issues: [
      { id: 1, typ: 'figur', schwere: 'kritisch', stelle_a: `${ch1.name}: ${ch1.pageNames[0]}`, chapter_ids: [ch1.id],
        beschreibung: 'Augenfarbe wechselt.', quelle: 'javascript:alert(1)', resolved: false, dismissed: false },
      // Ohne Schwere → zählt (und filtert) als «niedrig»; Abschnitt unbekannt → Kapitelanfang.
      { id: 2, typ: 'faktenfehler', stelle_a: `${ch2.name}: Gibt es nicht`, chapter_ids: [ch2.id],
        beschreibung: 'Datum falsch.', quelle: 'https://example.org/beleg', resolved: false, dismissed: false },
      { id: 3, typ: 'ort', schwere: 'mittel', stelle_a: ch1.name, chapter_ids: [ch1.id], resolved: true, dismissed: false },
      { id: 4, typ: 'objekt', schwere: 'niedrig', stelle_a: ch1.name, chapter_ids: [ch1.id], resolved: false, dismissed: true },
    ],
  };
}

async function seedChapters(page) {
  const chapters = await page.evaluate(() =>
    window.Alpine.store('nav').tree
      .filter(i => i.type === 'chapter' && !i.solo && (i.pages || []).length)
      .map(i => ({ id: i.id, name: i.name, pageNames: i.pages.map(p => p.name) })));
  expect(chapters.length, 'Seed-Buch braucht >= 2 Kapitel mit Abschnitten').toBeGreaterThanOrEqual(2);
  return chapters;
}

const tr = (page, key, params) => page.evaluate(([k, p]) => window.__app.t(k, p), [key, params || null]);

async function openCard(page) {
  await page.evaluate(() => window.__app.toggleKontinuitaetCard());
  return page.locator('.card--kontinuitaet');
}

test('Kontinuität: Zusammenfassung, Zähler, Filter, Detail, Quelle', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const [ch1, ch2] = await seedChapters(page);
  await page.route(`**/jobs/kontinuitaet/${bookId}`, json(mockCheck(ch1, ch2)));
  const card = await openCard(page);
  const rows = card.locator('.entity-list .entity-row');
  await expect(rows.first()).toBeVisible({ timeout: 20000 });

  // Marker in der Locale aufgelöst, nie roh.
  await card.locator('.collapsible-toggle', { hasText: await tr(page, 'kontinuitaet.summary') }).click();
  await expect(card.locator('.kontinuitaet-summary')).toHaveText(await tr(page, 'kontinuitaet.faktencheck.summaryFound'));

  // Aktiv = ohne «kein Fehler»: 3 Befunde; der ohne Schwere zählt als niedrig.
  const sevTabs = card.locator('.filter-bar .tabs').first().locator('.tabs-btn');
  await expect(rows).toHaveCount(3);
  await expect(sevTabs.nth(0).locator('.tabs-btn-count')).toHaveText('3');
  await expect(sevTabs.nth(1).locator('.tabs-btn-count')).toHaveText('1');
  await expect(sevTabs.nth(2).locator('.tabs-btn-count')).toHaveText('1');
  await expect(sevTabs.nth(3).locator('.tabs-btn-count')).toHaveText('1');

  // Niedrig-Tab zeigt genau die gezählte Zeile.
  await sevTabs.nth(3).click();
  await expect(sevTabs.nth(3)).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(1);

  // Status «Erledigt» + niedrig → nichts; der aktive Tab zählt 0, bleibt aber abwählbar.
  const statusTabs = card.locator('.filter-bar .tabs').nth(1).locator('.tabs-btn');
  await statusTabs.filter({ hasText: await tr(page, 'kontinuitaet.status.resolved') }).click();
  await expect(rows).toHaveCount(0);
  await expect(sevTabs.nth(3).locator('.tabs-btn-count')).toHaveText('0');
  await expect(sevTabs.nth(3)).toBeEnabled();
  await expect(sevTabs.nth(1)).toBeDisabled();

  // Filter zurücksetzen → wieder alle aktiven.
  await card.locator('.kontinuitaet-nomatch button').click();
  await expect(rows).toHaveCount(3);

  // Tastatur: Enter auf der Zeile klappt auf.
  const first = rows.first();
  await expect(first).toHaveAttribute('aria-expanded', 'false');
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(first).toHaveAttribute('aria-expanded', 'true');
  const detail1 = card.locator('.entity-detail').first();
  await expect(detail1).toBeVisible();
  // javascript:-Quelle wird reiner Text, kein Link.
  await expect(detail1.locator('.kontinuitaet-quelle a')).toHaveCount(0);
  await expect(detail1.locator('.kontinuitaet-quelle')).toContainText('javascript:alert(1)');
  // Aktionsknopf heisst «Als Fehlalarm markieren», das Badge bleibt «Kein Fehler».
  await expect(detail1.locator('.kontinuitaet-resolve-btn').nth(1)).toHaveText(await tr(page, 'kontinuitaet.dismiss'));

  // Befund 2: http(s)-Quelle ist ein Link, Stelle ohne Abschnitt als Kapitelanfang gekennzeichnet.
  const second = rows.nth(1);
  await expect(second.locator('.kontinuitaet-approx').first()).toBeVisible();
  await expect(first.locator('.kontinuitaet-approx').first()).toBeHidden();
  await second.focus();
  await page.keyboard.press('Space');
  await expect(second).toHaveAttribute('aria-expanded', 'true');
  await expect(card.locator('.entity-detail').nth(1).locator('.kontinuitaet-quelle a')).toHaveAttribute('href', 'https://example.org/beleg');

  guard.assertClean('Kontinuitäts-Karte');
});

test('Kontinuität: fehlgeschlagener Triage-Call rollt sichtbar zurück', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const [ch1, ch2] = await seedChapters(page);
  await page.route(`**/jobs/kontinuitaet/${bookId}`, json(mockCheck(ch1, ch2)));
  await page.route('**/jobs/kontinuitaet/issue/*/resolved', json({ error_code: 'INTERNAL' }, 500));
  const card = await openCard(page);
  const first = card.locator('.entity-list .entity-row').first();
  await expect(first).toBeVisible({ timeout: 20000 });
  await first.locator('.severity-tag').click();
  const btn = card.locator('.entity-detail').first().locator('.kontinuitaet-resolve-btn').first();
  const label = await tr(page, 'kontinuitaet.markResolved');
  await expect(btn).toHaveText(label);
  await btn.click();
  await expect(page.locator('.job-toast--err')).toContainText(await tr(page, 'kontinuitaet.error.triageFailed'));
  await expect(btn).toHaveText(label);
});

test('Kontinuität: Lade-Fehler zeigt Retry statt «noch keine Analyse»', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const [ch1, ch2] = await seedChapters(page);
  let fail = true;
  await page.route(`**/jobs/kontinuitaet/${bookId}`, (route) => (fail
    ? json({ error_code: 'INTERNAL' }, 500)(route)
    : json(mockCheck(ch1, ch2))(route)));
  const card = await openCard(page);
  const errText = await tr(page, 'kontinuitaet.error.loadFailed');
  await expect(card.locator('.card-empty-text', { hasText: errText })).toBeVisible({ timeout: 20000 });
  await expect(card.locator('.card-empty-text', { hasText: await tr(page, 'common.noAnalysisYet') })).toBeHidden();
  fail = false;
  await card.locator('.card-empty button', { hasText: await tr(page, 'kontinuitaet.error.retry') }).click();
  await expect(card.locator('.entity-list .entity-row')).toHaveCount(3);
});
