// Kapitel-Dashboard der Karte „Kapitel-Bewertung" gegen die ECHTE App
// (siehe playwright.app.config.js).
//
// Warum eine eigene Spec neben dem Smoke: der Smoke oeffnet die Karte, aber das
// Dev-Seed-Buch hat weder Figuren noch Schauplaetze, Szenen, Heatmap-Befunde
// oder Lektoratszeit — jede dieser Kacheln haengt an einem `x-if` und liefe
// dort nie durch den Template-Baum. Hier werden die Endpunkte per
// Route-Interception befuellt, sodass das ganze Raster wirklich rendert; dazu
// zwei Aussagen, die nur am echten DOM pruefbar sind: dass die Kacheln den
// SCOPE des Kapitels rechnen (nicht das Buch) und dass eine ungepruefte Seite
// KEINE Befund-Plakette bekommt.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test.describe.configure({ mode: 'serial' });

const json = (body) => (route) => route.fulfill({
  status: 200, contentType: 'application/json', body: JSON.stringify(body),
});

// Mocks mit den echten Kapitel-/Seiten-IDs des Seed-Buchs bauen.
function mockPayloads({ c1, c2, pagesC1 }) {
  return {
    heat: {
      mode: 'open',
      chapters: [
        { chapter_id: c1, chapter_name: 'A', pages_total: 2, pages_checked: 1, words: 400, words_checked: 200 },
        { chapter_id: c2, chapter_name: 'B', pages_total: 3, pages_checked: 3, words: 900, words_checked: 900 },
      ],
      matrix: {
        [c1]: { stil: { count: 6 }, grammatik: { count: 2 } },
        [c2]: { stil: { count: 45 } },
      },
      details: {
        [`${c1}:stil`]: [{ page_id: pagesC1[0], page_name: 'x', count: 6, samples: [] }],
        [`${c1}:grammatik`]: [{ page_id: pagesC1[0], page_name: 'x', count: 2, samples: [] }],
        [`${c2}:stil`]: [{ page_id: 999999, page_name: 'y', count: 45, samples: [] }],
      },
      totals: { stil: 51, grammatik: 2 },
    },
    lektoratTime: { per_chapter: [{ chapter_id: c1, seconds: 3720 }, { chapter_id: c2, seconds: 60 }] },
    figuren: { figuren: [
      { id: 'f1', name: 'Gregor Samsa', kurzname: 'Gregor', typ: 'hauptfigur',
        kapitel: [{ chapter_id: c1, name: 'A', haeufigkeit: 12 }, { chapter_id: c2, name: 'B', haeufigkeit: 30 }] },
      { id: 'f2', name: 'Grete Samsa', kurzname: 'Grete',
        kapitel: [{ chapter_id: c1, name: 'A', haeufigkeit: 4 }] },
      // Nur im FREMDEN Kapitel — darf in der Rangliste nicht auftauchen.
      { id: 'f3', name: 'Der Prokurist', kapitel: [{ chapter_id: c2, name: 'B', haeufigkeit: 9 }] },
    ] },
    orte: { orte: [
      { id: 'o1', name: 'Gregors Zimmer', typ: 'raum', kapitel: [{ chapter_id: c1, name: 'A', haeufigkeit: 7 }] },
      { id: 'o2', name: 'Treppenhaus', typ: 'gebaeude', kapitel: [{ chapter_id: c2, name: 'B', haeufigkeit: 3 }] },
    ] },
    szenen: { szenen: [
      { id: 11, chapter_id: c1, titel: 'Das Erwachen', wertung: 'stark', fig_ids: ['f1'] },
      { id: 12, chapter_id: c1, titel: 'Die Tuer', wertung: 'schwach', fig_ids: ['f1', 'f2'] },
      { id: 13, chapter_id: c2, titel: 'Der Apfel', wertung: 'stark', fig_ids: ['f3'] },
    ] },
  };
}

