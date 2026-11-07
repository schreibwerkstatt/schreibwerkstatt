// Verifiziert die SortableJS-Beat-DnD der Plot-Werkstatt end-to-end gegen die echte
// App (Smoke-Layer): Board per API seeden, Beat per Drag umsortieren, persistierte
// sort_order prüfen. Deckt den Drag-Pfad ab, den der reine Card-Open-Smoke nicht testet.
const { test, expect } = require('../e2e/_helpers/fixtures');

test('plot: Beat per SortableJS-Drag umsortieren persistiert', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__app && window.Alpine.store('nav').selectedBookId);
  const bookId = await page.evaluate(() => window.Alpine.store('nav').selectedBookId);

  // Board seeden: 1 Akt + 3 Beats via API (im Page-Kontext, mit Session-Cookie).
  const ids = await page.evaluate(async (bookId) => {
    const post = (url, body) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json());
    const act = await post('/plot/acts', { book_id: bookId, name: 'DnD-Akt' });
    const b1 = await post('/plot/beats', { book_id: bookId, act_id: act.id, titel: 'Beat A' });
    const b2 = await post('/plot/beats', { book_id: bookId, act_id: act.id, titel: 'Beat B' });
    const b3 = await post('/plot/beats', { book_id: bookId, act_id: act.id, titel: 'Beat C' });
    return { actId: act.id, b1: b1.id, b2: b2.id, b3: b3.id };
  }, bookId);

  // Plot-Karte öffnen + Board laden.
  await page.evaluate(() => window.__app.togglePlotCard());
  await page.waitForSelector('.card--plot .plot-beat[data-beat-id]');
  // Nur die eigene Zelle zählen: die Specs teilen sich die Smoke-DB, andere
  // Specs können Akte/Beats auf demselben Board hinterlassen.
  const cell = `.card--plot .plot-board .plot-beats[data-act-id="${ids.actId}"]`;
  await page.waitForFunction((sel) => document.querySelectorAll(`${sel} .plot-beat`).length === 3, cell);
  // SortableJS bindet die Zell-Container nach dem Board-Load asynchron neu
  // ($watch('acts') → nextTick → destroy → nextTick → init). Vor dem Drag kurz
  // abwarten, sonst greift der Drag eine noch ungebundene Zelle (Flake).
  await page.waitForTimeout(400);

  // Reihenfolge vor dem Drag (Board-Lesereihenfolge A,B,C).
  const before = await page.$$eval(`${cell} .plot-beat`, els => els.map(e => e.dataset.beatId));
  expect(before).toEqual([String(ids.b1), String(ids.b2), String(ids.b3)]);

  // Beat A (1.) per Drag über Beat C (3.) nach unten ziehen → erwartet B,C,A.
  // Drag startet ausschliesslich am Griff (.plot-beat-grip) — die restliche Karte
  // bleibt klick-fokussiert (Status zyklen, Titel→Edit), kein Drag/Klick-Konflikt.
  // Der synthetische Maus-Drag gegen SortableJS' forceFallback ist im Headless-/
  // CI-Umfeld zeitsensibel (gelegentlich startet der Drag nicht); darum bis zu
  // 4× versuchen, bis sich die Server-Reihenfolge ändert. Reine Test-Robustheit —
  // ein echter Maus-Drag mit natürlichem Verweilen reordert zuverlässig.
  const persistedLast = async () => page.evaluate(async (args) => {
    const data = await fetch(`/plot?book_id=${args.bookId}`).then(r => r.json());
    const inAct = data.beats.filter(b => b.act_id === args.actId).sort((a, b) => a.sort_order - b.sort_order);
    return inAct.length === 3 ? inAct[inAct.length - 1].id : null;
  }, { bookId, actId: ids.actId });

  for (let attempt = 0; attempt < 4 && (await persistedLast()) !== ids.b1; attempt++) {
    // Andere Specs hinterlassen Akte auf demselben Board: die eigene Spalte kann
    // rechts ausserhalb des Sichtbereichs liegen — ein Drag dorthin trifft nichts.
    await page.locator(cell).scrollIntoViewIfNeeded();
    const grip = await page.locator(`.card--plot .plot-board .plot-beat[data-beat-id="${ids.b1}"] .plot-beat-grip`).boundingBox();
    const d = await page.locator(`.card--plot .plot-board .plot-beat[data-beat-id="${ids.b3}"]`).boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    // Mehrere Schritte > fallbackTolerance(5px), damit SortableJS den Drag startet.
    await page.mouse.move(grip.x + grip.width / 2 + 4, grip.y + grip.height / 2 + 12, { steps: 4 });
    // In die untere Hälfte von Beat C ziehen (Einfügen dahinter) + kurz verweilen,
    // damit SortableJS' Fallback-dragOver am Ziel feuert, bevor losgelassen wird.
    await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2, { steps: 10 });
    await page.waitForTimeout(80);
    await page.mouse.move(d.x + d.width / 2, d.y + d.height - 4, { steps: 3 });
    await page.waitForTimeout(60);
    await page.mouse.up();
    await page.waitForTimeout(300);
  }

  // Persistierte Server-Reihenfolge prüfen (sort_order pro Zelle).
  await page.waitForFunction(async (args) => {
    const data = await fetch(`/plot?book_id=${args.bookId}`).then(r => r.json());
    const inAct = data.beats.filter(b => b.act_id === args.actId).sort((a, b) => a.sort_order - b.sort_order);
    return inAct.length === 3 && inAct[inAct.length - 1].id === args.b1;
  }, { bookId, actId: ids.actId, b1: ids.b1 }, { timeout: 10000 });

  const order = await page.evaluate(async (args) => {
    const data = await fetch(`/plot?book_id=${args.bookId}`).then(r => r.json());
    return data.beats.filter(b => b.act_id === args.actId)
      .sort((a, b) => a.sort_order - b.sort_order).map(b => b.id);
  }, { bookId, actId: ids.actId });
  expect(order).toEqual([ids.b2, ids.b3, ids.b1]);
  await page.evaluate((id) => fetch(`/plot/acts/${id}`, { method: 'DELETE' }), ids.actId);
});
