// Review über den Share-Link gegen die ECHTE App (docs/share-link.md →
// „Review-Modus"), alle drei Kommentar-Oberflächen im Zusammenspiel:
//   Share-Reader (Leser-Seite): Reviewer-Namen wählen, an einer markierten
//     Stelle «Änderung vorschlagen», Vorschlag erscheint als Karte
//   Notebook-Leseansicht (Owner): Vorschlag in der Leiste → «Übernehmen»
//     schreibt den Abschnitt, Thread gilt als erledigt
//   Owner-Karte «Geteilte Links»: Stand des Review-Links (Reviewer)
// Der Bucheditor teilt den Leisten-Kern; hier läuft der Notebook-Pfad.
//
// Eigene Wegwerf-Seite statt der Seed-Seiten: andere Specs zählen den Seed.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const PAGE_HTML = '<p>Der Hund bellt laut im Hof. Die Katze schläft am Ofen.</p>';
const VIEW_SEL = '#editor-card .page-content-view:not(.page-content-view--editing)';

async function createPage(page) {
  return page.evaluate(async (html) => {
    const nav = window.Alpine.store('nav');
    const first = nav.pages[0];
    const r = await fetch('/content/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: nav.selectedBookId, chapter_id: first.chapter_id || undefined, name: 'E2E Review', html }),
    });
    if (!r.ok) throw new Error('createPage ' + r.status);
    const created = await r.json();
    nav.pages = [...nav.pages, { ...created, chapterName: first.chapterName }];
    return created.id;
  }, PAGE_HTML);
}

async function serverHtml(page, id) {
  return page.evaluate(async (pid) => (await (await fetch('/content/pages/' + pid, { cache: 'no-store' })).json()).html || '', id);
}

test('Review-Link: Reviewer schlägt vor, Owner übernimmt in der Notebook-Leseansicht', async ({ page, browser }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const pageId = await createPage(page);
  try {
    const link = await page.evaluate(async (pid) => {
      const r = await fetch('/share/api/links', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'page', page_id: pid, mode: 'review', reviewers: ['Anna', 'Marco'] }),
      });
      return r.json();
    }, pageId);
    expect(link.mode).toBe('review');

    // ── Leser-Seite: eigener Kontext ohne Sitzung ─────────────────────────────
    const readerCtx = await browser.newContext({ baseURL: new URL(page.url()).origin });
    const reader = await readerCtx.newPage();
    await reader.goto(`/share/${link.token}`, { waitUntil: 'domcontentloaded' });

    // Sterne-Fazit ist ersetzt durch «Review»: Namen wählen.
    const section = reader.locator('#share-feedback.share-review');
    await expect(section.locator('.share-review__pick')).toHaveCount(2);
    await section.locator('.share-review__pick', { hasText: 'Anna' }).click();
    await expect(section).toContainText('Anna');

    // Stelle markieren → Kommentieren-Knopf → Modus «Änderung vorschlagen».
    await reader.evaluate(() => {
      const block = document.querySelector('#share-article [data-bid]');
      const text = block.firstChild;
      const start = text.textContent.indexOf('bellt laut');
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + 'bellt laut'.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await reader.locator('.share-sel-btn').click();
    const composer = reader.locator('#share-composer');
    await composer.locator('.share-composer__mode').nth(1).click();
    const sugg = composer.locator('.share-composer__suggestion');
    await expect(sugg).toHaveValue('bellt laut');
    await sugg.fill('kläfft leise');
    await composer.locator('.share-composer__submit').click();
    await expect(composer).toHaveCount(0);

    const card = reader.locator('.share-comments__list .comment-rail__thread');
    await expect(card.locator('.comment-suggestion__new')).toHaveText('kläfft leise');
    await expect(card.locator('.comment-rail__author')).toContainText('Anna');
    await readerCtx.close();

    // ── Owner: Notebook-Leseansicht, Leiste auf, übernehmen ───────────────────
    await page.evaluate(async (pid) => {
      const p = window.Alpine.store('nav').pages.find(x => x.id === pid);
      await window.__app.selectPage(p);
    }, pageId);
    await expect(page.locator(VIEW_SEL)).toContainText('bellt laut');
    await page.evaluate((token) => window.dispatchEvent(new CustomEvent('comments-rail:goto', { detail: { token } })), link.token);
    // Kommentare frisch laden (die Leiste lud beim Buchwechsel, vor dem Vorschlag).
    await page.evaluate(async () => {
      const el = document.querySelector('[x-data="editorCommentsCard"]');
      const card = el && window.Alpine.$data(el);
      await card?.loadBookComments?.();
    });
    const rail = page.locator('aside.comment-rail:not(.book-editor-comments)');
    const accept = rail.locator('.comment-suggestion .btn-compact', { hasText: /Übernehmen|Accept/ });
    await expect(accept).toBeVisible();
    await accept.click();

    await expect.poll(() => serverHtml(page, pageId)).toContain('kläfft leise');
    await expect(page.locator(VIEW_SEL)).toContainText('kläfft leise');
    await expect(rail.locator('.comment-suggestion__state--accepted')).toBeVisible();
    // Der Rest des Absatzes bleibt unangetastet.
    expect(await serverHtml(page, pageId)).toContain('Die Katze schläft am Ofen.');
    // Revisionsliste: die neueste Revision trägt die Quelle «review».
    const newest = await page.evaluate(async (pid) => {
      const j = await (await fetch(`/content/pages/${pid}/revisions`, { cache: 'no-store' })).json();
      const list = Array.isArray(j) ? j : (j.revisions || j.items || []);
      return list[0]?.source;
    }, pageId);
    expect(newest).toBe('review');

    // ── Owner-Karte: Stand des Review-Links ───────────────────────────────────
    await page.evaluate(() => window.__app.toggleShareLinksCard?.());
    const state = page.locator('.share-review-state').first();
    await expect(state).toContainText('Anna');
    await expect(state).toContainText('Marco');
    // Anlegen-Formular: Review-Schalter blendet die Reviewer-Eingabe ein
    // (tagInput mit Namen der übrigen Review-Links als Vorschlag).
    await page.evaluate(() => { window.Alpine.$data(document.querySelector('.card--share')).createReview = true; });
    await expect(page.locator('.card--share .share-create .tag-input')).toBeVisible();
  } finally {
    await page.evaluate(async (pid) => { await fetch('/content/pages/' + pid, { method: 'DELETE' }); }, pageId);
  }
});

