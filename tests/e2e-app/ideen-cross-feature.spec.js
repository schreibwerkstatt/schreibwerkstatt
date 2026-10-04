// Ideen in den anderen Ansichten, gegen die ECHTE App.
//
// WARUM DIESE SCHICHT: alle drei Stellen entstehen erst im gebooteten Template-Baum
// (String-Includes in x-for, Partial-Platzhalter der Buchübersicht) — der Smoke
// öffnet die Karten, klappt aber weder einen Strang noch eine Werkstatt-Figur auf
// und legt keine Ideen an.
//
// Geprüfte Invarianten:
//   1. Buchübersicht: Kachel „Ideen" zählt die offenen Ideen.
//   2. Plot-Grid: eine Idee am Strang erscheint als Referenz im Strang-Kopf.
//   3. Figuren-Werkstatt: eine Idee an der Werkstatt-Figur erscheint in der Titelzeile.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const IDEE_STRANG = 'Strang-Pendenz: Wendepunkt fehlt';
const IDEE_FIGUR = 'Figur-Pendenz: Bogen klären';

async function postJson(page, url, body) {
  return page.evaluate(async ({ u, b }) => {
    const res = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    return res.json();
  }, { u: url, b: body });
}

test('Ideen erscheinen in Buchübersicht, Strang-Kopf und Werkstatt-Figur', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  const act = await postJson(page, '/plot/acts', { book_id: bookId, name: 'Ideen-Akt' });
  const thread = await postJson(page, '/plot/threads', { book_id: bookId, name: 'Ideen-Strang' });
  await postJson(page, '/plot/beats', { book_id: bookId, act_id: act.id, thread_id: thread.id, titel: 'Beat im Strang' });
  const draft = await postJson(page, `/draft-figures/${bookId}`, { name: 'Ideen-Figur' });
  const i1 = await postJson(page, '/ideen', { book_id: bookId, content: IDEE_STRANG });
  const i2 = await postJson(page, '/ideen', { book_id: bookId, content: IDEE_FIGUR });
  expect(thread.id && draft.id && i1.id && i2.id).toBeTruthy();
  await postJson(page, `/ideen/${i1.id}/links`, { target_kind: 'thread', target_id: thread.id });
  await postJson(page, `/ideen/${i2.id}/links`, { target_kind: 'draft', target_id: draft.id });

  // 1. Buchübersicht
  await page.evaluate(async () => { await window.__app.toggleBookOverviewCard(); });
  const tile = page.locator('.overview-tile', { has: page.locator('.overview-tile-label', { hasText: /^Ideen$/ }) });
  await expect(tile).toBeVisible({ timeout: 15000 });
  await expect(tile.locator('.overview-fig-count')).not.toHaveText('0');

  // 2. Plot-Grid: Strang-Kopf
  await page.evaluate(async () => { await window.__app.togglePlotCard(); });
  const laneIdea = page.locator('.plot-swim-lane-text .idee-backlinks .entity-ref', { hasText: 'Wendepunkt fehlt' });
  await expect(laneIdea).toBeVisible({ timeout: 15000 });

  // 3. Figuren-Werkstatt: Titelzeile
  await page.evaluate(async (id) => { await window.__app.openWerkstattDraftById(id); }, draft.id);
  const draftIdea = page.locator('.werkstatt-detail-titlebar .idee-backlinks .entity-ref', { hasText: 'Bogen klären' });
  await expect(draftIdea).toBeVisible({ timeout: 15000 });
});
