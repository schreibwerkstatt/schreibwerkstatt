// Admin-Settings gegen die ECHTE App: jede Einstellung steht im Reiter ihres Themas.
// «Allgemein» trägt die Identität der Instanz, «Erweitert» nur anbieterübergreifendes
// KI-Tuning, Editor-Laufzeit und Aufbewahrung; Provider-spezifische Werte liegen im
// Panel ihres Providers (Lektorat-Split bei Claude, Extraktions-Deckel je lokalem Provider).

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp } = require('./_helpers/app');

const PLACEMENT = {
  general: ['app.name', 'app.public_url', 'seo.indexable'],
  auth: ['share.comment.rate_limit_max', 'share.comment.rate_limit_window_min'],
  api: ['macclient.github_token'],
  advanced: [
    'ai.chars_per_token', 'ai.lektorat_batch_concurrency', 'ai.lektorat_stylistic_cap',
    'ai.lektorat_chunk_chars', 'editor.lock_ttl_min', 'app.page_revision_limit',
    'app.job_runs_retention_days', 'app.chat_job_runs_retention_days', 'app.usage_events_retention_days',
  ],
};
const PROVIDER_PANEL = {
  claude: ['ai.lektorat_split'],
  ollama: ['ai.ollama.komplett.extract_max_tokens'],
  'openai-compat': ['ai.openai-compat.komplett.extract_max_tokens'],
};

const keysIn = (locator) => locator.evaluate((el) =>
  [...el.querySelectorAll('[x-data^="settingField"]')]
    .map((n) => (n.getAttribute('x-data').match(/k: '([^']+)'/) || [])[1])
    .filter(Boolean));

test('Admin-Settings: Einstellungen stehen im Reiter ihres Themas', async ({ page }) => {
  await bootApp(page);
  await page.evaluate(async () => { await window.__app.toggleAdminSettingsCard(); });
  const card = page.locator('[x-show="$app.showAdminSettingsCard"]').first();
  await expect(card).toBeVisible();

  // «Allgemein» ist der erste Reiter und beim Öffnen aktiv.
  await expect(card.locator('.tabs-btn').first()).toHaveText(/^(Allgemein|General)$/);
  await expect(card.locator(`section[x-bind="panel('general')"]`)).toBeVisible();

  for (const [tab, keys] of Object.entries(PLACEMENT)) {
    const found = await keysIn(card.locator(`section[x-bind="panel('${tab}')"]`));
    for (const k of keys) expect(found, `${k} im Reiter ${tab}`).toContain(k);
  }
  // «Erweitert» trägt genau die Liste oben — nichts Fremdes mehr.
  const advanced = await keysIn(card.locator(`section[x-bind="panel('advanced')"]`));
  expect(advanced.sort()).toEqual([...PLACEMENT.advanced].sort());

  for (const [provider, keys] of Object.entries(PROVIDER_PANEL)) {
    const found = await keysIn(card.locator(`[x-bind="panel('${provider}')"]`));
    for (const k of keys) expect(found, `${k} im Provider-Panel ${provider}`).toContain(k);
  }

  // Der Altschlüssel des Extraktions-Deckels taucht nirgends mehr auf.
  expect(await keysIn(card)).not.toContain('ai.komplett.extract_max_tokens');

  // Labels sind übersetzt (kein roher Key) im neuen Reiter.
  await card.locator('.tabs-btn', { hasText: /^(Allgemein|General)$/ }).click();
  const labels = await card.locator(`section[x-bind="panel('general')"] .setting-field`).allInnerTexts();
  expect(labels.length).toBe(3);
  for (const txt of labels) expect(txt).not.toMatch(/admin\.settings\./);
});
