// Tastatur-Hauptweg gegen die ECHTE App: Skip-Link → Seitenbaum → Abschnitt
// oeffnen → Notebook-Editor (Bearbeiten-Modus) → wieder heraus.
//
// Geprueft wird nicht die genaue Tab-Reihenfolge (die bricht bei jeder harmlosen
// Template-Aenderung), sondern dass der Fokus auf jedem Schritt SICHTBAR auf
// einem Element landet — nie auf <body>, nie auf einem versteckten oder
// durchsichtigen Element. Das ist der Fehler, den ein Layout-Umbau unbemerkt
// einbaut: Tab geht weiter, aber niemand sieht mehr, wo.
//
// Betroffener Editor: nur der Notebook-Editor (Einzelseiten-Edit-Modus).
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';

// Beschreibung + Sichtbarkeit des aktuell fokussierten Elements.
function focusState(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) {
      return { ok: false, desc: 'body' };
    }
    const r = el.getBoundingClientRect();
    // Im Viewport: der Browser scrollt ein fokussiertes Element selbst ins Bild —
    // liegt es danach noch ausserhalb (top: -3rem, translate), sieht es niemand.
    const inViewport = r.bottom > 0 && r.right > 0
      && r.top < window.innerHeight && r.left < window.innerWidth;
    const visible = r.width > 0 && r.height > 0 && inViewport
      && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    return {
      ok: visible,
      desc: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : ''),
      treeitem: el.getAttribute('role') === 'treeitem',
      pageItem: el.classList.contains('page-item'),
      pageId: el.dataset?.pageId || null,
    };
  });
}

test('Tastatur-Hauptweg: Fokus bleibt sichtbar von Skip-Link bis Editor', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);

  // 1) Erster Tab-Halt im Dokument ist der Skip-Link, und er wird sichtbar.
  await page.evaluate(() => { document.activeElement?.blur(); window.focus(); });
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  // poll: der Skip-Link gleitet per Transition ins Bild.
  await expect.poll(async () => (await focusState(page)).ok, { message: 'Skip-Link sichtbar bei Fokus' }).toBe(true);

  // Enter springt in den Hauptbereich.
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();

  // 2) Vom Skip-Link aus per Tab in den Seitenbaum — jeder Halt sichtbar.
  await page.locator('.skip-link').focus();
  const path = [];
  let reachedTree = false;
  for (let i = 0; i < 60 && !reachedTree; i++) {
    await page.keyboard.press('Tab');
    const s = await focusState(page);
    path.push(s.desc);
    expect(s.ok, `Tab-Halt ${i + 1} unsichtbar: ${s.desc}\nWeg: ${path.join(' → ')}`).toBe(true);
    reachedTree = s.treeitem;
  }
  expect(reachedTree, `Seitenbaum per Tab nicht erreicht.\nWeg: ${path.join(' → ')}`).toBe(true);

  // 3) Im Baum per Pfeil zum ersten Abschnitt, Enter oeffnet ihn.
  let st = await focusState(page);
  for (let i = 0; i < 30 && !st.pageItem; i++) {
    await page.keyboard.press('ArrowDown');
    st = await focusState(page);
    expect(st.ok, `Pfeil-Halt unsichtbar: ${st.desc}`).toBe(true);
  }
  expect(st.pageItem, 'per Pfeiltaste einen Abschnitt erreicht').toBe(true);
  const pageId = st.pageId;
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (id) => window.__app.showEditorCard === true && String(window.__app.currentPage?.id) === String(id),
    pageId,
    { timeout: 15000 },
  );

  // 4) Bearbeiten-Modus per Kuerzel; der Fokus sitzt danach in der Schreibflaeche.
  await page.keyboard.press('ControlOrMeta+e');
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
  await expect.poll(
    () => page.evaluate((sel) => !!document.activeElement?.closest(sel), EDIT_SEL),
    { message: 'Fokus in der Schreibflaeche nach Cmd/Ctrl+E' },
  ).toBe(true);

  // 5) Shift+Tab verlaesst die Schreibflaeche sichtbar (kein Fokus im Leeren).
  // Vorwaerts-Tab ist hier nicht pruefbar: die Schreibflaeche ist der letzte
  // sichtbare Tab-Halt des Dokuments, Tab geht von dort an die Browser-Leiste.
  await page.keyboard.press('Shift+Tab');
  const out = await focusState(page);
  expect(out.ok, `Shift+Tab aus dem Editor landet unsichtbar: ${out.desc}`).toBe(true);
  expect(
    await page.evaluate((sel) => !document.activeElement?.closest(sel), EDIT_SEL),
    'Shift+Tab verlaesst die Schreibflaeche',
  ).toBe(true);
});
