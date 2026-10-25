// Erzählte Zeit am Beat (public/js/book/plot/zeit.js): Befund-Plakette der
// Zeit-Messung an der Karte, gestrichelter Zeit-Tag bei unverstandener Angabe,
// „verstanden als" im Beat-Edit. Gegen die echte App, weil Plakette und Tag am
// vollen CSS (plot/board.css + plot/zeit.css) und am echten Template hängen.
const { test, expect } = require('../e2e/_helpers/fixtures');

test('plot: Zeit-Befund an der Karte, unverstandene Angabe, verstanden als', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__app && window.Alpine.store('nav').selectedBookId);
  const bookId = await page.evaluate(() => window.Alpine.store('nav').selectedBookId);

  const ids = await page.evaluate(async (bookId) => {
    const post = (url, body) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json());
    const act = await post('/plot/acts', { book_id: bookId, name: 'Zeit-Akt' });
    const a = await post('/plot/beats', { book_id: bookId, act_id: act.id, titel: 'Zeit-A', zeit: 'März 2000' });
    const b = await post('/plot/beats', { book_id: bookId, act_id: act.id, titel: 'Zeit-B', zeit: '1990' });
    const c = await post('/plot/beats', { book_id: bookId, act_id: act.id, titel: 'Zeit-C', zeit: 'vor der Reise' });
    return { actId: act.id, a: a.id, b: b.id, c: c.id };
  }, bookId);

  try {
    await page.evaluate(() => window.__app.togglePlotCard());
    const beat = id => page.locator(`.card--plot .plot-board .plot-beat[data-beat-id="${id}"]`);
    await expect(beat(ids.a)).toBeVisible();

    // B (1990) steht nach A (März 2000) in derselben Lane → Chronologie-Bruch, Ton mittel.
    const mark = beat(ids.b).locator('.plot-beat-timecheck');
    await expect(mark).toBeVisible();
    await expect(mark).toHaveClass(/plot-beat-timecheck--mittel/);
    await expect(mark).toHaveAttribute('data-tip', /März 2000/);
    await expect(beat(ids.a).locator('.plot-beat-timecheck')).toBeHidden();

    // Unverstandener Freitext: gestrichelter Tag, Tooltip sagt „nicht geprüft".
    const tagC = beat(ids.c).locator('.tag--zeit');
    await expect(tagC).toHaveClass(/tag--zeit-unklar/);
    await expect(tagC).toHaveCSS('border-top-style', 'dashed');
    await expect(beat(ids.a).locator('.tag--zeit')).toHaveAttribute('data-tip', /03\.2000/);

    // Beat-Edit: „verstanden als" für den gespeicherten Wert, „beim Speichern" für Getipptes.
    await beat(ids.a).locator('.plot-beat-title').click();
    const edit = beat(ids.a).locator('.plot-beat-edit');
    // Zeit sitzt in der klappbaren „Details"-Sektion; deren Zustand hängt an der Karte.
    const details = edit.locator('.plot-beat-edit-section').first();
    if (!await details.locator('.plot-edit-input').isVisible()) await details.locator('.collapsible-toggle').click();
    const hint = edit.locator('.plot-zeit-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText(/03\.2000/);
    await edit.locator('.plot-edit-input').fill('Sommer 2001');
    await expect(hint).not.toHaveText(/03\.2000/);
  } finally {
    await page.evaluate((id) => fetch(`/plot/acts/${id}`, { method: 'DELETE' }), ids.actId);
  }
});

