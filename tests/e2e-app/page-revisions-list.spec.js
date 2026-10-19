// Revisionsliste gegen die ECHTE App: zwei echte Saves (Text, dann nur
// Formatierung) erzeugen zwei Revisionen, die Liste buendelt sie zu einer
// Sitzung, der Viewer vergleicht in beide Richtungen, Anheften + Name landen
// im Abschnitt «Angeheftet», und Wiederherstellen ist im Edit-Modus gesperrt.
//
// WARUM DIESE SCHICHT: Liste, Zeile und Viewer sind String-Includes in einem
// Template mit verschachteltem collapsible/combobox-Scope — verschluckte
// Alpine-Expression-Fehler und falsch aufgeloeste Scope-Variablen sieht nur
// die gebootete App.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

// Eigener, frischer Abschnitt: die Seed-Abschnitte haben frühere Specs derselben
// Shard-Sitzung schon gespeichert, deren Saves fielen sonst in dieselbe Sitzung.
async function openFreshPage(page) {
  await bootApp(page);
  await selectSeededBook(page);
  const pid = await page.evaluate(async () => {
    const nav = window.Alpine.store('nav');
    const first = nav.pages[0];
    const r = await fetch('/content/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: nav.selectedBookId, chapter_id: first.chapter_id || undefined, name: 'E2E Revisionsliste', html: '<p>Ausgangstext.</p>' }),
    });
    if (!r.ok) throw new Error('createPage ' + r.status);
    const created = await r.json();
    nav.pages = [...nav.pages, { ...created, chapterName: first.chapterName }];
    await window.__app.selectPage(nav.pages[nav.pages.length - 1]);
    return created.id;
  });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.waitForSelector('.page-revisions-bar', { state: 'attached', timeout: 15000 });
  return pid;
}

// Zwei Saves ueber den echten Repo-Pfad: erst Text, dann nur Fett.
async function twoSaves(page, pid) {
  await page.evaluate(async (id) => {
    const { contentRepo } = await import('/js/repo/content.js');
    const cur = await contentRepo.loadPage(id, { fresh: true });
    const html1 = `${cur.html}<p>Revisionstest Absatz.</p>`;
    const s1 = await contentRepo.savePage(id, { html: html1, expected_updated_at: cur.updated_at });
    const html2 = html1.replace('Revisionstest Absatz.', 'Revisionstest <strong>Absatz</strong>.');
    await contentRepo.savePage(id, { html: html2, expected_updated_at: s1.updated_at });
    await window.__app._refetchCurrentPage();
  }, pid);
}

const t = (page, key, params) => page.evaluate(([k, p]) => window.__app.t(k, p), [key, params]);

test('Revisionsliste: Sitzung, Vergleich, Anheften, Sperre im Edit-Modus', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && /Alpine|Expression/i.test(m.text())) errors.push(m.text()); });

  const pid = await openFreshPage(page);
  try {
    await twoSaves(page, pid);
    await expect.poll(async () => (await page.evaluate(() =>
      window.Alpine.$data(document.querySelector('.page-revisions-bar')).revisions.length))).toBeGreaterThanOrEqual(2);

    await page.locator('.page-revisions-bar .collapsible-toggle').first().click();

    // Beide Saves derselben Sitzung → eine Kopfzeile mit Zaehl-Toggle.
    const groupToggle = page.locator('.page-revisions-group-toggle').first();
    await expect(groupToggle).toBeVisible();
    await expect(groupToggle).toContainText(await t(page, 'editor.revisions.group.count', { n: 2 }));
    const rows = page.locator('.page-revisions-day > .history-item--clickable');
    const before = await rows.count();
    await groupToggle.click();
    await expect(rows).toHaveCount(before + 1);
    await expect(page.locator('.page-revisions-row--child')).toHaveCount(1);

    // Viewer auf der juengsten Version: nur Formatierung geaendert.
    await rows.first().click();
    const dlg = page.locator('dialog.revision-viewer');
    await expect(dlg).toBeVisible();
    await dlg.locator('.revision-viewer__tabs .revision-viewer__tab').nth(1).click();
    await expect(dlg.locator('.revision-viewer__hint').filter({ hasText: await t(page, 'editor.revisions.viewer.noChanges') })).toBeVisible();
    await dlg.locator('.revision-viewer__compare .tabs-btn').nth(1).click();
    await expect(dlg.locator('.revision-viewer__hint').filter({ hasText: await t(page, 'editor.revisions.viewer.noChangesCurrent') })).toBeVisible();

    // Vorgaengerin im Vergleich: Text-Save davor → echter Unterschied.
    await dlg.locator('.revision-viewer__nav .revision-viewer__btn').first().click();
    await dlg.locator('.revision-viewer__compare .tabs-btn').first().click();
    await expect(dlg.locator('.revision-diff-body .diff-add').first()).toBeVisible();

    // Anheften + Name.
    await dlg.locator('.revision-viewer__pin .revision-viewer__btn').click();
    const label = dlg.locator('.revision-viewer__label');
    await expect(label).toBeVisible();
    await label.fill('Meilenstein E2E');
    await label.press('Enter');
    const pinnedHead = page.locator('.page-revisions-section__head');
    await expect(pinnedHead).toBeVisible();
    await expect(page.locator('.page-revisions-section .page-revisions-label')).toHaveText('Meilenstein E2E');
    await expect(dlg.locator('.revision-viewer__title')).toContainText('Meilenstein E2E');
    await dlg.locator('.revision-viewer__close').click();
    await expect(dlg).toBeHidden();

    // Edit-Modus sperrt Wiederherstellen (Puffer kennt den Restore nicht).
    await page.evaluate(() => { window.__app.editMode = true; });
    const restoreBtn = page.locator('.page-revisions-day > .history-item--clickable').first().locator('.btn-toggle-saved').first();
    await expect(restoreBtn).toBeDisabled();
    await page.evaluate(() => { window.__app.editMode = false; });
    await expect(restoreBtn).toBeEnabled();

    // Aufraeumen: Anheften loesen, damit Folge-Specs auf derselben DB nichts erben.
    await page.evaluate(async (id) => {
      const c = window.Alpine.$data(document.querySelector('.page-revisions-bar'));
      for (const r of c.pinnedRevs) await c.setPinned(r, false);
    }, pid);
    await expect(pinnedHead).toHaveCount(0);

    expect(errors).toEqual([]);
  } finally {
    await page.evaluate(async (id) => { await fetch('/content/pages/' + id, { method: 'DELETE' }); }, pid);
  }
});
