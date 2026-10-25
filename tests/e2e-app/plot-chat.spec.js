// Plot-Chat gegen die ECHTE App: Vorschläge einzeln übernehmen.
//
// Der KI-Lauf selbst ist nicht Gegenstand (Werkzeug-Logik: tests/unit/plot-chat-
// tools.test.mjs, Job: tests/unit/plot-chat-job.test.js). Hier zählt, was nur die
// gebootete App zeigt: die Vorschlagskarte im Panel, das Übernehmen über die
// echten /plot-Routen (Beat/Akt erscheint im Board), das Undo der Board-Historie
// und die Blockade eines Beats, dessen neuer Akt noch nicht übernommen ist.
// Die Assistant-Nachricht wird in den Karten-State gelegt; nur der Status-PATCH
// (der eine echte chat_messages-Zeile bräuchte) ist geroutet.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard.js');
const { bootApp, selectSeededBook } = require('./_helpers/app.js');

const BOARD = '#partial-plot-board-flat';
const ACT_NAME = 'Chat-Test-Akt';

async function openPlot(page) {
  await page.evaluate(() => window.__app.togglePlotCard());
  await expect(page.locator('.card--plot')).toBeVisible();
  // Board geladen: Leer-Zustand-Button oder Akt-anlegen-Button sichtbar.
  await expect(page.locator(`.card--plot .card-empty .card-empty-cta, ${BOARD} .plot-add-act-btn`)
    .filter({ visible: true }).first()).toBeVisible();
}

async function addAct(page, name) {
  const input = page.locator(`${BOARD} .plot-new-act-input`);
  if (!(await input.isVisible())) {
    const emptyBtn = page.locator('.card--plot .card-empty .card-empty-cta');
    if (await emptyBtn.isVisible()) await emptyBtn.click();
    else await page.locator(`${BOARD} .plot-add-act-btn`).first().click();
  }
  await input.fill(name);
  await input.press('Enter');
  await expect(page.locator(`${BOARD} .plot-column-title`, { hasText: name })).toBeVisible();
}

const plotData = (page, fn, arg) => page.evaluate(([src, a]) => {
  const data = window.Alpine.$data(document.querySelector('.card--plot'));
  return new Function('d', 'a', src)(data, a);
}, [fn, arg]);

test('Plot-Chat: Vorschläge einzeln übernehmen, Undo, Akt-Bezug blockiert bis übernommen', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  await openPlot(page);
  await addAct(page, ACT_NAME);
  const actId = await plotData(page, 'return d.acts.find(x => x.name === a).id;', ACT_NAME);

  // Status-PATCH: Echo mit applied_at/applied_id bzw. status (keine DB-Nachricht nötig).
  await page.route('**/plot/chat-proposal', async (route) => {
    const body = route.request().postDataJSON();
    const proposal = body.action === 'applied'
      ? { applied_at: new Date().toISOString(), applied_id: body.applied_id }
      : (body.action === 'discarded' ? { status: 'discarded' } : {});
    await route.fulfill({ json: { proposal } });
  });

  // Panel öffnen (Toggle am Ende der Kopf-Aktionen).
  await page.locator('.card--plot .card-actions button[aria-pressed]').last().click();
  await expect(page.locator('.card--plot .plot-chat')).toBeVisible();
  await expect(page.locator('.card--plot .plot-chat-input')).toBeVisible();
  // Das Öffnen legt asynchron eine Session an und leert dabei den Verlauf — erst
  // danach die Nachricht einspielen, sonst überschreibt der Reset sie.
  await page.waitForFunction(() => window.Alpine.$data(document.querySelector('.card--plot')).plotChatSessionId != null);

  await plotData(page, `
    d.plotChatMessages = [{
      id: 987654, role: 'assistant', content: 'Drei Vorschläge.',
      context_info: { mode: 'plot', tool_calls: [
        { name: 'get_plot_board', ok: true, iter: 1, input: { act_id: a }, view: { subject: [{ t: 'ref', k: 'act', id: String(a), v: 'Akt Test' }], result: null } },
        { name: 'final_answer', ok: true, iter: 2 },
      ], proposals: [
        { type: 'beat_create', ref: 1, act_id: a, thread_id: null, fields: { titel: 'Chat-Beat Eins' }, labels: { act: 'x' }, begruendung: 'Auftakt' },
        { type: 'beat_create', ref: 2, act_ref: 3, thread_id: null, fields: { titel: 'Chat-Beat im neuen Akt' }, labels: { act: 'Neuer Akt' } },
        { type: 'act_create', ref: 3, name: 'Chat-Akt Neu', thread_id: null, labels: {} },
      ] },
    }];`, actId);

  const cards = page.locator('.card--plot .plot-chat .chat-vorschlag');
  await expect(cards).toHaveCount(3);

  // Werkzeug-Verlauf: dasselbe Fragment wie im Buch-Chat (chat-tool-log).
  const log = page.locator('.card--plot .plot-chat .chat-tool-log');
  await expect(log.locator('.collapsible-toggle')).toHaveText('Werkzeug-Verlauf (1)');
  await log.locator('.collapsible-toggle').click();
  await expect(log.locator('.chat-tool-log-row')).toHaveText(/Plot-Board gelesen\s*Akt Akt Test/);
  const applyBtn = (i) => cards.nth(i).locator('.chat-vorschlag-btn').first();

  // ── Neuer Beat: übernehmen → im Board, Karte „Übernommen" ────────────────
  await applyBtn(0).click();
  await expect(page.locator(`${BOARD} .plot-beat`, { hasText: 'Chat-Beat Eins' })).toBeVisible();
  await expect(cards.nth(0).locator('.chat-vorschlag-label')).toHaveText('Übernommen');

  // ── Undo der Board-Historie nimmt die Übernahme zurück → wieder übernehmbar ─
  await page.locator('.card--plot .card-actions button').first().click();
  await expect(page.locator(`${BOARD} .plot-beat`, { hasText: 'Chat-Beat Eins' })).toHaveCount(0);
  await expect(applyBtn(0)).toHaveText('Erneut übernehmen');

  // ── Beat mit act_ref: blockiert, bis der neue Akt übernommen ist ──────────
  await expect(applyBtn(1)).toBeDisabled();
  await applyBtn(2).click();
  await expect(page.locator(`${BOARD} .plot-column-title`, { hasText: 'Chat-Akt Neu' })).toBeVisible();
  await expect(applyBtn(1)).toBeEnabled();
  await applyBtn(1).click();
  const newCol = page.locator(`${BOARD} .plot-column`, { has: page.locator('.plot-column-title', { hasText: 'Chat-Akt Neu' }) });
  await expect(newCol.locator('.plot-beat', { hasText: 'Chat-Beat im neuen Akt' })).toBeVisible();

  // Persistiert: nach Board-Reload stehen Akt + Beat weiter da.
  await plotData(page, 'return d.loadBoard();');
  await expect(newCol.locator('.plot-beat', { hasText: 'Chat-Beat im neuen Akt' })).toBeVisible();

  expect(guard.unmatched().map((f) => `[${f.channel}] ${f.text}`)).toEqual([]);
});