test('Kapitel-Dashboard rendert alle Kacheln und rechnet im Kapitel-Scope', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  const chapters = await page.evaluate(() =>
    window.Alpine.store('nav').tree
      .filter(i => i.type === 'chapter' && !i.solo)
      .map(i => ({ id: i.id, name: i.name, pageIds: (i.pages || []).map(p => p.id) })));
  expect(chapters.length, 'Seed-Buch braucht >= 2 Kapitel').toBeGreaterThanOrEqual(2);
  const [ch1, ch2] = chapters;
  const mock = mockPayloads({ c1: ch1.id, c2: ch2.id, pagesC1: ch1.pageIds });

  await page.route('**/history/fehler-heatmap/**', json(mock.heat));
  await page.route(`**/history/lektorat-time/${bookId}`, json(mock.lektoratTime));
  await page.route(`**/figures/${bookId}`, json(mock.figuren));
  await page.route(`**/figures/scenes/${bookId}`, json(mock.szenen));
  await page.route(`**/locations/${bookId}`, json(mock.orte));
  // Katalog leeren: der Boot hat ihn schon aus dem geteilten Wegwerf-Buch
  // geladen, und ein nicht-leerer Katalog wird vom Dashboard nicht neu geholt —
  // die Mocks oben griffen sonst nie, sobald eine andere Spec dort Figuren laesst.
  await page.evaluate(() => {
    const c = window.Alpine.store('catalog');
    c.figuren = []; c.orte = []; c.szenen = [];
  });

  // Nur die ERSTE Seite des Kapitels gilt als geprueft — die zweite darf keine
  // Plakette bekommen (ungeprueft ist nicht fehlerfrei).
  await page.evaluate((pid) => {
    window.__app.pageLastChecked = { [pid]: { at: new Date().toISOString(), pending: false, by: null } };
  }, ch1.pageIds[0]);

  await page.evaluate((id) => {
    window.__app.kapitelReviewChapterId = String(id);
    return window.__app.toggleKapitelReviewCard();
  }, ch1.id);

  const card = page.locator('.card--kapitel');
  const dash = card.locator('.kapitel-dashboard');
  await expect(dash).toBeVisible({ timeout: 20000 });

  // ── Umfang: Hero + Position + Fusszeile ──────────────────────────────────
  const umfang = dash.locator('.overview-tile--hero');
  await expect(umfang.locator('.overview-hero-value')).not.toBeEmpty();
  await expect(umfang.locator('.overview-tile-median'))
    .toHaveText(new RegExp(`1\\D+${chapters.length}`));
  await expect(umfang.locator('.kapitel-dash-foot .entity-ref--seite')).toBeVisible();

  // ── Lektorat: Abdeckung + Befunde NUR aus diesem Kapitel ─────────────────
  const lektoratLabel = await page.evaluate(() => window.__app.t('kapitelReview.dash.lektorat'));
  const lektorat = dash.locator('.overview-tile', { hasText: lektoratLabel });
  await expect(lektorat.locator('.overview-donut-text')).toHaveText('50%');
  // 6 + 2 aus Kapitel 1; die 45 aus Kapitel 2 gehoeren nicht dazu.
  await expect(lektorat.locator('.kapitel-dash-kv-value').first()).toHaveText('8');
  // Dichte gegen die 200 GEPRUEFTEN Woerter = 40/1k, Buchwert 51/1100 = 46.4.
  await expect(lektorat.locator('.kapitel-dash-worse')).toHaveCount(0);
  await expect(lektorat.locator('.kapitel-dash-better')).toContainText('40');
  await expect(lektorat).toContainText('1 h 2 min');

  // ── Top-Fehlertypen: der haeufigste Typ traegt den vollen Balken ─────────
  const typenLabel = await page.evaluate(() => window.__app.t('kapitelReview.dash.topTypen'));
  const typen = dash.locator('.overview-tile', { hasText: typenLabel });
  await expect(typen.locator('.overview-error-bar-item')).toHaveCount(2);
  await expect(typen.locator('.overview-error-count').first()).toHaveText('6');

  // ── Figuren: nur die des Kapitels, nach Auftritten sortiert ──────────────
  const figLabel = await page.evaluate(() => window.__app.t('kapitelReview.dash.figuren'));
  const figuren = dash.locator('.overview-tile', { hasText: figLabel });
  await expect(figuren.locator('.kapitel-dash-rank-row')).toHaveCount(2);
  await expect(figuren.locator('.kapitel-dash-rank-name').first()).toHaveText('Gregor');
  await expect(figuren.locator('.kapitel-dash-rank-count').first()).toHaveText('12');
  await expect(figuren).not.toContainText('Der Prokurist');

  // ── Schauplaetze + Szenen: ebenfalls kapitel-skopiert ────────────────────
  const orteLabel = await page.evaluate(() => window.__app.t('kapitelReview.dash.orte'));
  const orte = dash.locator('.overview-tile', { hasText: orteLabel });
  await expect(orte.locator('.entity-ref--ort')).toHaveCount(1);
  await expect(orte).toContainText('Gregors Zimmer');

  const szenenLabel = await page.evaluate(() => window.__app.t('kapitelReview.dash.szenen'));
  const szenen = dash.locator('.overview-tile', { hasText: szenenLabel });
  await expect(szenen.locator('.kapitel-dash-scene')).toHaveCount(2);
  await expect(szenen.locator('.overview-fig-count')).toHaveText('2');

  // ── Bewertungs-CTA, solange das Kapitel nie bewertet wurde ───────────────
  await expect(dash.locator('.overview-tile--cta')).toBeVisible();

  // ── Seitenliste: Balken ueberall, Plakette nur auf der gepruepten Seite ──
  const rows = card.locator('.kapitel-pages-list > .kapitel-page-row');
  await expect(rows.locator('.kapitel-page-bar')).toHaveCount(ch1.pageIds.length);
  await expect(rows.locator('.kapitel-page-findings')).toHaveCount(1);
  await expect(rows.locator('.kapitel-page-findings')).toHaveText('8');

  guard.assertClean('Kapitel-Dashboard');
});

