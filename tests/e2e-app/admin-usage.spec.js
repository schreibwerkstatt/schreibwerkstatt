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
  ['features', '/admin/usage/features'], ['time', '/admin/usage/time'], ['behavior', '/admin/usage/behavior'],
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

test('Verhalten mit Daten: Vorschlaege, Jobs, nie geoeffnete Funktionen, Kohorten', async ({ page }) => {
  // Zwei nachgeladene Partials (admin-usage-behavior + -more) im Karten-Scope;
  // ihre Ausdruecke laufen nur im vollen Baum. Report direkt in den Scope.
  await bootApp(page);
  await page.evaluate(async () => {
    window.__app.adminUsageTab = 'behavior';
    await window.__app.toggleAdminUsageCard();
  });
  const pane = page.locator('[x-show="adminUsageTab === \'behavior\'"]');
  await expect(pane).toBeVisible();
  await page.evaluate(() => {
    const c = window.Alpine.$data(document.querySelector('[x-data="adminUsageCard"]'));
    c.adminUsageBehavior = {
      activity: { activeUsers: 2, weekly: [{ week: '2026-10-26', activeUsers: 2, activeSeconds: 3600, activeDays: 3 }] },
      sessions: 5, logins: 2, booksCreated: 1,
      features: [{ feature: 'plot', opens: 4, users: 1, lastAt: '2026-10-30T10:00:00.000Z', sources: { palette: 3, tile: 1 }, medianSec: 125, totalSec: 600 }],
      jobs: [{ type: 'check', queued: 3, done: 2, error: 1, cancelled: 0, users: 1, medianSec: 40 }],
      proposals: [{ chat: 'plot', kind: 'beat_update', applied: 3, discarded: 1, reopened: 0, undone: 0, users: 1 }],
      lektorat: { runs: 1, users: 1, shown: 10, selected: 6, applied: 5, skipped: 1 },
      editors: [{ editor: 'focus', opens: 2, users: 1, sessions: 2, medianSec: 900, totalSec: 1800 }],
      hours: Array.from({ length: 24 }, (_, h) => (h === 9 ? 2 : 0)),
      tools: [{ event: 'dictation.start', count: 4, users: 1 }],
      cohorts: [{ email: 'neu@test.dev', displayName: 'Neu', startDate: '2026-10-01', activeDays7: 3, activeDays30: 9, activeDaysTotal: 12, activeWeeks: 4, lastActive: '2026-10-30' }],
      panels: [{ panel: 'ideen', editor: 'notebook', opens: 7, users: 1, medianSec: 300, totalSec: 2400 }],
      pageViews: { total: { views: 9, pages: 4, readSec: 600, editSec: 1200 },
        perUser: [{ email: 'leserin@test.dev', displayName: 'Leserin', views: 9, pages: 4, readSec: 600, editSec: 1200, changedShare: 0.5, returnShare: 0.25 }] },
      friction: [{ key: 'conflict.merged', count: 2, users: 1 }, { key: 'discard.keep', count: 0, users: 0 }],
    };
  });
  await expect(pane.locator('tr', { hasText: /Beat ändern|Edit beat/ })).toContainText('75 %');
  await expect(pane.locator('tr', { hasText: /Plot-Werkstatt|Plot/ }).first()).toBeVisible();
  // Funktionen ohne Oeffnung stehen mit 0 in der Tabelle (gedimmt).
  await expect(pane.locator('tr.admin-usage-row--muted').first()).toBeVisible();
  await expect(pane.locator('tr', { hasText: 'neu@test.dev' })).toBeVisible();
  await expect(pane.locator('canvas').first()).toBeVisible();
  // Dritter Teil (admin-usage-behavior-flow): Werkzeuge, Abschnitts-Besuche, Reibung.
  await expect(pane.locator('tr', { hasText: /Ideen zum Abschnitt|Ideas for the section/ })).toContainText('7');
  await expect(pane.locator('tr', { hasText: 'leserin@test.dev' })).toContainText('25 %');
  await expect(pane.locator('tr', { hasText: /still zusammengeführt|merged silently/ })).toContainText('2');
  await expect(pane.locator('tr.admin-usage-row--muted', { hasText: /behalten|kept/ })).toBeVisible();
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

test('Summary: leerer Zeitraum raeumt die Charts ab und zeigt den Leerzustand', async ({ page }) => {
  await bootApp(page);
  let empty = false;
  await page.route(u => new URL(u).pathname === '/admin/usage/summary', route => route.fulfill({ json: empty
    ? { totals: { usd: 0 }, topUsers: [], byModel: [], byType: [] }
    : { totals: { usd: 3 }, topUsers: [{ email: 'anna@ex.com', usd: 2 }], byModel: [{ model: 'm-x', usd: 3 }],
        byType: [{ type: 'check', usd: 3 }] } }));
  const first = page.waitForResponse(r => new URL(r.url()).pathname === '/admin/usage/summary');
  await page.evaluate(() => { location.hash = '#admin/usage/summary'; });
  await first;
  const pane = page.locator('#admin-usage-pane-summary');
  await expect(pane.locator('canvas[role="img"]').first()).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    Object.keys(Alpine.$data(document.querySelector('.card--admin-usage'))._adminUsageCharts || {}).length)).toBe(3);

  empty = true;
  const second = page.waitForResponse(r => new URL(r.url()).pathname === '/admin/usage/summary');
  await page.evaluate(() => { Alpine.$data(document.querySelector('.card--admin-usage')).adminUsageFrom = '2020-01-01'; });
  await second;
  await expect(pane.locator('canvas').first()).toBeHidden();
  await expect(pane.locator('figure .muted-msg')).toHaveCount(3);
  await expect(pane.locator('figure .muted-msg').first()).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    Object.keys(Alpine.$data(document.querySelector('.card--admin-usage'))._adminUsageCharts || {}).length)).toBe(0);
});

