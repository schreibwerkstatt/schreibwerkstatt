const { test, expect } = require('./_helpers/fixtures');

// Verifiziert das collapsible-Pattern gegen die echte Alpine-Runtime:
// x-bind="trigger" (@click + :aria-expanded), x-bind="chevron" (:class open)
// und x-bind="panel" (x-show) müssen als Direktiven-Spread greifen.
const URL = '/tests/fixtures/collapsible-harness.html';

test('collapsible: default geschlossen, toggelt auf Klick', async ({ page }) => {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Alpine && window.harnessReady);

  const panel = page.locator('#panel1');
  const trigger = page.locator('#trigger1');
  const chev = page.locator('#chev1');

  // Initial: Panel versteckt, aria-expanded=false, Chevron nicht .open
  await expect(panel).toBeHidden();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(chev).not.toHaveClass(/\bopen\b/);

  // Klick öffnet
  await trigger.click();
  await expect(panel).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(chev).toHaveClass(/\bopen\b/);

  // Erneuter Klick schliesst
  await trigger.click();
  await expect(panel).toBeHidden();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('collapsible(true): initial offen', async ({ page }) => {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Alpine && window.harnessReady);

  await expect(page.locator('#panel2')).toBeVisible();
  await expect(page.locator('#trigger2')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#chev2')).toHaveClass(/\bopen\b/);
});