test('Kapitel wechseln rechnet das Dashboard neu', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  const chapters = await page.evaluate(() =>
    window.Alpine.store('nav').tree
      .filter(i => i.type === 'chapter' && !i.solo)
      .map(i => ({ id: i.id, pageIds: (i.pages || []).map(p => p.id) })));
  const [ch1, ch2] = chapters;
  const mock = mockPayloads({ c1: ch1.id, c2: ch2.id, pagesC1: ch1.pageIds });

  await page.route('**/history/fehler-heatmap/**', json(mock.heat));
  await page.route(`**/history/lektorat-time/${bookId}`, json(mock.lektoratTime));
  await page.route(`**/figures/${bookId}`, json(mock.figuren));
  await page.route(`**/figures/scenes/${bookId}`, json(mock.szenen));
  await page.route(`**/locations/${bookId}`, json(mock.orte));
  // Katalog leeren: der Boot hat ihn schon aus dem geteilten Wegwerf-Buch
  // geladen, und ein nicht-leerer Katalog wird vom Dashboard nicht neu geholt —
  // die Mocks oben griffen sonst nie, sobald eine andere Spec dort Figuren laesst.
  await page.evaluate(() => {
    const c = window.Alpine.store('catalog');
    c.figuren = []; c.orte = []; c.szenen = [];
  });

  await page.evaluate((id) => {
    window.__app.kapitelReviewChapterId = String(id);
    return window.__app.toggleKapitelReviewCard();
  }, ch1.id);

  const dash = page.locator('.card--kapitel .kapitel-dashboard');
  await expect(dash).toBeVisible({ timeout: 20000 });
  const lektoratLabel = await page.evaluate(() => window.__app.t('kapitelReview.dash.lektorat'));
  await expect(dash.locator('.overview-tile', { hasText: lektoratLabel })
    .locator('.overview-donut-text')).toHaveText('50%');

  // Kapitel 2 ist vollstaendig geprueft — die Kachel muss sich mitbewegen,
  // sonst haengt das Dashboard am Memo des vorigen Kapitels fest.
  await page.evaluate((id) => { window.__app.kapitelReviewChapterId = String(id); }, ch2.id);
  await expect(dash.locator('.overview-tile', { hasText: lektoratLabel })
    .locator('.overview-donut-text')).toHaveText('100%');
  const figLabel = await page.evaluate(() => window.__app.t('kapitelReview.dash.figuren'));
  await expect(dash.locator('.overview-tile', { hasText: figLabel })).toContainText('Der Prokurist');

  guard.assertClean('Kapitel-Dashboard: Kapitelwechsel');
});

