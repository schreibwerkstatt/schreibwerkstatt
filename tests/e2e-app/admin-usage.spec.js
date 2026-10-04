// Admin-Usage (Abrechnung + Kosten je User x Job) gegen die ECHTE App. Abrechnung: der Tab ist ein nachgeladenes
// Sub-Partial im adminUsageCard-Scope, seine Alpine-Ausdruecke laufen nur im
// vollen Baum. Ohne Admin-Key zeigt er den Hinweis; mit Daten die Vergleichs-
// tabellen. Der Report wird im zweiten Fall direkt in den Scope gesetzt — die
// Rechnung selbst deckt tests/unit/anthropic-billing.test.js ab.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp } = require('./_helpers/app');

async function openBillingTab(page) {
  await page.evaluate(async () => {
    window.__app.adminUsageTab = 'billing';
    await window.__app.toggleAdminUsageCard();
  });
  const pane = page.locator('[x-show="adminUsageTab === \'billing\'"]');
  await expect(pane).toBeVisible();
  return pane;
}

test('Abrechnung ohne Admin-Key: Hinweis statt Tabellen', async ({ page }) => {
  await bootApp(page);
  const pane = await openBillingTab(page);
  await expect(pane.locator('p.muted-msg').first()).toContainText(/Admin-Key|admin key/);
  await expect(pane.locator('table')).toHaveCount(0);
});

test('Deep-Link #admin/usage/billing laedt den Abrechnungs-Tab', async ({ page }) => {
  // Der Hash-Router oeffnet die Karte ZUERST und setzt den Tab danach —
  // der Tab-Watcher muss dann selbst laden, sonst bleibt das Pane leer.
  await bootApp(page);
  const billingReq = page.waitForRequest(r => new URL(r.url()).pathname === '/admin/usage/billing');
  await page.evaluate(() => { location.hash = '#admin/usage/billing'; });
  await billingReq;
  const pane = page.locator('[x-show="adminUsageTab === \'billing\'"]');
  await expect(pane).toBeVisible();
  await expect(pane.locator('p.muted-msg').first()).toContainText(/Admin-Key|admin key/);
});

// Jeder Tab einzeln: laedt beim Oeffnen zuerst ein anderer Tab, darf der
// Load des richtigen nicht verpuffen.
for (const [tab, path] of [
  ['jobs', '/admin/usage/jobs'], ['chat', '/admin/usage/chat'], ['summary', '/admin/usage/summary'],
  ['features', '/admin/usage/features'], ['time', '/admin/usage/time'],
]) {
  test(`Deep-Link #admin/usage/${tab} laedt den Tab`, async ({ page }) => {
    await bootApp(page);
    const req = page.waitForRequest(r => new URL(r.url()).pathname === path);
    await page.evaluate(h => { location.hash = h; }, `#admin/usage/${tab}`);
    await req;
  });
}

test('Schneller Tab-Wechsel: neuer Tab laedt, waehrend der vorige noch laeuft', async ({ page }) => {
  await bootApp(page);
  // Users-Load kuenstlich haengen lassen, bis der Jobs-Tab angeklickt ist.
  let releaseUsers;
  const usersHeld = new Promise(r => { releaseUsers = r; });
  await page.route(u => new URL(u).pathname === '/admin/usage/users', async route => {
    await usersHeld;
    await route.continue();
  });
  const jobsReq = page.waitForRequest(r => new URL(r.url()).pathname === '/admin/usage/jobs');
  await page.evaluate(() => { location.hash = '#admin/usage'; });
  await expect(page.locator('.card--admin-usage')).toBeVisible();
  await page.evaluate(() => { window.__app.adminUsageTab = 'jobs'; });
  await jobsReq;
  releaseUsers();
  await expect(page.locator('.card--admin-usage [x-show="adminUsageLoading"]')).toBeHidden();
});

test('Abrechnung mit Daten: KPIs, Modell- und Tagestabelle, Abweichung markiert', async ({ page }) => {
  await bootApp(page);
  const pane = await openBillingTab(page);
  await page.evaluate(() => {
    const c = window.Alpine.$data(document.querySelector('[x-data="adminUsageCard"]'));
    c.adminUsageBilling = {
      configured: true, workspace: 'wrkspc_app', fromDay: '2026-09-01', toDay: '2026-09-03',
      lastFetchedAt: '2026-09-02T05:15:00.000Z', lastError: null,
      totals: { billedUsd: 12, ledgerUsd: 10, diffUsd: 2, diffPct: 0.2, coveredDays: 1 },
      days: [
        { day: '2026-09-01', billedUsd: 12, ledgerUsd: 10, diffUsd: 2, diffPct: 0.2 },
        { day: '2026-09-02', billedUsd: null, ledgerUsd: 1, diffUsd: null, diffPct: null },
      ],
      models: [
        { key: 'claude-opus-5-5', billedUsd: 11.5, ledgerUsd: 10, diffUsd: 1.5, diffPct: 0.15 },
        { key: 'cost:web_search', billedUsd: 0.5, ledgerUsd: 0, diffUsd: 0.5, diffPct: null },
      ],
      workspaces: [{ workspace_id: 'wrkspc_app', usd: 12 }, { workspace_id: null, usd: 3 }],
    };
  });
  await expect(pane.locator('table')).toHaveCount(2);
  await expect(pane.locator('table').first().locator('tbody tr')).toHaveCount(2);
  await expect(pane.locator('table').first()).toContainText(/Web-Suche|Web search/);
  await expect(pane.locator('.admin-usage-diff--off').first()).toBeVisible();
  await expect(pane.locator('table').nth(1)).toContainText(/nicht abgerufen|not fetched/);
  await expect(pane.locator('.admin-usage-billing-ws li')).toHaveCount(2);
});

