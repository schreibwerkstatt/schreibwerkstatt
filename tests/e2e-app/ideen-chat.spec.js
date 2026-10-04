// Ideen-Chat gegen die ECHTE App: Vorschläge einzeln übernehmen.
//
// Der KI-Lauf selbst ist nicht Gegenstand (Handler: tests/unit/ideen-chat-
// tools.test.mjs, Job: tests/unit/ideen-chat-job.test.js). Hier zählt, was nur
// die gebootete App zeigt: das Panel neben dem Board, die Vorschlagskarten samt
// Beleg, das Übernehmen über die echten /ideen-Routen (Ort, Stufe, neue Idee) und
// die Blockade einer Verknüpfung, deren neue Idee noch nicht übernommen ist.
// Die Assistant-Nachricht wird in den Karten-State gelegt; nur der Status-PATCH
// (der eine echte chat_messages-Zeile bräuchte) ist geroutet.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard.js');
const { bootApp, selectSeededBook } = require('./_helpers/app.js');

const CARD = '.card--ideenboard';

const boardData = (page, fn, arg) => page.evaluate(([src, a]) => {
  const data = window.Alpine.$data(document.querySelector('.card--ideenboard'));
  return new Function('d', 'a', src)(data, a);
}, [fn, arg]);

test('Ideen-Chat: Ort, Stufe mit Beleg und neue Idee einzeln übernehmen', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  const made = await page.evaluate(async (id) => {
    const tree = await fetch(`/content/books/${id}/tree`).then(r => r.json());
    const chapter = tree.chapters?.[0];
    const pageId = chapter?.pages?.[0]?.id;
    const post = (payload) => fetch('/ideen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: id, ...payload }),
    }).then(r => r.json());
    const bookIdee = await post({ content: 'Chat-Test: Idee ohne Ort' });
    const pageIdee = await post({ page_id: pageId, content: 'Chat-Test: Pendenz am Abschnitt' });
    return { chapterId: chapter.id, pageId, bookIdee: bookIdee.id, pageIdee: pageIdee.id };
  }, bookId);
  expect(made.pageId, 'Seed-Buch braucht eine Seite in einem Kapitel').toBeTruthy();

  await page.route('**/ideen/chat-proposal', async (route) => {
    const body = route.request().postDataJSON();
    const proposal = body.action === 'applied'
      ? { applied_at: new Date().toISOString(), applied_id: body.applied_id }
      : (body.action === 'discarded' ? { status: 'discarded' } : {});
    await route.fulfill({ json: { proposal } });
  });

  await page.evaluate(() => window.__app.toggleIdeenBoardCard());
  await expect(page.locator(CARD)).toBeVisible();
  await page.waitForFunction((id) => window.Alpine.$data(document.querySelector('.card--ideenboard')).ideen.some(i => i.id === id), made.pageIdee);

  // Panel öffnen; das Öffnen legt asynchron eine Session an und leert dabei den
  // Verlauf — erst danach die Nachricht einspielen.
  await page.locator(`${CARD} .card-header button[aria-pressed]`).first().click();
  await expect(page.locator(`${CARD} .ideen-chat`)).toBeVisible();
  await expect(page.locator(`${CARD} .ideen-chat-starters button`)).toHaveCount(3);
  await page.waitForFunction(() => window.Alpine.$data(document.querySelector('.card--ideenboard')).ideenChatSessionId != null);

  await boardData(page, `
    d.ideenChatMessages = [{
      id: 987655, role: 'assistant', content: 'Drei Vorschläge.',
      context_info: { mode: 'ideen', proposals: [
        { type: 'idee_update', ref: 1, idee_id: a.bookIdee, fields: { page_id: a.pageId },
          before: { page_id: null, chapter_id: null }, labels: { idee: 'Idee ohne Ort', anchor: 'Seite', anchor_before: null } },
        { type: 'idee_update', ref: 2, idee_id: a.pageIdee, fields: { status: 'erledigt' }, before: { status: 'offen' },
          beleg: { text: 'Zitat aus dem Text', page_id: a.pageId }, labels: { idee: 'Pendenz', beleg_page: 'Seite' }, begruendung: 'eingelöst' },
        { type: 'idee_create', ref: 3, fields: { content: 'Chat-Test: neue Idee', chapter_id: a.chapterId }, labels: { anchor: 'Kapitel' } },
        { type: 'link_create', ref: 4, idee_ref: 3, target_kind: 'beat', target_id: 1, labels: { idee: 'neue Idee', target: 'Beat' } },
      ] },
    }];`, made);

  const cards = page.locator(`${CARD} .ideen-chat .chat-vorschlag`);
  await expect(cards).toHaveCount(4);
  const applyBtn = (i) => cards.nth(i).locator('.chat-vorschlag-btn').first();
  const idee = (id) => boardData(page, 'const i = d.ideen.find(x => x.id === a); return i && { status: i.status, page_id: i.page_id };', id);

  // Beleg der Stufen-Änderung steht als Zitat mit Sprung in den Abschnitt.
  await expect(cards.nth(1).locator('.ideen-chat-beleg q')).toHaveText('Zitat aus dem Text');
  await expect(cards.nth(1).locator('.ideen-chat-beleg .entity-ref')).toBeVisible();

  // ── Ort: Buch-Idee bekommt den Abschnitt ──────────────────────────────────
  await applyBtn(0).click();
  await expect(cards.nth(0).locator('.chat-vorschlag-label')).toHaveText('Übernommen');
  expect((await idee(made.bookIdee)).page_id).toBe(made.pageId);

  // ── Stufe: erledigt ───────────────────────────────────────────────────────
  await applyBtn(1).click();
  await expect(cards.nth(1).locator('.chat-vorschlag-label')).toHaveText('Übernommen');
  expect((await idee(made.pageIdee)).status).toBe('erledigt');

  // ── Verknüpfung mit idee_ref: blockiert, bis die neue Idee übernommen ist ─
  await expect(applyBtn(3)).toBeDisabled();
  await applyBtn(2).click();
  await expect(cards.nth(2).locator('.chat-vorschlag-label')).toHaveText('Übernommen');
  await expect(applyBtn(3)).toBeEnabled();

  // Persistiert: nach Board-Reload steht alles so da.
  await boardData(page, 'return d.loadBoard();');
  expect(await idee(made.bookIdee)).toEqual({ status: 'offen', page_id: made.pageId });
  expect((await idee(made.pageIdee)).status).toBe('erledigt');
  expect(await boardData(page, 'return d.ideen.some(i => i.content === "Chat-Test: neue Idee" && i.chapter_id === a);', made.chapterId)).toBe(true);

  expect(guard.unmatched().map((f) => `[${f.channel}] ${f.text}`)).toEqual([]);
});
