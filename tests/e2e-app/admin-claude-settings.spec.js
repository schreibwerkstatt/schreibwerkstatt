// Claude-Tab der Admin-Settings gegen die ECHTE App: oben Standard-Felder und die
// Modellstufen (je Stufe eingeklappt, Kopfzeile nennt das Modell), darunter die
// eingeklappte Zuordnung Job → Stufe (aus lib/ai/job-tiers.js, vom Server geliefert)
// und der eingeklappte „Erweitert"-Bereich. Die Zähler an den Toggles dürfen eine
// aktive Abweichung nicht hinter dem Einklappen verstecken — das hängt am echten
// Alpine-Baum (collapsible + adminSettingsForm).

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp } = require('./_helpers/app');

async function openClaudeTab(page) {
  await page.evaluate(async () => { await window.__app.toggleAdminSettingsCard(); });
  const card = page.locator('[x-show="$app.showAdminSettingsCard"]').first();
  await expect(card).toBeVisible();
  await page.evaluate(() => {
    const c = window.Alpine.$data(document.querySelector('[x-data="adminSettingsCard"]'));
    c.adminSettingsTab = 'provider';
    c.adminSettingsProviderSubtab = 'claude';
  });
  return card;
}

const fieldOf = (card, key) => card.locator('.setting-field').filter({ hasText: key }).first();
const setForm = (page, values) => page.evaluate((v) => {
  const c = window.Alpine.$data(document.querySelector('[x-data="adminSettingsCard"]'));
  Object.assign(c.adminSettingsForm, v);
}, values);

test('Claude-Tab: Stufen und Zuordnung eingeklappt, Zähler zeigen Abweichungen', async ({ page }) => {
  await bootApp(page);
  const card = await openClaudeTab(page);
  const panel = card.locator('[x-bind="panel(\'claude\')"]');
  const toggles = panel.locator('.admin-settings-advanced > .collapsible-toggle');

  await expect(fieldOf(card, 'ai.claude.model')).toBeVisible();
  await expect(fieldOf(card, 'ai.claude.effort.lektorat')).toBeVisible();
  await expect(fieldOf(card, 'ai.claude.model.tier.standard')).toBeHidden();
  await expect(fieldOf(card, 'ai.claude.tier.job.check')).toBeHidden();
  await expect(fieldOf(card, 'ai.claude.context_window')).toBeHidden();

  // Drei Stufen (maximal, standard, leicht) + Zuordnung + Erweitert.
  await expect(toggles).toHaveCount(5);
  const maxToggle = toggles.nth(0);
  await expect(maxToggle).toContainText(/wie Stark|like Strong/);
  await expect(toggles.nth(1)).toContainText('claude-sonnet-5-5');
  await setForm(page, { 'ai.claude.model.tier.max': 'claude-fable-5-1' });
  await expect(maxToggle).toContainText('claude-fable-5-1');
  await maxToggle.click();
  for (const key of ['ai.claude.model.tier.max', 'ai.claude.context_window.tier.max',
    'ai.claude.max_tokens_out.tier.max', 'ai.claude.timeout_ms.tier.max']) {
    await expect(fieldOf(card, key)).toBeVisible();
  }

  // Zuordnung: ein Feld je Katalog-Job, Zähler zählt Abweichungen von der Vorbelegung.
  const jobToggle = toggles.nth(3);
  const jobBadge = jobToggle.locator('.admin-settings-active-badge');
  await expect(jobBadge).toBeHidden();
  await setForm(page, { 'ai.claude.tier.job.komplett-analyse': 'max', 'ai.claude.tier.job.synonym': 'strong' });
  await expect(jobBadge).toContainText('2');
  await jobToggle.click();
  for (const key of ['ai.claude.tier.job.check', 'ai.claude.tier.job.komplett-extract',
    'ai.claude.tier.job.book-chat', 'ai.claude.tier.job.chat-title']) {
    await expect(fieldOf(card, key)).toBeVisible();
  }

  // Erweitert: Limits der Stufe «stark» + Komplett-Timeout zählen.
  const advToggle = toggles.nth(4);
  const advBadge = advToggle.locator('.admin-settings-active-badge');
  await expect(advBadge).toBeHidden();
  await setForm(page, { 'ai.claude.context_window': 1000000, 'ai.claude.timeout_ms.komplett': 2400000 });
  await expect(advBadge).toContainText('2');
  await advToggle.click();
  for (const key of ['ai.claude.context_window', 'ai.claude.timeout_ms.komplett',
    'ai.komplett.factcheck', 'ai.claude.phase1_concurrency']) {
    await expect(fieldOf(card, key)).toBeVisible();
  }
});
