// Recherche-Chat-Panel: Zugänglichkeit des Panels (und unten: Ideen-Vorschläge) nach dem Refactoring, das
// die Render-Logik aus research-chat.js in research-chat-render.js ausgelagert
// hat. Smoke oeffnet die Karte, prueft aber KEINE Verhaltens-Invariante des
// Chat-Panels — dieser Spec tut genau das: Toggle-Button sichtbar (config
// enabled), Panel klappt auf, Eingabefeld + Sende-Button gerendert, Schliessen
// via Toggle-Icon. Kein echter Send: der Job-Worker ist Claude-only und ohne
// API-Key im Devmode ohne Wert (Server-Return 404 researchChatClaudeOnly);
// das Frontend-Refactoring ist der Gegenstand, nicht das Backend-Verhalten.
//
// Voraussetzung: /config liefert researchChat.enabled=true (effektiver Provider
// ist Claude + API-Key gesetzt). Ist der Key nicht gesetzt, blendet der Server
// das Feature ohnehin aus (routes/proxies.js#researchChat); ein Spec, der auf
// false-branches pruefte, waere von der lokalen .env abhaengig und darum nicht
// tragfaehig. Wir setzen den Store-Wert explizit auf true, um die
// Frontend-Invariante isoliert zu testen.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('recherche-chat: Toggle schaltet das Panel, Eingabefeld + Close arbeiten nach Render-Refactoring', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  await page.evaluate((id) => { location.hash = `#book/${id}/recherche`; }, bookId);
  await expect(page.locator('#recherche-card')).toBeVisible();

  // Store-Wert explizit true — isoliert die Frontend-Invariante von der
  // Server-Enable-Lage (Provider + Key).
  await page.evaluate(() => { window.Alpine.store('config').researchChatEnabled = true; });

  // Toggle-Button: nur sichtbar, wenn /config researchChat.enabled true ist.
  const toggleBtn = page.locator('#recherche-card .card-header-aside button[aria-pressed]').first();
  await expect(toggleBtn).toBeVisible();
  // Chat-Karte initial zu.
  await expect(page.locator('#research-chat-card')).toBeHidden();

  // Aufklappen: Chat-Karte sichtbar, Eingabefeld + Sende-Button gerendert, Fokus
  // landet im Textarea (toggleResearchChat fokussiert beim Oeffnen).
  await toggleBtn.click();
  await expect(page.locator('#research-chat-card')).toBeVisible();
  // Eigene Karte als Leiste des Splits (wie der Abschnitts-Chat neben dem
  // Editor), nicht mehr ein Panel innerhalb der Recherche-Karte.
  await expect(page.locator('#recherche-card #research-chat-card')).toHaveCount(0);
  await expect(page.locator('.recherche-split.aside-split--on > #research-chat-card.card--chat')).toHaveCount(1);
  const textarea = page.locator('#research-chat-messages ~ .chat-input-row textarea.research-chat-input');
  await expect(textarea).toBeVisible();
  await expect(page.locator('#research-chat-card .chat-send-btn')).toBeVisible();
  await expect(textarea).toBeFocused();

  // Eingabefeld nimmt Text auf (x-model an researchChatInput) — keine Aenderung
  // am State, nur Bindung geprueft (Alpine laeuft, Methode nicht verloren).
  await textarea.fill('Recherche-Testeingabe');
  await expect(textarea).toHaveValue('Recherche-Testeingabe');

  // Werkzeug-Verlauf: dasselbe Fragment wie im Buch-Chat (chat-tool-log); die
  // serverseitige Anthropic-Suche steht als eigene Zeile, der alte
  // Suchbegriffe-Block entfällt dann.
  await page.waitForFunction(() => window.Alpine.$data(document.querySelector('#recherche-card')).researchChatSessionId != null);
  await page.evaluate(() => {
    window.Alpine.$data(document.querySelector('#recherche-card')).researchChatMessages = [{
      id: 987656, role: 'assistant', content: 'Antwort.',
      context_info: { web_searches: 1, web_queries: ['Zuger Attentat'], tool_calls: [
        { name: 'web_search', server: true, ok: true, iter: 1, input: { query: 'Zuger Attentat' },
          view: { subject: [{ t: 'q', v: 'Zuger Attentat' }], result: { key: 'chat.toolResult.hits', params: { n: 8 } } } },
        { name: 'final_answer', ok: true, iter: 2 },
      ] },
    }];
  });
  const log = page.locator('#research-chat-card .chat-tool-log');
  await log.locator('.collapsible-toggle').click();
  await expect(log.locator('.chat-tool-log-row')).toHaveText(/Im Web gesucht\s*«Zuger Attentat»\s*8 Treffer/);
  await expect(page.locator('#research-chat-card .research-chat-queries')).toHaveCount(0);

  // Schliessen-Knopf im Kartenkopf (`.btn-card-close`, wie Abschnitts-Chat)
  // legt researchChatOpen=false → Chat-Karte zu, Recherche-Karte bleibt.
  await page.locator('#research-chat-card .btn-card-close').click();
  await expect(page.locator('#research-chat-card')).toBeHidden();
  await expect(page.locator('#recherche-card')).toBeVisible();
});
// Ideen-Vorschläge (final_answer.ideen, nur mit Schreibkontext): stehen in
// context_info.proposals HINTER den Fundstücken. Die Fundstück-Liste zeigt sie
// nicht, das geteilte Fragment chat-idee-vorschlaege.html schon, und «Als Idee
// erfassen» schickt den Index in proposals an PATCH /ideen/chat-proposal.
test('recherche-chat: Ideen-Vorschlag neben Fundstück, getrennt gerendert und erfassbar', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  await page.evaluate((id) => { location.hash = `#book/${id}/recherche`; }, bookId);
  await expect(page.locator('#recherche-card')).toBeVisible();
  await page.evaluate(() => { window.Alpine.store('config').researchChatEnabled = true; });
  await page.locator('#recherche-card .card-header-aside button[aria-pressed]').first().click();
  await page.waitForFunction(() => window.Alpine.$data(document.querySelector('#recherche-card')).researchChatSessionId != null);

  const patches = [];
  await page.route('**/ideen/chat-proposal', async (route) => {
    const body = route.request().postDataJSON();
    patches.push(body);
    // claim reserviert nur (vor dem Schreiben, proposal-status.js#applyProposalOnce).
    await route.fulfill({ json: { proposal: body.action === 'claim' ? { claimed_at: '2026-01-01T00:00:00.000Z' } : { applied_at: '2026-01-01T00:00:00.000Z', applied_id: body.applied_id } } });
  });
  const pageId = await page.evaluate(() => window.Alpine.store('nav').pages[0].id);
  await page.evaluate((pid) => {
    window.Alpine.$data(document.querySelector('#recherche-card')).researchChatMessages = [{
      id: 987657, role: 'assistant', content: 'Antwort.',
      context_info: { proposals: [
        { kind: 'fact', title: 'Eröffnung 1847', body: 'Die Strecke wurde 1847 eröffnet.', urls: [] },
        { type: 'idee_create', fields: { content: 'Bahnfahrt 1845 prüfen — Strecke erst 1847 eröffnet', page_id: pid },
          labels: { anchor: 'Testabschnitt', anchor_kind: 'page' } },
      ] },
    }];
  }, pageId);

  await expect(page.locator('#research-chat-card .research-chat-proposal')).toHaveCount(1);
  const idee = page.locator('#research-chat-card .chat-idee-vorschlaege .chat-vorschlag');
  await expect(idee).toHaveCount(1);
  await expect(idee.locator('.chat-idee-text')).toHaveText('Bahnfahrt 1845 prüfen — Strecke erst 1847 eröffnet');

  let created = [];
  try {
    await idee.getByRole('button', { name: /Als Idee erfassen|Note as idea/ }).click();
    await expect(idee).toHaveClass(/chat-vorschlag--applied/);
    created = await page.evaluate(async (pid) => (await (await fetch('/ideen?page_id=' + pid)).json()), pageId);
    const mine = created.filter(i => i.content === 'Bahnfahrt 1845 prüfen — Strecke erst 1847 eröffnet');
    expect(mine).toHaveLength(1);
    expect(patches.map(p => p.action)).toEqual(['claim', 'applied']);
    expect(patches[1]).toMatchObject({ message_id: 987657, index: 1, action: 'applied', applied_id: mine[0].id });
  } finally {
    // Seed-Abschnitt: angelegte Idee wieder entfernen, andere Specs zählen den Seed.
    created = await page.evaluate(async (pid) => (await (await fetch('/ideen?page_id=' + pid)).json()), pageId);
    for (const i of created.filter(x => x.content.startsWith('Bahnfahrt 1845'))) {
      await page.evaluate(async (id) => { await fetch('/ideen/' + id, { method: 'DELETE' }); }, i.id);
    }
  }
});