test('Bucheditor: Vorschlag in der Leiste übernehmen schreibt den Block neu', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const pageId = await createPage(page);
  try {
    // Review-Link + Vorschlag direkt über die öffentlichen Routen (die
    // Leser-Seite prüft der Test oben).
    const token = await page.evaluate(async (pid) => {
      const j = async (url, body) => (await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })).json();
      const link = await j('/share/api/links', { kind: 'page', page_id: pid, mode: 'review', reviewers: ['Lea'] });
      const html = (await (await fetch('/content/pages/' + pid, { cache: 'no-store' })).json()).html;
      const bid = /data-bid="([0-9a-f]+)"/.exec(html)[1];
      await j(`/share/${link.token}/comment`, {
        body: 'ruhiger', suggestion: 'schnarcht', reader_token: 'rLeaToken0001',
        anchor_bid: bid, anchor_quote: 'schläft', anchor_start: 36, anchor_end: 43,
      });
      return link.token;
    }, pageId);
    expect(token).toBeTruthy();

    await page.evaluate(() => window.__app.toggleBookEditorCard());
    const editor = page.locator('.card--bookeditor');
    await expect(editor.locator('.book-editor-page-body').first()).toBeVisible({ timeout: 15000 });
    await page.evaluate(async () => {
      const d = window.Alpine.$data(document.querySelector('.card--bookeditor'));
      await d._loadBookComments();
      if (!d.commentRailVisible) d.toggleCommentRail();
    });
    const accept = editor.locator('.book-editor-comments .comment-suggestion .btn-compact', { hasText: /Übernehmen|Accept/ });
    await expect(accept).toBeVisible();
    await accept.click();

    await expect.poll(() => serverHtml(page, pageId)).toContain('Die Katze schnarcht am Ofen.');
    await expect(editor.locator('.book-editor-page-body', { hasText: 'schnarcht' })).toBeVisible();
    const dirty = await page.evaluate(() => window.Alpine.$data(document.querySelector('.card--bookeditor')).dirtyCount);
    expect(dirty).toBe(0);
  } finally {
    await page.evaluate(async (pid) => { await fetch('/content/pages/' + pid, { method: 'DELETE' }); }, pageId);
  }
});

