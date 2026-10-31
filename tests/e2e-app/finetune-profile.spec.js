// Trainingsprofile der Fine-Tuning-Export-Karte gegen die ECHTE App (siehe
// playwright.app.config.js): Profil-Combobox setzt die Export-Felder, der
// Download liefert eine Studio-YAML, deren Werte zum gewählten Profil passen
// und deren max_seq_length dem Export-Feld folgt. Die Ergebnis-Partial
// (finetune-export-result.html) lädt verschachtelt in die Karte.

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const tr = (page, key, params) => page.evaluate(([k, p]) => window.__app.t(k, p), [key, params || null]);

async function downloadYaml(page, card) {
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    card.getByRole('button', { name: /studio-config\.yaml/ }).click(),
  ]);
  expect(dl.suggestedFilename()).toBe('studio-config.yaml');
  return fs.readFileSync(await dl.path(), 'utf8');
}

test('Fine-Tuning-Export: Profilwahl setzt Felder, YAML passt zum Profil', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(() => window.__app.toggleFinetuneExportCard());
  const card = page.locator('.card--finetune');
  await expect(card).toBeVisible();
  // Verschachtelte Ergebnis-Partial ist geladen und erbt den Karten-Scope.
  await expect(card.locator('#partial-finetune-export-result .muted-msg')).toBeVisible();

  const seq = card.locator('#ft-max-seq-tokens');
  const maxChars = card.locator('#ft-max-chars');
  await expect(seq).toHaveValue(/^4[’',.]?096$/);

  // Default-Profil: Ministral 3 8B, 20 GB.
  let yaml = await downloadYaml(page, card);
  expect(yaml).toContain('# ' + await tr(page, 'finetune.profile.yaml.model', { model: 'unsloth/Ministral-3-8B-Instruct-2512-unsloth-bnb-4bit' }));
  expect(yaml).toMatch(/^ {2}batch_size: 2$/m);
  expect(yaml).toMatch(/^ {2}max_seq_length: 4096$/m);
  expect(yaml).toMatch(/^ {2}lora_r: 32$/m);
  expect(yaml).toMatch(/^ {2}packing: false$/m);
  expect(yaml).toMatch(/^ {2}finetune_vision_layers: false$/m);

  // Profil wechseln über die Combobox.
  const label24 = await tr(page, 'finetune.profile.option', { model: 'Ministral 3 8B', vram: 24 });
  const profileRow = card.locator('.card-form-row', { hasText: await tr(page, 'finetune.profile') });
  await profileRow.locator('.combobox-trigger').click();
  await card.getByRole('option', { name: label24 }).click();
  await expect(seq).toHaveValue(/^8[’',.]?192$/);
  await expect(maxChars).toHaveValue(/^8[’',.]?000$/);

  yaml = await downloadYaml(page, card);
  expect(yaml).toMatch(/^ {2}max_seq_length: 8192$/m);
  expect(yaml).toMatch(/^ {2}lora_r: 64$/m);
  expect(yaml).toMatch(/^ {2}lora_alpha: 64$/m);

  // Von Hand geändertes Sequenz-Budget landet in der YAML, nicht der Profilwert.
  // numInput schreibt beim Fokus den Rohwert ins Feld; ohne Fokus-Fenster
  // (CI, mehrere Worker) feuert das Event erst nach dem Select-All von fill()
  // und der Text wird angehängt statt ersetzt.
  await seq.focus();
  await expect(seq).toHaveValue('8192');
  await seq.fill('2048');
  await seq.blur();
  yaml = await downloadYaml(page, card);
  expect(yaml).toMatch(/^ {2}max_seq_length: 2048$/m);
  expect(yaml).toMatch(/^ {2}lora_r: 64$/m);

  guard.assertClean('Fine-Tuning-Profile');
});

test('Fine-Tuning-Export: Leser-Optionen sind vorbelegt, keine Autor-Optionen', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(() => window.__app.toggleFinetuneExportCard());
  const card = page.locator('.card--finetune');
  await expect(card).toBeVisible();
  // KI-Optionen kommen aus der verschachtelten Partial.
  await expect(card.locator('#partial-finetune-export-ai #ft-ai-reverse')).toBeAttached();

  await expect(card.locator('#ft-type-correction')).toHaveCount(0);
  await expect(card.locator('#ft-ai-reasoning')).toHaveCount(0);
  await expect(card.locator('#ft-ai-persona')).toBeVisible();
  await expect(card.locator('#ft-ai-persona')).toBeChecked();
  await expect(card.locator('#ft-ai-deutung')).toBeChecked();
  await expect(card.locator('#ft-ai-voice')).toBeChecked();

  guard.assertClean('Fine-Tuning-Leser');
});
