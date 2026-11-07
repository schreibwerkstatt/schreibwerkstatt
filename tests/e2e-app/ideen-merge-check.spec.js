// Zusammenführen und Auto-Erledigt-Hinweis gegen die ECHTE App:
//  - Ideen-Chat: Vorschlag `idee_merge` übernehmen → Quellen weg, Zieltext neu
//    (echte Route POST /ideen/:id/merge)
//  - Board-Liste: Sammelaktion «Zusammenführen» mit Rückfrage
//  - Hinweis an der Board-Karte (Fragment ideen-check-hint): «Noch offen»
//    verwirft ihn (DELETE /ideen/:id/check-hint), «Erledigt» setzt die Stufe
// Der Hinweis selbst entsteht serverseitig im KI-Job (tests/unit/ideen-auto-check.test.js);
// hier wird er in den Board-State gelegt, um Markup und Schreibwege zu prüfen.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard.js');
const { bootApp, selectSeededBook } = require('./_helpers/app.js');

const CARD = '.card--ideenboard';
const PREFIX = 'E2E-Merge ';

const boardData = (page, fn, arg) => page.evaluate(([src, a]) => {
  const data = window.Alpine.$data(document.querySelector('.card--ideenboard'));
  return new Function('d', 'a', src)(data, a);
}, [fn, arg]);

async function seed(page, bookId, contents) {
  return page.evaluate(async ({ id, list, prefix }) => {
    const board = await fetch(`/ideen/board?book_id=${id}`).then(r => r.json());
    await Promise.all((board.ideen || []).filter(i => String(i.content).startsWith(prefix))
      .map(i => fetch(`/ideen/${i.id}`, { method: 'DELETE' })));
    const tree = await fetch(`/content/books/${id}/tree`).then(r => r.json());
    const pageId = tree.chapters?.[0]?.pages?.[0]?.id;
    const out = [];
    for (const c of list) {
      const r = await fetch('/ideen', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: id, page_id: pageId, content: prefix + c }),
      }).then(x => x.json());
      out.push(r.id);
    }
    return { ids: out, pageId };
  }, { id: bookId, list: contents, prefix: PREFIX });
}

async function openBoard(page, ids) {
  await page.evaluate(() => window.__app.toggleIdeenBoardCard());
  await expect(page.locator(CARD)).toBeVisible();
  await page.waitForFunction((want) => {
    const d = window.Alpine.$data(document.querySelector('.card--ideenboard'));
    return want.every(id => d.ideen.some(i => i.id === id));
  }, ids);
}

test('Ideen-Chat: Zusammenführen übernehmen — Quellen weg, Zieltext neu', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const { ids: [keep, dup] } = await seed(page, bookId, ['Kellerszene', 'Keller-Szene länger']);
  await page.route('**/ideen/chat-proposal', (route) => {
    const body = route.request().postDataJSON();
    if (body.action === 'claim') return route.fulfill({ json: { proposal: { claimed_at: new Date().toISOString() } } });
    return route.fulfill({ json: { proposal: { applied_at: new Date().toISOString(), applied_id: body.applied_id } } });
  });
  await openBoard(page, [keep, dup]);
  await page.locator(`${CARD} .card-header button[aria-pressed]`).first().click();
  await expect(page.locator('#ideen-chat-card')).toBeVisible();
  await page.waitForFunction(() => window.Alpine.$data(document.querySelector('.card--ideenboard')).ideenChatSessionId != null);

  await boardData(page, `
    d.ideenChatMessages = [{ id: 987700, role: 'assistant', content: 'Eine Dublette.', context_info: { mode: 'ideen', proposals: [
      { type: 'idee_merge', ref: 1, idee_id: a.keep, merge_ids: [a.dup], fields: { content: a.text },
        before: { content: a.before }, labels: { idee: 'Kellerszene', merged: [{ id: a.dup, text: 'Keller-Szene länger', anchor: 'Seite' }] },
        begruendung: 'derselbe Gedanke' },
    ] } }];`, { keep, dup, text: `${PREFIX}Kellerszene, länger`, before: `${PREFIX}Kellerszene` });

  const card = page.locator('#ideen-chat-card .chat-vorschlag');
  await expect(card.locator('.chat-vorschlag-label')).toHaveText('Zusammenführen');
  await expect(card.locator('.ideen-chat-merge-list li')).toHaveText(/Keller-Szene länger/);
  await expect(card.locator('.chat-word-diff')).toBeVisible();
  await card.locator('.chat-vorschlag-btn').first().click();
  // Zusammenführen löscht die Dublette — Rückfrage vor dem Schreiben.
  await page.locator('#app-confirm-dialog .confirm-dialog-btn--danger').click();
  await expect(card.locator('.chat-vorschlag-label')).toHaveText('Übernommen');

  const state = await boardData(page, 'return { dup: d.ideen.some(i => i.id === a.dup), text: d.ideen.find(i => i.id === a.keep)?.content };', { keep, dup });
  expect(state).toEqual({ dup: false, text: `${PREFIX}Kellerszene, länger` });
  await boardData(page, 'return d.loadBoard();');
  expect(await boardData(page, 'return d.ideen.some(i => i.id === a);', dup)).toBe(false);
  expect(guard.unmatched().map((f) => `[${f.channel}] ${f.text}`)).toEqual([]);
});