// Kachel „Fortschritt": Bearbeitungsstand der Abschnitte aus $store.badges.
// Die Eingaben werden gesetzt, nicht aus dem Seed gelesen — sonst haengt die
// Erwartung am Zufallsstand des geteilten Wegwerf-Buchs.
test('Fortschritt zeigt den Bearbeitungsstand und was liegen bleibt', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  await page.route('**/history/fehler-heatmap/**', json({ chapters: [], matrix: {}, details: {} }));
  await page.route(`**/history/lektorat-time/${bookId}`, json({ per_chapter: [] }));

  const ch = await page.evaluate(() => {
    const c = window.Alpine.store('nav').tree
      .find(i => i.type === 'chapter' && !i.solo && (i.pages || []).length >= 2);
    return c ? { id: c.id, pageIds: c.pages.map(p => p.id) } : null;
  });
  expect(ch, 'Seed-Buch braucht ein Kapitel mit >= 2 Abschnitten').not.toBeNull();
  const [p1, p2] = ch.pageIds;

  // p1: final, seit 60 Tagen unberuehrt — darf NICHT als liegen geblieben gelten.
  // p2: redigiert, seither geaendert, seit 60 Tagen unberuehrt.
  // Uebrige Abschnitte: ohne Stufe, frisch.
  await page.evaluate(({ id, p1, p2 }) => {
    const day = 86400000;
    const pages = window.Alpine.store('nav').tree.find(i => String(i.id) === String(id)).pages;
    for (const p of pages) p.updated_at = new Date(Date.now() - day).toISOString();
    for (const pid of [p1, p2]) pages.find(p => p.id === pid).updated_at = new Date(Date.now() - 60 * day).toISOString();
    const badges = window.Alpine.store('badges');
    badges.editStatusChain = ['rohfassung', 'ueberarbeitet', 'redigiert', 'final'];
    badges.editStatus = {
      [String(p1)]: { status: 'final' },
      [String(p2)]: { status: 'redigiert', stale: true },
    };
    window.__app.kapitelReviewChapterId = String(id);
    return window.__app.toggleKapitelReviewCard();
  }, { id: ch.id, p1, p2 });

  const tile = page.locator('.card--kapitel .kapitel-dash-progress');
  await expect(tile).toBeVisible({ timeout: 20000 });
  const n = ch.pageIds.length;
  await expect(tile.locator('.overview-tile-median')).toHaveText(new RegExp(`1\\D+${n}`));
  await expect(tile.locator('.overview-stacked-seg--status3')).toBeVisible();
  await expect(tile.locator('.overview-stacked-seg--status2')).toBeVisible();
  await expect(tile.locator('.overview-stacked-seg--status0')).toHaveCount(0);
  await expect(tile.locator('.overview-stacked-seg--ohne')).toHaveCount(n > 2 ? 1 : 0);
  // Ein echtes Segment hat Breite — ein Flex-Wert, der nicht greift, liesse es auf 0.
  const w = await tile.locator('.overview-stacked-seg--status3').evaluate(el => el.getBoundingClientRect().width);
  expect(w).toBeGreaterThan(0);
  await expect(tile.locator('.kapitel-dash-progress-stale')).toBeVisible();

  const idle = tile.locator('.kapitel-dash-progress-idle-row');
  await expect(idle).toHaveCount(1);
  await expect(idle.locator('.entity-ref--seite')).toBeVisible();
  await expect(idle.locator('.kapitel-dash-progress-idle-days')).toContainText('60');

  guard.assertClean('Kapitel-Dashboard: Fortschritt');
});
