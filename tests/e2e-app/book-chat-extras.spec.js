// Buch-Chat: Zusätze unter einer Agent-Antwort gegen die ECHTE App
// (playwright.app.config.js) — String-Include `book-chat-msg-extras` in der
// Nachrichten-Schleife, `collapsible` im x-for, Fussnoten mit Seitensprung,
// Recherche-Übergabe per Window-Event, Kosten in der Token-Zeile.
//
// Die Antwort selbst kommt aus einem KI-Job und ist hier nicht erzeugbar: die zwei
// Leserouten der Karte (Sessions-Liste + Session) werden abgefangen und mit einer
// realistischen Antwort bedient; Karte, Templates und Methoden laufen echt.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const CARD = '#book-chat-card';

test('buch-chat: Werkzeug-Verlauf, Belege, Recherche-Hinweis, Kosten', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const SID = 987654;

  await page.route(`**/chat/sessions/book/${bookId}`, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([{ id: SID, title: 'Spec', preview: 'Frage', last_message_at: new Date().toISOString() }]),
  }));
  await page.route(`**/chat/session/${SID}`, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      id: SID, book_id: Number(bookId), kind: 'book',
      messages: [
        { id: 1, role: 'user', content: 'Stimmt das mit dem Mauerfall?', created_at: new Date().toISOString() },
        {
          id: 2, role: 'assistant', content: 'Im Buch fällt die Mauer 1989.',
          tokens_in: 12000, tokens_out: 300, cache_read_in: 0, created_at: new Date().toISOString(),
          context_info: {
            mode: 'agent', iterations: 2, stop_reason: 'final_answer', cost_usd: 0.0421,
            tool_calls: [
              { name: 'search_passages', input: { pattern: '<b>Mauer</b>' }, ok: true, durationMs: 42, resultBytes: 900, truncated: true, iter: 1 },
              { name: 'get_pages', input: { ids: [1] }, ok: false, durationMs: 3, resultBytes: 20, truncated: false, iter: 1, error: 'kaputt' },
              { name: 'final_answer', input: { antwort_chars: 30 }, ok: true, durationMs: 0, resultBytes: 30, truncated: false, iter: 2 },
            ],
            citations: [
              { n: 1, page_id: 4242, page_name: 'Seite <script>', quote: 'Die Mauer fiel.', valid: true },
              { n: 2, page_id: null, page_name: null, quote: 'Erfunden', valid: false, reason: 'quote_mismatch' },
            ],
            recherche_hinweis: true, recherche_frage: 'Wann fiel die Berliner Mauer?',
          },
        },
      ],
    }),
  }));
  await page.route('**/jobs/active?type=book-chat*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ jobId: null }),
  }));

  await page.evaluate(() => {
    window.__askEvents = [];
    window.addEventListener('research-chat:ask', (e) => window.__askEvents.push(e.detail));
    window.Alpine.store('config').researchChatEnabled = true;
  });
  await page.evaluate(() => window.__app.toggleBookChatCard());
  const card = page.locator(CARD);
  await expect(card).toBeVisible();

  const extras = card.locator('.book-chat-extras');
  await expect(extras).toHaveCount(1);

  // Fussnoten: Text per x-text (kein HTML), ungültiges Zitat markiert.
  const cites = extras.locator('.book-chat-citation');
  await expect(cites).toHaveCount(2);
  await expect(cites.nth(0).locator('.entity-ref--seite .entity-ref__label')).toHaveText('Seite <script>');
  await expect(cites.nth(1)).toHaveClass(/book-chat-citation--invalid/);
  await expect(cites.nth(1).locator('.entity-ref')).toHaveCount(0);

  // Werkzeug-Verlauf: zu → auf; final_answer erscheint nicht.
  const rows = extras.locator('.book-chat-tool-row');
  await expect(rows.first()).toBeHidden();
  await extras.locator('.book-chat-tools .collapsible-toggle').click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.book-chat-tool-args')).toHaveText('{"pattern":"<b>Mauer</b>"}');
  await expect(rows.nth(0)).toContainText('42 ms');
  await expect(rows.nth(1)).toHaveClass(/book-chat-tool-row--failed/);

  // Kosten in der Token-Zeile.
  await expect(card.locator('.chat-msg--assistant .chat-token-info')).toContainText('0.04');

  // Recherche-Übergabe: Event mit vorgeschlagener Frage + Buch-ID.
  await extras.locator('.book-chat-research-hint button').click();
  const asked = await page.evaluate(() => window.__askEvents);
  expect(asked).toEqual([{ question: 'Wann fiel die Berliner Mauer?', bookId: Number(bookId) }]);
});