// Übergabe aus einer anderen Oberfläche (Buch-Chat → Recherche-Chat): die Frage
// landet in einer NEUEN Session, nicht im laufenden Gespräch — und wird nicht
// gesendet (Muster prepare<L>Draft, chat-base.js).
test('recherche-chat: Übergabe legt die Frage in eine neue Session (nicht ins laufende Gespräch)', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  await page.evaluate((id) => { location.hash = `#book/${id}/recherche`; }, bookId);
  await expect(page.locator('#recherche-card')).toBeVisible();
  await page.evaluate(() => { window.Alpine.store('config').researchChatEnabled = true; });

  // Laufendes Gespräch vortäuschen: eine Session mit Nachrichten.
  await page.route(`**/chat/sessions/research/${bookId}`, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([{ id: 111, title: 'Alt', preview: 'Alte Frage', last_message_at: new Date().toISOString() }]),
  }));
  await page.route('**/chat/session/111', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ id: 111, kind: 'research', messages: [{ id: 1, role: 'user', content: 'Alte Frage' }] }),
  }));
  // Neue Session abfangen: die ID ist fest, damit der Test sie prüfen kann.
  const created = [];
  await page.route('**/chat/session/research', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    created.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 4242 }) });
  });
  const jobs = [];
  await page.route('**/jobs/research-chat', async (route) => {
    jobs.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jobId: 1 }) });
  });

  // Panel aufklappen: das laufende Gespräch steht.
  await page.locator('#recherche-card .card-header-aside button[aria-pressed]').first().click();
  await page.waitForFunction(() => window.Alpine.$data(document.querySelector('#recherche-card')).researchChatSessionId === 111);

  // Übergabe: Window-Event wie aus dem Buch-Chat.
  await page.evaluate((id) => {
    window.dispatchEvent(new CustomEvent('research-chat:ask', {
      detail: { bookId: Number(id), question: 'Wann fiel die Berliner Mauer?' },
    }));
  }, bookId);

  const textarea = page.locator('#research-chat-messages ~ .chat-input-row textarea.research-chat-input');
  await expect(textarea).toHaveValue('Wann fiel die Berliner Mauer?');
  await expect(textarea).toBeFocused();
  await page.waitForFunction(() => window.Alpine.$data(document.querySelector('#recherche-card')).researchChatSessionId === 4242);

  expect(created.length, 'eine neue Session wurde angelegt').toBeGreaterThan(0);
  expect(jobs.length, 'die Frage wird NICHT gesendet').toBe(0);
  // Das alte Gespräch steht nicht mehr im Weg.
  expect(await page.evaluate(() => window.Alpine.$data(document.querySelector('#recherche-card')).researchChatMessages.length)).toBe(0);
});


