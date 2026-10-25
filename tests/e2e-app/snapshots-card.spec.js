// Fassungen-Karte gegen die ECHTE App: Vergleich zweier Fassungen und Reader.
//
// Warum hier und nicht nur als Unit-Test: die Diff-Logik (book-snapshot-diff.js)
// ist unit-getestet, aber die Kapitel-Liste, die Summen-Badges und der Fehler-
// Hinweis des Readers haengen am echten Template-Baum. Der Smoke oeffnet die
// Karte nur ohne Fassungen — Vergleich und Reader rendern dort nicht.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('fassungen: umbenanntes Kapitel verschiebt keine Abschnitte; Reader ohne aktuellen Stand zeigt keinen Loesch-Diff', async ({ page, consoleGuard }) => {
  // Der Reader loggt den absichtlich abgebrochenen Fetch des aktuellen Stands.
  consoleGuard.ignore(/\[snapshots:open:current\]/);
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  // Fassung A, dann ein Kapitel umbenennen, dann Fassung B.
  const setup = await page.evaluate(async (id) => {
    const capture = (label) => fetch(`/snapshots/${id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }),
    }).then(r => r.json()).then(j => j.snapshot);
    const a = await capture('E2E-A');
    const full = await fetch(`/snapshots/${id}/${a.id}`).then(r => r.json());
    const chapter = (function find(list) {
      for (const n of list || []) {
        if (n.type !== 'chapter') continue;
        if ((n.children || []).some(c => c.type === 'page')) return n;
        const sub = find(n.children);
        if (sub) return sub;
      }
      return null;
    })(full.snapshot.content.tree);
    await fetch(`/content/chapters/${chapter.srcId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: chapter.name + ' E2E' }),
    });
    const b = await capture('E2E-B');
    return { a: a.id, b: b.id, chapterId: chapter.srcId, chapterName: chapter.name };
  }, bookId);

  try {
    await page.evaluate(async () => { await window.__app.toggleSnapshotsCard?.(); });
    await page.waitForFunction(() => document.querySelector('.card--snapshots')?.checkVisibility?.());

    // Default-Auswahl: neueste (B) gegen zweitneueste (A); gerechnet wird erst
    // auf Anstoss (Combobox-Wechsel) — hier direkt.
    await page.waitForFunction(() => window.Alpine.$data(document.querySelector('.card--snapshots')).compareTo);
    await page.evaluate(() => window.Alpine.$data(document.querySelector('.card--snapshots')).runCompare());
    const summary = page.locator('.snapshots-summary');
    await expect(summary).toBeVisible();
    // Badges mit Zaehler 0 stehen per x-show versteckt im DOM → nur sichtbare zaehlen.
    const chaptersChanged = await page.evaluate(() => window.__app.t('snapshots.summary.chaptersChanged', { n: 1 }));
    await expect(summary.locator('.badge:visible', { hasText: chaptersChanged })).toHaveCount(1);
    const movedWord = await page.evaluate(() => window.__app.t('snapshots.summary.moved', { n: 0 }).replace(/^0\s*/, ''));
    await expect(summary.locator('.badge:visible', { hasText: movedWord })).toHaveCount(0);
    const renamedTag = await page.evaluate((old) => window.__app.t('snapshots.renamedTag', { old }), setup.chapterName);
    await expect(page.locator('.snapshots-chapters .snapshots-entry')).toContainText(renamedTag);

    // Reader: aktueller Buchstand nicht ladbar → Hinweis, kein „im aktuellen Buch geloescht".
    await page.route('**/book-editor/*/contents', route => route.abort());
    await page.locator('.snapshots-table tbody tr').first().locator('button').first().click();
    const reader = page.locator('.snapshot-reader');
    await expect(reader.locator('.snapshot-reader__stream')).toBeVisible();
    await expect(reader.locator('.snapshot-reader__current-failed')).toBeVisible();
    await expect(reader.locator('.snapshot-reader__badge--removed:visible')).toHaveCount(0);
    await page.unroute('**/book-editor/*/contents');
    await page.keyboard.press('Escape');
  } finally {
    await page.evaluate(async (s) => {
      await fetch(`/content/chapters/${s.chapterId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: s.chapterName }),
      });
      for (const sid of [s.a, s.b]) await fetch(`/snapshots/${location.hash.split('/')[1]}/${sid}`, { method: 'DELETE' });
    }, setup);
  }
});
