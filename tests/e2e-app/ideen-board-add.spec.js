// Ideen-Board gegen die ECHTE App: Gliedern im Board — «+ Kapitel» und eine
// eingefuegte Liste als eine Idee je Zeile (public/js/book/ideen-board/add.js).
//
// Warum hier: die Aussagen haengen am echten Baum (`createChapter` der Wurzel,
// Bahn aus `$store.nav.tree`), am Bestaetigungsdialog der Shell und daran, dass
// das Board offen BLEIBT — der Sidebar-Weg oeffnet den neuen Abschnitt sonst
// zum Schreiben. Nichts gestubbt.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const DIALOG = '#app-confirm-dialog[open]';
const CHAPTER_NAME = 'E2E Gliederung Board';

// Was dieses Spec anlegt, raeumt es weg (ein Server, ein Seed-Stand fuer alle
// App-Specs): erst die Ideen — beim Kapitel-Loeschen wuerden sie sonst zu
// Buch-Ideen und blieben stehen —, dann Abschnitte und Kapitel.
async function cleanup(page, bookId) {
  await page.evaluate(async ({ id, name }) => {
    const tree = await fetch(`/content/books/${id}/tree`).then(r => r.json());
    const chapters = (tree.chapters || []).filter(c => c.name === name);
    const board = await fetch(`/ideen/board?book_id=${id}`).then(r => r.json());
    const ids = new Set(chapters.map(c => c.id));
    const pageIds = new Set(chapters.flatMap(c => (c.pages || []).map(p => p.id)));
    const stale = (board.ideen || []).filter(i => ids.has(i.chapter_id) || pageIds.has(i.page_id));
    await Promise.all(stale.map(i => fetch(`/ideen/${i.id}`, { method: 'DELETE' })));
    for (const pid of pageIds) await fetch(`/content/pages/${pid}`, { method: 'DELETE' });
    for (const cid of ids) await fetch(`/content/chapters/${cid}`, { method: 'DELETE' });
  }, { id: bookId, name: CHAPTER_NAME });
}

test('ideen-board: «+ Kapitel» legt an, Bahn steht leer da, Liste wird eine Idee je Zeile', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  await cleanup(page, bookId);

  try {
    await page.evaluate((id) => { location.hash = `#book/${id}/ideen`; }, bookId);
    const card = page.locator('#ideen-board-card');
    await expect(card).toBeVisible();

    // ── «+ Kapitel»: Name im Dialog, Board bleibt offen ─────────────────────
    await card.locator('.ideen-board-add-chapter').click();
    await page.locator(`${DIALOG} .confirm-dialog-field`).fill(CHAPTER_NAME);
    await page.locator(`${DIALOG} .confirm-dialog-btn:not(.confirm-dialog-btn--cancel)`).click();

    const chapterId = await expect.poll(() => page.evaluate((name) =>
      window.Alpine.store('nav').tree.find(i => i.type === 'chapter' && i.name === name)?.id ?? null, CHAPTER_NAME))
      .not.toBeNull().then(() => page.evaluate((name) =>
        window.Alpine.store('nav').tree.find(i => i.type === 'chapter' && i.name === name).id, CHAPTER_NAME));

    // Kein Sprung in den Editor: wer im Board gliedert, gliedert weiter.
    await expect(card).toBeVisible();

    // Die neue Bahn steht im Raster, obwohl sie keine Idee traegt, und ist im
    // Anlegen-Feld vorgewaehlt (Bahn-Key je nach Buch Kapitel oder Abschnitt).
    const laneKey = await page.evaluate(() => window.Alpine.$data(document.getElementById('ideen-board-card')).newLaneKey);
    expect(laneKey).toMatch(/^(chapter|page):\d+$/);
    await expect(card.locator(`[data-idee-lane="${laneKey}"]`).first()).toBeVisible();
    await expect(card.locator('.ideen-board-add-input')).toBeFocused();

    // ── Eingefuegte Liste: Rueckfrage, dann eine Idee je Zeile ──────────────
    await card.locator('.ideen-board-add-input').fill('- Schwester taucht auf\n- Brief im Regen\n\n- Bahnhof bei Nacht');
    await card.locator('.ideen-board-add .ideen-add-btn').click();
    await expect(page.locator(`${DIALOG} .confirm-dialog-message`)).toContainText('3');
    await page.locator(`${DIALOG} .confirm-dialog-btn:not(.confirm-dialog-btn--cancel)`).click();

    const cell = card.locator(`[data-idee-lane="${laneKey}"][data-idee-status-cell="offen"]`);
    await expect(cell.locator('[data-idee-card-id]')).toHaveCount(3);
    await expect(card.locator('.ideen-board-add-input')).toHaveValue('');

    // Persistiert, ohne Aufzaehlungszeichen, am neuen Kapitel (bzw. seinem Abschnitt).
    const stored = await page.evaluate(async ({ id, cid }) => {
      const data = await fetch(`/ideen/board?book_id=${id}`).then(r => r.json());
      return data.ideen.filter(i => i.lane_chapter_id === cid || i.chapter_id === cid).map(i => i.content).sort();
    }, { id: bookId, cid: chapterId });
    expect(stored).toEqual(['Bahnhof bei Nacht', 'Brief im Regen', 'Schwester taucht auf']);
  } finally {
    await cleanup(page, bookId);
  }
});

test('ideen-karte: Ideen an drei Orten zeigen den Hinweis aufs Board, der Knopf oeffnet es', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  // Der Tipp ist pro User weggeklickt (serverseitig) — fuer diesen Lauf offen.
  await page.evaluate(() => window.Alpine.store('hints').setDismissed([]));
  const pageIds = await page.evaluate(() => window.Alpine.store('nav').pages.slice(0, 3).map(p => p.id));
  expect(pageIds.length, 'Seed-Buch braucht drei Abschnitte').toBe(3);
  try {
    const card = page.locator('#ideen-card');
    const hint = card.locator('.ideen-board-hint');
    for (const [n, pid] of pageIds.entries()) {
      await page.evaluate(async (id) => {
        await window.__app.selectPage(window.Alpine.store('nav').pages.find(p => p.id === id));
        if (!window.__app.showIdeenCard) await window.__app.toggleIdeenCard();
      }, pid);
      await expect(card).toBeVisible();
      // Erst ab dem dritten Ort — zwei Orte sind noch kein Gliedern.
      await expect(hint).toHaveCount(0);
      const before = await card.locator('[data-idee-id]').count();
      await card.locator('.ideen-input').fill(`Hinweis-Test ${n}`);
      await card.locator('.ideen-input').press('Enter');
      await expect(card.locator('[data-idee-id]')).toHaveCount(before + 1);
    }
    await expect(hint).toBeVisible();

    await hint.locator('.feature-tip__action').click();
    await expect(page.locator('#ideen-board-card')).toBeVisible();
    expect(await page.evaluate(() => window.Alpine.store('hints').isOpen('ideen.boardOverview'))).toBe(false);
  } finally {
    await page.evaluate(async (id) => {
      const data = await fetch(`/ideen/board?book_id=${id}`).then(r => r.json());
      const mine = data.ideen.filter(i => /^Hinweis-Test \d$/.test(i.content));
      await Promise.all(mine.map(i => fetch(`/ideen/${i.id}`, { method: 'DELETE' })));
    }, bookId);
  }
});
