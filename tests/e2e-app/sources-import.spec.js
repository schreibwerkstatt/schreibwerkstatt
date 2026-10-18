// Literatur-Import (BibTeX/RIS) in der Quellen-Karte gegen die ECHTE App:
// Datei wählen → Format erkannt → POST /sources/import → Liste + Ergebnis.
// Der Parser ist unit-getestet (bib-parse.test.mjs), der Endpunkt integriert
// (sources-import.test.js) — hier hängt die Kette aus Toolbar-Knopf, Panel,
// Datei-Input, Format-Combobox und Neuladen der Liste dran. Genau diese
// Kette bricht still (Alpine schluckt Expression-Fehler).
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const TMP_DIR = path.join(__dirname, '..', '.tmp');
const BIB = path.join(TMP_DIR, 'sources-import-probe.bib');

test.beforeAll(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  // Zwei brauchbare Einträge (einer mit babel-Umlaut), einer ohne Titel/Person.
  fs.writeFileSync(BIB, [
    '@book{importprobe1, author={M"uller, Hans}, title={Importprobe Eins}, year=2021, publisher={Verlag}}',
    '@article{importprobe2, author={Meier, Anna}, title={Importprobe Zwei}, journal={Merkur}, year=2019}',
    '@misc{leer, year=2000}',
  ].join('\n'));
});

test('quellen: BibTeX-Datei importieren, Ergebnis + Fehlerzeile, Liste neu geladen', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  // Bekannter Stand: Probe-Quellen aus einem früheren Lauf aus der Bibliothek löschen.
  await page.evaluate(async () => {
    const pool = await fetch('/sources/pool?archived=1').then(r => r.json());
    for (const s of Array.isArray(pool) ? pool : []) {
      if (/^Importprobe/.test(s.title || '')) await fetch(`/sources/${s.id}`, { method: 'DELETE' });
    }
  });
  expect(bookId).toBeTruthy();

  await page.evaluate(async () => { await window.__app.toggleSourcesCard?.(); });
  await page.waitForFunction(() => document.querySelector('#sources-card')?.checkVisibility?.());

  await page.locator('#sources-card .card-toolbar button', { hasText: 'Importieren' }).click();
  const panel = page.locator('.sources-import');
  await expect(panel).toBeVisible();

  await panel.locator('input[type=file]').setInputFiles(BIB);
  await expect(panel.locator('.sources-import-file')).toContainText('sources-import-probe.bib');
  await expect(panel.locator('.combobox-value')).toHaveText('BibTeX (.bib)');
  await expect(panel.locator('textarea')).toHaveValue(/importprobe1/);

  await panel.getByRole('button', { name: 'Importieren', exact: true }).click();
  await expect(panel.locator('.card-status')).toContainText('3 Einträge gelesen: 2 neu');
  await expect(panel.locator('.sources-import-errors')).toContainText('Eintrag 3 (leer)');

  // Liste der Karte ist neu geladen, babel-Umlaut dekodiert.
  await expect(page.locator('.sources-title', { hasText: 'Importprobe Eins' })).toBeVisible();
  await expect(page.locator('.sources-title', { hasText: 'Importprobe Zwei' })).toBeVisible();
  await expect(page.locator('.sources-cell-author', { hasText: 'Müller' })).toBeVisible();

  // Zweiter Lauf derselben Datei: nichts doppelt.
  await panel.getByRole('button', { name: 'Importieren', exact: true }).click();
  await expect(panel.locator('.card-status')).toContainText('0 neu, 2 schon in der Bibliothek');
});
