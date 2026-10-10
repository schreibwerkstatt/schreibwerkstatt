// Seiten-Chat gegen die ECHTE App: Senden → Vorschlag → Übernehmen /
// Rückgängig, Inline-Marken der Leseansicht, Titelvariante, und der
// Notebook-Edit-Modus (Übernahme landet im Live-Editor statt per Server-Write).
//
// Mock-AI auf Netzebene: POST /jobs/chat, das Job-Polling und das Nachladen der
// Session (GET /chat/session/:id) sind per `page.route` gestubbt — der Job-
// Worker bräuchte sonst einen echten Provider. Alles andere (Session anlegen,
// Seite laden/speichern, Rename) läuft gegen den echten Server. Die Vorschlags-
// PATCHes werden abgefangen und protokolliert (die Nachrichten-IDs der
// gemockten Antwort existieren serverseitig nicht).
//
// Eigene Wegwerf-Seite statt der Seed-Seiten: andere Specs zählen den Seed.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const PAGE_HTML = '<p>Der Hund bellt laut im Hof. Die Katze schläft am Ofen.</p>';
const VIEW_SEL = '#editor-card .page-content-view:not(.page-content-view--editing)';
const EDIT_SEL = '#editor-card .page-content-view--editing';

async function createPage(page) {
  return page.evaluate(async (html) => {
    const nav = window.Alpine.store('nav');
    const first = nav.pages[0];
    const r = await fetch('/content/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: nav.selectedBookId, chapter_id: first.chapter_id || undefined, name: 'E2E Seiten-Chat', html }),
    });
    if (!r.ok) throw new Error('createPage ' + r.status);
    const created = await r.json();
    const p = { ...created, chapterName: first.chapterName };
    nav.pages = [...nav.pages, p];
    await window.__app.selectPage(p);
    return created.id;
  }, PAGE_HTML);
}

async function deletePage(page, id) {
  await page.evaluate(async (pid) => { await fetch('/content/pages/' + pid, { method: 'DELETE' }); }, id);
}

async function serverHtml(page, id) {
  return page.evaluate(async (pid) => {
    const r = await fetch('/content/pages/' + pid, { cache: 'no-store' });
    return (await r.json()).html || '';
  }, id);
}

// Netz-Mocks für genau EINEN Chat-Turn. Liefert das PATCH-Protokoll.
// `contextInfo` ersetzt das context_info der Antwort (Ideen-Vorschläge).
async function mockChatTurn(page, pageId, contextInfo = { titel_varianten: ['Hofgeflüster', 'Stille im Hof'] }) {
  const patches = [];
  let answered = false;
  await page.route('**/jobs/chat', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    answered = true;
    await route.fulfill({ json: { jobId: 'e2e-page-chat-job' } });
  });
  await page.route('**/jobs/e2e-page-chat-job', (route) => route.fulfill({
    json: { id: 'e2e-page-chat-job', type: 'chat', status: 'done', progress: 100, result: { assistant_message_id: 900002 } },
  }));
  await page.route(/\/chat\/session\/\d+$/, async (route) => {
    if (route.request().method() !== 'GET' || !answered) return route.continue();
    const sid = Number(route.request().url().split('/').pop());
    await route.fulfill({
      json: {
        id: sid, kind: 'page', page_id: pageId, title: null,
        messages: [
          { id: 900001, role: 'user', content: 'Mach es leiser', vorschlaege: [], context_info: null },
          {
            id: 900002, role: 'assistant', content: 'Hier ein Vorschlag.',
            vorschlaege: [{ original: 'bellt laut', ersatz: 'bellt leise', begruendung: 'ruhiger' }],
            context_info: typeof contextInfo === 'function' ? contextInfo() : contextInfo,
          },
        ],
      },
    });
  });
  await page.route('**/ideen/chat-proposal', async (route) => {
    const body = route.request().postDataJSON();
    patches.push({ url: route.request().url(), body });
    await route.fulfill({ json: { proposal: body.action === 'applied' ? { applied_at: '2026-01-01T00:00:00.000Z', applied_id: body.applied_id } : body.action === 'discarded' ? { status: 'discarded' } : {} } });
  });
  await page.route('**/chat/message/*/vorschlag/*/*', async (route) => {
    patches.push({ url: route.request().url(), body: route.request().postDataJSON() });
    await route.fulfill({ json: { ok: true } });
  });
  return patches;
}

