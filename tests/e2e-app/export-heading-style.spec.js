// Ueberschriften-Gestaltung in PDF- und EPUB-Karte gegen die ECHTE App: das
// EPUB-Fragment kommt per `@include` in den Struktur-Tab, die Auswahllisten aus
// dem geteilten Slice — beides sieht erst der volle Template-Baum. Geprueft wird
// das Ein-/Ausblenden, das an Linien und Nummerierung haengt.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const label = (page, key) => page.evaluate((k) => window.__app.t(k), key);

test('PDF-Karte: Linien-Optionen erst mit Linie, Praefix-Feld erst bei eigenem Wort', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(() => window.__app.togglePdfExportCard());
  const card = page.locator('.card--pdfexport');
  await expect(card).toBeVisible();
  await page.waitForFunction(() => window.Alpine.$data(document.querySelector('.card--pdfexport')).activeProfile);
  await page.evaluate(() => {
    const d = window.Alpine.$data(document.querySelector('.card--pdfexport'));
    d.setUiMode('expert');
    d.activeTab = 'chapter';
    Object.assign(d.activeProfile.config.chapter, { titleStyle: 'centered-large', titleRule: false, subTitleRule: false, pageTitleRule: false, numbering: 'none' });
  });
  const panel = card.locator('.export-tab-panel:visible');
  await expect(panel.getByText(await label(page, 'export.heading.group'), { exact: true })).toBeVisible();
  const ruleStyle = panel.locator('.card-form-label', { hasText: await label(page, 'export.heading.ruleStyle') });
  await expect(ruleStyle).toBeHidden();

  await page.evaluate(() => { window.Alpine.$data(document.querySelector('.card--pdfexport')).activeProfile.config.chapter.subTitleRule = true; });
  await expect(ruleStyle).toBeVisible();

  // left-rule zieht die Linie selbst: die Checkbox am Kapiteltitel faellt weg.
  const chapterRule = panel.locator('.pdfx-check', { hasText: await label(page, 'export.heading.chapterRule') });
  await expect(chapterRule).toBeVisible();
  await page.evaluate(() => { window.Alpine.$data(document.querySelector('.card--pdfexport')).activeProfile.config.chapter.titleStyle = 'left-rule'; });
  await expect(chapterRule).toBeHidden();

  const prefixText = panel.locator('.card-form-label', { hasText: await label(page, 'export.heading.numberPrefixText') });
  await page.evaluate(() => { window.Alpine.$data(document.querySelector('.card--pdfexport')).activeProfile.config.chapter.numbering = 'arabic'; });
  await expect(panel.locator('.card-form-label', { hasText: await label(page, 'export.heading.numberPrefix') }).first()).toBeVisible();
  await expect(prefixText).toBeHidden();
  await page.evaluate(() => { window.Alpine.$data(document.querySelector('.card--pdfexport')).activeProfile.config.chapter.numberPrefix = 'custom'; });
  await expect(prefixText).toBeVisible();
});

test('EPUB-Karte: Ueberschriften-Fragment im Struktur-Tab, Linien-Optionen erst mit Linie', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(() => window.__app.toggleEpubExportCard());
  const card = page.locator('.card--epubexport');
  await expect(card).toBeVisible();
  await page.waitForFunction(() => window.Alpine.$data(document.querySelector('.card--epubexport')).pub);
  await page.evaluate(() => {
    const d = window.Alpine.$data(document.querySelector('.card--epubexport'));
    d.activeTab = 'structure';
    Object.assign(d.pub, { epub_chapter_title_style: 'centered-large', epub_chapter_rule: false, epub_sub_title_rule: false, epub_page_rule: false, epub_chapter_numbering: 'none' });
  });
  const panel = card.locator('.export-tab-panel:visible');
  await expect(panel.getByText(await label(page, 'export.heading.group'), { exact: true })).toBeVisible();
  const ruleStyle = panel.locator('.card-form-label', { hasText: await label(page, 'export.heading.ruleStyle') });
  await expect(ruleStyle).toBeHidden();
  await page.evaluate(() => { window.Alpine.$data(document.querySelector('.card--epubexport')).pub.epub_page_rule = true; });
  await expect(ruleStyle).toBeVisible();
  // Auswahlliste aus dem geteilten Slice: acht Linienarten.
  const opts = await page.evaluate(() => window.Alpine.$data(document.querySelector('.card--epubexport')).headingStyleOptions('ruleStyle').length);
  expect(opts).toBe(8);
  await page.evaluate(() => { window.Alpine.$data(document.querySelector('.card--epubexport')).pub.epub_chapter_numbering = 'roman'; });
  await expect(panel.locator('.card-form-label', { hasText: await label(page, 'export.heading.numberCase') })).toBeVisible();
});
