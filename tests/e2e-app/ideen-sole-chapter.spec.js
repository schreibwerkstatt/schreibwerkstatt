// Einabschnitts-Kapitel auf der IDEEN-KARTE gegen die echte App: ein Kapitel
// mit genau einem Abschnitt ist EIN Ort (ideen-shared.js#ideenPlace). Neben
// dem Editor wie neben der Kapitelbewertung zeigt die Karte die Ideen von
// Abschnitt und Kapitel zusammen und legt neue am Abschnitt an; die
// Knopf-Plakette zaehlt beide, der Verschieben-Picker bietet keinen der zwei
// Anker als Ziel an.
//
// Warum e2e-app: der Ort kommt aus `$store.nav.tree` — ob der echte Baum die
// Kapitel-Abschnitt-Beziehung so liefert, wie die Karte sie liest, sieht nur
// die gebootete App.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('ideen-karte: Einabschnitts-Kapitel zeigt Abschnitt + Kapitel als einen Ort', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const made = await page.evaluate(async (id) => {
    const post = (url, payload) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }).then(r => r.json());
    const chapter = await post('/content/chapters', { book_id: id, name: 'Einzelkapitel' });
    const p = await post('/content/pages', { chapter_id: chapter.id, name: 'Einziger Abschnitt', html: '<p>Text.</p>' });
    // Eine Idee am Kapitel eines Einabschnitts-Kapitels legt der Server nicht
    // mehr an (lib/idee-anchor.js) — sie entsteht, wenn ein Kapitel mit zwei
    // Abschnitten einen verliert. Genau so wird sie hier gebaut.
    const extra = await post('/content/pages', { chapter_id: chapter.id, name: 'Wird geloescht', html: '<p>x</p>' });
    const atChapter = await post('/ideen', { book_id: id, chapter_id: chapter.id, content: 'Plan am Kapitel' });
    await fetch(`/content/pages/${extra.id}`, { method: 'DELETE' });
    const atPage = await post('/ideen', { book_id: id, page_id: p.id, content: 'Notiz am Abschnitt' });
    await window.__app.loadPages({ source: 'job' });
    return { chapterId: chapter.id, pageId: p.id, ideen: [atChapter.id, atPage.id] };
  }, bookId);

  try {
    await page.evaluate(async (pid) => {
      await window.__app.selectPage(window.Alpine.store('nav').pages.find(p => p.id === pid));
    }, made.pageId);
    // Knopf-Plakette neben dem Editor: beide offenen Ideen.
    await expect.poll(() => page.evaluate(() => window.__app.currentPageIdeenOpenCount)).toBe(2);

    await page.evaluate(() => window.__app.toggleIdeenCard());
    const card = page.locator('#ideen-card');
    for (const id of made.ideen) await expect(card.locator(`[data-idee-id="${id}"]`)).toBeVisible();

    // Neue Idee aus der Abschnitts-Karte → am Abschnitt.
    await card.locator('.ideen-input').fill('Neu am Ort');
    await card.locator('.ideen-input').press('Enter');
    const created = card.locator('[data-idee-id]', { hasText: 'Neu am Ort' });
    await expect(created).toBeVisible();
    made.ideen.push(Number(await created.getAttribute('data-idee-id')));

    // Verschieben-Picker: weder der Abschnitt noch das eigene Kapitel als Ziel.
    const item = card.locator(`[data-idee-id="${made.ideen[0]}"]`);
    await item.locator('.idee-menu button').click();
    await page.getByRole('menuitem', { name: 'Verschieben' }).click();
    const panel = page.locator('.idee-move-popover');
    await panel.locator('.combobox-trigger').click();
    await expect(panel.locator('.combobox-option', { hasText: 'Einziger Abschnitt' })).toHaveCount(0);
    await expect(panel.locator('.combobox-option', { hasText: 'Einzelkapitel' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // Dieselbe Liste aus der Kapitelbewertung heraus; neue Idee auch dort am Abschnitt.
    await page.evaluate((cid) => window.__app.toggleChapterIdeenCard(cid), made.chapterId);
    for (const id of made.ideen) await expect(card.locator(`[data-idee-id="${id}"]`)).toBeVisible();
    await card.locator('.ideen-input').fill('Aus dem Kapitel');
    await card.locator('.ideen-input').press('Enter');
    const fromChapter = card.locator('[data-idee-id]', { hasText: 'Aus dem Kapitel' });
    await expect(fromChapter).toBeVisible();
    const fromChapterId = Number(await fromChapter.getAttribute('data-idee-id'));
    made.ideen.push(fromChapterId);

    const anchors = await page.evaluate(async (pid) => {
      const rows = await fetch(`/ideen?page_id=${pid}`).then(r => r.json());
      return rows.map(r => r.content);
    }, made.pageId);
    expect(anchors).toEqual(expect.arrayContaining(['Notiz am Abschnitt', 'Neu am Ort', 'Aus dem Kapitel']));
    expect(anchors).not.toContain('Plan am Kapitel');
  } finally {
    await page.evaluate(async (m) => {
      // Erst weg vom Abschnitt, sonst laedt der offene Editor ihn nach dem Loeschen nach (404).
      await window.__app.selectPage(window.Alpine.store('nav').pages.find(p => p.id !== m.pageId));
      for (const id of m.ideen) await fetch(`/ideen/${id}`, { method: 'DELETE' });
      await fetch(`/content/pages/${m.pageId}`, { method: 'DELETE' });
      await fetch(`/content/chapters/${m.chapterId}`, { method: 'DELETE' });
      await window.__app.loadPages({ source: 'job' });
    }, made);
  }
});
