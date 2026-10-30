// Dialog „Nicht gespeichert" (app/app-offline-rescue.js) in der echten App:
// abgewiesene Offline-Inhalte (Abschnitt, Idee) und Entwurfs-Sicherungen
// erscheinen im Banner und im Dialog, lassen sich kopieren, ausdrücklich
// verwerfen und erneut senden — nichts verschwindet still.
//
// RESCUE_SHOTS=<Ordner> legt Screenshots (hell/dunkel, Desktop/Mobil) ab.

const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const SHOTS = process.env.RESCUE_SHOTS || null;
const shot = (page, name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, name + '.png') }) : null);

// Ein abgewiesenes Anlegen, eine abgewiesene Idee, eine verworfene Fassung.
// Der Server lehnt Anlegen währenddessen ab (403, z.B. Recht entzogen); die
// echte Outbox spielt beim Wiederverbinden selbst ab.
async function seedRescue(page, context) {
  const reject403 = (route) => (route.request().method() === 'POST'
    ? route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error_code: 'FORBIDDEN' }) })
    : route.fallback());
  const ids = await page.evaluate(() => {
    const nav = window.Alpine.store('nav');
    return { bookId: nav.selectedBookId, pageId: nav.pages[0].id, chapterId: nav.tree.find((it) => it.type === 'chapter' && !it.solo).id };
  });
  await context.setOffline(true);
  await page.evaluate(async ({ bookId, chapterId }) => {
    const { contentRepo } = await import('/js/repo/content.js');
    const I = await import('/js/repo/ideen-queue.js');
    await contentRepo.createPage({ book_id: bookId, chapter_id: chapterId, name: 'Im Tunnel angelegt', html: '<p>Der Zug hielt zwischen zwei Stationen, und niemand sagte etwas.</p>' });
    await I.createIdee({ book_id: bookId, content: 'Figur verliert den Schlüssel — später auflösen.' });
  }, ids);
  await page.route('**/ideen', reject403);
  await page.route('**/content/pages', reject403);
  await context.setOffline(false);
  // Das `online`-Ereignis startet die Outbox schon selbst: abwarten, bis
  // sie durch ist, und einmal ausdrücklich nachlaufen lassen.
  await page.waitForFunction(() => !window.__app._outboxFlushing, null, { timeout: 15000 });
  await page.evaluate(() => window.__app._flushOutbox());
  await page.waitForFunction(() => !window.__app._outboxFlushing, null, { timeout: 15000 });
  await page.evaluate(async (pageId) => {
    const D = await import('/js/editor/draft-storage.js');
    D.writeDraft(`${pageId}:discarded`, '<p>Die verworfene Fassung aus dem Konfliktdialog.</p>', '<p>alt</p>', 'T0');
    await window.__app._refreshRescueCount();
  }, ids.pageId);
  await page.unroute('**/ideen', reject403);
  await page.unroute('**/content/pages', reject403);
  return ids;
}

test('Banner + Dialog: drei Arten, kopieren, verwerfen, erneut versuchen', async ({ page, context }) => {
  test.setTimeout(90000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await bootApp(page);
  await selectSeededBook(page);
  await seedRescue(page, context);

  const banner = page.locator('.session-banner--rescue');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('3');
  // Abgewiesenes zählt nicht als „wartet auf Sync".
  expect(await page.evaluate(() => window.Alpine.store('session').pendingSyncCount)).toBe(0);
  await shot(page, 'banner');

  await banner.getByRole('button').click();
  const dlg = page.locator('dialog.offline-rescue-dialog');
  await expect(dlg).toBeVisible();
  const items = dlg.locator('.offline-rescue-item');
  await expect(items).toHaveCount(3);
  await expect(dlg).toContainText('Im Tunnel angelegt');
  await expect(dlg).toContainText('Der Zug hielt zwischen zwei Stationen');
  await expect(dlg).toContainText('Figur verliert den Schlüssel');
  await expect(dlg).toContainText('Die verworfene Fassung');
  await shot(page, 'dialog-light');
  // Ablehnungsgrund steht dabei (403 → kein Recht mehr).
  await expect(items.filter({ hasText: 'Im Tunnel angelegt' }).locator('.offline-rescue-reason')).toBeVisible();

  // Kopieren: Klartext in die Zwischenablage.
  const section = items.filter({ hasText: 'Im Tunnel angelegt' });
  await section.getByRole('button', { name: /Kopieren|Copy/ }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Der Zug hielt zwischen zwei Stationen');

  // Verwerfen nur nach Rückfrage — Abbrechen lässt den Eintrag stehen.
  const backup = items.filter({ hasText: 'Die verworfene Fassung' });
  await backup.getByRole('button', { name: /Verwerfen|Discard/ }).click();
  const confirm = page.locator('#app-confirm-dialog');
  await expect(confirm).toBeVisible();
  await shot(page, 'confirm');
  await confirm.locator('.confirm-dialog-btn--cancel').click();
  await expect(items).toHaveCount(3);
  await backup.getByRole('button', { name: /Verwerfen|Discard/ }).click();
  await confirm.locator('.confirm-dialog-btn--danger').click();
  await expect(items).toHaveCount(2);

  // Erneut versuchen: jetzt nimmt der Server an — Abschnitt und Idee sind dort.
  await dlg.locator('.confirm-dialog-btn--primary').click();
  await expect(page.locator('.session-banner--rescue')).toBeHidden({ timeout: 15000 });
  // Der Banner geht, sobald nichts mehr abgewiesen ist — gesendet ist da noch
  // nicht zwingend alles. Darum auf den Serverstand warten.
  const onServer = () => page.evaluate(async () => {
    const bookId = window.Alpine.store('nav').selectedBookId;
    const tree = await (await fetch(`/content/books/${bookId}/tree?__fresh=1`)).json();
    const all = [...(tree.topPages || []), ...(tree.chapters || []).flatMap(function walk(c) { return [...(c.pages || []), ...(c.subchapters || []).flatMap(walk)]; })];
    const board = await (await fetch(`/ideen/board?book_id=${bookId}`)).json();
    return {
      pages: all.filter((p) => p.name === 'Im Tunnel angelegt').length,
      ideas: (board.ideen || board.items || board || []).filter?.((i) => /Schlüssel/.test(i.content)).length ?? null,
    };
  });
  await expect.poll(async () => (await onServer()).pages, { timeout: 15000 }).toBe(1);
  await expect.poll(async () => (await onServer()).ideas ?? 1, { timeout: 15000 }).toBe(1);
});

test('Dialog auf schmalem Bildschirm: kein horizontales Scrollen, Knöpfe erreichbar', async ({ page, context }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 375, height: 740 });
  await bootApp(page);
  await selectSeededBook(page);
  await seedRescue(page, context);
  await page.locator('.session-banner--rescue').getByRole('button').click();
  const dlg = page.locator('dialog.offline-rescue-dialog');
  await expect(dlg).toBeVisible();
  const box = await dlg.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  expect(await dlg.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await shot(page, 'dialog-mobile');
});

test('Dunkelmodus ab dem Start (nur mit RESCUE_SHOTS)', async ({ page, context }) => {
  test.skip(!SHOTS, 'nur Screenshot');
  test.setTimeout(90000);
  await page.emulateMedia({ colorScheme: 'dark' });
  await bootApp(page);
  await selectSeededBook(page);
  await seedRescue(page, context);
  await page.locator('.session-banner--rescue').getByRole('button').click();
  await expect(page.locator('dialog.offline-rescue-dialog')).toBeVisible();
  await shot(page, 'dialog-dark');
});