// Users-Tab: Aufschluesselung je User x Job-Typ + Matrix (admin-usage-breakdown.html).
async function openUsersTab(page) {
  await page.evaluate(async () => {
    window.__app.adminUsageTab = 'users';
    await window.__app.toggleAdminUsageCard();
  });
  const pane = page.locator('[x-show="adminUsageTab === \'users\'"]');
  await expect(pane).toBeVisible();
  return pane;
}

test('Users-Tab: Matrix + Aufschluesselung pro User', async ({ page }) => {
  await bootApp(page);
  const pane = await openUsersTab(page);
  await page.evaluate(() => {
    const c = window.Alpine.$data(document.querySelector('[x-data="adminUsageCard"]'));
    c.adminUsageBreakdown = [
      { email: 'anna@ex.com', source: 'job', type: 'komplett-analyse', calls: 2, usd: 6, tokensIn: 2e6, tokensOut: 0 },
      { email: 'anna@ex.com', source: 'chat', type: 'book', calls: 5, usd: 1.5, tokensIn: 0, tokensOut: 1e5 },
      { email: 'ben@ex.com', source: 'job', type: 'check', calls: 1, usd: 0.3, tokensIn: 1e5, tokensOut: 0 },
      { email: '', source: 'job', type: 'check', calls: 1, usd: 0.1, tokensIn: 1e4, tokensOut: 0 },
    ];
  });
  const matrix = pane.locator('.admin-usage-breakdown-matrix table');
  await expect(matrix.locator('tbody tr')).toHaveCount(3);
  await expect(matrix.locator('thead th')).toHaveCount(1 + 3 + 2); // User + 3 Typen + Übrige + Total

  await matrix.locator('tbody .internal-link', { hasText: 'anna@ex.com' }).click();
  const detail = pane.locator('.admin-usage-breakdown-detail');
  await expect(detail).toBeVisible();
  await expect(detail.locator('tbody tr')).toHaveCount(2);
  await expect(detail).toContainText(/Buch-Chat|Book chat/);
  await expect(detail).toContainText('80 %');
});

test('Schalter „Admins einbeziehen“ steuert includeAdmins im Request', async ({ page }) => {
  await bootApp(page);
  await openUsersTab(page);
  const toggle = page.locator('.admin-usage-range .toggle-switch__btn');
  await expect(toggle).toBeVisible();
  const req = page.waitForRequest(r => r.url().includes('/admin/usage/users'));
  await toggle.click(); // Default an → aus
  expect(new URL((await req).url()).searchParams.get('includeAdmins')).toBeNull();
  const req2 = page.waitForRequest(r => r.url().includes('/admin/usage/breakdown'));
  await toggle.click();
  expect(new URL((await req2).url()).searchParams.get('includeAdmins')).toBe('1');
});

test('Chat-Tab: Bewertungs-Filter schickt feedback=down und zeigt die Bewertung', async ({ page }) => {
  await bootApp(page);
  // Liste der Daumen-runter-Antworten: nur Metadaten, die Spalte zeigt 👎.
  await page.route(u => new URL(u).pathname === '/admin/usage/chat', route => {
    const fb = new URL(route.request().url()).searchParams.get('feedback');
    const rows = fb === 'down'
      ? [{ id: 1, sessionId: 1, userEmail: 'anna@ex.com', createdAt: '2026-10-01T10:00:00.000Z',
           sessionKind: 'book', bookId: 7, model: 'm-x', feedback: -1,
           tokensIn: 10, tokensOut: 5, cacheReadIn: 0, usd: 0.01 }]
      : [];
    return route.fulfill({ json: { rows, total: rows.length } });
  });
  const first = page.waitForRequest(r => new URL(r.url()).pathname === '/admin/usage/chat');
  await page.evaluate(() => { location.hash = '#admin/usage/chat'; });
  await first;
  const pane = page.locator('[x-show="adminUsageTab === \'chat\'"]');
  await expect(pane.locator('.admin-usage-filter label')).toHaveCount(2);
  const req = page.waitForRequest(r => new URL(r.url()).pathname === '/admin/usage/chat'
    && new URL(r.url()).searchParams.get('feedback') === 'down');
  await page.evaluate(() => { Alpine.$data(document.querySelector('.card--admin-usage')).adminUsageChatFeedback = 'down'; });
  await req;
  await expect(pane.locator('table.data-table tbody tr').last()).toContainText('👎');
  await expect(pane.locator('table.data-table tbody tr').last()).toContainText('m-x');
});