async function openChatAndSend(page) {
  await page.evaluate(() => window.__app.toggleChatCard());
  await expect(page.locator('#chat-card')).toBeVisible();
  await page.waitForFunction(() => !!window.Alpine.$data(document.getElementById('chat-card')).chatSessionId);
  await page.locator('#chat-card .chat-input').fill('Mach es leiser');
  await page.locator('#chat-card .chat-send-btn').click();
  await expect(page.locator('#chat-card .chat-vorschlaege:not(.chat-idee-vorschlaege) .chat-vorschlag')).toHaveCount(1);
}

test('Seiten-Chat (Leseansicht): Übernehmen speichert, Marke verschwindet, Rückgängig nimmt zurück, Titel übernehmen', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const pageId = await createPage(page);
  try {
    await page.waitForFunction(() => window.__app.showEditorCard && (window.__app.originalHtml || '').includes('bellt laut'));
    const patches = await mockChatTurn(page, pageId);
    await openChatAndSend(page);

    // Wort-Diff statt zweier Blöcke.
    const card = page.locator('#chat-card .chat-vorschlag');
    await expect(card.locator('.chat-word-diff__del')).toHaveText('laut');
    await expect(card.locator('.chat-word-diff__add')).toHaveText('leise');
    // Inline-Marke in der Leseansicht (über Alpine.store('pageChat')).
    await expect(page.locator(`${VIEW_SEL} .chat-mark`)).toHaveCount(1);

    // Übernehmen → Server-Write, Marke weg, applied persistiert.
    await card.locator('.chat-vorschlag-actions button:visible').first().click();
    await expect.poll(() => serverHtml(page, pageId)).toContain('bellt leise');
    await expect(page.locator(`${VIEW_SEL} .chat-mark`)).toHaveCount(0);
    await expect(card).toHaveClass(/chat-vorschlag--applied/);
    expect(patches.some(p => /\/vorschlag\/0\/applied$/.test(p.url) && p.body?.applied === true)).toBe(true);

    // Rückgängig → Originaltext zurück, applied:false persistiert.
    await card.locator('.chat-vorschlag-actions button:visible').first().click();
    await expect.poll(() => serverHtml(page, pageId)).toContain('bellt laut');
    await expect(card).not.toHaveClass(/chat-vorschlag--applied/);
    expect(patches.some(p => /\/vorschlag\/0\/applied$/.test(p.url) && p.body?.applied === false)).toBe(true);

    // Titelvariante übernehmen → Seitentitel über die Rename-Route.
    const titel = page.locator('#chat-card .chat-titel-item').first();
    await expect(titel.locator('.chat-titel-text')).toHaveText('Hofgeflüster');
    await titel.locator('.chat-vorschlag-btn').first().click();
    await page.waitForFunction(() => window.__app.currentPage?.name === 'Hofgeflüster');
  } finally {
    await deletePage(page, pageId);
  }
});

test('Seiten-Chat (Notebook-Edit-Modus): Übernehmen ersetzt im Live-Editor, Autosave-Pfad speichert', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const pageId = await createPage(page);
  try {
    await page.waitForFunction(() => window.__app.showEditorCard && (window.__app.originalHtml || '').includes('bellt laut'));
    await page.evaluate(() => window.__app.startEdit());
    await page.waitForSelector(EDIT_SEL);
    await mockChatTurn(page, pageId);
    await openChatAndSend(page);

    await page.locator('#chat-card .chat-vorschlag .chat-vorschlag-actions button:visible').first().click();
    // Im Editor ersetzt, Session dirty — kein Server-Write daneben, der vom
    // nächsten Autosave überschrieben würde.
    await expect(page.locator(EDIT_SEL)).toContainText('bellt leise');
    expect(await page.evaluate(() => window.__app.editDirty)).toBe(true);
    expect(await serverHtml(page, pageId)).toContain('bellt laut');

    await page.evaluate(() => window.__app.quickSave());
    await expect.poll(() => serverHtml(page, pageId)).toContain('bellt leise');
    await page.evaluate(() => window.__app.cancelEdit());
  } finally {
    await deletePage(page, pageId);
  }
});

