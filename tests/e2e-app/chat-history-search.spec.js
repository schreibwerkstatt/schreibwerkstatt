// Suche im Verlauf (docs/chats.md#suche-im-verlauf) gegen die ECHTE App: Fragment-
// Include `chat-history-search` in beiden Chat-Karten, verschachtelte Komponente
// `chatHistorySearch` (ruft die Lade-Methode der Karte über den Scope-Merge),
// Sprung zur Treffer-Nachricht + Hervorhebung (chat-base.js `_hitMsgId`).
//
// Die Treffer kommen aus Gesprächen, die hier nicht erzeugbar sind (KI-Jobs): die
// Leserouten (Sessions-Liste, Session, Suche) sind abgefangen; Karte, Templates und
// Methoden laufen echt. Server-Seite der Suche: tests/unit/chat-search.test.js +
// tests/integration/chat-search-route.test.js.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const NOW = new Date().toISOString();

// Langes Gespräch, damit der Sprung zur Treffer-Nachricht messbar ist.
function longSession(sid, hitId) {
  const messages = [];
  for (let i = 0; i < 30; i++) {
    const id = hitId - 20 + i;
    messages.push({ id, role: i % 2 ? 'assistant' : 'user', content: id === hitId ? 'Der Leuchtturm steht im Kapitel 3.' : `Nachricht ${i} `.repeat(12), created_at: NOW });
  }
  return { id: sid, kind: 'book', messages };
}

test('Buch-Chat: Suche zeigt Treffer statt Liste, Klick springt zur Nachricht', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const NEWEST = 880001; const OLD = 880002; const HIT = 990050;

  await page.route(`**/chat/sessions/book/${bookId}`, (route) => route.fulfill(json([
    { id: NEWEST, title: 'Neuestes', last_message_at: NOW },
    { id: OLD, title: 'Altes Gespräch', last_message_at: NOW },
  ])));
  await page.route(`**/chat/session/${NEWEST}`, (route) => route.fulfill(json({ id: NEWEST, kind: 'book', messages: [] })));
  await page.route(`**/chat/session/${OLD}`, (route) => route.fulfill(json(longSession(OLD, HIT))));
  await page.route('**/jobs/active?type=book-chat*', (route) => route.fulfill(json({ jobId: null })));
  const searches = [];
  await page.route(`**/chat/search/${bookId}?*`, (route) => {
    searches.push(new URL(route.request().url()).searchParams);
    return route.fulfill(json({
      semantic: true, semanticError: false, pending: 3, indexing: true,
      hits: [{ message_id: HIT, round_id: HIT + 1, session_id: OLD, kind: 'book', page_id: null, page_name: null,
        title: 'Altes Gespräch', created_at: NOW, snippet: 'Der <mark>Leuchtturm</mark> steht &lt;b&gt;', match: 'both' }],
    }));
  });

  await page.evaluate(() => window.__app.toggleBookChatCard());
  const card = page.locator('#book-chat-card');
  await expect(card).toBeVisible();
  await expect(card.locator('.chat-session-item:not(.chat-hist-hit)')).toHaveCount(2);
  await expect(card.locator('.chat-hist-search .seg-toggle')).toBeHidden(); // Umschalter nur im Abschnitts-Chat

  await card.locator('.chat-hist-search input').fill('Leuchtturm');
  const hit = card.locator('.chat-hist-hit');
  await expect(hit).toHaveCount(1);
  expect(searches[0].get('kind')).toBe('book');
  expect(searches[0].has('page_id')).toBe(false);
  await expect(hit.locator('mark')).toHaveText('Leuchtturm');
  await expect(hit.locator('.chat-hist-hit-snippet')).toContainText('<b>'); // escaped, kein Markup
  await expect(hit.locator('.chat-hist-match--both')).toHaveCount(1);
  await expect(card.locator('.chat-hist-results .card-hint')).toBeVisible(); // Index läuft noch
  await expect(card.locator('.chat-session-item:not(.chat-hist-hit)').first()).toBeHidden();

  await hit.click();
  const target = card.locator(`.chat-msg[data-msg-id="${HIT}"]`);
  await expect(target).toHaveClass(/chat-msg--hit/);
  await expect(card.locator('.chat-msg--hit')).toHaveCount(1);
  // Die Treffer-Nachricht liegt im sichtbaren Bereich des Verlaufs, nicht am Ende.
  const inView = await page.evaluate((id) => {
    const box = document.getElementById('book-chat-messages');
    const el = box.querySelector(`[data-msg-id="${id}"]`);
    const b = box.getBoundingClientRect(); const r = el.getBoundingClientRect();
    return r.bottom > b.top && r.top < b.bottom && box.scrollTop + box.clientHeight < box.scrollHeight - 5;
  }, HIT);
  expect(inView).toBe(true);

  // Esc leert die Suche, die Liste ist wieder da.
  await card.locator('.chat-hist-search input').press('Escape');
  await expect(card.locator('.chat-session-item:not(.chat-hist-hit)')).toHaveCount(2);
});

test('Abschnitts-Chat: Umschalter Abschnitt/Buch steuert page_id', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const pageId = await page.evaluate(async () => {
    const p = window.Alpine.store('nav').pages[0];
    await window.__app.selectPage(p);
    return p.id;
  });
  await page.route(`**/chat/sessions/${pageId}`, (route) => route.fulfill(json([{ id: 880101, title: 'Hier', last_message_at: NOW }])));
  await page.route('**/chat/session/880101', (route) => route.fulfill(json({ id: 880101, kind: 'page', page_id: pageId, messages: [] })));
  await page.route('**/jobs/active?type=chat*', (route) => route.fulfill(json({ jobId: null })));
  const searches = [];
  await page.route(`**/chat/search/${bookId}?*`, (route) => {
    searches.push(new URL(route.request().url()).searchParams);
    return route.fulfill(json({ semantic: false, semanticError: false, pending: 0, indexing: false, hits: [] }));
  });

  await page.evaluate(() => window.__app.toggleChatCard());
  const card = page.locator('#chat-card');
  await expect(card).toBeVisible();
  await card.locator('.chat-hist-search input').fill('Lena');
  await expect(card.locator('.chat-hist-results .muted-msg')).toBeVisible();
  expect(searches.at(-1).get('kind')).toBe('page');
  expect(searches.at(-1).get('page_id')).toBe(String(pageId));

  await card.locator('.chat-hist-search .seg-toggle button').nth(1).click();
  await expect.poll(() => searches.length).toBe(2);
  expect(searches.at(-1).has('page_id')).toBe(false);
});