// Link frei geteilt (Team-Chat), keine Namensliste: der Reader fragt nach dem
// Namen, die Person trägt sich ein, der Beitrag geht durch und trägt den Namen.
// Eigener offener Vorschlag: kein «Erledigt» (entscheidet der Autor), Text
// bearbeitbar; die alte Stelle steht einmal, durchgestrichen im Anker-Zitat.
test('Review-Link ohne Namensliste: Leser trägt sich selbst ein und schlägt vor', async ({ page, browser }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const pageId = await createPage(page);
  try {
    const link = await page.evaluate(async (pid) => (await fetch('/share/api/links', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'page', page_id: pid, mode: 'review', reviewers: [] }),
    })).json(), pageId);

    const readerCtx = await browser.newContext({ baseURL: new URL(page.url()).origin });
    const reader = await readerCtx.newPage();
    await reader.goto(`/share/${link.token}`, { waitUntil: 'networkidle' });
    await reader.evaluate(() => {
      const block = document.querySelector('#share-article [data-bid]');
      const text = block.firstChild;
      const start = text.textContent.indexOf('bellt laut');
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + 'bellt laut'.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await reader.locator('.share-sel-btn').click();
    const composer = reader.locator('#share-composer');
    await composer.locator('.share-composer__mode').nth(1).click();
    await composer.locator('.share-composer__suggestion').fill('kläfft leise');
    await composer.locator('.share-composer__submit').click();

    // Namens-Dialog ohne Liste: nur das Feld zum Eintragen.
    const modal = reader.locator('#share-name-modal');
    await expect(modal.locator('.share-review__name')).toBeVisible();
    await expect(modal.locator('.share-review__pick')).toHaveCount(0);
    await modal.locator('.share-review__name').fill('Lea');
    await modal.locator('.share-review__name').press('Enter');
    await expect(composer).toHaveCount(0);

    const card = reader.locator('.share-comments__list .comment-rail__thread').first();
    await expect(card.locator('.comment-rail__author')).toContainText('Lea');
    await expect(card.locator('.comment-rail__quote--old')).toHaveText('bellt laut');
    await expect(card.locator('del')).toHaveCount(0);
    // Kein «Erledigt» am offenen Vorschlag; Bearbeiten ändert den Ersatztext.
    await card.hover();
    await expect(card.locator('.share-thread__action', { hasText: /Mark as done|erledigt/i })).toHaveCount(0);
    await card.locator('.share-thread__action', { hasText: /Edit|Bearbeiten/ }).click();
    await card.locator('.share-thread__suggestion-edit').fill('jault');
    await card.locator('.share-thread__edit button').first().click();
    await expect(card.locator('.comment-suggestion__new')).toHaveText('jault');

    // Abschluss-Sektion: Lea ist eingetragen.
    await expect(reader.locator('#share-feedback.share-review')).toContainText('Lea');
    await readerCtx.close();

    const st = await page.evaluate(async (t) => (await fetch(`/share/api/links/${t}/review`)).json(), link.token);
    expect(st.reviewers.map(r => r.name)).toEqual(['Lea']);
  } finally {
    await page.evaluate(async (pid) => { await fetch('/content/pages/' + pid, { method: 'DELETE' }); }, pageId);
  }
});

// Notebook-Leseansicht, kurzer Abschnitt: die Leiste ist auf Blatthöhe gedeckelt
// (--pcv-max-h). Ohne Mindesthöhe schnitt sie bei einem Zweizeiler schon die
// erste Vorschlagskarte ab — «Übernehmen» lag unsichtbar im Scrollbereich.
test('Notebook-Leseansicht: kurzer Abschnitt, erste Vorschlagskarte steht ganz in der Leiste', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await bootApp(page);
  await selectSeededBook(page);
  const pageId = await createPage(page);
  try {
    const token = await page.evaluate(async (pid) => {
      const j = async (url, body) => (await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })).json();
      const link = await j('/share/api/links', { kind: 'page', page_id: pid, mode: 'review', reviewers: ['Lea'] });
      const html = (await (await fetch('/content/pages/' + pid, { cache: 'no-store' })).json()).html;
      const bid = /data-bid="([0-9a-f]+)"/.exec(html)[1];
      for (const [w, s] of [['Hund', 9], ['Katze', 33], ['Ofen', 52]]) {
        await j(`/share/${link.token}/comment`, {
          body: 'Eine etwas längere Begründung, damit die Karte Höhe hat.', suggestion: w + 'chen',
          reader_token: 'rLeaToken0001', anchor_bid: bid, anchor_quote: w, anchor_start: s, anchor_end: s + w.length,
        });
      }
      return link.token;
    }, pageId);
    await page.evaluate(async (pid) => {
      const p = window.Alpine.store('nav').pages.find(x => x.id === pid);
      await window.__app.selectPage(p);
    }, pageId);
    await page.evaluate((t) => window.dispatchEvent(new CustomEvent('comments-rail:goto', { detail: { token: t } })), token);
    await page.evaluate(async () => {
      const el = document.querySelector('[x-data="editorCommentsCard"]');
      await window.Alpine.$data(el)?.loadBookComments?.();
    });
    const rail = page.locator('aside.comment-rail:not(.book-editor-comments)');
    const accept = rail.locator('.comment-suggestion .btn-compact', { hasText: /Übernehmen|Accept/ }).first();
    await expect(accept).toBeVisible();
    await rail.evaluate(el => { el.scrollTop = 0; });
    const [railBox, btnBox] = [await rail.boundingBox(), await accept.boundingBox()];
    expect(btnBox.y + btnBox.height).toBeLessThanOrEqual(railBox.y + railBox.height);
  } finally {
    await page.evaluate(async (pid) => { await fetch('/content/pages/' + pid, { method: 'DELETE' }); }, pageId);
  }
});