test('Jobs-Tab: «Weitere laden» haengt die naechste Seite an, Filter beginnt wieder vorn', async ({ page }) => {
  await bootApp(page);
  const offsets = [];
  await page.route(u => new URL(u).pathname === '/admin/usage/jobs', route => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
    offsets.push(offset);
    const n = Math.min(50, 70 - offset);
    const rows = Array.from({ length: n }, (_, i) => ({ id: offset + i + 1, userEmail: 'anna@ex.com', type: 'check',
      model: 'm-x', tokensIn: 1, tokensOut: 1, cacheReadIn: 0, cacheCreationIn: 0, usd: 0.01, bookId: 1,
      queuedAt: '2026-10-01T10:00:00.000Z' }));
    return route.fulfill({ json: { rows, total: 70 } });
  });
  const first = page.waitForResponse(r => new URL(r.url()).pathname === '/admin/usage/jobs');
  await page.evaluate(() => { location.hash = '#admin/usage/jobs'; });
  await first;
  const pane = page.locator('#admin-usage-pane-jobs');
  await expect(pane.locator('tbody tr')).toHaveCount(50);
  await expect(pane.locator('.admin-usage-more')).toContainText(/50 (von|of) 70/);
  await pane.locator('.admin-usage-more button').click();
  await expect(pane.locator('tbody tr')).toHaveCount(70);
  await expect(pane.locator('.admin-usage-more')).toContainText(/70 (von|of) 70/);
  await expect(pane.locator('.admin-usage-more button')).toBeHidden();
  expect(offsets).toEqual([0, 50]);

  // Zeitraum-/Filterwechsel laedt wieder ab der ersten Seite.
  const again = page.waitForResponse(r => new URL(r.url()).pathname === '/admin/usage/jobs');
  await page.locator('.admin-usage-range .toggle-switch__btn').click();
  await again;
  expect(offsets[2]).toBe(0);
  await expect(pane.locator('tbody tr')).toHaveCount(50);
});

test('Users-Tab: «Gespeichert» verschwindet nach zwei Sekunden', async ({ page }) => {
  await bootApp(page);
  await page.route(u => new URL(u).pathname === '/admin/usage/users', route => route.fulfill({ json: {
    users: [{ email: 'anna@ex.com', displayName: 'Anna', usd: 1, tokensIn: 1, tokensOut: 1, monthlyBudgetUsd: null, budgetMode: 'none' }],
  } }));
  await page.route(u => new URL(u).pathname === '/admin/usage/breakdown', route => route.fulfill({ json: { rows: [] } }));
  await page.route(u => new URL(u).pathname.startsWith('/admin/users/'), route => route.fulfill({ json: {
    user: { monthly_budget_usd: 5, budget_mode: 'soft' },
  } }));
  const pane = await openUsersTab(page);
  const save = pane.locator('.admin-usage-actions button').first();
  await expect(save).toHaveText(/^(Speichern|Save)$/);
  await save.click();
  await expect(save).toHaveText(/^(Gespeichert|Saved)$/);
  await expect(save).toHaveText(/^(Speichern|Save)$/, { timeout: 4000 });
});

test('Tabs: Pfeiltaste wechselt den Tab, Panes sind per aria verknuepft', async ({ page }) => {
  await bootApp(page);
  await openUsersTab(page);
  const tab = page.locator('#admin-usage-tab-users');
  await expect(tab).toHaveAttribute('aria-controls', 'admin-usage-pane-users');
  await expect(page.locator('#admin-usage-pane-users')).toHaveAttribute('role', 'tabpanel');
  const jobsReq = page.waitForRequest(r => new URL(r.url()).pathname === '/admin/usage/jobs');
  await tab.focus();
  await page.keyboard.press('ArrowRight');
  await jobsReq;
  await expect(page.locator('#admin-usage-tab-jobs')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#admin-usage-tab-jobs')).toBeFocused();
});
