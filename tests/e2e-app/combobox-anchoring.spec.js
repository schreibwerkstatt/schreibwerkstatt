// Combobox-Dropdown haengt am Trigger — in JEDER Karte, ohne Fall-Liste.
//
// Warum gegen die ECHTE App und nicht als Fixture-Harness: die Invariante ist
// eine Aussage ueber den CONTAINING BLOCK, und den bestimmt das volle CSS der
// Shell. Das Dropdown ist `position: fixed` und wird von x-anchor (Floating UI)
// am Trigger verankert. Floating UI haelt jeden Vorfahren mit
// `container-type != normal` fuer einen Containing Block und rechnet die
// Koordinaten relativ dazu — der Browser tut das NICHT. Sitzt der
// `container-type` also auf einem Vorfahren der Combobox, klappt die Liste um
// genau den Offset dieses Vorfahren daneben auf (links oben statt am Trigger),
// waehrend jeder Zustand korrekt „offen" sagt. Ein Harness ohne die echte
// Karten-Geometrie saehe davon nichts.
//
// Warum ueber alle Karten statt einer Fall-Liste: eine Liste deckt nur ab, wer
// beim Bauen an sie denkt — die Kacheln von „Meine Statistik" (`.overview-tile`
// traegt `container-type`) standen nie drauf. Die Karten kommen wie im Smoke aus
// `EXCLUSIVE_CARDS`, je Karte wird jede sichtbare Combobox aufgeklappt.
// Geprueft wird die LINKE Kante, nicht nur die Naehe: kompakte Comboboxen sind
// breiter als ihr Trigger, eine zentrierte Liste (falsche x-anchor-Platzierung)
// faellt nur dort auf.
//
// Grenze: Comboboxen in zugeklappten Panels oder inaktiven Reitern sind beim
// Oeffnen der Karte nicht sichtbar und bleiben ungeprueft.
//
// Konsequenz fuer neuen Code: `container-type` gehoert auf einen Wrapper, in dem
// kein Popover aufgeht — nicht auf die Karten-Wurzel oder eine Kachel mit
// Combobox (sonst dort `container-type: normal`, siehe my-stats.css).
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('combobox-anchoring: in jeder Karte klappt die Liste am Trigger auf', async ({ page }) => {
  test.setTimeout(180_000);
  await bootApp(page);
  await selectSeededBook(page);

  // Kartenermittlung wie smoke.spec.js: Registry-SSoT, Buchtyp-gegatete Karten
  // bekommen ihren Typ, sonst wuerden sie nie gerendert.
  const cards = await page.evaluate(async () => {
    const reg = await import('/js/cards/feature-registry.js');
    return reg.EXCLUSIVE_CARDS
      .filter((c) => typeof window.__app[c.toggle] === 'function')
      .map((c) => ({
        toggle: c.toggle,
        buchtyp: Array.isArray(c.requiresBuchtyp) ? c.requiresBuchtyp[0] : (c.requiresBuchtyp || null),
      }))
      .sort((a, b) => a.toggle.localeCompare(b.toggle));
  });
  expect(cards.length, 'mind. eine Toggle-Karte gefunden').toBeGreaterThan(5);

  const failures = [];
  let checked = 0;
  for (const { toggle, buchtyp } of cards) {
    await page.evaluate(() => window.__app._closeOtherMainCards?.(null));
    await page.waitForTimeout(80);
    await page.evaluate(({ n, bt }) => {
      const nav = window.Alpine.store('nav');
      const book = (nav.books || []).find((b) => String(b.id) === String(nav.selectedBookId));
      window.__anchorPrevBuchtyp = book ? book.buchtyp : undefined;
      if (book && bt) book.buchtyp = bt;
      return Promise.resolve(window.__app[n]());
    }, { n: toggle, bt: buchtyp });
    // Render + Lazy-Partial-Inject abwarten; dann bis die Karten-Einblendung
    // (`cardFadeIn`, Transform) steht — waehrend sie laeuft, IST die Karte ein
    // Containing Block und die Messung waere bedeutungslos.
    await page.waitForTimeout(450);
    await expect.poll(() => page.evaluate(() =>
      [...document.querySelectorAll('.layout-main .card')]
        .every((el) => getComputedStyle(el).transform === 'none'))).toBe(true);

    const res = await page.evaluate(async () => {
      const frames = (n) => new Promise((r) => {
        const step = (k) => (k <= 0 ? r() : requestAnimationFrame(() => step(k - 1)));
        step(n);
      });
      const describe = (wrap) => {
        const lbl = wrap.getAttribute('aria-labelledby');
        const text = (lbl && document.getElementById(lbl.split(' ')[0])?.textContent)
          || wrap.querySelector('.combobox-value')?.textContent || '';
        const host = wrap.closest('[class*="tile"], .card');
        return `«${text.trim()}» in .${String(host?.className || '').trim().split(/\s+/).join('.')}`;
      };
      const out = { checked: 0, bad: [] };
      const wraps = [...document.querySelectorAll('.layout-main .combobox-wrap')]
        .filter((w) => w.checkVisibility());
      const waitDropdown = async (scope) => {
        for (let i = 0; i < 20; i++) {
          const dd = scope.querySelector('.combobox-dropdown');
          if (dd) return dd;
          await frames(1);
        }
        return null;
      };
      for (const wrap of wraps) {
        if (!wrap.isConnected) continue;
        const shellTrigger = wrap.querySelector(':scope > .combobox-trigger');
        if (!shellTrigger) continue;
        const data = window.Alpine.$data(wrap);
        // Echte Combobox oder Lazy-Huelle (Organizer-Zeilen: statischer Trigger,
        // der Klick montiert die echte Combobox mit `autoOpen`). Ein Trigger mit
        // `aria-haspopup="dialog"` oeffnet einen Picker, keine Liste.
        const real = typeof data?.toggle === 'function' && 'ddWidth' in data;
        if (real && (data._disabled || data.open)) continue;
        if (!real && shellTrigger.getAttribute('aria-haspopup') !== 'listbox') continue;
        // Erst scrollen, dann oeffnen: ein Scroll-Event schliesst die Liste.
        shellTrigger.scrollIntoView({ block: 'center' });
        await frames(2);
        shellTrigger.click();
        const dd = await waitDropdown(real ? wrap : document.querySelector('.layout-main'));
        if (!dd) { out.bad.push(`${describe(wrap)}: Liste oeffnet nicht`); continue; }
        const box = dd.closest('.combobox-wrap');
        const trigger = box.querySelector(':scope > .combobox-trigger');
        await frames(3); // Floating UI rechnet asynchron
        const t = trigger.getBoundingClientRect();
        const d = dd.getBoundingClientRect();
        // Linksbuendig (bottom-start) oder — ragte sie rechts hinaus — von
        // Floating UIs flip rechtsbuendig gekippt (bottom-end). Am Viewport-Rand
        // darf shift (padding 5) einruecken. Eine zentrierte oder um einen
        // Container-Offset verschobene Liste trifft keine der Kanten.
        const xOk = Math.abs(d.left - t.left) < 2 || Math.abs(d.right - t.right) < 2
          || d.left <= 6 || d.right >= window.innerWidth - 6;
        // Unten kein Platz → Flip nach oben.
        const yOk = Math.abs(d.top - t.bottom) < 2 || Math.abs(d.bottom - t.top) < 2;
        if (!xOk || !yOk) {
          out.bad.push(`${describe(box)}: Liste x=${Math.round(d.x)} y=${Math.round(d.y)} w=${Math.round(d.width)}, `
            + `Trigger x=${Math.round(t.x)} y=${Math.round(t.y)} w=${Math.round(t.width)} h=${Math.round(t.height)}`);
        }
        out.checked++;
        window.Alpine.$data(box).close();
        await frames(2);
      }
      return out;
    });
    checked += res.checked;
    for (const b of res.bad) failures.push(`${toggle}: ${b}`);

    await page.evaluate(() => {
      const nav = window.Alpine.store('nav');
      const book = (nav.books || []).find((b) => String(b.id) === String(nav.selectedBookId));
      if (book && window.__anchorPrevBuchtyp !== undefined) book.buchtyp = window.__anchorPrevBuchtyp;
    });
  }

  // Schutz gegen einen Lauf, der still nichts misst (Selektor-Drift).
  expect(checked, 'geprüfte Comboboxen').toBeGreaterThan(10);
  expect(failures, `Comboboxen, deren Liste nicht am Trigger haengt:\n${failures.join('\n')}`).toEqual([]);
});