// Änderungen an bestehenden Einträgen (recherche-chat-changes.html): eigene
// Karten neben Fundstück und Idee, Übernehmen schickt den ECHTEN Index in
// context_info.proposals, Verwerfen läuft über PATCH /research/chat-proposal.
test('recherche-chat: Änderungsvorschläge getrennt gerendert, Übernehmen + Verwerfen', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  await page.evaluate((id) => { location.hash = `#book/${id}/recherche`; }, bookId);
  await expect(page.locator('#recherche-card')).toBeVisible();
  await page.evaluate(() => { window.Alpine.store('config').researchChatEnabled = true; });
  await page.locator('#recherche-card .card-header-aside button[aria-pressed]').first().click();
  await page.waitForFunction(() => window.Alpine.$data(document.querySelector('#recherche-card')).researchChatSessionId != null);

  const applied = [];
  const patched = [];
  await page.route('**/research/chat-proposal/apply', async (route) => {
    const body = route.request().postDataJSON();
    applied.push(body);
    await route.fulfill({ json: { item: { id: 4242 }, proposal: { type: 'research_update', item_id: 4242, fields: { status: 'eingearbeitet' }, labels: { item: 'Fahrplan 1847' }, applied_at: '2026-01-01T00:00:00.000Z', applied_id: 4242 } } });
  });
  await page.route('**/research/chat-proposal', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const body = route.request().postDataJSON();
    patched.push(body);
    await route.fulfill({ json: { proposal: { type: 'research_archive', item_id: 4243, status: 'discarded' } } });
  });
  const pageId = await page.evaluate(() => window.Alpine.store('nav').pages[0].id);
  await page.evaluate((pid) => {
    window.Alpine.$data(document.querySelector('#recherche-card')).researchChatMessages = [{
      id: 987658, role: 'assistant', content: 'Antwort.',
      context_info: { proposals: [
        { kind: 'fact', title: 'Neu', body: 'Neues Fundstück', urls: [] },
        { type: 'research_update', item_id: 4242, fields: { status: 'eingearbeitet', append: 'Ab 1902 elektrisch.' },
          before: { status: 'offen' }, beleg: { text: 'um 7 Uhr in Olten', page_id: pid },
          labels: { item: 'Fahrplan 1847', beleg_page: 'Ankunft' } },
        { type: 'research_archive', item_id: 4243, labels: { item: 'Alter Fund' } },
        { type: 'research_merge', item_id: 4242, merge_item_id: 4244, fields: {}, before: {},
          labels: { item: 'Fahrplan 1847', merge_item: 'Fahrplan Kopie' }, merge_preview: { body: 'Kopie-Text' } },
        { type: 'idee_create', fields: { content: 'Uhrzeit prüfen', page_id: pid }, labels: { anchor: 'Ankunft', anchor_kind: 'page' } },
      ] },
    }];
  }, pageId);

  const card = page.locator('#research-chat-card');
  await expect(card.locator('.research-chat-proposal')).toHaveCount(1);
  await expect(card.locator('.chat-idee-vorschlaege .chat-vorschlag')).toHaveCount(1);
  const changes = card.locator('.research-chat-changes > .chat-vorschlag');
  await expect(changes).toHaveCount(3);
  const update = changes.nth(0);
  await expect(update.locator('.research-chat-change-beleg q')).toHaveText('um 7 Uhr in Olten');
  await expect(update).toContainText('Ab 1902 elektrisch.');
  await expect(changes.nth(2)).toContainText('Kopie-Text');

  await update.getByRole('button', { name: /Übernehmen|Apply/ }).click();
  await expect(update).toHaveClass(/chat-vorschlag--applied/);
  expect(applied[0]).toMatchObject({ message_id: 987658, index: 1 });

  const archive = changes.nth(1);
  await archive.getByRole('button', { name: /Verwerfen|Discard/ }).click();
  await expect(archive).toHaveClass(/chat-vorschlag--discarded/);
  expect(patched[0]).toMatchObject({ message_id: 987658, index: 2, action: 'discarded' });
});
