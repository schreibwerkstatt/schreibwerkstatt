// Spannungsbogen der Plot-Werkstatt: die Klapp-ANIMATION gegen die echte App.
//
// Warum hier und nicht als Fixture-Harness: die Aussage haengt an der echten
// CSS-Hoehenkette des Panels (`.plot-tension-body` + Kind-Abstaende) im
// Zusammenspiel mit `x-collapse`, das ausschliesslich `height` animiert. Liegt
// vertikaler Innenabstand als Padding AM Panel, ist er der Boden der Animation:
// die Hoehe laeuft nur bis zur Padding-Hoehe, haelt dort bis zum Ende der
// Transition-Dauer und springt dann per `display: none` weg — sichtbares Rucken
// an beiden Enden. Ein Harness mit Minimal-CSS wuesste von diesem Padding nichts.
//
// Gemessen wird Frame fuer Frame per requestAnimationFrame, nicht per Endzustand:
// der Defekt liegt ausschliesslich im Verlauf, Anfangs- und Endlayout sind in
// beiden Faellen identisch (darum prueft der Test beides).
//
// Mutationsprobe: gibt man `.plot-tension-body` das vertikale Padding zurueck
// (`padding: var(--space-sm) 0 var(--space-2xs)` ohne `display: flow-root`),
// bleibt `minNonZero` bei 10px stehen (8px + 2px) und der Test faellt.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp } = require('./_helpers/app');

// Genug Beats mit Intensitaet, dass der Bogen ueberhaupt rendert (>= 2 Punkte).
const ACTS = 2;
const BEATS_PER_ACT = 4;

let bookId = null;
let createdActIds = [];

// Der Lauf teilt EINEN Seed-Stand (playwright.app.config.js: `workers: 1`) —
// die angelegten Akte darum wieder wegraeumen (CASCADE nimmt die Beats mit).
test.afterAll(async ({ browser }) => {
  if (!bookId || !createdActIds.length) return;
  const page = await browser.newPage();
  try {
    await bootApp(page);
    await page.evaluate(
      (ids) => Promise.all(ids.map(id => fetch(`/plot/acts/${id}`, { method: 'DELETE' }))),
      createdActIds,
    );
  } finally {
    await page.close();
  }
});

test('plot: Spannungsbogen klappt ohne Sprung bis auf Hoehe 0 zu und wieder auf', async ({ page }) => {
  await bootApp(page);
  bookId = await page.evaluate(() => window.Alpine.store('nav').selectedBookId);

  createdActIds = await page.evaluate(async (cfg) => {
    const post = (url, body) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json());
    const ids = [];
    for (let a = 1; a <= cfg.acts; a++) {
      const act = await post('/plot/acts', { book_id: cfg.bookId, name: `Bogen-Akt ${a}` });
      ids.push(act.id);
      for (let i = 1; i <= cfg.beats; i++) {
        await post('/plot/beats', {
          book_id: cfg.bookId, act_id: act.id, titel: `Bogen-Beat ${a}.${i}`,
          intensitaet: ((a + i) % 5) + 1,
        });
      }
    }
    return ids;
  }, { bookId, acts: ACTS, beats: BEATS_PER_ACT });

  await page.evaluate(() => window.__app.togglePlotCard());
  await page.waitForSelector('.card--plot .plot-tension-dot');
  // Panel ist initial offen (`collapsible(true)`); Board-Load + Alpine-Ticks
  // abwarten, damit die gemessene Ruhehoehe die endgueltige ist.
  await page.waitForTimeout(600);

  const rec = await page.evaluate(async () => {
    const root = document.querySelector('.card--plot .plot-tension');
    const toggle = root.querySelector('.plot-tension-toggle');
    const panel = root.querySelector('.plot-tension-body');
    const chart = root.querySelector('.plot-tension-chart');
    const heights = [];
    let running = true;
    const loop = () => {
      if (!running) return;
      heights.push(panel.getBoundingClientRect().height);
      requestAnimationFrame(loop);
    };
    const geo = () => ({
      rootH: +root.getBoundingClientRect().height.toFixed(2),
      chartTop: +chart.getBoundingClientRect().top.toFixed(2),
    });

    const before = geo();
    requestAnimationFrame(loop);
    await new Promise(r => setTimeout(r, 50));
    toggle.click();                                   // zuklappen
    await new Promise(r => setTimeout(r, 700));
    const closeFrames = heights.slice();
    heights.length = 0;
    toggle.click();                                   // wieder aufklappen
    await new Promise(r => setTimeout(r, 700));
    running = false;
    return { closeFrames, openFrames: heights, before, after: geo() };
  });

  const nonZero = (arr) => arr.filter(h => h > 0.5);

  // 1) Zuklappen laeuft bis (fast) 0 durch — kein Padding-Boden, von dem aus die
  //    letzten Pixel wegspringen. Vor dem Fix blieb die Hoehe bei 10px stehen.
  const closeMin = Math.min(...nonZero(rec.closeFrames));
  expect(closeMin, `kleinste gemessene Hoehe beim Zuklappen: ${closeMin}px`).toBeLessThan(6);
  expect(rec.closeFrames[rec.closeFrames.length - 1]).toBeLessThan(0.5);

  // 2) Aufklappen startet bei (fast) 0, nicht bei der Padding-Hoehe.
  const openMin = Math.min(...nonZero(rec.openFrames));
  expect(openMin, `kleinste gemessene Hoehe beim Aufklappen: ${openMin}px`).toBeLessThan(6);

  // 3) Monoton: keine Richtungswechsel im Verlauf (ein Sprung zurueck waere
  //    genau das Rucken, das ein Neu-Messen mitten in der Animation ausloest).
  const drift = (arr, sign) => arr.reduce((acc, h, i) => (
    i && (h - arr[i - 1]) * sign < -1 ? acc + 1 : acc
  ), 0);
  expect(drift(nonZero(rec.closeFrames), -1), 'Richtungswechsel beim Zuklappen').toBe(0);
  expect(drift(nonZero(rec.openFrames), 1), 'Richtungswechsel beim Aufklappen').toBe(0);

  // 4) Ruhelayout unveraendert: der Abstand wanderte vom Panel-Padding an die
  //    Kinder — sichtbar darf sich dabei nichts verschoben haben.
  expect(rec.after).toEqual(rec.before);

  // 5) Klick genau auf den Chevron klappt auch bei breitem Toggle. Der Toggle
  //    ist `width: 100%`; ein Press-Scale (`button:active { scale(0.98) }`)
  //    zoege seine linke Kante um ~1 % der Breite nach innen, der Chevron am
  //    Rand wanderte unter dem Zeiger weg, mouseup laege ausserhalb des Buttons
  //    und `click` feuerte auf dem gemeinsamen Vorfahren statt am Toggle.
  //    Echte Maus statt `el.click()`: nur sie durchlaeuft :active.
  //    Mutationsprobe: `.collapsible-toggle:active { transform: none; }` in
  //    css/entities/entity-list.css entfernen → aria-expanded bleibt stehen.
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForTimeout(300);
  const toggle = page.locator('.card--plot .plot-tension-toggle');
  const chevron = toggle.locator('.history-chevron');
  for (const expected of ['false', 'true']) {
    const box = await chevron.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(toggle).toHaveAttribute('aria-expanded', expected);
    await page.waitForTimeout(400);
  }
});
