// .swbook-Export (Export-Karte, docs/book-migration.md) gegen die ECHTE App:
// alle Extra-Blöcke stehen standardmässig an — ein Umzug soll nichts verlieren —,
// und der Download fragt jeden Block an, auch den Werk-Block. Abwählen nimmt
// den Block aus der Anfrage.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('swbook-Export: alle Blöcke standardmässig an, Werk-Block abwählbar', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);

  const urls = [];
  await page.route('**/book-migration/*', (route) => {
    urls.push(route.request().url());
    route.fulfill({ status: 200, contentType: 'application/zip', body: 'PK' });
  });

  await page.evaluate(() => window.__app.toggleExportCard());
  const ids = ['analysis', 'lektorat', 'chats', 'research', 'werk'];
  for (const id of ids) await expect(page.locator(`#migrate-${id}`)).toBeChecked();
  await expect(page.locator('label.form-check', { has: page.locator('#migrate-werk') }))
    .toContainText('Werkstätten, Publikation & KI-Ergebnisse');

  const btn = page.getByRole('button', { name: /\.swbook|Schreibwerkstatt-Buch/ });
  await btn.click();
  await expect.poll(() => urls.length).toBe(1);
  const q = new URL(urls[0]).searchParams;
  for (const id of ids) expect(q.get(id)).toBe('1');

  await page.locator('#migrate-werk').uncheck();
  await btn.click();
  await expect.poll(() => urls.length).toBe(2);
  expect(new URL(urls[1]).searchParams.get('werk')).toBeNull();
});
