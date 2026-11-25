// Job-Fortschritt `x-job-progress` gegen die ECHTE App (public/js/job-progress.js):
// ein laufender Job zeigt Balken + «Abbrechen», der Klick schickt DELETE /jobs/:id
// an den Job, den der Poller der Fläche verfolgt (Job-ID aus startPoll, `timer`),
// und der abgebrochene Lauf endet mit einer neutralen Statuszeile — kein Fehler.
// Geprüft an zwei Flächen mit `timer`: Erzählprofil-Karte (Komplettanalyse,
// createCardJobFeature) und Stapel-Lektorat in der Sidebar (Root-Poller).

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const json = (body, status = 200) => (route) => route.fulfill({
  status, contentType: 'application/json', body: JSON.stringify(body),
});
const tr = (page, key, params) => page.evaluate(([k, p]) => window.__app.t(k, p), [key, params || null]);

// Gemockter Job: läuft, bis DELETE kommt; danach `cancelled`.
async function mockJob(page, startUrl, jobId) {
  let cancelled = false;
  await page.route(startUrl, (r) => (r.request().method() === 'POST' ? json({ jobId })(r) : r.continue()));
  await page.route(`**/jobs/${jobId}`, (r) => {
    if (r.request().method() === 'DELETE') { cancelled = true; return json({ ok: true })(r); }
    return json(cancelled
      ? { id: jobId, status: 'cancelled', error: 'job.cancelled', progress: 30 }
      : { id: jobId, status: 'running', progress: 30, statusText: 'job.phase.aiReply' })(r);
  });
}

async function cancelAndExpectNeutral(page, progress, jobId) {
  const cancelBtn = progress.locator('.job-progress-cancel');
  await expect(cancelBtn).toBeVisible({ timeout: 10000 });
  await expect(progress.locator('.progress-bar-wrap')).toBeVisible();
  const del = page.waitForRequest((r) => r.method() === 'DELETE' && r.url().endsWith(`/jobs/${jobId}`));
  await cancelBtn.click();
  await del;
  const status = progress.locator('.card-status');
  await expect(status).toHaveText(await tr(page, 'job.cancelled'), { timeout: 10000 });
  await expect(progress.locator('.error-msg')).toHaveCount(0);
  await expect(cancelBtn).toBeHidden();
  await expect(progress.locator('.progress-bar-wrap')).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  // Ohne Event-Stream pollt startPoll alle 2 s; der Stream schickte für den
  // gemockten Job nie das Ende.
  await page.route('**/events/stream**', (r) => r.fulfill({ status: 204, body: '' }));
});

test('Erzählprofil: laufender Job zeigt Abbrechen, Abbruch ist kein Fehler', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  await mockJob(page, '**/jobs/erzaehlprofil', 'job-ep-x');
  await page.evaluate(() => window.__app.toggleErzaehlprofilCard());
  const card = page.locator('.card--erzaehlprofil');
  await expect(card).toBeVisible();
  await page.evaluate(() => window.Alpine.$data(document.querySelector('.card--erzaehlprofil')).runErzaehlprofil());
  await cancelAndExpectNeutral(page, card.locator('.job-progress'), 'job-ep-x');
  guard.assertClean('Erzählprofil abbrechen');
});

test('Stapel-Lektorat (Sidebar): laufender Job zeigt Abbrechen, Abbruch ist kein Fehler', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  await mockJob(page, '**/jobs/batch-check', 'job-batch-x');
  // Rückfrage bestätigen, ohne den Dialog zu bedienen (appConfirm ist nicht Teil der Prüfung).
  await page.evaluate(() => { window.__app.appConfirm = async () => true; window.__app.batchCheck(); });
  await cancelAndExpectNeutral(page, page.locator('.job-progress.batch-progress'), 'job-batch-x');
  guard.assertClean('Stapel-Lektorat abbrechen');
});

// Lektorat (stabilisiert, docs/lektorat.md): Prüflauf eines Abschnitts im
// Notebook-Editor. Der Poller hängt per Abschnitt in `_checkPollTimers` —
// Abbrechen über `cancelLektoratCheck`, nicht über `timer`.
test('Lektorat-Prüflauf (Notebook): Abbrechen im Fortschritt, Abbruch ist kein Fehler', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
  await mockJob(page, '**/jobs/check', 'job-check-x');
  await page.evaluate(() => window.__app.runCheck());
  const progress = page.locator('.job-progress.lektorat-check-progress');
  const cancelBtn = progress.locator('.job-progress-cancel');
  await expect(cancelBtn).toBeVisible({ timeout: 10000 });
  const del = page.waitForRequest((r) => r.method() === 'DELETE' && r.url().endsWith('/jobs/job-check-x'));
  await cancelBtn.click();
  await del;
  await expect.poll(() => page.evaluate(() => window.__app.checkLoading), { timeout: 10000 }).toBe(false);
  // Ergebnis-Fläche: neutrale Meldung statt «Fehler: …».
  const out = await page.evaluate(() => window.__app.analysisOut);
  expect(out).toContain(await tr(page, 'job.cancelled'));
  expect(out).not.toContain('error-msg');
  await expect(cancelBtn).toBeHidden();
  guard.assertClean('Lektorat-Prüflauf abbrechen');
});

// Gescheiterter Abbruch (DELETE → 500): der Job läuft weiter, «Abbrechen» muss
// wieder klickbar sein — der zweite Versuch bricht ab.
test('Abbrechen scheitert: Knopf wird wieder frei, zweiter Versuch bricht ab', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const jobId = 'job-ep-fail';
  let deletes = 0;
  let cancelled = false;
  await page.route('**/jobs/erzaehlprofil', (r) => (r.request().method() === 'POST' ? json({ jobId })(r) : r.continue()));
  await page.route(`**/jobs/${jobId}`, (r) => {
    if (r.request().method() === 'DELETE') {
      deletes += 1;
      if (deletes === 1) return json({ error_code: 'X' }, 500)(r);
      cancelled = true;
      return json({ ok: true })(r);
    }
    return json(cancelled
      ? { id: jobId, status: 'cancelled', error: 'job.cancelled', progress: 30 }
      : { id: jobId, status: 'running', progress: 30, statusText: 'job.phase.aiReply' })(r);
  });
  await page.evaluate(() => window.__app.toggleErzaehlprofilCard());
  const card = page.locator('.card--erzaehlprofil');
  await expect(card).toBeVisible();
  await page.evaluate(() => window.Alpine.$data(document.querySelector('.card--erzaehlprofil')).runErzaehlprofil());
  const progress = card.locator('.job-progress');
  const cancelBtn = progress.locator('.job-progress-cancel');
  await expect(cancelBtn).toBeVisible({ timeout: 10000 });
  const firstDel = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().endsWith(`/jobs/${jobId}`));
  await cancelBtn.click();
  await firstDel;
  await expect(cancelBtn).toBeEnabled({ timeout: 5000 });
  await cancelAndExpectNeutral(page, progress, jobId);
  expect(deletes).toBe(2);
});