test('plot: Durchsicht der Zeitvorschläge — Belege sichtbar, nur eindeutige vorausgewählt, ein Undo-Schritt', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__app && window.Alpine.store('nav').selectedBookId);
  const bookId = await page.evaluate(() => window.Alpine.store('nav').selectedBookId);
  const ids = await page.evaluate(async (bookId) => {
    const post = (url, body) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(r => r.json());
    const act = await post('/plot/acts', { book_id: bookId, name: 'Vorschlag-Akt' });
    const a = await post('/plot/beats', { book_id: bookId, act_id: act.id, titel: 'Vorschlag-A', status: 'im_buch' });
    const b = await post('/plot/beats', { book_id: bookId, act_id: act.id, titel: 'Vorschlag-B', status: 'im_buch' });
    return { actId: act.id, a: a.id, b: b.id };
  }, bookId);

  // Die Ableitung (beste Fundstelle → Ereignisse) ist serverseitig getestet; hier zählt
  // die Oberfläche — darum die Vorschlagsliste gestubbt, PATCH/Undo echt.
  await page.route('**/plot/zeit-vorschlaege?*', route => route.fulfill({
    json: { vorschlaege: [
      { beat_id: ids.a, zeit: '1999', page_id: 1, page_name: 'Das nächste Drama', n: 1, spread: 0, eindeutig: true,
        belege: [{ datum: '1999', ereignis: 'Renate ist schwanger' }] },
      { beat_id: ids.b, zeit: '1980–1999', page_id: 1, page_name: 'Das nächste Drama', n: 2, spread: 19, eindeutig: false,
        belege: [{ datum: '1980', ereignis: 'Adrian wird Pfarrer' }, { datum: '1999', ereignis: 'Renate ist schwanger' }] },
    ] },
  }));

  try {
    await page.evaluate(() => window.__app.togglePlotCard());
    const review = page.locator('.card--plot .plot-zeit-review');
    await expect(review).toBeVisible();
    await review.locator('.collapsible-toggle').click();
    const rows = review.locator('.plot-zeit-review-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Renate ist schwanger');
    await expect(rows.nth(0).locator('.entity-ref--seite')).toContainText('Das nächste Drama');
    // Nur der eindeutige Vorschlag ist vorausgewählt; der breite trägt den Hinweis.
    await expect(rows.nth(0).locator('input[type=checkbox]')).toBeChecked();
    await expect(rows.nth(1).locator('input[type=checkbox]')).not.toBeChecked();
    await expect(rows.nth(1).locator('.badge')).toBeVisible();
    await expect(rows.nth(0).locator('.badge')).toBeHidden();

    await review.locator('.plot-zeit-review-actions .btn-compact').first().click();
    const zeitOf = id => page.evaluate(id => Alpine.$data(document.querySelector('.card--plot')).beats.find(b => b.id === id)?.zeit ?? null, id);
    await expect.poll(() => zeitOf(ids.a)).toBe('1999');
    expect(await zeitOf(ids.b)).toBeNull();

    // Ein Undo-Schritt nimmt die Sammel-Übernahme zurück.
    await page.evaluate(() => Alpine.$data(document.querySelector('.card--plot')).plotHistoryUndo());
    await expect.poll(() => zeitOf(ids.a)).toBeNull();
  } finally {
    await page.unroute('**/plot/zeit-vorschlaege?*');
    await page.evaluate((id) => fetch(`/plot/acts/${id}`, { method: 'DELETE' }), ids.actId);
  }
});

test('plot: Alters-Chip der Strang-Figur an der Karte', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__app && window.Alpine.store('nav').selectedBookId);
  const bookId = await page.evaluate(() => window.Alpine.store('nav').selectedBookId);
  const ids = await page.evaluate(async (bookId) => {
    const post = (url, body) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(r => r.json());
    const act = await post('/plot/acts', { book_id: bookId, name: 'Alter-Akt (32-38)' });
    const thread = await post('/plot/threads', { book_id: bookId, name: 'Alter-Strang' });
    const beat = await post('/plot/beats', { book_id: bookId, act_id: act.id, thread_id: thread.id, titel: 'Alter-Beat', zeit: '2002–2003' });
    return { actId: act.id, threadId: thread.id, beatId: beat.id };
  }, bookId);

  // Strang-Figur + Steckbrief-Geburtsjahr kommen vom Server (integration-getestet);
  // hier die Board-Antwort so ergänzt, dass der Strang einer Figur *1968 gehört.
  await page.route('**/plot?book_id=*', async route => {
    const res = await route.fetch();
    const json = await res.json();
    json.threads = json.threads.map(t => (t.id === ids.threadId ? { ...t, fig_id: 'fig_alter_test' } : t));
    json.geburtsjahre = { ...(json.geburtsjahre || {}), fig_alter_test: 1968 };
    await route.fulfill({ response: res, json });
  });

  try {
    await page.evaluate(() => window.__app.togglePlotCard());
    // Mit Strang rendert das Swimlane-Grid statt des flachen Boards.
    const chip = page.locator(`#partial-plot-board-grid .plot-beat[data-beat-id="${ids.beatId}"] .tag--alter`);
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(/34–35/);
    await expect(chip).toHaveAttribute('data-tip', /1968/);
    // Zeitfenster des Akts für den Strang, einmal je Zelle: 1968 + (32–38) → 2000–2007.
    const zelle = page.locator(`#partial-plot-board-grid .plot-swim-cell:has(.plot-beat[data-beat-id="${ids.beatId}"]) .plot-swim-cell-zeit`);
    await expect(zelle).toBeVisible();
    await expect(zelle).toHaveText(/2000–2007/);
  } finally {
    await page.unroute('**/plot?book_id=*');
    await page.evaluate(async ({ actId, threadId }) => {
      await fetch(`/plot/acts/${actId}`, { method: 'DELETE' });
      await fetch(`/plot/threads/${threadId}`, { method: 'DELETE' });
    }, ids);
  }
});
