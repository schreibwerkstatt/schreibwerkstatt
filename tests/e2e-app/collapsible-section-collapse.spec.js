// `.collapsible-section` (geteilte Klappsektion, css/entities/entity-list.css):
// die Klapp-ANIMATION gegen die echte App.
//
// Warum hier und nicht als Fixture-Harness: die Aussage haengt an der echten
// CSS-Hoehenkette des Panels im Zusammenspiel mit `x-collapse`, das
// ausschliesslich `height` animiert. Vertikales Padding, Margin oder Border am
// Panel bleiben als Boden der Animation stehen und springen am Ende per
// `display: none` weg — Rucken beim Zuklappen (Kontinuitaets-Zusammenfassung,
// PDF-Export, Erzaehlprofil, …). Ein Harness mit Minimal-CSS wuesste davon nichts.
//
// Das Panel wird mit Text als direktem Inhalt in die gebootete App gehaengt —
// der haerteste Konsument (Kontinuitaets-Zusammenfassung via `x-text`): dort
// gibt es kein Kind, an das sich ein Innenabstand verlegen liesse.
//
// Mutationsprobe: `.collapsible-section` wieder `padding: var(--space-6) …
// var(--space-10); margin: var(--space-sm) 0` geben → `closeMin` bleibt bei der
// Padding-Hoehe stehen, und die letzte Hoehe vor dem Verschwinden ist > 6px.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp } = require('./_helpers/app');

// Zwei Formen: die geteilte `.collapsible-section` (Text direkt im Panel) und
// das nackte Panel mit gestyltem Kind (Grid + margin-top + Rahmen am Kind) —
// das Muster aller uebrigen Konsumenten, gestuetzt von `.collapse-panel`.
const LOREM = 'Lorem ipsum dolor sit amet. '.repeat(20);
const CASES = [
  { name: 'collapsible-section', panel: `<div x-bind="panel" class="collapsible-section kontinuitaet-summary">${LOREM}</div>` },
  { name: 'nacktes Panel + gestyltes Kind', panel: `<div x-bind="panel"><div class="device-tokens-body kapitel-subchapters-body"><p>${LOREM}</p></div></div>` },
];

for (const c of CASES) test(`${c.name}: klappt ohne Sprung bis auf Hoehe 0 zu und wieder auf`, async ({ page }) => {
  await bootApp(page);

  const rec = await page.evaluate(async (panelHtml) => {
    const host = document.createElement('div');
    host.className = 'collapsible-wrap';
    host.setAttribute('x-data', 'collapsible(true)');
    host.innerHTML = `
      <button type="button" class="collapsible-toggle" x-bind="trigger">
        <span class="history-chevron" x-bind="chevron" aria-hidden="true"></span>
        <span>Toggle</span>
      </button>
      ${panelHtml}
      <p class="after-probe">Danach</p>`;
    document.body.prepend(host);
    window.Alpine.initTree(host);
    await new Promise(r => setTimeout(r, 100));

    const toggle = host.querySelector('.collapsible-toggle');
    const panel = host.querySelector('.collapse-panel');
    const probe = host.querySelector('.after-probe');
    const heights = [];
    let running = true;
    const loop = () => {
      if (!running) return;
      heights.push(panel.getBoundingClientRect().height);
      requestAnimationFrame(loop);
    };
    const geo = () => ({
      panelH: +panel.getBoundingClientRect().height.toFixed(2),
      probeTop: +probe.getBoundingClientRect().top.toFixed(2),
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
    const after = geo();
    host.remove();
    return { closeFrames, openFrames: heights, before, after };
  }, c.panel);

  const nonZero = (arr) => arr.filter(h => h > 0.5);

  // 1) Zuklappen laeuft bis (fast) 0 durch — kein Padding-Boden.
  const closeMin = Math.min(...nonZero(rec.closeFrames));
  expect(closeMin, `kleinste gemessene Hoehe beim Zuklappen: ${closeMin}px`).toBeLessThan(6);
  expect(rec.closeFrames[rec.closeFrames.length - 1]).toBeLessThan(0.5);

  // 2) Aufklappen startet bei (fast) 0.
  const openMin = Math.min(...nonZero(rec.openFrames));
  expect(openMin, `kleinste gemessene Hoehe beim Aufklappen: ${openMin}px`).toBeLessThan(6);

  // 3) Monoton: keine Richtungswechsel im Verlauf.
  const drift = (arr, sign) => arr.reduce((acc, h, i) => (
    i && (h - arr[i - 1]) * sign < -1 ? acc + 1 : acc
  ), 0);
  expect(drift(nonZero(rec.closeFrames), -1), 'Richtungswechsel beim Zuklappen').toBe(0);
  expect(drift(nonZero(rec.openFrames), 1), 'Richtungswechsel beim Aufklappen').toBe(0);

  // 4) Ruhelayout nach dem Zyklus unveraendert, und der Folgeinhalt sitzt nach
  //    dem Aufklappen dort, wo er vorher sass (kein Nachrutschen der Margins).
  expect(rec.after).toEqual(rec.before);
});