test('Seiten-Chat: Ideen-Vorschlag bearbeiten und als Idee am Abschnitt erfassen', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const pageId = await createPage(page);
  try {
    await page.waitForFunction(() => window.__app.showEditorCard && (window.__app.originalHtml || '').includes('bellt laut'));
    const patches = await mockChatTurn(page, pageId, () => ({
      proposals: [{
        type: 'idee_create', fields: { content: 'Hund: hier laut, in Kapitel 2 stumm — klären', page_id: pageId },
        begruendung: 'Widerspruch', labels: { anchor: 'E2E Seiten-Chat', anchor_kind: 'page' },
      }],
    }));
    await openChatAndSend(page);

    const idee = page.locator('#chat-card .chat-idee-vorschlaege .chat-vorschlag');
    await expect(idee).toHaveCount(1);
    await expect(idee.locator('.chat-idee-text')).toHaveText('Hund: hier laut, in Kapitel 2 stumm — klären');
    await expect(idee.locator('.chat-idee-anchor .entity-ref')).toContainText('E2E Seiten-Chat');

    // Bearbeiten → Text ändern → Erfassen legt die Idee mit dem geänderten Text an.
    await idee.getByRole('button', { name: /Bearbeiten|Edit/ }).click();
    await idee.locator('textarea.chat-idee-edit').fill('Hund: laut oder stumm? Kapitel 2 prüfen');
    await idee.getByRole('button', { name: /Als Idee erfassen|Note as idea/ }).click();
    await expect(idee).toHaveClass(/chat-vorschlag--applied/);
    const ideen = await page.evaluate(async (pid) => (await (await fetch('/ideen?page_id=' + pid)).json()), pageId);
    expect(ideen.map(i => i.content)).toEqual(['Hund: laut oder stumm? Kapitel 2 prüfen']);
    const applied = patches.find(p => /\/ideen\/chat-proposal$/.test(p.url));
    expect(applied?.body).toMatchObject({ message_id: 900002, index: 0, action: 'applied', applied_id: ideen[0].id });
    expect(await page.evaluate((pid) => window.Alpine.store('badges').ideenCounts[pid], pageId)).toBe(1);
  } finally {
    await deletePage(page, pageId);
  }
});

test('Seiten-Chat: Ideen-Vorschlag am Kapitel erfassen', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const pageId = await createPage(page);
  const chapterId = await page.evaluate(() => window.Alpine.store('nav').pages.find(p => p.chapter_id)?.chapter_id);
  expect(chapterId).toBeTruthy();
  let created = [];
  try {
    await page.waitForFunction(() => window.__app.showEditorCard && (window.__app.originalHtml || '').includes('bellt laut'));
    await mockChatTurn(page, pageId, () => ({
      proposals: [{
        type: 'idee_create', fields: { content: 'Zeitlinie des Kapitels prüfen', chapter_id: chapterId },
        labels: { anchor: 'Seed-Kapitel', anchor_kind: 'chapter' },
      }],
    }));
    await openChatAndSend(page);

    const idee = page.locator('#chat-card .chat-idee-vorschlaege .chat-vorschlag');
    await expect(idee.locator('.chat-idee-anchor .entity-ref')).toBeVisible();
    await expect(idee.locator('.chat-idee-anchor .muted-msg')).toHaveText(/Kapitel|chapter/);
    await idee.getByRole('button', { name: /Als Idee erfassen|Note as idea/ }).click();
    await expect(idee).toHaveClass(/chat-vorschlag--applied/);
    created = await page.evaluate(async (cid) => (await (await fetch('/ideen?chapter_id=' + cid)).json()), chapterId);
    expect(created.map(i => i.content)).toContain('Zeitlinie des Kapitels prüfen');
    expect(created.find(i => i.content === 'Zeitlinie des Kapitels prüfen').page_id ?? null).toBeNull();
    expect(await page.evaluate((cid) => window.Alpine.store('badges').chapterIdeenCounts[cid], chapterId)).toBeGreaterThan(0);
  } finally {
    // Seed-Kapitel: die angelegte Idee wieder entfernen, andere Specs zählen den Seed.
    for (const i of created.filter(x => x.content === 'Zeitlinie des Kapitels prüfen')) {
      await page.evaluate(async (id) => { await fetch('/ideen/' + id, { method: 'DELETE' }); }, i.id);
    }
    await deletePage(page, pageId);
  }
});
