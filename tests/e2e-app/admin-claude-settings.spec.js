// Claude-Tab der Admin-Settings gegen die ECHTE App: oben API-Key + Modell, direkt
// darunter die vier Modellstufen (je Stufe eingeklappt, Kopfzeile nennt Modell und
// Job-Zahl), die eingeklappte Zuordnung Job → Stufe (eine Zeile je Job mit
// Segment-Umschalter, Katalog aus lib/ai/job-tiers.js), der eingeklappte Effort- und
// der „Erweitert"-Bereich. Die Zähler an den Toggles dürfen eine
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
  const jobRow = (type) => panel.locator(`.admin-tier-row[data-key="ai.claude.tier.job.${type}"]`);

  await expect(fieldOf(card, 'ai.claude.model')).toBeVisible();
  await expect(fieldOf(card, 'ai.claude.effort.lektorat')).toBeHidden();
  await expect(fieldOf(card, 'ai.claude.model.tier.standard')).toBeHidden();
  await expect(jobRow('check')).toBeHidden();
  await expect(fieldOf(card, 'ai.claude.context_window')).toBeHidden();

  // Vier Stufen (maximal, stark, standard, leicht) + Zuordnung + Effort + Erweitert,
  // Stufen direkt unter dem Modell, vor den Effort-Feldern.
  await expect(toggles).toHaveCount(7);
  const maxToggle = toggles.nth(0);
  await expect(maxToggle).toContainText(/wie Stark|like Strong/);
  await expect(maxToggle).toContainText(/0 Jobs|0 jobs/);
  await expect(toggles.nth(2)).toContainText('claude-sonnet-5-5');
  await setForm(page, { 'ai.claude.model': 'claude-opus-5-5', 'ai.claude.model.tier.max': 'claude-fable-5-1' });
  await expect(toggles.nth(1)).toContainText('claude-opus-5-5');
  await expect(maxToggle).toContainText('claude-fable-5-1');
  await maxToggle.click();
  for (const key of ['ai.claude.model.tier.max', 'ai.claude.context_window.tier.max',
    'ai.claude.max_tokens_out.tier.max', 'ai.claude.timeout_ms.tier.max']) {
    await expect(fieldOf(card, key)).toBeVisible();
  }

  // Zuordnung: eine Zeile je Katalog-Job mit Segment-Umschalter; Zähler zählt
  // Abweichungen von der Vorbelegung, die Stufen-Kopfzeile die Jobs der Stufe.
  const jobToggle = toggles.nth(4);
  const jobBadge = jobToggle.locator('.admin-settings-active-badge');
  await expect(jobBadge).toBeHidden();
  await setForm(page, { 'ai.claude.tier.job.komplett-analyse': 'max' });
  await expect(jobBadge).toContainText('1');
  await expect(maxToggle).toContainText(/1 Job|1 job/);
  await jobToggle.click();
  for (const type of ['check', 'komplett-extract', 'book-chat', 'chat-title']) {
    await expect(jobRow(type)).toBeVisible();
    await expect(jobRow(type).locator('.seg-toggle button')).toHaveCount(4);
  }
  const syn = jobRow('synonym');
  await expect(syn).not.toHaveClass(/is-changed/);
  await expect(syn.locator('.seg-toggle--active')).toHaveText(/Leicht|Light/);
  await syn.locator('.seg-toggle button').nth(1).click();
  await expect(syn.locator('.seg-toggle--active')).toHaveText(/Stark|Strong/);
  await expect(syn).toHaveClass(/is-changed/);
  await expect(syn.locator('.admin-tier-row-default')).toContainText(/Leicht|Light/);
  await expect(jobBadge).toContainText('2');
  expect(await page.evaluate(() => window.Alpine.$data(document.querySelector('[x-data="adminSettingsCard"]'))
    .adminSettingsForm['ai.claude.tier.job.synonym'])).toBe('strong');

  // Effort: eingeklappt, Zähler nennt Felder mit eigenem Wert.
  const effToggle = toggles.nth(5);
  const effBadge = effToggle.locator('.admin-settings-active-badge');
  await expect(effBadge).toBeHidden();
  await setForm(page, { 'ai.claude.effort.lektorat': 'high' });
  await expect(effBadge).toContainText('1');
  await effToggle.click();
  await expect(fieldOf(card, 'ai.claude.effort.lektorat')).toBeVisible();

  // Erweitert: Limits der Stufe «stark» + Komplett-Timeout zählen.
  const advToggle = toggles.nth(6);
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
