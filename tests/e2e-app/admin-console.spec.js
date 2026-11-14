// Admin-Konsole gegen die ECHTE App (Backup, Bücher, Logs, JS-Fehler):
//  - Backup: eine Vormerkung (auch aus einer früheren Sitzung) steht als
//    Hinweis in der Karte, «Vormerkung verwerfen» löscht sie auf dem Server.
//  - Bücher: Owner zuweisen geht als Picker-Popover am Zeilen-Knopf auf, keine
//    Combobox je Tabellenzeile.
//  - Logs: mit Filter ist Live-Tail gesperrt und aus; Filter zurücksetzen
//    startet den Stream wieder. Filterfelder wenden sich selbst an.
//  - Hash-Routing aus der Registry: #admin/<slug> öffnet die Karte und bleibt
//    beim Öffnen per Toggle identisch.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp } = require('./_helpers/app');

test('Backup: vorgemerkter Restore erscheint als Hinweis und lässt sich verwerfen', async ({ page }) => {
  await bootApp(page);
  // Vormerkung über die API anlegen: Snapshot der laufenden DB hochladen.
  const staged = await page.evaluate(async () => {
    const prep = await (await fetch('/admin/backup/snapshot', { method: 'POST' })).json();
    const gz = await (await fetch('/admin/backup/download?token=' + encodeURIComponent(prep.token))).blob();
    const r = await fetch('/admin/backup/restore', {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: gz,
    });
    return r.status;
  });
  expect(staged).toBe(200);

  await page.evaluate(() => { location.hash = '#admin/backup'; });
  const card = page.locator('.card--admin-backup');
  await expect(card).toBeVisible();
  const banner = card.locator('.admin-backup-pending');
  await expect(banner).toBeVisible();
  await expect(banner).not.toContainText('admin.backup.');

  await banner.getByRole('button', { name: /Vormerkung verwerfen|Discard staged backup/ }).click();
  await expect(banner).toBeHidden();
  const info = await page.evaluate(async () => (await fetch('/admin/backup/info')).json());
  expect(info.hasPending).toBe(false);
});

test('Bücher: Owner-Zuweisung als Picker-Popover, nicht als Combobox je Zeile', async ({ page }) => {
  await bootApp(page);
  // Ein Buch ohne Owner gibt es im Seed nicht immer — die Tabelle prüfen wir
  // nur, wenn sie da ist; der Picker selbst muss ausserhalb der Tabelle liegen.
  await page.evaluate(() => { location.hash = '#admin/books'; });
  const card = page.locator('.card--admin-books');
  await expect(card).toBeVisible();
  await expect(card.locator('table .combobox-wrap')).toHaveCount(0);
  const picker = page.locator('.picker-popover.admin-books-assign-picker');
  await expect(picker).toHaveCount(1);
  expect(await page.evaluate(() => location.hash)).toBe('#admin/books');

  // Öffnen am Knopf: Kopf nennt das Buch, Esc schliesst.
  await expect(card.locator('table tbody tr').first()).toBeVisible();
  const name = await page.evaluate(() => {
    const el = document.querySelector('[x-data="adminBooksCard"]');
    const c = window.Alpine.$data(el);
    c.openAssign(el.querySelector('.card-title'), c.books[0]);
    return c.books[0].name;
  });
  await expect(picker).toBeVisible();
  await expect(picker.locator('.picker-popover__subject')).toHaveText(name);
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
});

test('Logs: Live-Tail mit Filter gesperrt, Zurücksetzen startet den Stream wieder', async ({ page }) => {
  await bootApp(page);
  await page.evaluate(() => { location.hash = '#admin/logs'; });
  const card = page.locator('.card--admin-logs');
  await expect(card).toBeVisible();
  const live = card.locator('.admin-logs-livetail');
  await expect(live).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() =>
    !!window.Alpine.$data(document.querySelector('[x-data="adminLogsCard"]')).adminLogsEventSource)).toBe(true);

  // Volltext tippen — ohne Knopf, die Suche läuft nach kurzer Pause selbst.
  await card.locator('.admin-logs-filter-label--wide input').fill('page load');
  await expect(live).toBeDisabled();
  await expect(live).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => page.evaluate(() =>
    window.Alpine.$data(document.querySelector('[x-data="adminLogsCard"]')).adminLogsEventSource)).toBe(null);

  await card.getByRole('button', { name: /Filter zurücksetzen|Reset filter|Clear filter/ }).click();
  await expect(live).toBeEnabled();
  await expect(live).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() =>
    !!window.Alpine.$data(document.querySelector('[x-data="adminLogsCard"]')).adminLogsEventSource)).toBe(true);
  // Server-Zeitzone als Hinweis.
  await expect(card).toContainText(/Server-Ortszeit|server local time/);
});

test('Hash-Routing: jede Admin-Karte aus der Registry hat ihren #admin/<slug>', async ({ page }) => {
  await bootApp(page);
  const slugs = await page.evaluate(async () => {
    const reg = await import('/js/cards/feature-registry.js');
    return reg.ADMIN_CARDS.map(c => ({ slug: c.admin.slug, partial: c.partial, toggle: c.toggle }));
  });
  expect(slugs.length).toBeGreaterThanOrEqual(10);
  for (const { slug, partial, toggle } of slugs) {
    await page.evaluate((t) => window.__app[t](), toggle);
    await expect(page.locator(`.card--${partial}`).first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(new RegExp(`^#admin/${slug}(/|$)`));
    await page.evaluate(() => window.__app._closeOtherMainCards?.(null));
  }
});
