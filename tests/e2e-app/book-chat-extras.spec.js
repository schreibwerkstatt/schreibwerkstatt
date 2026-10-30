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
            pre_context: { count: 4, chars: 3000 },
            tool_rounds: [{ iter: 1, tokIn: 12000, tokOut: 300, note: 'Ich suche die Stelle zum Mauerfall.' }, { iter: 2, tokIn: 900, tokOut: 40 }],
            tool_calls: [
              { name: 'search_passages', input: { pattern: '<b>Mauer</b>', max_results: 15 }, ok: true, durationMs: 42, resultBytes: 900, truncated: true, iter: 1,
                view: { subject: [{ t: 'q', v: '<b>Mauer</b>' }, { t: 'ref', k: 'chapter', id: '999', v: 'Teil <i>1</i>' }], result: { key: 'chat.toolResult.hits', params: { n: 3 } } } },
              { name: 'get_pages', input: { ids: [1] }, ok: false, durationMs: 3, resultBytes: 20, truncated: false, iter: 1, error: 'kaputt' },
              { name: 'search_similar', input: { query: 'Grenzöffnung' }, ok: true, durationMs: 2300, resultBytes: 900, truncated: false, iter: 2 },
              { name: 'final_answer', input: { antwort_chars: 30, zitate_count: 2 }, ok: true, durationMs: 0, resultBytes: 30, truncated: false, iter: 3, citations_invalid: 1 },
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

  // Werkzeug-Verlauf (geteiltes Fragment chat-tool-log): zu → auf; Vorab-Kontext,
  // Rundenköpfe mit Notiz, Zeilen, Zitat-Abschluss; final_answer selbst ist keine Zeile.
  const log = extras.locator('.chat-tool-log');
  const rows = log.locator('.chat-tool-log-row');
  await expect(log.locator('.collapsible-toggle').first()).toHaveText('Werkzeug-Verlauf (3, davon 1 mit Fehler)');
  await expect(rows.first()).toBeHidden();
  await log.locator('.collapsible-toggle').first().click();
  await expect(rows).toHaveCount(3);
  await expect(log.locator('.chat-tool-log-item--pre')).toHaveText('Vorab geladen: 4 passende Textstellen');
  const rounds = log.locator('.chat-tool-log-round');
  await expect(rounds).toHaveCount(2);
  await expect(rounds.nth(0).locator('.chat-tool-log-note')).toHaveText('Ich suche die Stelle zum Mauerfall.');
  await expect(rounds.nth(0).locator('.chat-tool-log-round-tokens')).toContainText('Tokens');
  await expect(rows.nth(0).locator('.chat-tool-log-label')).toHaveText('Wortlaut im Buch gesucht');
  await expect(rows.nth(0).locator('.chat-tool-log-quote')).toHaveText('«<b>Mauer</b>»');
  await expect(rows.nth(0).locator('.entity-ref--kapitel .entity-ref__label')).toHaveText('Teil <i>1</i>');
  await expect(rows.nth(0).locator('.chat-tool-log-result')).toHaveText('3 Treffer');
  await expect(rows.nth(0)).not.toContainText('42');
  await expect(rows.nth(1)).toHaveClass(/chat-tool-log-row--failed/);
  // Rohtext ohne errorKey: angezeigt wird der generische übersetzte Text.
  await expect(rows.nth(1).locator('.chat-tool-log-error')).toHaveText('Werkzeug-Aufruf fehlgeschlagen');
  // Ältere Antwort ohne Sicht: Suchbegriff aus den Argumenten; Dauer ab 1 s.
  await expect(rows.nth(2).locator('.chat-tool-log-quote')).toHaveText('«Grenzöffnung»');
  await expect(rows.nth(2).locator('.chat-tool-log-meta')).toHaveText('2.3 s');
  await expect(log.locator('.chat-tool-log-item--final')).toHaveText('Antwort mit 2 Zitaten, 1 davon nicht im Text bestätigt');
  if (process.env.SHOT) await log.screenshot({ path: process.env.SHOT });

  // Kosten in der Token-Zeile.
  await expect(card.locator('.chat-msg--assistant .chat-token-info')).toContainText('0.04');

  // Recherche-Übergabe: Event mit vorgeschlagener Frage + Buch-ID.
  await extras.locator('.book-chat-research-hint button').click();
  const asked = await page.evaluate(() => window.__askEvents);
  expect(asked).toEqual([{ question: 'Wann fiel die Berliner Mauer?', bookId: Number(bookId) }]);
});

test('buch-chat: Werkzeug-Verlauf wächst während des Laufs mit (liveTools am Job)', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const SID = 987655;
  const JOB = 'live-job-1';
  await page.route(`**/chat/sessions/book/${bookId}`, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([{ id: SID, title: 'Live', preview: 'Frage', last_message_at: new Date().toISOString() }]),
  }));
  await page.route(`**/chat/session/${SID}`, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ id: SID, book_id: Number(bookId), kind: 'book',
      messages: [{ id: 1, role: 'user', content: 'Wo steht das?', created_at: new Date().toISOString() }] }),
  }));
  await page.route('**/jobs/active?type=book-chat*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ jobId: JOB }),
  }));
  const search = (pattern) => ({ name: 'search_passages', ok: true, iter: 2,
    view: { subject: [{ t: 'q', v: pattern }], result: { key: 'chat.toolResult.hits', params: { n: 2 } } } });
  await page.route(`**/jobs/${JOB}`, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ id: JOB, type: 'book-chat', status: 'running', progress: 30, statusText: 'job.phase.agentTools', statusParams: { current: 2, total: 8 },
      liveTools: [{ name: 'list_chapters', ok: true, iter: 1, view: { subject: [], result: { key: 'chat.toolResult.entries', params: { n: 11 } } } },
        search('Mauer'), search('Grenze'), search('Trabant')],
      liveRounds: [{ iter: 1, tokIn: 100, tokOut: 10 }, { iter: 2, tokIn: 200, tokOut: 10, note: 'Jetzt die Fundstellen.' }] }),
  }));

  await page.evaluate(() => window.__app.toggleBookChatCard());
  const card = page.locator(CARD);
  const live = card.locator('.chat-tool-log-live .chat-tool-log');
  // Live offen, ohne Klick; drei gleiche Suchen einer Runde als Sammelzeile.
  await expect(live.locator('.collapsible-toggle').first()).toHaveText('Werkzeuge bisher (4)');
  await expect(live.locator('.chat-tool-log-note').nth(1)).toHaveText('Jetzt die Fundstellen.');
  await expect(live.locator('.chat-tool-log-note').nth(0)).toBeHidden();
  const group = live.locator('.chat-tool-log-group');
  await expect(group.locator('.chat-tool-log-group-toggle')).toContainText('Wortlaut im Buch gesucht ×3');
  await expect(group.locator('.chat-tool-log-group-toggle')).toContainText('«Mauer», «Grenze», «Trabant»');
  await expect(group.locator('.chat-tool-log-group-toggle')).toContainText('3 mit Treffer, 0 ohne');
  await expect(group.locator('.chat-tool-log-row').first()).toBeHidden();
  await group.locator('.chat-tool-log-group-toggle').click();
  await expect(group.locator('.chat-tool-log-row')).toHaveCount(3);
  if (process.env.SHOT_LIVE) await live.screenshot({ path: process.env.SHOT_LIVE });
});