test('Board-Liste: zwei markierte Ideen zusammenführen', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const { ids: [first, second] } = await seed(page, bookId, ['Brief erwähnen', 'Brief der Mutter']);
  await openBoard(page, [first, second]);
  await boardData(page, 'd.setView("list"); d.query = a;', PREFIX);

  const merge = page.locator(`${CARD} .selection-bar button`, { hasText: 'Zusammenführen' });
  await page.locator(`${CARD} tr[data-idee-row-id="${first}"] input[type=checkbox]`).check();
  await expect(merge).toBeHidden();
  await page.locator(`${CARD} tr[data-idee-row-id="${second}"] input[type=checkbox]`).check();
  await merge.click();

  const field = page.locator('#app-confirm-dialog .confirm-dialog-field');
  await expect(field).toHaveValue(`${PREFIX}Brief erwähnen · ${PREFIX}Brief der Mutter`);
  await field.fill(`${PREFIX}Brief der Mutter erwähnen`);
  await page.locator('#app-confirm-dialog [x-ref="confirmDialogConfirmBtn"]').click();

  await expect(page.locator(`${CARD} tr[data-idee-row-id="${second}"]`)).toHaveCount(0);
  expect(await boardData(page, 'return d.ideen.find(i => i.id === a)?.content;', first)).toBe(`${PREFIX}Brief der Mutter erwähnen`);
  expect(guard.unmatched().map((f) => `[${f.channel}] ${f.text}`)).toEqual([]);
});

test('Hinweis an der Board-Karte: «Noch offen» verwirft, «Erledigt» setzt die Stufe', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const { ids: [a, b], pageId } = await seed(page, bookId, ['Tür abschliessen', 'Schlüssel verstecken']);
  await openBoard(page, [a, b]);
  await boardData(page, `
    d.query = a.prefix;
    d.ideen = d.ideen.map(i => (a.ids.includes(i.id)
      ? { ...i, check_hint: { beleg: 'Sie schliesst die Tür ab.', page_id: a.pageId, page_name: 'Seite', begruendung: 'steht da', at: '' } }
      : i));
    d._memos = {};`, { ids: [a, b], pageId, prefix: PREFIX });

  const hintOf = (id) => page.locator(`${CARD} [data-idee-card-id="${id}"] .idee-check-hint`);
  await expect(hintOf(a)).toBeVisible();
  await expect(hintOf(a).locator('q')).toHaveText('Sie schliesst die Tür ab.');
  await expect(hintOf(a).locator('.entity-ref')).toBeVisible();

  await hintOf(a).getByRole('button', { name: 'Noch offen' }).click();
  await expect(hintOf(a)).toHaveCount(0);
  expect(await boardData(page, 'return d.ideen.find(i => i.id === a).status;', a)).toBe('offen');

  await hintOf(b).getByRole('button', { name: 'Erledigt' }).click();
  await expect.poll(() => boardData(page, 'return d.ideen.find(i => i.id === a)?.status;', b)).toBe('erledigt');
  expect(guard.unmatched().map((f) => `[${f.channel}] ${f.text}`)).toEqual([]);
});
