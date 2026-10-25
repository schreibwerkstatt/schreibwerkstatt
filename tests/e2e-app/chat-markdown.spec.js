// Chat-Markdown gegen die ECHTE App (playwright.app.config.js): markdown-it lädt
// erst beim ersten Rendern nach (lazy-libs.js#loadMarkdownIt), die Chat-Basis
// rendert danach über `_chatMdReady` neu. Nur hier sichtbar — die Unit-Tests
// laden markdown-it vorab und sehen weder den Nachlade-Pfad noch das x-html.
// Stellvertretend am Buch-Chat; alle fünf Chats teilen `_renderChatMarkdown`
// bzw. `_chatMarkdownDep` aus chat-base.js.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const CARD = '#book-chat-card';

const ANSWER = [
  '## Befund',
  '',
  'Der Text ist **stimmig**, nur `a*b*c` bleibt Code.',
  '',
  '| Figur | Kapitel |',
  '|---|---|',
  '| Anna | 3 |',
  '',
  'Mehr: [Bern](https://de.wikipedia.org/wiki/Bern_(Stadt))',
  '',
  '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>',
].join('\n');

test('chat-markdown: Antwort wird nach dem Nachladen als Markdown gerendert, Roh-HTML bleibt Text', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const SID = 876543;

  await page.route(`**/chat/sessions/book/${bookId}`, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([{ id: SID, title: 'Spec', preview: 'Frage', last_message_at: new Date().toISOString() }]),
  }));
  await page.route(`**/chat/session/${SID}`, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      id: SID, book_id: Number(bookId), kind: 'book',
      messages: [
        { id: 1, role: 'user', content: 'Passt das?', created_at: new Date().toISOString() },
        { id: 2, role: 'assistant', content: ANSWER, created_at: new Date().toISOString(), context_info: { mode: 'agent' } },
      ],
    }),
  }));
  await page.route('**/jobs/active?type=book-chat*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ jobId: null }),
  }));

  await page.evaluate(() => window.__app.toggleBookChatCard());
  const text = page.locator(`${CARD} .chat-msg--assistant .chat-msg-text:visible`);

  await expect(text.locator('h3.chat-heading')).toHaveText('Befund');
  await expect(text.locator('strong')).toHaveText('stimmig');
  await expect(text.locator('code.chat-code')).toHaveText('a*b*c');
  await expect(text.locator('.table-scroll > table.chat-table td').first()).toHaveText('Anna');
  await expect(text.locator('a.chat-link')).toHaveAttribute('href', 'https://de.wikipedia.org/wiki/Bern_(Stadt)');

  await expect(text.locator('img, script')).toHaveCount(0);
  await expect(text).toContainText('<script>window.__xss=1</script>');
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});
