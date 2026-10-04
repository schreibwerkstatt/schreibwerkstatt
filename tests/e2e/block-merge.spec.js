const { test, expect } = require('./_helpers/fixtures');

// Block-Level-Merge (Notebook + Focus). Same-User-Multi-Device-Konflikt:
// nicht-kollidierende Block-Edits mergen still, echter Block-Overlap öffnet das
// Auflösungs-Banner. Harness importiert die echte Merge-Engine (block-merge.js)
// + das echte Konflikt-Modal-Markup (Kopie aus partials/conflict-resolution.html)
// unter echtem Alpine. Voller Dual-Tab-Save-Roundtrip braucht Express
// und ist hier out-of-scope — Engine + Auflösungs-UX sind abgedeckt.
const HARNESS = '/tests/fixtures/block-merge-harness.html';

// Drei <p> mit stabilen data-bid (wie ensureBlockIds sie vergibt).
const BASE = '<p data-bid="aaaaaaaa">Absatz eins.</p><p data-bid="bbbbbbbb">Absatz zwei.</p><p data-bid="cccccccc">Absatz drei.</p>';

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.harnessReady === true);
});

test('Verschiedene Blöcke geändert → stiller Auto-Merge, kein Konflikt', async ({ page }) => {
  // Tab A ändert Block 1, Tab B (remote) ändert Block 2 — disjunkt.
  const local  = '<p data-bid="aaaaaaaa">Absatz eins — von mir geändert.</p><p data-bid="bbbbbbbb">Absatz zwei.</p><p data-bid="cccccccc">Absatz drei.</p>';
  const remote = '<p data-bid="aaaaaaaa">Absatz eins.</p><p data-bid="bbbbbbbb">Absatz zwei — vom anderen Gerät.</p><p data-bid="cccccccc">Absatz drei.</p>';

  const res = await page.evaluate(({ base, local, remote }) => {
    const { merged, conflicts } = window.mergeBlocks(base, local, remote);
    return { conflicts: conflicts.length, html: window.mergedToHtml(merged) };
  }, { base: BASE, local, remote });

  expect(res.conflicts).toBe(0);
  // Beide Edits im gemergten Resultat enthalten.
  expect(res.html).toContain('von mir geändert');
  expect(res.html).toContain('vom anderen Gerät');
});

test('Beide ändern denselben Block → Banner mit Block-by-Block-Auflösung', async ({ page }) => {
  const local  = '<p data-bid="aaaaaaaa">Absatz eins — meine Fassung.</p><p data-bid="bbbbbbbb">Absatz zwei.</p><p data-bid="cccccccc">Absatz drei.</p>';
  const remote = '<p data-bid="aaaaaaaa">Absatz eins — fremde Fassung.</p><p data-bid="bbbbbbbb">Absatz zwei.</p><p data-bid="cccccccc">Absatz drei.</p>';

  // Merge berechnen + Konflikt-Banner öffnen (wie _attemptBlockMerge → _openConflictResolution).
  const nConflicts = await page.evaluate(({ base, local, remote }) => {
    const { merged, conflicts } = window.mergeBlocks(base, local, remote);
    window.Alpine.$data(document.querySelector('#app')).openConflict(merged, conflicts);
    return conflicts.length;
  }, { base: BASE, local, remote });
  expect(nConflicts).toBe(1);

  // Banner sichtbar, genau ein Konflikt-Block, beide Previews da.
  await expect(page.locator('.conflict-overlay')).toBeVisible();
  await expect(page.locator('.conflict-block')).toHaveCount(1);
  await expect(page.locator('.preview-local')).toContainText('meine Fassung');
  await expect(page.locator('.preview-remote')).toContainText('fremde Fassung');

  // Default-Auswahl = lokal (least surprise).
  await expect(page.locator('.choice-local')).toHaveClass(/is-active/);

  // Auf „Andere Version" wechseln → Auswahl flippt.
  await page.locator('.choice-remote').click();
  await expect(page.locator('.choice-remote')).toHaveClass(/is-active/);
  await expect(page.locator('.choice-local')).not.toHaveClass(/is-active/);

  // Übernehmen → finales HTML enthält die fremde Fassung, nicht die lokale.
  await page.locator('[data-testid="apply"]').click();
  await expect(page.locator('.conflict-overlay')).not.toBeVisible();
  const resolved = await page.evaluate(() => window.Alpine.$data(document.querySelector('#app')).lastResolved);
  expect(resolved).toContain('fremde Fassung');
  expect(resolved).not.toContain('meine Fassung');
});

test('Bulk „Alle anderen" setzt alle Konflikte auf remote', async ({ page }) => {
  // Zwei kollidierende Blöcke.
  const local  = '<p data-bid="aaaaaaaa">eins lokal</p><p data-bid="bbbbbbbb">zwei lokal</p>';
  const remote = '<p data-bid="aaaaaaaa">eins remote</p><p data-bid="bbbbbbbb">zwei remote</p>';

  const n = await page.evaluate(({ local, remote }) => {
    const base = '<p data-bid="aaaaaaaa">eins</p><p data-bid="bbbbbbbb">zwei</p>';
    const { merged, conflicts } = window.mergeBlocks(base, local, remote);
    window.Alpine.$data(document.querySelector('#app')).openConflict(merged, conflicts);
    return conflicts.length;
  }, { local, remote });
  expect(n).toBe(2);

  await page.locator('[data-testid="bulk-remote"]').click();
  await expect(page.locator('.choice-remote.is-active')).toHaveCount(2);

  await page.locator('[data-testid="apply"]').click();
  const out = await page.evaluate(() => window.Alpine.$data(document.querySelector('#app')));
  expect(out.lastResolved).toContain('eins remote');
  expect(out.lastResolved).toContain('zwei remote');
  expect(out.lastMix).toEqual({ local: 0, remote: 2, both: 0 });
});