// Bucheditor: Übernehmen verwirft den Undo-Verlauf des Abschnitts (sonst holte
// Cmd+Z den Stand vor dem Vorschlag zurück und speicherte ihn darüber), und wer
// während des Speicherns im Block tippt, behält seine Eingabe — sie landet beim
// nächsten Save im Konflikt-Dialog statt still überschrieben zu werden.
test('Bucheditor: Übernehmen verwirft Undo und überschreibt keine Eingabe während des Speicherns', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  const pageId = await createPage(page);
  try {
    await page.evaluate(async (pid) => {
      const j = async (url, body) => (await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })).json();
      const link = await j('/share/api/links', { kind: 'page', page_id: pid, mode: 'review', reviewers: ['Lea'] });
      const html = (await (await fetch('/content/pages/' + pid, { cache: 'no-store' })).json()).html;
      const bid = /data-bid="([0-9a-f]+)"/.exec(html)[1];
      for (const [q, sugg, s] of [['schläft', 'schnarcht', 36], ['Hof', 'Garten', 24]]) {
        await j(`/share/${link.token}/comment`, {
          body: '', suggestion: sugg, reader_token: 'rLeaToken0001',
          anchor_bid: bid, anchor_quote: q, anchor_start: s, anchor_end: s + q.length,
        });
      }
    }, pageId);

    await page.evaluate(() => window.__app.toggleBookEditorCard());
    const editor = page.locator('.card--bookeditor');
    await expect(editor.locator('.book-editor-page-body').first()).toBeVisible({ timeout: 15000 });
    await page.evaluate(async () => {
      const d = window.Alpine.$data(document.querySelector('.card--bookeditor'));
      await d._loadBookComments();
      if (!d.commentRailVisible) d.toggleCommentRail();
    });

    // 1) Undo-Verlauf vorhanden → nach dem Übernehmen weg.
    await page.evaluate((pid) => {
      const card = window.Alpine.$data(document.querySelector('.card--bookeditor'));
      card._historyFor(pid, { create: true });
    }, pageId);
    const acceptFor = (text) => editor.locator('.book-editor-comments .comment-rail__thread', { hasText: text })
      .locator('.comment-suggestion .btn-compact', { hasText: /Übernehmen|Accept/ });
    await acceptFor('schnarcht').click();
    await expect.poll(() => serverHtml(page, pageId)).toContain('schnarcht');
    expect(await page.evaluate((pid) => {
      const card = window.Alpine.$data(document.querySelector('.card--bookeditor'));
      return card._histories?.has(pid) || false;
    }, pageId)).toBe(false);

    // 2) Save künstlich anhalten, währenddessen «tippen» → Eingabe bleibt.
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.route(`**/content/pages/${pageId}`, async (route) => {
      if (route.request().method() === 'PUT') await gate;
      await route.continue();
    });
    await acceptFor('Garten').click();
    await page.evaluate((pid) => {
      const card = window.Alpine.$data(document.querySelector('.card--bookeditor'));
      const b = card._blockById(pid);
      b.html = '<p>MEINE EINGABE</p>';
      b.dirty = true;
    }, pageId);
    release();
    await expect.poll(() => serverHtml(page, pageId)).toContain('Garten');
    await page.waitForTimeout(300);
    const blk = await page.evaluate((pid) => {
      const b = window.Alpine.$data(document.querySelector('.card--bookeditor'))._blockById(pid);
      return { html: b.html, dirty: b.dirty };
    }, pageId);
    expect(blk.html).toContain('MEINE EINGABE');
    expect(blk.dirty).toBe(true);
    await page.unroute(`**/content/pages/${pageId}`);
    // Aufräumen: der Block bleibt dirty — Autosave darf das Wegwerf-Abschnittsende nicht stören.
    await page.evaluate((pid) => {
      const card = window.Alpine.$data(document.querySelector('.card--bookeditor'));
      card._autosave?.clear?.(pid);
      card._blockById(pid).dirty = false;
    }, pageId);
  } finally {
    await page.evaluate(async (pid) => { await fetch('/content/pages/' + pid, { method: 'DELETE' }); }, pageId);
  }
});
