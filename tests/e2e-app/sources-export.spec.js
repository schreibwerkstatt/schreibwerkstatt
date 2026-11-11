// Schlagworte + Verzeichnis-Export der Quellen-Karte gegen die ECHTE App.
//
// Warum App-Ebene: der Export lebt von der Kette Combobox (multiple) →
// Karten-State → Rohliste per /sources bzw. /sources/pool → pures Formatieren
// (public/js/sources/export.js, eigene Unit-Suite). Nur hier sieht man, ob die
// Auswahl tatsaechlich im Ergebnis ankommt und ob das Panel die Karte nicht
// verstellt.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('quellen: Schlagworte setzen, filtern und als Verzeichnis exportieren', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  // Bekannter Stand (eine DB fuer die ganze App-Suite, s. sources-card.spec.js).
  await page.evaluate(async (id) => {
    const pool = await fetch('/sources/pool?archived=1').then(r => r.json());
    for (const s of Array.isArray(pool) ? pool : []) await fetch(`/sources/${s.id}`, { method: 'DELETE' });
    const post = (b) => fetch('/sources', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: id, ...b }),
    });
    await post({ csl_type: 'book', title: 'The Scrum Guide', year: '2020', url: 'https://scrumguides.org',
      authors: [{ family: 'Schwaber', given: 'Ken' }], tags: ['ZHAW'] });
    await post({ csl_type: 'book', title: 'Team Topologies', year: '2019',
      authors: [{ family: 'Skelton', given: 'Matthew' }], tags: ['ZHAW'] });
    await post({ csl_type: 'book', title: 'Die Verwandlung', year: '1915',
      authors: [{ family: 'Kafka', given: 'Franz' }] });
  }, bookId);

  await page.evaluate(async () => { await window.__app.toggleSourcesCard?.(); });
  await page.waitForFunction(() => document.querySelectorAll('.sources-table tbody tr').length === 3);
  await expect(page.locator('.sources-table .sources-tag:visible', { hasText: 'ZHAW' })).toHaveCount(2);

  // Schlagwort im Formular: tippen + Enter, speichern → Chip an der Zeile.
  await page.locator('.sources-title', { hasText: 'Die Verwandlung' }).click();
  await page.fill('.sources-form .tag-input-field', 'Roman');
  await page.press('.sources-form .tag-input-field', 'Enter');
  await expect(page.locator('.sources-form .tag-input-chip', { hasText: 'Roman' })).toHaveCount(1);
  // Vorschlag aus der Bibliothek.
  await expect(page.locator('.sources-form .tag-input-suggestion', { hasText: 'ZHAW' })).toHaveCount(1);
  await page.locator('.sources-form-actions button.primary').click();
  await expect(page.locator('.sources-form')).toBeHidden();
  await expect(page.locator('.sources-table tr', { hasText: 'Die Verwandlung' }).locator('.sources-tag', { hasText: 'Roman' })).toBeVisible();

  // Toolbar-Filter nach Schlagwort.
  const toolbarTag = page.locator('#sources-card .filter-bar .combobox-wrap').nth(1);
  await toolbarTag.locator('.combobox-trigger').click();
  await toolbarTag.locator('.combobox-option', { hasText: 'Roman' }).click();
  await expect(page.locator('.sources-table tbody tr')).toHaveCount(1);
  await toolbarTag.locator('.combobox-trigger').click();
  await toolbarTag.locator('.combobox-option', { hasText: 'Alle Schlagworte' }).click();
  await expect(page.locator('.sources-table tbody tr')).toHaveCount(3);

  // Export: Standard ist das aktuelle Buch, alle drei Quellen.
  await page.getByRole('button', { name: 'Exportieren', exact: true }).click();
  const panel = page.locator('.sources-export');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.export-chip')).toHaveCount(1);   // das aktuelle Buch
  await expect(panel.getByText('3 Quellen')).toBeVisible();

  // Schlagwort ZHAW waehlen → nur die beiden Kurs-Quellen.
  const tagBox = panel.locator('.card-form-row').filter({ has: page.locator('.card-form-label', { hasText: /^Schlagworte$/ }) });
  await tagBox.locator('.combobox-trigger').click();
  await tagBox.locator('.combobox-option', { hasText: 'ZHAW' }).click();
  await page.keyboard.press('Escape');
  await expect(panel.getByText('2 Quellen')).toBeVisible();
  const preview = panel.locator('.sources-export-preview');
  await expect(preview).toHaveValue(/Schwaber, K\. \(2020\)/);
  await expect(preview).toHaveValue(/Skelton/);
  await expect(preview).not.toHaveValue(/Kafka/);

  // Linksammlung: nur die Quelle mit URL, die andere wird als fehlend gemeldet.
  const fmtBox = panel.locator('.card-form-row').filter({ has: page.locator('.card-form-label', { hasText: /^Format$/ }) });
  await fmtBox.locator('.combobox-trigger').click();
  await fmtBox.locator('.combobox-option', { hasText: 'Linksammlung' }).click();
  await expect(preview).toHaveValue('- The Scrum Guide (Schwaber, 2020): https://scrumguides.org');
  await expect(panel.getByText(/1 ohne DOI\/URL/)).toBeVisible();

  // Ganze Bibliothek (Buch abwaehlen) + BibTeX-Download mit Schlagwort-Dateiname.
  await panel.locator('.export-chip-remove').first().click();
  await expect(panel.locator('.export-chip', { hasText: 'Devmode' })).toHaveCount(0);
  await fmtBox.locator('.combobox-trigger').click();
  await fmtBox.locator('.combobox-option', { hasText: 'BibTeX' }).click();
  await expect(preview).toHaveValue(/keywords = \{ZHAW\}/);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    panel.getByRole('button', { name: 'Herunterladen' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('zhaw.bib');
});
