// Manuskript-Import gegen die echte App (siehe playwright.app.config.js).
//
// Der Kern des Features ist die KONFIGURIERBARKEIT: welche Ueberschriften-Ebene
// zum Kapitel wird und welche zur Seite, entscheidet der User in der Karte. Der
// Splitter selbst ist als reine Funktion unit-getestet
// (tests/unit/manuscript-split.test.js) — hier haengt der Weg dran, auf dem die
// Einstellung aus der Oberflaeche beim Server ankommt: Combobox-Auswahl →
// Query-Parameter → Vorschau bzw. angelegte Gliederung. Genau diese Kette bricht
// still (Alpine schluckt Expression-Fehler), darum braucht sie einen Browser.

const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp } = require('./_helpers/app');

const TMP_DIR = path.join(__dirname, '..', '.tmp');
const DOC = path.join(TMP_DIR, 'manuscript-import-probe.docx');
const DOC_IMG = path.join(TMP_DIR, 'manuscript-import-image.docx');
// 1×1-PNG: Bilder verwirft der Import — die Vorschau muss das sagen.
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test.describe.configure({ mode: 'serial' });

// Kein Binaer-Fixture im Repo: das Probe-Dokument wird aus der `docx`-Lib
// erzeugt, die der Word-Export ohnehin mitbringt.
test.beforeAll(async () => {
  const { Document, Packer, Paragraph, HeadingLevel } = require('docx');
  const children = [];
  for (const teil of ['Erster Teil', 'Zweiter Teil']) {
    children.push(new Paragraph({ text: teil, heading: HeadingLevel.HEADING_1 }));
    for (const kap of ['Ankunft', 'Abschied']) {
      children.push(new Paragraph({ text: `${teil} – ${kap}`, heading: HeadingLevel.HEADING_2 }));
      children.push(new Paragraph({ text: 'Ein Absatz mit etwas Text darin.' }));
    }
  }
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(DOC, await Packer.toBuffer(new Document({ sections: [{ children }] })));
  const { ImageRun } = require('docx');
  fs.writeFileSync(DOC_IMG, await Packer.toBuffer(new Document({ sections: [{ children: [
    new Paragraph({ text: 'Kapitel mit Bild', heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new ImageRun({ type: 'png', data: PNG_1PX, transformation: { width: 10, height: 10 } })] }),
    new Paragraph({ text: 'Text danach.' }),
  ] }] })));
});

async function openManuscriptImport(page) {
  await bootApp(page);
  await page.evaluate(() => { location.hash = '#import'; });
  await page.waitForSelector('#folder-import-card', { state: 'visible' });
  await page.locator('#folder-import-card .form-radio-option', { hasText: 'Word-/Text-Dokument' }).click();
  await expect(page.locator('.folder-import-mapping')).toBeVisible();
}

// Rolle einer Ebene setzen. `lvl` ist 1-basiert und deckt nur H1–H3 ab
// (H4–H6 liegen im eingeklappten Zusatz-Block).
async function setRole(page, lvl, label) {
  const row = page.locator('.folder-import-mapping .folder-import-map-grid').first()
    .locator('.folder-import-map-row').nth(lvl - 1);
  const cb = row.locator('.combobox-wrap');
  await cb.locator('.combobox-trigger').click();
  await cb.locator('.combobox-option', { hasText: label }).first().click();
  await expect(cb.locator('.combobox-value')).toHaveText(label);
}

test('Zuordnung h1=Kapitel / h2=Seite kommt als Vorschau zurueck', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await openManuscriptImport(page);

  // Default-Zuordnung steht sichtbar in den Comboboxen.
  const rows = page.locator('.folder-import-mapping .folder-import-map-grid').first().locator('.folder-import-map-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).locator('.combobox-value')).toHaveText('Kapitel');
  await expect(rows.nth(1).locator('.combobox-value')).toHaveText('Abschnitt');

  await page.setInputFiles('#folder-import-card .folder-import-drop input[type=file]', DOC);
  await page.getByRole('button', { name: 'Vorschau berechnen' }).click();

  await expect(page.locator('.folder-import-preview-summary')).toHaveText('2 Kapitel, 4 Abschnitte');
  // Die gefundenen Ebenen werden ausgewiesen — sonst raet der User seine Zuordnung.
  await expect(page.locator('.folder-import-heading-counts')).toContainText('2× Überschrift 1');
  await expect(page.locator('.folder-import-heading-counts')).toContainText('4× Überschrift 2');
  guard.assertClean('Manuskript-Vorschau (Default-Zuordnung)');
});

test('geaenderte Zuordnung aendert die Gliederung', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await openManuscriptImport(page);
  await page.setInputFiles('#folder-import-card .folder-import-drop input[type=file]', DOC);

  await setRole(page, 2, 'Unterkapitel');
  // Aus 4 Seiten-Ueberschriften werden 4 Unterkapitel, die Seiten erben ihren Namen.
  await page.getByRole('button', { name: 'Vorschau berechnen' }).click();
  await expect(page.locator('.folder-import-preview-summary')).toHaveText('6 Kapitel, 4 Abschnitte');

  await setRole(page, 2, 'Fliesstext');
  // Ohne Seiten-Ueberschrift traegt jedes Kapitel genau eine Seite.
  await page.getByRole('button', { name: 'Vorschau berechnen' }).click();
  await expect(page.locator('.folder-import-preview-summary')).toHaveText('2 Kapitel, 2 Abschnitte');
  guard.assertClean('Manuskript-Vorschau (geaenderte Zuordnung)');
});

test('Import legt Kapitel und Seiten nach der Zuordnung an', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await openManuscriptImport(page);

  const bookName = `Manuskript-Probe ${Date.now()}`;
  await page.locator('#folder-import-card .form-radio-option', { hasText: 'Neues Buch anlegen' }).click();
  await page.fill('#folder-import-card .folder-import-input', bookName);
  await page.setInputFiles('#folder-import-card .folder-import-drop input[type=file]', DOC);
  await page.getByRole('button', { name: 'Import starten' }).click();

  await expect(page.locator('.folder-import-result')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('.folder-import-result')).toContainText('4 Abschnitte angelegt');
  await expect(page.locator('.folder-import-result')).toContainText('2 Kapitel angelegt');
  // Die verwendete Zuordnung steht im Ergebnis — sie ist die Erklaerung dafuer,
  // warum die Gliederung so aussieht, wie sie aussieht.
  await expect(page.locator('.folder-import-result')).toContainText('chapter,page');
  // Import-Log: übersetzte Zeilen aus { key, params }, kein roher Key.
  const logBlock = page.locator('.folder-import-log-block');
  await logBlock.locator('.collapsible-toggle').click();
  await expect(logBlock.locator('.folder-import-log')).toContainText(`Buch «${bookName}» angelegt`);
  await expect(logBlock.locator('.folder-import-log')).toContainText('Import abgeschlossen: 4 Abschnitte, 2 Kapitel, 0 Fehler');
  await expect(logBlock.locator('.folder-import-log')).not.toContainText('importLog.');
  guard.assertClean('Manuskript-Import');
});

test('Vorschau zeigt Import-Hinweise (Bilder werden verworfen)', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await openManuscriptImport(page);
  await page.setInputFiles('#folder-import-card .folder-import-drop input[type=file]', DOC_IMG);
  await page.getByRole('button', { name: 'Vorschau berechnen' }).click();
  await expect(page.locator('.folder-import-preview-row .folder-import-warnings'))
    .toContainText('1 Bild(er) nicht übernommen');
  guard.assertClean('Manuskript-Vorschau mit Bild');
});
