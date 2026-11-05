// Beat-Karte: wo die Aktionen liegen und was die Karte NICHT überdecken darf.
//
// Die Schnellaktionen (Verwerfen/Löschen) liegen im Beat-Edit, nicht als
// Hover-Overlay auf der Karte: als Overlay lagen sie genau auf den Badges der
// Kopfzeile (Textstellen-Chip, Konflikt-Warnung) — der Klick aufs Chip traf dann
// das Löschen-Icon. Gegen die echte App, weil die Mechanik am vollen CSS hängt
// (components/hover-reveal.css + plot/board.css).
const { test, expect } = require('../e2e/_helpers/fixtures');

// Akt + Beat anlegen; der Akt fällt am Ende wieder weg (seine Beats per CASCADE).
async function seedBeat(page, titel, status = 'geplant') {
  const bookId = await page.evaluate(() => window.Alpine.store('nav').selectedBookId);
  return page.evaluate(async ({ bookId, titel, status }) => {
    const post = (url, body) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json());
    const act = await post('/plot/acts', { book_id: bookId, name: 'Aktionen-Akt' });
    const beat = await post('/plot/beats', { book_id: bookId, act_id: act.id, titel, status });
    return { actId: act.id, beatId: beat.id };
  }, { bookId, titel, status });
}

// Der Beat kann im flachen Board ODER im Akte×Stränge-Grid stehen (die Suite
// teilt einen Seed-Stand, in dem ein Strang liegen bleiben kann) — deshalb wird
// die SICHTBARE Karte genommen, nicht die erste im DOM.
async function openPlotCard(page, beatId) {
  await page.evaluate(() => window.__app.togglePlotCard());
  const card = page.locator(`.card--plot .plot-beat[data-beat-id="${beatId}"]:visible`).first();
  await expect(card).toBeVisible();
  return card;
}

test('plot: Die Beat-Karte in der Ansicht trägt keine Aktions-Buttons', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__app && window.Alpine.store('nav').selectedBookId);
  const ids = await seedBeat(page, 'Aktionen-Beat');

  // Die App-Suite teilt EINEN Seed-Stand: der Akt fällt am Ende wieder weg (seine
  // Beats per CASCADE), sonst schiebt er spätere Board-Specs (plot-dnd) aus dem Bild.
  try {
    const card = await openPlotCard(page, ids.beatId);
    // Kein Overlay, das den Textstellen-Chip oder den Konflikt-Badge verdecken
    // könnte — die Aktionen liegen im Edit.
    await expect(card.locator('.plot-beat-actions')).toHaveCount(0);
    await expect(card.locator('.plot-beat-view .icon-btn')).toHaveCount(0);
  } finally {
    await page.evaluate((id) => fetch(`/plot/acts/${id}`, { method: 'DELETE' }), ids.actId);
  }
});

test('plot: Verwerfen und Löschen stehen im Beat-Edit', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__app && window.Alpine.store('nav').selectedBookId);
  const ids = await seedBeat(page, 'Aktionen-Beat');
  const bookId = await page.evaluate(() => window.Alpine.store('nav').selectedBookId);

  try {
    const card = await openPlotCard(page, ids.beatId);
    await card.locator('.plot-beat-title').first().click();
    const edit = card.locator('.plot-beat-edit');
    await expect(edit).toBeVisible();
    await expect(edit.locator('.plot-beat-discard')).toBeVisible();
    await expect(edit.locator('.plot-beat-delete')).toBeVisible();

    // Verwerfen persistiert das Flag (eigene Achse, kein Status).
    await edit.locator('.plot-beat-discard').click();
    await expect.poll(async () => page.evaluate(async ({ beatId, bookId }) => {
      const board = await fetch(`/plot?book_id=${bookId}`).then(r => r.json());
      return (board.beats || []).find(b => b.id === beatId)?.verworfen || 0;
    }, { beatId: ids.beatId, bookId })).toBe(1);
    // Ein verworfener Beat verlässt das Board (pro Akt eingeklappt) — und der
    // offene Edit-Zustand geht mit (keine Verfassung ohne Karte).
    await expect(page.locator(`.card--plot .plot-beat[data-beat-id="${ids.beatId}"]:visible`)).toHaveCount(0);
  } finally {
    await page.evaluate((id) => fetch(`/plot/acts/${id}`, { method: 'DELETE' }), ids.actId);
  }
});

test('plot: Der Textstellen-Chip zeigt die Zahl und öffnet das Fundstellen-Popover', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__app && window.Alpine.store('nav').selectedBookId);
  // Der Beat-Titel steht woertlich im Seed-Text ("Als Gregor Samsa eines Morgens…"),
  // damit der Anker-Lauf (ohne Embedding-Backend: FTS ueber den Titel) eine
  // Fundstelle findet — so bekommt die Karte den Textstellen-Chip.
  const ids = await seedBeat(page, 'Gregor Samsa', 'im_buch');
  const bookId = await page.evaluate(() => window.Alpine.store('nav').selectedBookId);

  try {
    const anchored = await page.evaluate(async (bookId) => {
      const post = (url, body) => fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(r => r.json());
      const job = await post('/jobs/beat-anchor', { book_id: bookId });
      if (!job.jobId) return { ok: false, reason: 'no job' };
      for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 300));
        const j = await fetch(`/jobs/${job.jobId}`).then(r => r.json());
        if (j.status === 'done') return { ok: true, occurrences: j.result?.occurrences };
        if (j.status === 'error' || j.status === 'cancelled') return { ok: false, reason: j.status, error: j.error };
      }
      return { ok: false, reason: 'timeout' };
    }, bookId);
    expect(anchored.ok, `Anker-Lauf: ${JSON.stringify(anchored)}`).toBe(true);

    const card = await openPlotCard(page, ids.beatId);
    const chip = card.locator('.plot-beat-anchor--confirmed').first();
    await expect(chip).toBeVisible();
    // Die Zahl der Fundstellen steht im Chip.
    await expect(chip).toHaveText(/^[1-9]\d*$/);

    // Der Chip ist frei: nichts liegt ueber ihm, der Klick oeffnet das Popover.
    await chip.scrollIntoViewIfNeeded();
    const covered = await chip.evaluate(el => {
      const b = el.getBoundingClientRect();
      const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return top !== el ? (top.className || top.tagName) : '';
    });
    expect(covered).toBe('');

    await chip.click();
    const popover = page.locator('.plot-occ-popover');
    await expect(popover).toBeVisible();
    await expect(popover.locator('.plot-occ-item').first()).toBeVisible();
  } finally {
    await page.evaluate((id) => fetch(`/plot/acts/${id}`, { method: 'DELETE' }), ids.actId);
  }
});
